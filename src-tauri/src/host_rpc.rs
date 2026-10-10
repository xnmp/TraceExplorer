//! One reverse-RPC transport per backend connection. All host services share
//! IDs, bounded pending admission, disconnect fanout and late-reply handling.
use crate::error::AppError;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};

type Reply = Result<Value, AppError>;
type SendFrame = dyn Fn(Value) -> Result<(), AppError> + Send + Sync;
pub struct HostRpcClient {
    send: Arc<SendFrame>,
    pending: Mutex<HashMap<String, mpsc::Sender<Reply>>>,
    sequence: AtomicU64,
}
static CLIENT: OnceLock<HostRpcClient> = OnceLock::new();

impl HostRpcClient {
    pub fn new(send: impl Fn(Value) -> Result<(), AppError> + Send + Sync + 'static) -> Self {
        Self {
            send: Arc::new(send),
            pending: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(1),
        }
    }

    fn id(&self) -> String {
        format!("host:{}", self.sequence.fetch_add(1, Ordering::Relaxed))
    }

    pub fn deliver(&self, frame: &Value) -> bool {
        let Some(id) = frame["id"].as_str().filter(|id| id.starts_with("host:")) else {
            return false;
        };
        let sender = self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(id);
        if let Some(sender) = sender {
            let result = if frame["jsonrpc"] != "2.0"
                || frame.get("result").is_some() == frame.get("error").is_some()
            {
                Err(AppError::Other("Malformed host service reply".into()))
            } else if let Some(error) = frame.get("error") {
                Err(AppError::Other(
                    error["message"]
                        .as_str()
                        .unwrap_or("Host service failed")
                        .into(),
                ))
            } else {
                Ok(frame["result"].clone())
            };
            let _ = sender.send(result);
        } else if let Some(handle) = frame["result"]["handle"]
            .as_str()
            .filter(|handle| handle == &id)
        {
            // A process response can arrive after cancellation. Release its
            // output spool even though its waiter has already gone away.
            let _ = self.send(
                json!({"jsonrpc":"2.0","method":"host.process.release","params":{"handle":handle}}),
            );
        }
        true
    }

    pub fn disconnected(&self) {
        for (_, sender) in self
            .pending
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .drain()
        {
            let _ = sender.send(Err(AppError::Other("Plugin host disconnected".into())));
        }
    }

    fn send(&self, frame: Value) -> Result<(), AppError> {
        if serde_json::to_vec(&frame)
            .map_err(|_| AppError::Other("Invalid host request".into()))?
            .len()
            > 1024 * 1024
        {
            return Err(AppError::Other("Host request exceeds 1 MiB".into()));
        }
        (self.send)(frame)
    }

    pub fn invoke(
        &self,
        method: &str,
        params: Value,
        cancelled: &impl Fn() -> bool,
        deadline: Option<Instant>,
        cancel: Option<(&str, Value)>,
    ) -> Reply {
        let id = self.id();
        let (sender, receiver) = mpsc::channel();
        {
            let mut pending = self
                .pending
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            let limit = if method.ends_with(".cancel") || method.ends_with(".release") {
                32
            } else {
                28
            };
            if pending.len() >= limit {
                return Err(AppError::Other("Host request capacity reached".into()));
            }
            pending.insert(id.clone(), sender);
        }
        if let Err(error) =
            self.send(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
        {
            self.pending
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&id);
            return Err(error);
        }
        loop {
            let timed_out = deadline.is_some_and(|deadline| Instant::now() >= deadline);
            if cancelled() || timed_out {
                self.pending
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .remove(&id);
                if let Some((method, params)) = cancel {
                    let params = if params.is_null() {
                        json!({"requestId":id})
                    } else {
                        params
                    };
                    let _ = self.send(
                        json!({"jsonrpc":"2.0","id":self.id(),"method":method,"params":params}),
                    );
                }
                return Err(AppError::Other(
                    if timed_out {
                        "Host request timed out"
                    } else {
                        "Host request cancelled"
                    }
                    .into(),
                ));
            }
            match receiver.recv_timeout(Duration::from_millis(20)) {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(_) => return Err(AppError::Other("Host reply was lost".into())),
            }
        }
    }
}

pub fn configure(send: impl Fn(Value) -> Result<(), AppError> + Send + Sync + 'static) {
    let _ = CLIENT.set(HostRpcClient::new(send));
}
pub fn deliver(frame: &Value) -> bool {
    CLIENT.get().is_some_and(|client| client.deliver(frame))
}
pub fn disconnected() {
    if let Some(client) = CLIENT.get() {
        client.disconnected();
    }
}
pub(crate) fn invoke(
    method: &str,
    params: Value,
    cancelled: &impl Fn() -> bool,
    deadline: Option<Instant>,
    cancel: Option<(&str, Value)>,
) -> Reply {
    CLIENT
        .get()
        .ok_or_else(|| AppError::Other("Host service is unavailable".into()))?
        .invoke(method, params, cancelled, deadline, cancel)
}
pub(crate) fn notify(method: &str, params: Value) -> Result<(), AppError> {
    CLIENT
        .get()
        .ok_or_else(|| AppError::Other("Host service is unavailable".into()))?
        .send(json!({"jsonrpc":"2.0","method":method,"params":params}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mixed_services_correlate_reverse_replies_and_reject_malformed_frames() {
        let (sent, frames) = mpsc::channel();
        let client = Arc::new(HostRpcClient::new(move |value| {
            sent.send(value).unwrap();
            Ok(())
        }));
        let mut workers = vec![];
        for method in ["host.text.describe", "host.process.run"] {
            let client = client.clone();
            workers.push(std::thread::spawn(move || {
                client.invoke(
                    method,
                    json!({}),
                    &|| false,
                    Some(Instant::now() + Duration::from_secs(1)),
                    None,
                )
            }));
        }
        let first = frames.recv().unwrap();
        let second = frames.recv().unwrap();
        assert_ne!(first["id"], second["id"]);
        assert!(
            client.deliver(&json!({"jsonrpc":"2.0","id":second["id"],"result":second["method"]}))
        );
        assert!(client.deliver(&json!({"jsonrpc":"2.0","id":first["id"],"result":first["method"]})));
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap().unwrap())
            .collect();
        assert_eq!(
            results,
            vec![json!("host.text.describe"), json!("host.process.run")]
        );
        assert!(!client.deliver(&json!({"id":1,"result":null})));
    }

    #[test]
    fn timeout_cancels_owned_request_and_late_process_output_is_released() {
        let (sent, frames) = mpsc::channel();
        let client = HostRpcClient::new(move |value| {
            sent.send(value).unwrap();
            Ok(())
        });
        assert!(client
            .invoke(
                "host.process.run",
                json!({}),
                &|| false,
                Some(Instant::now()),
                Some(("host.process.cancel", Value::Null))
            )
            .is_err());
        let request = frames.recv().unwrap();
        let cancel = frames.recv().unwrap();
        assert_eq!(cancel["params"]["requestId"], request["id"]);
        client.deliver(
            &json!({"jsonrpc":"2.0","id":request["id"],"result":{"handle":request["id"]}}),
        );
        let release = frames.recv().unwrap();
        assert_eq!(release["method"], "host.process.release");
        assert_eq!(release["params"]["handle"], request["id"]);
    }
}
