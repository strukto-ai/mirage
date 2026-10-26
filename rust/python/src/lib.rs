mod shell;

use pyo3::create_exception;
use pyo3::exceptions::PyException;
use pyo3::prelude::*;
use pyo3::types::PyBytes;

create_exception!(mirage._rs, StreamError, PyException);

/// One open stream: `feed` takes a chunk and returns the bytes it produced;
/// a refusal raises `StreamError(message, output)` with the output written
/// before it. Opening a stream and each step of its work run with the GIL
/// released, so a stream working on one thread never stalls Python on
/// another (a workspace's loop beside the server's).
#[pyclass(module = "mirage._rs")]
struct Stream {
    inner: Box<dyn streams::Stream>,
    out: Vec<u8>,
}

impl Stream {
    /// Run one step of the stream's work with the GIL released and hand
    /// back what it wrote.
    fn step<'py>(
        &mut self,
        py: Python<'py>,
        work: impl Send
        + FnOnce(&mut dyn streams::Stream, &mut Vec<u8>) -> Result<(), streams::StreamError>,
    ) -> PyResult<Bound<'py, PyBytes>> {
        let Self { inner, out } = self;
        let result = py.detach(|| work(inner.as_mut(), out));
        let output = PyBytes::new(py, out);
        out.clear();
        match result {
            Ok(()) => Ok(output),
            Err(err) => Err(StreamError::new_err((err.message, output.unbind()))),
        }
    }
}

#[pymethods]
impl Stream {
    #[new]
    fn new(py: Python<'_>, kind: &str, config: &[u8]) -> PyResult<Self> {
        let inner = py
            .detach(|| streams::open(kind, config))
            .map_err(|err| StreamError::new_err((err.message,)))?;
        Ok(Self {
            inner,
            out: Vec::new(),
        })
    }

    fn feed<'py>(&mut self, py: Python<'py>, data: &[u8]) -> PyResult<Bound<'py, PyBytes>> {
        self.step(py, |stream, out| stream.feed(data, out))
    }

    fn finish<'py>(&mut self, py: Python<'py>) -> PyResult<Bound<'py, PyBytes>> {
        self.step(py, |stream, out| stream.finish(out))
    }

    /// The input a multi-input stream needs next, or `None` when it can go
    /// on without more.
    fn wants(&self) -> Option<usize> {
        self.inner.wants()
    }

    fn feed_input<'py>(
        &mut self,
        py: Python<'py>,
        index: usize,
        data: &[u8],
    ) -> PyResult<Bound<'py, PyBytes>> {
        self.step(py, |stream, out| stream.feed_input(index, data, out))
    }

    /// Whether `drain` has work or output left.
    fn busy(&self) -> bool {
        self.inner.busy()
    }

    fn cancel(&mut self) -> bool {
        self.inner.cancel()
    }

    /// Bounded steps of the work `busy` reports, up to a piece of output
    /// (`streams::drain_steps`), and that output.
    fn drain<'py>(&mut self, py: Python<'py>) -> PyResult<Bound<'py, PyBytes>> {
        self.step(py, |stream, out| streams::drain_steps(stream, out))
    }

    fn end_input<'py>(&mut self, py: Python<'py>, index: usize) -> PyResult<Bound<'py, PyBytes>> {
        self.step(py, |stream, out| stream.end_input(index, out))
    }

    /// Start the next input of a stream that reads one after another.
    fn begin(&mut self, py: Python<'_>, config: &[u8]) -> PyResult<()> {
        self.inner
            .begin(config)
            .map_err(|err| StreamError::new_err((err.message, PyBytes::new(py, b"").unbind())))
    }

    /// Whether the input fed since the last answer, then `data`, passes the
    /// stream's test, in one call; the next input starts empty.
    fn test(&mut self, py: Python<'_>, data: &[u8]) -> PyResult<bool> {
        let inner = &mut self.inner;
        py.detach(|| inner.test(data))
            .map_err(|err| StreamError::new_err((err.message, PyBytes::new(py, b"").unbind())))
    }

    /// Whether the stream wants no more of the current input.
    fn done(&self) -> bool {
        self.inner.done()
    }

    /// The command's exit status for the input so far.
    fn status(&self) -> i32 {
        self.inner.status()
    }

    /// The stream's current progress, encoded as its typed JSON record.
    fn metadata<'py>(&self, py: Python<'py>) -> Bound<'py, PyBytes> {
        let mut out = Vec::new();
        self.inner.metadata(&mut out);
        PyBytes::new(py, &out)
    }

    /// What the stream wrote to stderr since the last call.
    fn take_stderr<'py>(&mut self, py: Python<'py>) -> Bound<'py, PyBytes> {
        let mut err = Vec::new();
        self.inner.take_stderr(&mut err);
        PyBytes::new(py, &err)
    }

    /// The host operation the stream waits on, as its JSON header and the
    /// bytes it carries, or None while it waits on none.
    fn request<'py>(
        &mut self,
        py: Python<'py>,
    ) -> Option<(Bound<'py, PyBytes>, Bound<'py, PyBytes>)> {
        let mut data = Vec::new();
        let header = self.inner.request(&mut data)?;
        Some((PyBytes::new(py, &header), PyBytes::new(py, &data)))
    }

    /// Answer the request taken last with a JSON reply and its bytes.
    fn respond<'py>(
        &mut self,
        py: Python<'py>,
        reply: &[u8],
        data: &[u8],
    ) -> PyResult<Bound<'py, PyBytes>> {
        self.step(py, |stream, out| stream.respond(reply, data, out))
    }
}

