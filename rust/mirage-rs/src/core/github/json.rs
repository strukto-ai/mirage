// Prints numbers and strings as Go 1.25.5's encoding/json does (BSD-3-Clause;
// see licenses/third_party/go.txt).

//! A JSON value that keeps its keys in the order they arrived or were set,
//! which is how gh's exports print and how a REST body reads back.

use std::fmt;

use serde::de::{Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) enum Json {
    #[default]
    Null,
    Bool(bool),
    Int(i128),
    Float(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Obj),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Obj(Vec<(String, Json)>);

static NULL: Json = Json::Null;

impl Obj {
    pub(crate) fn new() -> Obj {
        Obj(Vec::new())
    }

    pub(crate) fn find(&self, key: &str) -> Option<&Json> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub(crate) fn find_mut(&mut self, key: &str) -> Option<&mut Json> {
        self.0.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    /// The value at `key`, null when there is none.
    pub(crate) fn get(&self, key: &str) -> &Json {
        self.find(key).unwrap_or(&NULL)
    }

    pub(crate) fn has(&self, key: &str) -> bool {
        self.find(key).is_some()
    }

    /// Set `key`, keeping its place when it is already there.
    pub(crate) fn set(&mut self, key: impl Into<String>, value: impl Into<Json>) {
        let key = key.into();
        let value = value.into();
        match self.find_mut(&key) {
            Some(slot) => *slot = value,
            None => self.0.push((key, value)),
        }
    }

    pub(crate) fn remove(&mut self, key: &str) -> Option<Json> {
        let at = self.0.iter().position(|(k, _)| k == key)?;
        Some(self.0.remove(at).1)
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = &(String, Json)> {
        self.0.iter()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl Json {
    pub(crate) fn parse(bytes: &[u8]) -> Result<Json, String> {
        serde_json::from_slice(bytes).map_err(|err| err.to_string())
    }

    /// The value at `key` of an object, null for anything else.
    pub(crate) fn get(&self, key: &str) -> &Json {
        match self {
            Json::Obj(obj) => obj.get(key),
            _ => &NULL,
        }
    }

    pub(crate) fn as_obj(&self) -> Option<&Obj> {
        match self {
            Json::Obj(obj) => Some(obj),
            _ => None,
        }
    }

    pub(crate) fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(text) => Some(text),
            _ => None,
        }
    }

    pub(crate) fn as_int(&self) -> Option<i128> {
        match self {
            Json::Int(value) => Some(*value),
            _ => None,
        }
    }

    pub(crate) fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(value) => Some(*value),
            _ => None,
        }
    }

    pub(crate) fn is_null(&self) -> bool {
        matches!(self, Json::Null)
    }

    /// The string, empty for anything else.
    pub(crate) fn text(&self) -> &str {
        self.as_str().unwrap_or("")
    }

    /// The array's items, none for anything else.
    pub(crate) fn items(&self) -> &[Json] {
        match self {
            Json::Arr(items) => items,
            _ => &[],
        }
    }

    pub(crate) fn truthy(&self) -> bool {
        match self {
            Json::Null => false,
            Json::Bool(value) => *value,
            Json::Int(value) => *value != 0,
            Json::Float(value) => *value != 0.0,
            Json::Str(text) => !text.is_empty(),
            Json::Arr(items) => !items.is_empty(),
            Json::Obj(obj) => !obj.is_empty(),
        }
    }

    /// The value as a line of text shows it: nothing for null, a string
    /// as it is, anything else as its JSON.
    pub(crate) fn show(&self) -> String {
        match self {
            Json::Null => String::new(),
            Json::Str(text) => text.clone(),
            other => other.dump(),
        }
    }

    /// One line of JSON, nothing escaped that JSON does not require.
    pub(crate) fn dump(&self) -> String {
        let mut out = String::new();
        self.write(&mut out);
        out
    }

    fn write(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
            Json::Int(value) => out.push_str(&value.to_string()),
            Json::Float(value) => out.push_str(&float_text(*value)),
            Json::Str(text) => quote_into(text, out),
            Json::Arr(items) => {
                out.push('[');
                for (at, item) in items.iter().enumerate() {
                    if at > 0 {
                        out.push(',');
                    }
                    item.write(out);
                }
                out.push(']');
            }
            Json::Obj(obj) => {
                out.push('{');
                for (at, (key, value)) in obj.0.iter().enumerate() {
                    if at > 0 {
                        out.push(',');
                    }
                    quote_into(key, out);
                    out.push(':');
                    value.write(out);
                }
                out.push('}');
            }
        }
    }
}

