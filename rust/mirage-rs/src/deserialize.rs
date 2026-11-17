use std::fmt;

use crate::stream::{StreamError, latin1_bytes};

/// A count over a whole input, which a 32-bit build's `usize` cannot hold,
/// a value past `u64` saturating.
pub(crate) fn saturating_u64<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<u64, D::Error> {
    struct Visitor;
    impl serde::de::Visitor<'_> for Visitor {
        type Value = u64;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("a non-negative count")
        }
        fn visit_u64<E>(self, value: u64) -> Result<u64, E> {
            Ok(value)
        }
        fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<u64, E> {
            u64::try_from(value).map_err(|_| E::custom("a count cannot be negative"))
        }
        // JSON integers past u64 arrive as doubles; the cast saturates.
        fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<u64, E> {
            if value >= 0.0 {
                Ok(value as u64)
            } else {
                Err(E::custom("a count cannot be negative"))
            }
        }
    }
    deserializer.deserialize_any(Visitor)
}

/// `saturating_u64` for an optional count.
pub(crate) fn saturating_u64_opt<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<u64>, D::Error> {
    struct Visitor;
    impl<'de> serde::de::Visitor<'de> for Visitor {
        type Value = Option<u64>;
        fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
            f.write_str("a non-negative count or null")
        }
        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(None)
        }
        fn visit_some<D: serde::Deserializer<'de>>(self, d: D) -> Result<Self::Value, D::Error> {
            saturating_u64(d).map(Some)
        }
    }
    deserializer.deserialize_option(Visitor)
}

/// `saturating_usize` for an optional count.
pub(crate) fn saturating_usize_opt<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<usize>, D::Error> {
    Ok(saturating_u64_opt(deserializer)?.map(|value| usize::try_from(value).unwrap_or(usize::MAX)))
}

/// A count from a host's configuration as a `usize`, a value past what this
/// target holds saturating as an unbounded flag does, so a 32-bit wasm build
/// accepts what a 64-bit one does.
pub(crate) fn saturating_usize<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<usize, D::Error> {
    saturating_u64(deserializer).map(|value| usize::try_from(value).unwrap_or(usize::MAX))
}

/// Bytes a host sends as a string of one character per byte, each below
/// U+0100, which JSON carries whatever the bytes are.
pub(crate) fn latin1<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<u8>, D::Error> {
    let text = <std::borrow::Cow<'de, str> as serde::Deserialize>::deserialize(deserializer)?;
    latin1_bytes(&text)
        .ok_or_else(|| serde::de::Error::custom("a byte string holds a character past U+00FF"))
}

/// `latin1` for an optional byte string.
pub(crate) fn latin1_opt<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<u8>>, D::Error> {
    let text =
        <Option<std::borrow::Cow<'de, str>> as serde::Deserialize>::deserialize(deserializer)?;
    text.map(|text| {
        latin1_bytes(&text)
            .ok_or_else(|| serde::de::Error::custom("a byte string holds a character past U+00FF"))
    })
    .transpose()
}

/// `latin1` for a list of byte strings.
pub(crate) fn latin1_list<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<Vec<u8>>, D::Error> {
    let texts = <Vec<std::borrow::Cow<'de, str>> as serde::Deserialize>::deserialize(deserializer)?;
    texts
        .iter()
        .map(|text| {
            latin1_bytes(text).ok_or_else(|| {
                serde::de::Error::custom("a byte string holds a character past U+00FF")
            })
        })
        .collect()
}

pub(crate) fn parse_config<'a, T: serde::Deserialize<'a>>(
    config: &'a [u8],
) -> Result<T, StreamError> {
    serde_json::from_slice(config)
        .map_err(|err| StreamError::new(format!("bad stream config: {err}")))
}
