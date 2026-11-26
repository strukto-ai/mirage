use crate::proto::{Frame, read_frame, write_frame};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{RecvTimeoutError, Sender, channel};
use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::{Duration, Instant};

/// How long a sent request waits for its reply: a host whose backend
/// stalls fails the call rather than holding the machine's programs
/// forever. Sending is not bounded: the host reads its pipe without
/// pause, so a write blocks only while the host itself is stopped.
pub const REPLY_WAIT: Duration = Duration::from_secs(300);

/// The most bytes and requests sent ahead of their replies: what a host,
/// which answers in order, queues at most for one mount.
pub const AHEAD_BYTES: usize = 8 << 20;
pub const AHEAD_REQUESTS: usize = 1024;

/// Why a request got no answer: the host refused it with a condition such
/// as `ENOENT`, the pipe to the host is gone, or the host did not answer
/// in time.
#[derive(Clone, Debug)]
pub enum Failure {
    Refused(String),
    Lost,
    Late,
}

fn locked<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// One file handle's requests sent ahead: how many have no reply yet, the
/// first refusal among them, and whether the handle is released, so its
/// record goes once the last reply comes.
#[derive(Default)]
struct HandleWrites {
    unanswered: usize,
    refused: Option<Failure>,
    released: bool,
}

/// The requests sent ahead of their replies: their bytes, each one's
/// handle and size by id, and each handle's record.
#[derive(Default)]
struct Ahead {
    bytes: usize,
    sent: HashMap<u64, (u64, usize)>,
    handles: HashMap<u64, HandleWrites>,
    ended: bool,
}

/// The pipe to the host: each request waits for the reply carrying its id,
/// and each frame the host starts goes to the handler `serve` is given.
/// A write may go ahead of its reply (`send_ahead`); its handle waits for
/// it at close or fsync (`settle`).
pub struct Link {
    out: Mutex<Box<dyn Write + Send>>,
    pending: Mutex<Option<HashMap<u64, Sender<Frame>>>>,
    ahead: Mutex<Ahead>,
    answered: Condvar,
    next: AtomicU64,
    wait: Duration,
}

impl Link {
    pub fn new(out: Box<dyn Write + Send>) -> Link {
        Link::waiting(out, REPLY_WAIT)
    }

    /// A link whose requests wait `wait` for their replies.
    pub fn waiting(out: Box<dyn Write + Send>, wait: Duration) -> Link {
        Link {
            out: Mutex::new(out),
            pending: Mutex::new(Some(HashMap::new())),
            ahead: Mutex::new(Ahead::default()),
            answered: Condvar::new(),
            next: AtomicU64::new(0),
            wait,
        }
    }

