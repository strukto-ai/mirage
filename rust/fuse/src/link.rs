use crate::proto::{Frame, read_frame, write_frame};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Mutex, MutexGuard};

/// Why a request got no answer: the host refused it with a condition such
/// as `ENOENT`, or the pipe to the host is gone.
#[derive(Debug)]
pub enum Failure {
    Refused(String),
    Lost,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The pipe to the host: each request waits for the reply carrying its id,
/// and each frame the host starts goes to the handler `serve` is given.
pub struct Link {
    out: Mutex<Box<dyn Write + Send>>,
    pending: Mutex<Option<HashMap<u64, Sender<Frame>>>>,
    next: AtomicU64,
}

impl Link {
    pub fn new(out: Box<dyn Write + Send>) -> Link {
        Link {
            out: Mutex::new(out),
            pending: Mutex::new(Some(HashMap::new())),
            next: AtomicU64::new(0),
        }
    }

    /// Send `op` with `args` and `body`, and wait for its reply.
    pub fn call(&self, op: &str, args: Value, body: &[u8]) -> Result<Frame, Failure> {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let mut head = match args {
            Value::Object(head) => head,
            _ => Map::new(),
        };
        head.insert("id".into(), id.into());
        head.insert("op".into(), op.into());
        let (tx, rx) = channel();
        match locked(&self.pending).as_mut() {
            Some(pending) => pending.insert(id, tx),
            None => return Err(Failure::Lost),
        };
        if self.send(&head, body).is_err() {
            if let Some(pending) = locked(&self.pending).as_mut() {
                pending.remove(&id);
            }
            return Err(Failure::Lost);
        }
        let reply = rx.recv().map_err(|_| Failure::Lost)?;
        match reply.str("errno") {
            Some(condition) => Err(Failure::Refused(condition.to_string())),
            None => Ok(reply),
        }
    }

    /// Send `op` without waiting for its reply, as a release does.
    pub fn post(&self, op: &str, args: Value) {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let mut head = match args {
            Value::Object(head) => head,
            _ => Map::new(),
        };
        head.insert("id".into(), id.into());
        head.insert("op".into(), op.into());
        if let Err(err) = self.send(&head, &[]) {
            eprintln!("mirage-fuse: sending {op} failed: {err}");
        }
    }

    /// Write one frame to the host.
    pub fn send(&self, head: &Map<String, Value>, body: &[u8]) -> io::Result<()> {
        let mut out = locked(&self.out);
        write_frame(&mut *out, head, body)
    }

    /// Route each frame on `input` until it ends: a reply to the request
    /// waiting for it, any other frame to `push`. Every request still
    /// waiting then fails as lost.
    pub fn serve(&self, input: &mut impl Read, mut push: impl FnMut(Frame)) -> io::Result<()> {
        let ended = loop {
            match read_frame(input) {
                Ok(Some(frame)) => match frame.u64("id") {
                    Some(id) => {
                        let waiter = locked(&self.pending).as_mut().and_then(|p| p.remove(&id));
                        if let Some(waiter) = waiter {
                            let _ = waiter.send(frame);
                        }
                    }
                    None => push(frame),
                },
                Ok(None) => break Ok(()),
                Err(err) => break Err(err),
            }
        };
        locked(&self.pending).take();
        ended
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::proto::encode;
    use serde_json::json;
    use std::sync::Arc;

    fn frame(head: Value, body: &[u8]) -> Vec<u8> {
        let Value::Object(head) = head else {
            unreachable!()
        };
        encode(&head, body)
    }

    #[test]
    fn a_reply_reaches_its_request_and_a_push_its_handler() {
        let link = Arc::new(Link::new(Box::new(io::sink())));
        let caller = {
            let link = link.clone();
            std::thread::spawn(move || link.call("getattr", json!({"path": "/w"}), &[]))
        };
        while locked(&link.pending).as_ref().is_some_and(|p| p.is_empty()) {
            std::thread::yield_now();
        }
        let mut input = frame(json!({"push": "inval", "paths": ["/w/a"]}), &[]);
        input.extend(frame(json!({"id": 1, "a": {"m": 0o40755}}), b""));
        let mut pushed = Vec::new();
        link.serve(&mut input.as_slice(), |f| pushed.push(f))
            .unwrap();
        assert_eq!(pushed[0].str("push"), Some("inval"));
        assert!(caller.join().unwrap().is_ok());
    }

    #[test]
    fn a_refusal_carries_its_condition() {
        let link = Arc::new(Link::new(Box::new(io::sink())));
        let caller = {
            let link = link.clone();
            std::thread::spawn(move || link.call("getattr", json!({"path": "/w/x"}), &[]))
        };
        while locked(&link.pending).as_ref().is_some_and(|p| p.is_empty()) {
            std::thread::yield_now();
        }
        let input = frame(json!({"id": 1, "errno": "ENOENT"}), b"");
        link.serve(&mut input.as_slice(), |_| {}).unwrap();
        assert!(matches!(caller.join().unwrap(), Err(Failure::Refused(c)) if c == "ENOENT"));
    }

    #[test]
    fn a_request_still_waiting_when_the_pipe_ends_is_lost() {
        let link = Arc::new(Link::new(Box::new(io::sink())));
        let caller = {
            let link = link.clone();
            std::thread::spawn(move || link.call("statfs", json!({}), &[]))
        };
        while locked(&link.pending).as_ref().is_some_and(|p| p.is_empty()) {
            std::thread::yield_now();
        }
        link.serve(&mut [].as_slice(), |_| {}).unwrap();
        assert!(matches!(caller.join().unwrap(), Err(Failure::Lost)));
    }
}
