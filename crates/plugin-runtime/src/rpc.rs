//! One reverse-RPC transport per backend connection. All host services share
//! IDs, bounded pending admission, disconnect fanout and late-reply handling.
use crate::Error as AppError;
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
struct Pending {
    sender: mpsc::Sender<Reply>,
    lane: usize,
}
fn lane(method: &str, params: &Value) -> usize {
    if method.ends_with(".cancel")
        || method.ends_with(".release")
        || method == "host.services.invoke"
            && matches!(
                params["method"].as_str(),
                Some("status" | "cancel" | "acknowledge")
            )
    {
        1
    } else if matches!(
        method,
        "host.artifacts.stage"
            | "host.artifacts.seal"
            | "host.artifacts.acquired"
            | "host.services.provider.update"
            | "host.services.test.update"
            | "host.process.read"
    ) {
        2
    } else {
        0
    }
}
pub struct HostRpcClient {
    send: Arc<SendFrame>,
    pending: Mutex<HashMap<String, Pending>>,
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
                Err(AppError::Remote {
                    code: error["data"]["code"]
                        .as_str()
                        .unwrap_or("host_failed")
                        .to_owned(),
                    message: error["message"]
                        .as_str()
                        .unwrap_or("Host service failed")
                        .to_owned(),
                })
            } else {
                Ok(frame["result"].clone())
            };
            let _ = sender.sender.send(result);
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
            let _ = sender
                .sender
                .send(Err(AppError::Other("Plugin host disconnected".into())));
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
            let lane = lane(method, &params);
            if pending.values().filter(|entry| entry.lane == lane).count() >= [28, 4, 8][lane] {
                return Err(AppError::Other("Host request capacity reached".into()));
            }
            pending.insert(id.clone(), Pending { sender, lane });
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
pub fn invoke(
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
pub fn notify(method: &str, params: Value) -> Result<(), AppError> {
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

    /// Plan §21.3 #5: process, text, artifact and service reverse requests share
    /// one id space and one bounded ordinary lane. Cancelled and late replies
    /// neither leak pending slots nor reach another waiter, and control and
    /// completion requests stay admissible while every ordinary slot is held.
    #[test]
    fn mixed_kind_reverse_requests_with_cancelled_and_late_replies_stay_correlated_and_bounded() {
        use std::sync::atomic::AtomicBool;
        type Worker = std::thread::JoinHandle<Reply>;
        let (sent, frames) = mpsc::channel::<Value>();
        let client = Arc::new(HostRpcClient::new(move |frame| {
            sent.send(frame).unwrap();
            Ok(())
        }));
        let next = || frames.recv_timeout(Duration::from_secs(2)).unwrap();
        let spawn = |method: &'static str, params: Value, cancel: Arc<AtomicBool>| -> Worker {
            let client = client.clone();
            std::thread::spawn(move || {
                client.invoke(
                    method,
                    params,
                    &|| cancel.load(Ordering::Acquire),
                    None,
                    (method == "host.process.run").then_some(("host.process.cancel", Value::Null)),
                )
            })
        };
        let kinds: [(&'static str, Value); 4] = [
            ("host.process.run", json!({"program":"fixture"})),
            ("host.text.generate", json!({"prompt":"fixture"})),
            (
                "host.artifacts.read",
                json!({"artifact":{"handle":"fixture"}}),
            ),
            ("host.services.invoke", json!({"method":"start"})),
        ];
        let mut ids = std::collections::HashSet::new();
        let mut unique = |frame: &Value| {
            let id = frame["id"]
                .as_str()
                .expect("reverse request has a string id");
            assert!(ids.insert(id.to_owned()), "reverse id {id} was reused");
        };
        // Fill the ordinary lane with every kind; some of each kind are cancelled.
        let mut ordinary = vec![];
        for index in 0..28 {
            let (method, params) = kinds[index % 4].clone();
            let cancel = Arc::new(AtomicBool::new(false));
            let worker = spawn(method, params, cancel.clone());
            let frame = next();
            assert_eq!(frame["method"], method);
            unique(&frame);
            ordinary.push((frame, cancel, worker, (index / 4) % 2 == 1));
        }
        for (method, params) in kinds.clone() {
            let probe = Some(Instant::now() + Duration::from_millis(200));
            let refused = client.invoke(method, params, &|| false, probe, None);
            assert!(
                matches!(&refused, Err(AppError::Other(m)) if m.contains("capacity")),
                "{method} was admitted beyond the ordinary bound"
            );
        }
        // Control and completion lanes remain live while ordinary slots are full.
        let mut priority = vec![];
        for (method, params) in [
            ("host.services.invoke", json!({"method":"status"})),
            ("host.services.invoke", json!({"method":"cancel"})),
            ("host.services.invoke", json!({"method":"acknowledge"})),
            ("host.artifacts.stage", json!({})),
            ("host.artifacts.seal", json!({})),
            ("host.services.provider.update", json!({})),
        ] {
            let worker = spawn(method, params.clone(), Arc::new(AtomicBool::new(false)));
            let frame = next();
            assert_eq!(
                (&frame["method"], &frame["params"]),
                (&json!(method), &params)
            );
            unique(&frame);
            priority.push((frame, worker));
        }
        for (frame, worker) in priority.into_iter().rev() {
            assert!(client
                .deliver(&json!({"jsonrpc":"2.0","id":frame["id"],"result":{"for":frame["id"]}})));
            assert_eq!(worker.join().unwrap().unwrap(), json!({"for":frame["id"]}));
        }
        // Cancel half; owned process work announces cancellation of its own id.
        let mut cancelled = vec![];
        let mut live = vec![];
        for (frame, cancel, worker, cancelled_here) in ordinary {
            if cancelled_here {
                cancel.store(true, Ordering::Release);
                let failure = worker.join().unwrap().unwrap_err();
                assert!(matches!(failure, AppError::Other(m) if m.contains("cancelled")));
                if frame["method"] == "host.process.run" {
                    let notice = next();
                    unique(&notice);
                    assert_eq!(notice["method"], "host.process.cancel");
                    assert_eq!(notice["params"]["requestId"], frame["id"]);
                }
                cancelled.push(frame);
            } else {
                live.push((frame, worker));
            }
        }
        // Cancellation alone frees exactly the cancelled slots, before any reply.
        let mut filler = vec![];
        for index in 0..cancelled.len() {
            let (method, params) = kinds[index % 4].clone();
            let worker = spawn(method, params, Arc::new(AtomicBool::new(false)));
            let frame = next();
            unique(&frame);
            filler.push((frame, worker));
        }
        let probe = Some(Instant::now() + Duration::from_millis(200));
        assert!(matches!(
            client.invoke("host.artifacts.read", json!({}), &|| false, probe, None),
            Err(AppError::Other(m)) if m.contains("capacity")
        ));
        // Late replies to cancelled work never reach a live waiter; a late
        // process reply still releases its spooled output.
        for frame in &cancelled {
            let reply = if frame["method"] == "host.process.run" {
                json!({"handle":frame["id"]})
            } else {
                json!({"late":frame["id"]})
            };
            assert!(client.deliver(&json!({"jsonrpc":"2.0","id":frame["id"],"result":reply})));
            if frame["method"] == "host.process.run" {
                let release = next();
                assert_eq!(release["method"], "host.process.release");
                assert_eq!(release["params"]["handle"], frame["id"]);
                assert!(release.get("id").is_none());
            }
        }
        // Live work is answered out of order; each waiter gets only its own reply,
        // and a duplicate reply is absorbed without affecting anyone else.
        for (frame, _) in live.iter().chain(&filler).rev() {
            let reply = json!({"jsonrpc":"2.0","id":frame["id"],"result":{"for":frame["id"],"method":frame["method"]}});
            assert!(client.deliver(&reply));
            assert!(client.deliver(&reply));
        }
        for (frame, worker) in filler.into_iter().chain(live) {
            assert_eq!(
                worker.join().unwrap().unwrap(),
                json!({"for":frame["id"],"method":frame["method"]})
            );
        }
        assert!(frames.try_recv().is_err(), "unexpected extra reverse frame");
        // Every cancelled, late or answered request released its slot: the full
        // ordinary bound is available again, and still bounded.
        let mut refill = vec![];
        for index in 0..28 {
            let (method, params) = kinds[index % 4].clone();
            let worker = spawn(method, params, Arc::new(AtomicBool::new(false)));
            let frame = next();
            unique(&frame);
            refill.push((frame, worker));
        }
        let probe = Some(Instant::now() + Duration::from_millis(200));
        assert!(matches!(
            client.invoke("host.text.generate", json!({}), &|| false, probe, None),
            Err(AppError::Other(m)) if m.contains("capacity")
        ));
        for (frame, worker) in refill {
            client.deliver(&json!({"jsonrpc":"2.0","id":frame["id"],"result":frame["id"]}));
            assert_eq!(worker.join().unwrap().unwrap(), frame["id"]);
        }
    }

    #[test]
    fn saturated_configuration_reads_preserve_completion_and_cancellation_capacity() {
        let (sent, frames) = mpsc::channel();
        let client = Arc::new(HostRpcClient::new(move |frame| {
            sent.send(frame).unwrap();
            Ok(())
        }));
        let mut workers = vec![];
        let mut requests = vec![];
        for _ in 0..28 {
            let client = client.clone();
            workers.push(std::thread::spawn(move || {
                client.invoke("host.credentials.get", json!({}), &|| false, None, None)
            }));
            requests.push(frames.recv_timeout(Duration::from_secs(2)).unwrap());
        }
        assert!(client
            .invoke("host.credentials.get", json!({}), &|| false, None, None)
            .is_err());
        for method in [
            "host.artifacts.stage",
            "host.artifacts.seal",
            "host.artifacts.acquired",
            "host.services.provider.update",
            "host.process.cancel",
        ] {
            let client = client.clone();
            workers.push(std::thread::spawn(move || {
                client.invoke(method, json!({}), &|| false, None, None)
            }));
            requests.push(frames.recv_timeout(Duration::from_secs(2)).unwrap());
        }
        for request in requests {
            client
                .deliver(&json!({"jsonrpc":"2.0","id":request["id"],"result":{"completed":true}}));
        }
        for worker in workers {
            assert_eq!(worker.join().unwrap().unwrap(), json!({"completed":true}));
        }
    }
}
