use pyo3::create_exception;
use pyo3::exceptions::PyException;
use pyo3::prelude::*;
use pyo3::types::PyBytes;

create_exception!(mirage_rs, StreamError, PyException);

/// One open stream: `feed` takes a chunk and returns the bytes it produced;
/// a refusal raises `StreamError(message, output)` with the output written
/// before it.
#[pyclass(unsendable, module = "mirage_rs")]
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
}

#[pymodule]
fn mirage_rs(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<Stream>()?;
    m.add("StreamError", m.py().get_type::<StreamError>())?;
    Ok(())
}
