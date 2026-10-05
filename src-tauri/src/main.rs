use base64::Engine;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    io::{self, BufRead, Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use trace_explorer_backend::{EventEmitter, Request, MAX_MESSAGE_BYTES};

fn send(output: &Mutex<io::Stdout>, value: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(value)?;
    if bytes.len() > 32 * 1024 * 1024 {
        return Err(io::Error::other("Plugin response exceeds 32 MiB"));
    }
    let mut output = output
        .lock()
        .map_err(|_| io::Error::other("RPC output lock poisoned"))?;
    if bytes.len() <= MAX_MESSAGE_BYTES {
        output.write_all(&bytes)?;
        output.write_all(b"\n")?;
    } else {
        let id = value
            .get("id")
            .ok_or_else(|| io::Error::other("Plugin event exceeds frame limit"))?;
        let count = bytes.len().div_ceil(256 * 1024);
        for (sequence, chunk) in bytes.chunks(256 * 1024).enumerate() {
            serde_json::to_writer(
                &mut *output,
                &json!({"jsonrpc":"2.0","id":id,"chunk":{"sequence":sequence,"final":sequence+1==count,"data":base64::engine::general_purpose::STANDARD.encode(chunk)}}),
            )?;
            output.write_all(b"\n")?;
        }
    }
    output.flush()
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(std::ffi::OsStr::new("--data-dir")) {
        return Err("Usage: trace-explorer-backend --data-dir <absolute-directory>".into());
    }
    let directory = PathBuf::from(args.next().ok_or("Missing data directory")?);
    if args.next().is_some() {
        return Err("Unexpected argument".into());
    }
    trace_explorer_backend::initialize(&directory)?;
    let output = Arc::new(Mutex::new(io::stdout()));
    let callback_output = output.clone();
    trace_explorer_backend::host_process::configure(move |value| {
        send(&callback_output, &value).map_err(Into::into)
    });
    let event_output = output.clone();
    let app = EventEmitter::new(move |event, payload| {
        send(
            &event_output,
            &json!({"jsonrpc":"2.0","method":"event","params":{"name":event,"payload":payload}}),
        )
        .map_err(Into::into)
    });
    let (sender, mut input) = tokio::sync::mpsc::channel(64);
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut input = stdin.lock();
        loop {
            let mut frame = Vec::new();
            match input
                .by_ref()
                .take((MAX_MESSAGE_BYTES + 2) as u64)
                .read_until(b'\n', &mut frame)
            {
                Ok(0) | Err(_) => break,
                Ok(_)
                    if frame.len() - usize::from(frame.last() == Some(&b'\n'))
                        > MAX_MESSAGE_BYTES =>
                {
                    break
                }
                Ok(_) => {
                    if sender.blocking_send(frame).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let slots = Arc::new(tokio::sync::Semaphore::new(32));
    let active = Arc::new(Mutex::new(HashSet::new()));
    let mut handlers = tokio::task::JoinSet::new();
    while let Some(frame) = input.recv().await {
        let value = match serde_json::from_slice::<Value>(&frame) {
            Ok(value) => value,
            Err(error) => {
                send(
                    &output,
                    &json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":error.to_string()}}),
                )?;
                continue;
            }
        };
        if trace_explorer_backend::host_process::deliver(&value) {
            continue;
        }
        let request = match serde_json::from_value::<Request>(value) {
            Ok(request) => request,
            Err(error) => {
                send(
                    &output,
                    &json!({"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":error.to_string()}}),
                )?;
                continue;
            }
        };
        let id = request.id;
        let permit = match slots.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                send(
                    &output,
                    &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32002,"message":"Plugin request capacity reached"}}),
                )?;
                continue;
            }
        };
        if !active
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(id)
        {
            send(
                &output,
                &json!({"jsonrpc":"2.0","id":id,"error":{"code":-32600,"message":"Duplicate active request ID"}}),
            )?;
            continue;
        }
        let output = output.clone();
        let app = app.clone();
        let active = active.clone();
        handlers.spawn(async move {
            let _permit = permit;
            let response = trace_explorer_backend::dispatch(app, request).await;
            if let Err(cause)=send(&output,&response) {
                let _=send(&output,&json!({"jsonrpc":"2.0","id":id,"error":{"code":-32003,"message":cause.to_string()}}));
            }
            active
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .remove(&id);
        });
        while handlers.try_join_next().is_some() {}
    }
    trace_explorer_backend::host_process::disconnected();
    trace_explorer_backend::shutdown_jobs();
    handlers.abort_all();
    // Accepted blocking workers can be inside HTTP calls. The host retains
    // recovery evidence and owns all CLI children; it need not wait on them.
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    std::process::exit(0)
}
