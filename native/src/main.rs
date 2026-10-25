use human_input_worker::protocol::{Fault, Request};
use human_input_worker::runtime::Runtime;
use human_input_worker::wire::{Line, read_line};
use serde_json::{Value, json};
use std::io::{self, Write};
use std::sync::{Arc, Mutex, mpsc};

fn response(id: Value, result: Result<Value, Fault>) -> Value {
    match result {
        Ok(result) => json!({ "id": id, "ok": true, "result": result }),
        Err(error) => json!({ "id": id, "ok": false, "error": error }),
    }
}
fn output(writer: &Mutex<io::Stdout>, value: Value) {
    let mut writer = writer
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if serde_json::to_writer(&mut *writer, &value).is_err()
        || writer.write_all(b"\n").is_err()
        || writer.flush().is_err()
    {
        eprintln!("human-input-worker: parent response pipe is closed");
    }
}
#[cfg(windows)]
fn main() {
    let runtime = Runtime::new(Arc::new(human_input_worker::win32::WindowsPlatform));
    let writer = Arc::new(Mutex::new(io::stdout()));
    // Only 64 pending commands; execution has its own thread and admits no
    // queued input. The reader immediately sets cancellation before dispatch.
    let (sender, receiver) = mpsc::sync_channel::<Request>(64);
    let reader_runtime = Arc::clone(&runtime);
    let reader_writer = Arc::clone(&writer);
    let reader = std::thread::Builder::new()
        .name("human-input-reader".into())
        .spawn(move || {
            let stdin = io::stdin();
            let mut input = stdin.lock();
            loop {
                match read_line(&mut input) {
                    Ok(Line::Data(bytes)) => {
                        let raw = serde_json::from_slice::<Value>(&bytes);
                        let id = raw
                            .as_ref()
                            .ok()
                            .and_then(|v| v.get("id"))
                            .filter(|id| id.as_i64().is_some())
                            .cloned()
                            .unwrap_or(Value::Null);
                        if !id.is_null() {
                            reader_runtime.renew();
                        }
                        match serde_json::from_slice::<Request>(&bytes) {
                            Ok(request) => {
                                if let Request::Cancel {
                                    operation_id,
                                    reason,
                                    ..
                                } = &request
                                {
                                    reader_runtime.request_cancel(
                                        operation_id.as_deref(),
                                        reason.as_deref().unwrap_or("explicit_cancel"),
                                    );
                                }
                                let id = request.id();
                                if let Request::Pause {
                                    operation_id,
                                    reason,
                                    ..
                                } = &request
                                {
                                    reader_runtime.request_pause(
                                        operation_id,
                                        reason.as_deref().unwrap_or("explicit_pause"),
                                    );
                                }
                                if let Err(error) = sender.try_send(request) {
                                    output(
                                        &reader_writer,
                                        response(
                                            json!(id),
                                            Err(Fault::new(
                                                "request_overflow",
                                                format!("Bounded dispatch is unavailable: {error}"),
                                            )),
                                        ),
                                    );
                                }
                            }
                            Err(error) => output(
                                &reader_writer,
                                response(id, Err(Fault::new("invalid_request", error.to_string()))),
                            ),
                        }
                    }
                    Ok(Line::TooLong) => output(
                        &reader_writer,
                        response(
                            Value::Null,
                            Err(Fault::new("line_too_long", "Request line exceeds 2 MiB")),
                        ),
                    ),
                    Ok(Line::Eof) => break,
                    Err(error) => {
                        eprintln!("human-input-worker: stdin error: {error}");
                        break;
                    }
                }
            }
            reader_runtime.eof();
        });
    let reader = match reader {
        Ok(reader) => reader,
        Err(error) => {
            eprintln!("human-input-worker: cannot create reader: {error}");
            return;
        }
    };
    for request in receiver {
        let id = request.id();
        let result = match request {
            Request::Hello { .. } => Ok(
                json!({ "protocol": 2, "version": "0.2.0", "platform": "windows", "capabilities": {
                    "move": true, "click": true, "drag": true, "typing": true, "reading": true,
                    "scroll":true,"key":true,"copy":true,"cut":true,"paste":true,"activate":true,"pause":true,"resume":true,"events":true,
                    "cancel_on_user_message": false, "page_change_detection": false,
                    "delivery_verified": false, "hooks": false, "capture": false,
                    "parent_lease_ms": 3000, "guard_interval_ms": 20,
                    "max_line_bytes": 2097152, "max_events": 12000,
                    "exclusive_lock": "Local\\HumanInputMCP.Input.v1"
                }}),
            ),
            Request::Ping { .. } => Ok(json!({ "alive": true })),
            Request::Observe { hwnd, .. } => runtime.observe(&hwnd).and_then(|snapshot| {
                serde_json::to_value(snapshot)
                    .map_err(|e| Fault::new("serialization_error", e.to_string()))
            }),
            Request::Start { plan, .. } => runtime.start(plan),
            Request::Status { operation_id, .. } => {
                runtime.status(&operation_id).and_then(|status| {
                    serde_json::to_value(status)
                        .map_err(|e| Fault::new("serialization_error", e.to_string()))
                })
            }
            Request::Cancel {
                operation_id,
                reason,
                ..
            } => runtime.cancel(
                operation_id.as_deref(),
                reason.as_deref().unwrap_or("explicit_cancel"),
            ),
            Request::Pause {
                operation_id,
                reason,
                ..
            } => runtime.pause(&operation_id, reason.as_deref().unwrap_or("explicit_pause")),
            Request::Resume { request, .. } => runtime.resume(request),
            Request::Events {
                after_seq, limit, ..
            } => runtime.events(after_seq, limit),
        };
        output(&writer, response(json!(id), result));
    }
    runtime.eof();
    // EOF drains to a terminal cleanup barrier before the process exits.
    // On timeout keep waiting with admission poisoned; exiting immediately
    // would abandon owned button/key releases on the execution thread.
    loop {
        match runtime.cancel(None, "stdin_eof") {
            Ok(_) => break,
            Err(error) if error.code == "cancellation_timeout" => {
                eprintln!("human-input-worker: waiting for EOF cleanup barrier")
            }
            Err(error) => {
                eprintln!("human-input-worker: EOF cleanup error: {}", error.message);
                break;
            }
        }
    }
    let _ = reader.join();
}
#[cfg(not(windows))]
fn main() {
    eprintln!("human-input-worker requires Windows");
    std::process::exit(1);
}
