use pyo3::create_exception;
use pyo3::exceptions::PyException;
use pyo3::prelude::*;
use pyo3::types::PyBytes;

create_exception!(mirage_rs, StreamError, PyException);

/// One open stream: `feed` takes a chunk and returns the bytes it produced;
/// a refusal raises `StreamError(message, output)` with the output written
/// before it.
#[pyclass(module = "mirage_rs")]
struct Stream {
    inner: Box<dyn streams::Stream>,
    out: Vec<u8>,
}

impl Stream {
    fn deliver<'py>(
        &mut self,
        py: Python<'py>,
        result: Result<(), streams::StreamError>,
    ) -> PyResult<Bound<'py, PyBytes>> {
        let output = PyBytes::new(py, &self.out);
        self.out.clear();
        match result {
            Ok(()) => Ok(output),
            Err(err) => Err(StreamError::new_err((err.message, output.unbind()))),
        }
    }
}

#[pymethods]
impl Stream {
    #[new]
    fn new(kind: &str, config: &[u8]) -> PyResult<Self> {
        let inner =
            streams::open(kind, config).map_err(|err| StreamError::new_err((err.message,)))?;
        Ok(Self {
            inner,
            out: Vec::new(),
        })
    }

    fn feed<'py>(&mut self, py: Python<'py>, data: &[u8]) -> PyResult<Bound<'py, PyBytes>> {
        let result = self.inner.feed(data, &mut self.out);
        self.deliver(py, result)
    }

    fn finish<'py>(&mut self, py: Python<'py>) -> PyResult<Bound<'py, PyBytes>> {
        let result = self.inner.finish(&mut self.out);
        self.deliver(py, result)
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
        let result = self.inner.feed_input(index, data, &mut self.out);
        self.deliver(py, result)
    }

    /// Whether `drain` has work or output left.
    fn busy(&self) -> bool {
        self.inner.busy()
    }

    /// One bounded step of the work `busy` reports, and its output.
    fn drain<'py>(&mut self, py: Python<'py>) -> PyResult<Bound<'py, PyBytes>> {
        let result = self.inner.drain(&mut self.out);
        self.deliver(py, result)
    }

    fn end_input<'py>(&mut self, py: Python<'py>, index: usize) -> PyResult<Bound<'py, PyBytes>> {
        let result = self.inner.end_input(index, &mut self.out);
        self.deliver(py, result)
    }

    /// Start the next input of a stream that reads one after another.
    fn begin(&mut self, py: Python<'_>, config: &[u8]) -> PyResult<()> {
        self.inner
            .begin(config)
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

    /// What the stream wrote to stderr since the last call.
    fn take_stderr<'py>(&mut self, py: Python<'py>) -> Bound<'py, PyBytes> {
        let mut err = Vec::new();
        self.inner.take_stderr(&mut err);
        PyBytes::new(py, &err)
    }
}

#[pymodule]
fn mirage_rs(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<Stream>()?;
    m.add("StreamError", m.py().get_type::<StreamError>())?;
    Ok(())
}
