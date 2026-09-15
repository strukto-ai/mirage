// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

mod bridge;
mod vfs;

use std::time::Duration;

use nfsserve::tcp::{NFSTcp, NFSTcpListener};
use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;

use bridge::Delegate;
use vfs::MirageVFS;

/// A running NFS server: the tokio runtime lives here, inside the
/// extension, invisible to Python -- mirage code spawns no threads.
/// Dropping the runtime (stop) aborts the accept loop and the idle
/// flusher.
#[pyclass]
struct NFSServerHandle {
    runtime: Option<tokio::runtime::Runtime>,
    port: u16,
}

#[pymethods]
impl NFSServerHandle {
    /// The TCP port actually bound, which is the requested one or the
    /// OS's choice when 0 was asked for.
    fn port(&self) -> u16 {
        self.port
    }

    /// Stop serving. The caller flushes buffered writes before this
    /// (NFSManager.close does: unmount, flush_all, stop), so aborting
    /// in-flight tasks cannot lose acknowledged bytes.
    fn stop(&mut self, py: Python<'_>) {
        if let Some(runtime) = self.runtime.take() {
            py.allow_threads(|| runtime.shutdown_timeout(Duration::from_secs(5)));
        }
    }
}

/// Start the NFSv3 server for one delegate.
///
/// Binds host:port (port 0 asks the OS), spawns the accept loop and an
/// idle flusher that calls ``delegate.flush_idle()`` every
/// ``idle_seconds``, and returns a handle carrying the bound port.
/// Every delegate callback is scheduled onto ``event_loop``; the
/// caller therefore must keep that loop running, and code on that loop
/// must never touch the mountpoint synchronously -- the request it
/// blocks is the one it must answer.
#[pyfunction]
#[pyo3(signature = (delegate, event_loop, host, port, root_id, uid, gid, idle_seconds))]
#[allow(clippy::too_many_arguments)]
fn start(
    py: Python<'_>,
    delegate: Py<PyAny>,
    event_loop: Py<PyAny>,
    host: String,
    port: u16,
    root_id: u64,
    uid: u32,
    gid: u32,
    idle_seconds: f64,
) -> PyResult<NFSServerHandle> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("MIRAGE_NFS_LOG")
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .with_writer(std::io::stderr)
        .try_init();
    let flusher = Delegate::new(
        Python::with_gil(|py| delegate.clone_ref(py)),
        Python::with_gil(|py| event_loop.clone_ref(py)),
    );
    let vfs = MirageVFS::new(Delegate::new(delegate, event_loop), root_id, uid, gid);
    py.allow_threads(|| {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .map_err(|e| PyRuntimeError::new_err(e.to_string()))?;
        let listener = runtime
            .block_on(NFSTcpListener::bind(&format!("{host}:{port}"), vfs))
            .map_err(|e| PyRuntimeError::new_err(format!("nfs bind failed: {e}")))?;
        let bound = listener.get_listen_port();
        runtime.spawn(async move {
            let _ = listener.handle_forever().await;
        });
        runtime.spawn(async move {
            let period = Duration::from_secs_f64(idle_seconds.max(0.5));
            loop {
                tokio::time::sleep(period).await;
                let _ = flusher.call("flush_idle", ()).await;
            }
        });
        Ok(NFSServerHandle {
            runtime: Some(runtime),
            port: bound,
        })
    })
}

#[pymodule]
fn mirage_nfs(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<NFSServerHandle>()?;
    m.add_function(wrap_pyfunction!(start, m)?)?;
    Ok(())
}
