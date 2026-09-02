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

use nfsserve::nfs::nfsstat3;
use pyo3::call::PyCallArgs;
use pyo3::prelude::*;
use pyo3::types::PyModule;

/// The delegate half of the adapter: a Python object whose async
/// methods this module schedules onto the workspace event loop.
///
/// Every call crosses on primitives (u64, str, bytes) and returns
/// primitives or duck-typed attr objects; all filesystem intelligence
/// stays in Python where it is unit-testable without a mount. The
/// pattern is the one the bridge spike measured at ~59us per call:
/// `run_coroutine_threadsafe` from a tokio blocking thread, then
/// `Future.result()`, whose condition-variable wait releases the GIL
/// so the loop thread is free to run the coroutine.
pub struct Delegate {
    obj: Py<PyAny>,
    event_loop: Py<PyAny>,
}

impl Delegate {
    pub fn new(obj: Py<PyAny>, event_loop: Py<PyAny>) -> Self {
        Self { obj, event_loop }
    }

    pub fn clone_ref(&self) -> Self {
        Python::with_gil(|py| Self {
            obj: self.obj.clone_ref(py),
            event_loop: self.event_loop.clone_ref(py),
        })
    }

    /// Await one delegate coroutine from a non-loop thread.
    ///
    /// Runs on tokio's blocking pool: the wait parks a thread, never a
    /// runtime worker, and the loop stays free to serve other calls.
    pub async fn call(
        &self,
        method: &'static str,
        args: impl for<'py> PyCallArgs<'py> + Send + 'static,
    ) -> Result<Py<PyAny>, nfsstat3> {
        let me = self.clone_ref();
        tokio::task::spawn_blocking(move || me.call_blocking(method, args))
            .await
            .map_err(|_| nfsstat3::NFS3ERR_SERVERFAULT)?
    }

    fn call_blocking(
        &self,
        method: &'static str,
        args: impl for<'py> PyCallArgs<'py>,
    ) -> Result<Py<PyAny>, nfsstat3> {
        let scheduled: Result<Py<PyAny>, PyErr> = Python::with_gil(|py| {
            let coro = self.obj.bind(py).call_method1(method, args)?;
            let asyncio = PyModule::import(py, "asyncio")?;
            let fut = asyncio.call_method1(
                "run_coroutine_threadsafe",
                (coro, self.event_loop.bind(py)),
            )?;
            Ok(fut.unbind())
        });
        let fut = scheduled.map_err(|err| Python::with_gil(|py| to_status(py, err)))?;
        Python::with_gil(|py| {
            // Future.result waits on a Condition, which releases the
            // GIL, so holding it here cannot starve the loop.
            match fut.call_method1(py, "result", (30.0,)) {
                Ok(value) => Ok(value),
                Err(err) => Err(to_status(py, err)),
            }
        })
    }
}

/// Map a Python exception onto the NFS status the wire answers with.
///
/// `StaleHandleError` answers STALE directly -- staleness is not a
/// POSIX condition and carries no errno. Everything else goes through
/// ``mirage.mount.errors.classify_error``, the shared table every
/// kernel adapter uses, so a mirage exception is named once in one
/// place: it classifies typed exceptions (FileNotFoundError and kin)
/// as well as errno-carrying OSErrors. Anything it cannot name is a
/// server fault rather than a lie about the file.
fn to_status(py: Python<'_>, err: PyErr) -> nfsstat3 {
    let name = err.get_type(py).name().map(|n| n.to_string());
    if matches!(name.as_deref(), Ok("StaleHandleError")) {
        return nfsstat3::NFS3ERR_STALE;
    }
    let classified: Option<i32> = PyModule::import(py, "mirage.mount.errors")
        .and_then(|m| m.call_method1("classify_error", (err.value(py),)))
        .and_then(|v| v.extract::<i32>())
        .ok();
    match classified {
        Some(libc_errno) => errno_to_status(libc_errno),
        None => nfsstat3::NFS3ERR_SERVERFAULT,
    }
}

fn errno_to_status(errno: i32) -> nfsstat3 {
    match errno {
        1 => nfsstat3::NFS3ERR_PERM,          // EPERM
        2 => nfsstat3::NFS3ERR_NOENT,         // ENOENT
        5 => nfsstat3::NFS3ERR_IO,            // EIO
        13 => nfsstat3::NFS3ERR_ACCES,        // EACCES
        17 => nfsstat3::NFS3ERR_EXIST,        // EEXIST
        20 => nfsstat3::NFS3ERR_NOTDIR,       // ENOTDIR
        21 => nfsstat3::NFS3ERR_ISDIR,        // EISDIR
        22 => nfsstat3::NFS3ERR_INVAL,        // EINVAL
        27 => nfsstat3::NFS3ERR_FBIG,         // EFBIG
        28 => nfsstat3::NFS3ERR_NOSPC,        // ENOSPC
        30 => nfsstat3::NFS3ERR_ROFS,         // EROFS
        63 => nfsstat3::NFS3ERR_NAMETOOLONG,  // ENAMETOOLONG (darwin)
        36 => nfsstat3::NFS3ERR_NAMETOOLONG,  // ENAMETOOLONG (linux)
        66 => nfsstat3::NFS3ERR_NOTEMPTY,     // ENOTEMPTY (darwin)
        39 => nfsstat3::NFS3ERR_NOTEMPTY,     // ENOTEMPTY (linux)
        _ => nfsstat3::NFS3ERR_IO,
    }
}
