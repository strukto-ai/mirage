use pyo3::prelude::*;
use pyo3::types::{PyBytes, PyString};

/// Shell text as bytes: UTF-8, a lone surrogate standing for the byte it
/// escapes.
pub(crate) fn bytes_of(value: &Bound<'_, PyAny>) -> PyResult<Vec<u8>> {
    let text = match value.cast::<PyString>() {
        Ok(text) => text.clone(),
        Err(_) => value.str()?,
    };
    match text.to_str() {
        Ok(text) => Ok(text.as_bytes().to_vec()),
        Err(_) => text
            .call_method1("encode", ("utf-8", "surrogateescape"))?
            .extract(),
    }
}

/// Bytes as shell text, the inverse of `bytes_of`.
pub(crate) fn text_of<'py>(py: Python<'py>, bytes: &[u8]) -> PyResult<Bound<'py, PyAny>> {
    match std::str::from_utf8(bytes) {
        Ok(text) => Ok(PyString::new(py, text).into_any()),
        Err(_) => PyBytes::new(py, bytes).call_method1("decode", ("utf-8", "surrogateescape")),
    }
}
