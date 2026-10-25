//! A stream written as one async function over its host: each request the
//! function awaits goes to the host through `request`, the host's answer
//! resumes it at that `await`, and a `pause` hands the host the output so
//! far, so a run that waits on its host at many points reads as straight
//! code. Nothing runs between polls; the host's yield between `drain`s is
//! the only scheduling there is.

use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll, Waker};

use crate::request::{Reply, Request};
use crate::{Stream, StreamError};

#[derive(Default)]
struct Slot {
    asked: Option<Request>,
    waiting: bool,
    reply: Option<(Reply, Vec<u8>)>,
    out: Vec<u8>,
    err: Vec<u8>,
}

/// The task's side of its host: the requests it awaits and what it writes.
#[derive(Clone, Default)]
pub(crate) struct Host(Arc<Mutex<Slot>>);

impl Host {
    fn slot(&self) -> MutexGuard<'_, Slot> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Ask the host, and wait for its answer and the bytes it carries.
    pub(crate) async fn ask(&self, request: Request) -> (Reply, Vec<u8>) {
        let mut request = Some(request);
        poll_fn(|_| {
            let mut slot = self.slot();
            if let Some(request) = request.take() {
                slot.asked = Some(request);
                return Poll::Pending;
            }
            slot.reply.take().map_or(Poll::Pending, Poll::Ready)
        })
        .await
    }

    /// Hand the host the output so far before going on.
    pub(crate) async fn pause(&self) {
        let mut paused = false;
        poll_fn(|_| {
            if std::mem::replace(&mut paused, true) {
                Poll::Ready(())
            } else {
                Poll::Pending
            }
        })
        .await;
    }

    pub(crate) fn print(&self, data: &[u8]) {
        self.slot().out.extend_from_slice(data);
    }

    pub(crate) fn warn(&self, data: &[u8]) {
        self.slot().err.extend_from_slice(data);
    }
}

struct Task {
    run: Mutex<Pin<Box<dyn Future<Output = i32> + Send>>>,
    host: Host,
    status: Option<i32>,
}

/// The stream that runs `run` to its exit status.
pub(crate) fn spawn<F>(run: impl FnOnce(Host) -> F) -> Box<dyn Stream>
where
    F: Future<Output = i32> + Send + 'static,
{
    let host = Host::default();
    let run: Pin<Box<dyn Future<Output = i32> + Send>> = Box::pin(run(host.clone()));
    Box::new(Task {
        run: Mutex::new(run),
        host,
        status: None,
    })
}

impl Stream for Task {
    fn feed(&mut self, _input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("this stream reads through requests"))
    }

    fn finish(&mut self, _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Ok(())
    }

    fn busy(&self) -> bool {
        let slot = self.host.slot();
        self.status.is_none() && slot.asked.is_none() && !slot.waiting
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.busy() {
            let run = self.run.get_mut().unwrap_or_else(PoisonError::into_inner);
            if let Poll::Ready(status) = run.as_mut().poll(&mut Context::from_waker(Waker::noop()))
            {
                self.status = Some(status);
            }
        }
        out.append(&mut self.host.slot().out);
        Ok(())
    }

    fn status(&self) -> i32 {
        self.status.unwrap_or(0)
    }

    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        err.append(&mut self.host.slot().err);
    }

    fn request(&mut self, data: &mut Vec<u8>) -> Option<Vec<u8>> {
        let mut slot = self.host.slot();
        let mut request = slot.asked.take()?;
        slot.waiting = true;
        Some(request.encode(data))
    }

    fn respond(&mut self, reply: &[u8], data: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        let reply = Reply::decode(reply).map_err(StreamError::new)?;
        let mut slot = self.host.slot();
        if !std::mem::replace(&mut slot.waiting, false) {
            return Err(StreamError::new("no request is waiting"));
        }
        slot.reply = Some((reply, data.to_vec()));
        Ok(())
    }
}