    /// Wait on the replies to requests sent ahead until `done` holds of
    /// them, at most the link's wait.
    fn await_ahead(
        &self,
        mut done: impl FnMut(&Ahead) -> bool,
    ) -> Result<MutexGuard<'_, Ahead>, Failure> {
        let deadline = Instant::now() + self.wait;
        let mut ahead = locked(&self.ahead);
        while !done(&ahead) {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(Failure::Late);
            }
            ahead = self
                .answered
                .wait_timeout(ahead, left)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        }
        Ok(ahead)
    }

    /// Send `op` for host handle `fh` without waiting for its reply, once
    /// the requests already ahead leave room for it. A refusal one of the
    /// handle's earlier requests met fails it unsent, as does a pipe gone.
    pub fn send_ahead(&self, fh: u64, op: &str, args: Value, body: &[u8]) -> Result<(), Failure> {
        let room = |a: &Ahead| {
            a.ended
                || a.handles.get(&fh).is_some_and(|h| h.refused.is_some())
                || a.sent.is_empty()
                || (a.bytes + body.len() <= AHEAD_BYTES && a.sent.len() < AHEAD_REQUESTS)
        };
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        {
            let mut ahead = self.await_ahead(room)?;
            if ahead.ended {
                return Err(Failure::Lost);
            }
            if let Some(refused) = ahead.handles.get(&fh).and_then(|h| h.refused.clone()) {
                return Err(refused);
            }
            ahead.bytes += body.len();
            ahead.sent.insert(id, (fh, body.len()));
            ahead.handles.entry(fh).or_default().unanswered += 1;
        }
        let mut head = match args {
            Value::Object(head) => head,
            _ => Map::new(),
        };
        head.insert("id".into(), id.into());
        head.insert("op".into(), op.into());
        if self.send(&head, body).is_err() {
            self.answer_ahead(id, Some(Failure::Lost));
            return Err(Failure::Lost);
        }
        Ok(())
    }

    /// Wait until every request sent ahead for host handle `fh` before this
    /// call has its reply, and hand over the first refusal the handle met,
    /// once. Writes sent meanwhile through the same handle, by another
    /// descriptor of it, are not waited for, so they cannot hold it off.
    pub fn settle(&self, fh: u64) -> Result<(), Failure> {
        let before: Vec<u64> = locked(&self.ahead)
            .sent
            .iter()
            .filter(|(_, (handle, _))| *handle == fh)
            .map(|(&id, _)| id)
            .collect();
        let mut ahead = self.await_ahead(|a| before.iter().all(|id| !a.sent.contains_key(id)))?;
        let Some(handle) = ahead.handles.get_mut(&fh) else {
            return Ok(());
        };
        let refused = handle.refused.take();
        if handle.unanswered == 0 {
            ahead.handles.remove(&fh);
        }
        refused.map_or(Ok(()), Err)
    }

    /// The first refusal among host handle `fh`'s requests sent ahead, if
    /// one came: it stays for the close or fsync that waits on them.
    pub fn refusal(&self, fh: u64) -> Option<Failure> {
        locked(&self.ahead)
            .handles
            .get(&fh)
            .and_then(|h| h.refused.clone())
    }

    /// Forget host handle `fh` once its last request sent ahead has its
    /// reply: it is released, so no close or fsync waits for it any more.
    pub fn released(&self, fh: u64) {
        let mut ahead = locked(&self.ahead);
        let Some(handle) = ahead.handles.get_mut(&fh) else {
            return;
        };
        handle.released = true;
        if handle.unanswered == 0 {
            ahead.handles.remove(&fh);
        }
    }

    /// Settle request `id` if it was sent ahead, with `refusal` when its
    /// reply refused it; whether it was.
    fn answer_ahead(&self, id: u64, refusal: Option<Failure>) -> bool {
        let mut ahead = locked(&self.ahead);
        let Some((fh, bytes)) = ahead.sent.remove(&id) else {
            return false;
        };
        ahead.bytes -= bytes;
        if let Some(handle) = ahead.handles.get_mut(&fh) {
            handle.unanswered -= 1;
            if handle.refused.is_none() {
                handle.refused = refusal;
            }
            if handle.released && handle.unanswered == 0 {
                ahead.handles.remove(&fh);
            }
        }
        self.answered.notify_all();
        true
    }

    /// Send `op` with `args` and `body`, and wait for its reply; a reply
    /// later than the link's wait finds no one waiting and is dropped. A
    /// timeout that loses the race to `serve`, which already took the
    /// waiter, takes the reply it hands over, so exactly one side owns it.
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
        let reply = match rx.recv_timeout(self.wait) {
            Ok(reply) => reply,
            Err(RecvTimeoutError::Timeout) => {
                let mine = locked(&self.pending)
                    .as_mut()
                    .and_then(|p| p.remove(&id))
                    .is_some();
                if mine {
                    return Err(Failure::Late);
                }
                rx.recv().map_err(|_| Failure::Lost)?
            }
            Err(RecvTimeoutError::Disconnected) => return Err(Failure::Lost),
        };
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
    /// waiting for it or sent ahead, any other frame to `push`. A reply no
    /// request waits for any more that opened a host handle has it
    /// released, as no one else will. Every request still waiting then
    /// fails as lost, and every one sent ahead fails its handle so.
    pub fn serve(&self, input: &mut impl Read, mut push: impl FnMut(Frame)) -> io::Result<()> {
        let ended = loop {
            match read_frame(input) {
                Ok(Some(frame)) => match frame.u64("id") {
                    Some(id) => {
                        let waiter = locked(&self.pending).as_mut().and_then(|p| p.remove(&id));
                        match waiter {
                            Some(waiter) => {
                                let _ = waiter.send(frame);
                            }
                            None => {
                                let refusal =
                                    frame.str("errno").map(|c| Failure::Refused(c.to_string()));
                                if !self.answer_ahead(id, refusal)
                                    && let Some(fh) = frame.u64("fh")
                                {
                                    self.post("release", serde_json::json!({ "fh": fh }));
                                }
                            }
                        }
                    }
                    None => push(frame),
                },
                Ok(None) => break Ok(()),
                Err(err) => break Err(err),
            }
        };
        locked(&self.pending).take();
        let mut ahead = locked(&self.ahead);
        ahead.ended = true;
        let sent: Vec<u64> = ahead.sent.drain().map(|(_, (fh, _))| fh).collect();
        ahead.bytes = 0;
        for fh in sent {
            if let Some(handle) = ahead.handles.get_mut(&fh) {
                handle.unanswered = 0;
                handle.refused.get_or_insert(Failure::Lost);
            }
        }
        ahead.handles.retain(|_, h| !h.released);
        self.answered.notify_all();
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
    fn a_reply_later_than_the_wait_fails_its_request_and_goes_nowhere() {
        let link = Link::waiting(Box::new(io::sink()), Duration::from_millis(20));
        assert!(matches!(
            link.call("statfs", json!({}), &[]),
            Err(Failure::Late)
        ));
        assert!(locked(&link.pending).as_ref().is_some_and(|p| p.is_empty()));
        let input = frame(json!({"id": 1}), b"");
        let mut pushed = 0;
        link.serve(&mut input.as_slice(), |_| pushed += 1).unwrap();
        assert_eq!(pushed, 0);
    }

    #[derive(Clone, Default)]
    struct Kept(Arc<Mutex<Vec<u8>>>);

    impl Write for Kept {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            locked(&self.0).extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn a_late_reply_that_opened_a_handle_has_it_released() {
        let out = Kept::default();
        let link = Link::waiting(Box::new(out.clone()), Duration::from_millis(20));
        assert!(matches!(
            link.call("open", json!({"path": "/w/a"}), &[]),
            Err(Failure::Late)
        ));
        let input = frame(json!({"id": 1, "fh": 7, "k": true}), b"");
        link.serve(&mut input.as_slice(), |_| {}).unwrap();
        let sent = locked(&out.0).clone();
        let mut frames = sent.as_slice();
        let open = crate::proto::read_frame(&mut frames).unwrap().unwrap();
        let release = crate::proto::read_frame(&mut frames).unwrap().unwrap();
        assert_eq!(open.str("op"), Some("open"));
        assert_eq!(
            (release.str("op"), release.u64("fh")),
            (Some("release"), Some(7))
        );
    }

    /// The host's end of a pipe `link` serves on a thread of its own,
    /// open until the test drops it.
    fn served(link: &Arc<Link>) -> std::os::unix::net::UnixStream {
        let (replies, mut input) = std::os::unix::net::UnixStream::pair().unwrap();
        let link = link.clone();
        std::thread::spawn(move || link.serve(&mut input, |_| {}));
        replies
    }

    /// Run `f` on a thread of its own and hand back its result, or None
    /// when it has not returned within `within`.
    fn returns_within<T: Send + 'static>(
        within: Duration,
        f: impl FnOnce() -> T + Send + 'static,
    ) -> (std::sync::mpsc::Receiver<T>, Option<T>) {
        let (tx, rx) = channel();
        std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        let got = rx.recv_timeout(within).ok();
        (rx, got)
    }

    #[test]
    fn a_write_sent_ahead_returns_at_once_and_its_settle_waits_for_the_reply() {
        let link = Arc::new(Link::new(Box::new(io::sink())));
        assert!(
            link.send_ahead(7, "write", json!({"fh": 7, "offset": 0}), b"hi")
                .is_ok()
        );
        let settling = {
            let link = link.clone();
            returns_within(Duration::from_millis(50), move || link.settle(7))
        };
        assert!(settling.1.is_none());
        let input = frame(json!({"id": 1}), b"");
        link.serve(&mut input.as_slice(), |_| {}).unwrap();
        assert!(settling.0.recv().unwrap().is_ok());
        assert!(locked(&link.ahead).handles.is_empty());
    }

    #[test]
    fn a_settle_waits_only_for_the_writes_sent_before_it() {
        let link = Arc::new(Link::new(Box::new(io::sink())));
        link.send_ahead(7, "write", json!({}), b"a").unwrap();
        let settling = {
            let link = link.clone();
            returns_within(Duration::from_millis(50), move || link.settle(7))
        };
        assert!(settling.1.is_none());
        link.send_ahead(7, "write", json!({}), b"b").unwrap();
        let mut replies = served(&link);
        replies.write_all(&frame(json!({"id": 1}), b"")).unwrap();
        assert!(settling.0.recv().unwrap().is_ok());
        assert_eq!(locked(&link.ahead).handles[&7].unanswered, 1);
    }

    #[test]
    fn a_refused_write_fails_the_settle_once_and_the_writes_after_it() {
        let link = Arc::new(Link::new(Box::new(io::sink())));
        link.send_ahead(7, "write", json!({"fh": 7, "offset": 0}), b"a")
            .unwrap();
        let mut replies = served(&link);
        replies
            .write_all(&frame(json!({"id": 1, "errno": "ENOSPC"}), b""))
            .unwrap();
        while !locked(&link.ahead).sent.is_empty() {
            std::thread::yield_now();
        }
        assert!(matches!(
            link.send_ahead(7, "write", json!({"fh": 7, "offset": 1}), b"b"),
            Err(Failure::Refused(c)) if c == "ENOSPC"
        ));
        assert!(matches!(link.settle(7), Err(Failure::Refused(c)) if c == "ENOSPC"));
        assert!(link.settle(7).is_ok());
    }

    #[test]
    fn writes_ahead_wait_once_the_bytes_in_flight_fill_the_window() {
        let link = Arc::new(Link::new(Box::new(io::sink())));
        link.send_ahead(7, "write", json!({}), &vec![0; AHEAD_BYTES])
            .unwrap();
        let next = {
            let link = link.clone();
            returns_within(Duration::from_millis(50), move || {
                link.send_ahead(7, "write", json!({}), b"x")
            })
        };
        assert!(next.1.is_none());
        let mut replies = served(&link);
        replies.write_all(&frame(json!({"id": 1}), b"")).unwrap();
        assert!(next.0.recv().unwrap().is_ok());
    }

    #[test]
    fn writes_ahead_fail_their_handle_as_lost_when_the_pipe_ends() {
        let link = Link::new(Box::new(io::sink()));
        link.send_ahead(7, "write", json!({}), b"a").unwrap();
        link.serve(&mut [].as_slice(), |_| {}).unwrap();
        assert!(matches!(link.settle(7), Err(Failure::Lost)));
        assert!(matches!(
            link.send_ahead(7, "write", json!({}), b"b"),
            Err(Failure::Lost)
        ));
    }

    #[test]
    fn a_released_handle_is_forgotten_once_its_last_reply_comes() {
        let link = Link::new(Box::new(io::sink()));
        link.send_ahead(7, "write", json!({}), b"a").unwrap();
        link.released(7);
        assert!(locked(&link.ahead).handles.contains_key(&7));
        let input = frame(json!({"id": 1, "errno": "EIO"}), b"");
        link.serve(&mut input.as_slice(), |_| {}).unwrap();
        assert!(locked(&link.ahead).handles.is_empty());
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