/// A float as ECMAScript and Go's JSON encoders write it: the shortest
/// digits that read back the same, in exponent form below 1e-6 and from
/// 1e21 on, negative zero as 0.
pub(crate) fn float_text(value: f64) -> String {
    let value = if value == 0.0 { 0.0 } else { value };
    let magnitude = value.abs();
    if magnitude != 0.0 && !(1e-6..1e21).contains(&magnitude) {
        let text = format!("{value:e}");
        return match text.split_once('e') {
            Some((digits, power)) if !power.starts_with('-') => format!("{digits}e+{power}"),
            _ => text,
        };
    }
    format!("{value}")
}

pub(crate) fn quote_into(text: &str, out: &mut String) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if u32::from(c) < 0x20 => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
}

pub(crate) fn quoted(text: &str) -> String {
    let mut out = String::new();
    quote_into(text, &mut out);
    out
}

impl From<&str> for Json {
    fn from(value: &str) -> Json {
        Json::Str(value.to_owned())
    }
}

impl From<&String> for Json {
    fn from(value: &String) -> Json {
        Json::Str(value.clone())
    }
}

impl From<String> for Json {
    fn from(value: String) -> Json {
        Json::Str(value)
    }
}

impl From<bool> for Json {
    fn from(value: bool) -> Json {
        Json::Bool(value)
    }
}

impl From<i128> for Json {
    fn from(value: i128) -> Json {
        Json::Int(value)
    }
}

impl From<i64> for Json {
    fn from(value: i64) -> Json {
        Json::Int(i128::from(value))
    }
}

impl From<Vec<Json>> for Json {
    fn from(value: Vec<Json>) -> Json {
        Json::Arr(value)
    }
}

impl From<Obj> for Json {
    fn from(value: Obj) -> Json {
        Json::Obj(value)
    }
}

impl From<&[String]> for Json {
    fn from(value: &[String]) -> Json {
        Json::Arr(value.iter().map(Json::from).collect())
    }
}

impl<'de> Deserialize<'de> for Json {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Json, D::Error> {
        struct Reader;
        impl<'de> Visitor<'de> for Reader {
            type Value = Json;
            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON value")
            }
            fn visit_bool<E>(self, value: bool) -> Result<Json, E> {
                Ok(Json::Bool(value))
            }
            fn visit_i64<E>(self, value: i64) -> Result<Json, E> {
                Ok(Json::Int(i128::from(value)))
            }
            fn visit_u64<E>(self, value: u64) -> Result<Json, E> {
                Ok(Json::Int(i128::from(value)))
            }
            fn visit_f64<E>(self, value: f64) -> Result<Json, E> {
                Ok(Json::Float(value))
            }
            fn visit_str<E>(self, value: &str) -> Result<Json, E> {
                Ok(Json::Str(value.to_owned()))
            }
            fn visit_string<E>(self, value: String) -> Result<Json, E> {
                Ok(Json::Str(value))
            }
            fn visit_unit<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_none<E>(self) -> Result<Json, E> {
                Ok(Json::Null)
            }
            fn visit_some<D: Deserializer<'de>>(self, d: D) -> Result<Json, D::Error> {
                Json::deserialize(d)
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Json, A::Error> {
                let mut items = Vec::new();
                while let Some(item) = seq.next_element()? {
                    items.push(item);
                }
                Ok(Json::Arr(items))
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Json, A::Error> {
                let mut obj = Obj::new();
                while let Some((key, value)) = map.next_entry::<String, Json>()? {
                    obj.set(key, value);
                }
                Ok(Json::Obj(obj))
            }
        }
        deserializer.deserialize_any(Reader)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_keep_their_order_through_a_round_trip() {
        let value = Json::parse(br#"{"z":1,"a":[true,null,"x"],"m":{"b":2,"a":1}}"#).unwrap();
        assert_eq!(
            value.dump(),
            r#"{"z":1,"a":[true,null,"x"],"m":{"b":2,"a":1}}"#
        );
    }

    #[test]
    fn a_repeated_key_keeps_its_first_place_and_last_value() {
        let value = Json::parse(br#"{"a":1,"b":2,"a":3}"#).unwrap();
        assert_eq!(value.dump(), r#"{"a":3,"b":2}"#);
    }

    #[test]
    fn floats_switch_to_exponents_where_ecmascript_does() {
        assert_eq!(float_text(1e21), "1e+21");
        assert_eq!(float_text(1.5e-7), "1.5e-7");
        assert_eq!(float_text(1e20), "100000000000000000000");
        assert_eq!(float_text(-0.0), "0");
        assert_eq!(float_text(0.25), "0.25");
    }

    #[test]
    fn control_characters_escape_and_others_do_not() {
        assert_eq!(quoted("a\"\\\n\u{1}é"), r#""a\"\\\n\u0001é""#);
    }
}