/// An NFSv3 server with no I/O of its own: the host feeds it each
/// connection's bytes, runs the file operations `requests` names, and
/// hands each result back through `complete`.
#[pyclass(module = "mirage._rs")]
struct NFSServer {
    inner: streams::nfs::Server,
}

#[pymethods]
impl NFSServer {
    #[new]
    fn new(config: &[u8]) -> PyResult<Self> {
        let inner = streams::nfs::Server::new(config)
            .map_err(|err| StreamError::new_err((err.message,)))?;
        Ok(Self { inner })
    }

    /// Take what connection `conn` sent; returns the replies it answers
    /// at once.
    fn feed<'py>(
        &mut self,
        py: Python<'py>,
        conn: u32,
        data: &[u8],
    ) -> PyResult<Bound<'py, PyBytes>> {
        let mut out = Vec::new();
        self.inner
            .feed(conn, data, &mut out)
            .map_err(|err| StreamError::new_err((err.message,)))?;
        Ok(PyBytes::new(py, &out))
    }

    /// The file operations calls wait on, as a JSON array.
    fn requests<'py>(&mut self, py: Python<'py>) -> Bound<'py, PyBytes> {
        let mut out = Vec::new();
        self.inner.requests(&mut out);
        PyBytes::new(py, &out)
    }

    /// Hand back request `id`'s JSON reply and data; returns the call's
    /// connection (None once it has closed) and its reply once it has one.
    fn complete<'py>(
        &mut self,
        py: Python<'py>,
        id: u32,
        reply: &[u8],
        data: &[u8],
    ) -> PyResult<(Option<u32>, Bound<'py, PyBytes>)> {
        let mut out = Vec::new();
        let conn = self
            .inner
            .complete(id, reply, data, &mut out)
            .map_err(|err| StreamError::new_err((err.message,)))?;
        Ok((conn, PyBytes::new(py, &out)))
    }

    /// Forget connection `conn` and the calls it has out.
    fn close(&mut self, conn: u32) {
        self.inner.close(conn);
    }
}

#[pymodule]
#[pyo3(name = "_rs")]
fn mirage_rs(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<Stream>()?;
    m.add_class::<NFSServer>()?;
    m.add_class::<shell::ShellTree>()?;
    m.add_class::<shell::ShellNode>()?;
    m.add("StreamError", m.py().get_type::<StreamError>())?;
    Ok(())
}
