macro_rules! debug {
    ($($arg:tt)*) => {
        if false {
            let _ = format_args!($($arg)*);
        }
    };
}
macro_rules! trace {
    ($($arg:tt)*) => {
        if false {
            let _ = format_args!($($arg)*);
        }
    };
}
macro_rules! warn {
    ($($arg:tt)*) => {
        if false {
            let _ = format_args!($($arg)*);
        }
    };
}
macro_rules! error {
    ($($arg:tt)*) => {
        if false {
            let _ = format_args!($($arg)*);
        }
    };
}

mod context;
mod host;
mod mount;
mod mount_handlers;
#[allow(clippy::module_inception)]
mod nfs;
mod nfs_handlers;
mod portmap;
mod portmap_handlers;
mod rpc;
mod rpcwire;
mod transaction_tracker;
mod vfs;
mod write_counter;
mod xdr;

use std::collections::HashMap;
use std::future::Future;
use std::io::Cursor;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use serde::Deserialize;

use crate::StreamError;
use context::RPCContext;
use host::{HostFs, Shared, lock};
use transaction_tracker::TransactionTracker;

/// The largest record a client may send: a WRITE of `wtmax` bytes plus
/// its call header.
const MAX_RECORD: usize = 4 * 1024 * 1024;

type Task = Pin<Box<dyn Future<Output = Option<Vec<u8>>> + Send + Sync>>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    export: String,
    generation: u64,
    port: u16,
}

#[derive(Default)]
struct Connection {
    pending: Vec<u8>,
    record: Vec<u8>,
}

/// An NFSv3 server with no I/O of its own. The host feeds it the bytes
/// each client connection sends and writes back the bytes it answers;
/// the file operations a call needs come out of `requests` for the host
/// to run, and each result goes back through `complete`, which resumes
/// the call that asked for it.
pub struct Server {
    shared: Arc<Mutex<Shared>>,
    context: RPCContext,
    connections: HashMap<u32, Connection>,
    tasks: HashMap<u64, (u32, Task)>,
    next_task: u64,
}

impl Server {
    /// Open a server from its JSON config: the export path a client
    /// mounts, the generation stamped into every file handle (a handle
    /// from another generation is stale), and the port it listens on.
    pub fn new(config: &[u8]) -> Result<Self, StreamError> {
        let config: Config = serde_json::from_slice(config)
            .map_err(|err| StreamError::new(format!("bad nfs config: {err}")))?;
        let shared = Arc::new(Mutex::new(Shared::default()));
        let context = RPCContext {
            local_port: config.port,
            client_addr: String::new(),
            vfs: Arc::new(HostFs::new(shared.clone(), config.generation)),
            export_name: Arc::new(config.export),
            transaction_tracker: Arc::new(TransactionTracker::default()),
        };
        Ok(Self {
            shared,
            context,
            connections: HashMap::new(),
            tasks: HashMap::new(),
            next_task: 0,
        })
    }

    /// Take the bytes connection `conn` sent and append to `out` the
    /// replies they answer at once; the rest wait on `requests`.
    pub fn feed(&mut self, conn: u32, data: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let connection = self.connections.entry(conn).or_default();
        connection.pending.extend_from_slice(data);
        let mut records = Vec::new();
        let mut at = 0;
        while connection.pending.len() - at >= 4 {
            let header = u32::from_be_bytes([
                connection.pending[at],
                connection.pending[at + 1],
                connection.pending[at + 2],
                connection.pending[at + 3],
            ]);
            let len = (header & 0x7fff_ffff) as usize;
            if connection.record.len() + len > MAX_RECORD {
                self.close(conn);
                return Err(StreamError::new("nfs record too large"));
            }
            let start = at + 4;
            if connection.pending.len() - start < len {
                break;
            }
            connection
                .record
                .extend_from_slice(&connection.pending[start..start + len]);
            at = start + len;
            if header & 0x8000_0000 != 0 {
                records.push(std::mem::take(&mut connection.record));
            }
        }
        connection.pending.drain(..at);
        for record in records {
            self.spawn(conn, record, out);
        }
        Ok(())
    }

    /// Append to `out`, as a JSON array, the file operations calls are
    /// waiting on that the host has not been asked for yet.
    pub fn requests(&mut self, out: &mut Vec<u8>) {
        let requests = lock(&self.shared).take_requests();
        serde_json::to_writer(out, &requests).expect("requests serialize");
    }

    /// Hand back the result of request `id`: its JSON reply and, for a
    /// read, the bytes read. Appends the call's reply to `out` once it
    /// has one and returns its connection, or `None` when that
    /// connection has closed.
    pub fn complete(
        &mut self,
        id: u32,
        reply: &[u8],
        data: &[u8],
        out: &mut Vec<u8>,
    ) -> Result<Option<u32>, StreamError> {
        let task = lock(&self.shared).complete(id, reply, data)?;
        Ok(task.and_then(|task| self.poll(task, out)))
    }

    /// Forget connection `conn` and the calls it has out.
    pub fn close(&mut self, conn: u32) {
        self.connections.remove(&conn);
        self.tasks.retain(|_, (owner, _)| *owner != conn);
        let tasks = &self.tasks;
        lock(&self.shared).forget(|task| !tasks.contains_key(&task));
    }

    fn spawn(&mut self, conn: u32, record: Vec<u8>, out: &mut Vec<u8>) {
        let mut context = self.context.clone();
        context.client_addr = conn.to_string();
        let task: Task = Box::pin(async move {
            let mut output = Vec::new();
            match rpcwire::handle_rpc(&mut Cursor::new(record), &mut output, context).await {
                Ok(true) => Some(output),
                Ok(false) | Err(_) => None,
            }
        });
        self.next_task += 1;
        self.tasks.insert(self.next_task, (conn, task));
        self.poll(self.next_task, out);
    }

    fn poll(&mut self, id: u64, out: &mut Vec<u8>) -> Option<u32> {
        let (conn, task) = self.tasks.get_mut(&id)?;
        let conn = *conn;
        lock(&self.shared).current = id;
        let mut cx = Context::from_waker(Waker::noop());
        if let Poll::Ready(reply) = task.as_mut().poll(&mut cx) {
            self.tasks.remove(&id);
            if let Some(reply) = reply {
                out.extend_from_slice(&(reply.len() as u32 | 0x8000_0000).to_be_bytes());
                out.extend_from_slice(&reply);
            }
        }
        Some(conn)
    }
}

#[cfg(test)]
mod tests;
