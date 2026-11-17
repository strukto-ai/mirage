// Adapted from jq 1.8.2 (MIT), src/builtin.c, src/jv.c and src/jv_aux.c. See licenses/third_party/jq.txt.

use super::meter::{Charge, Limits};
use super::value::{StringBuffer, Value};

/// Why a native builtin produced no value.
pub(crate) enum Fault {
    Error(Value),
    Halt(Option<Value>, Option<f64>),
}

pub(super) type Answer = Result<Value, Fault>;

pub(super) fn fail(message: impl Into<String>) -> Fault {
    Fault::Error(StringBuffer::from(message.into()).into_value())
}

pub(super) fn type_error(bad: &Value, message: &str) -> Fault {
    fail(format!("{} ({}) {message}", bad.kind(), bad.dump_trunc()))
}

pub(super) fn array_too_long(items: usize) -> Fault {
    fail(format!("jq array limit of {items} elements exceeded"))
}

pub(super) fn array_limit(items: Vec<Value>, limits: Limits) -> Answer {
    let mut charge = Charge::open(items.capacity() * std::mem::size_of::<Value>());
    if items.len() > limits.items {
        return Err(array_too_long(limits.items));
    }
    charge.set(0);
    Ok(Value::array(items))
}
