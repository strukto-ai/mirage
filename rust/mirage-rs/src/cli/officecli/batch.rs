// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! `batch`: a JSON array of items run against one open workbook, saved
//! once at the end. By default a failure anywhere leaves the workbook as
//! it was; `--best-effort` keeps what succeeded and `--stop-on-error`
//! stops at the first failure, as OfficeCLI 1.0.161 runs a batch.

use super::node::Json;

/// One item of a batch.
#[derive(Debug, Default)]
pub(super) struct Item {
    pub(super) command: String,
    pub(super) path: Option<String>,
    pub(super) props: Option<Vec<(String, String)>>,
    pub(super) selector: Option<String>,
    pub(super) text: Option<String>,
    pub(super) depth: Option<i64>,
    pub(super) compact: Option<bool>,
    pub(super) fields: Option<String>,
    /// Every other field, kept to echo the item back.
    others: Vec<(String, Json)>,
}

const FIELDS: [&str; 23] = [
    "command",
    "op",
    "path",
    "parent",
    "type",
    "from",
    "index",
    "after",
    "before",
    "to",
    "path2",
    "props",
    "selector",
    "text",
    "mode",
    "compact",
    "fields",
    "depth",
    "part",
    "xpath",
    "action",
    "xml",
    "dumpversion",
];

/// The fields of an item echoed back, in OfficeCLI's order.
const ECHO: [&str; 22] = [
    "command",
    "path",
    "parent",
    "type",
    "from",
    "index",
    "after",
    "before",
    "to",
    "path2",
    "props",
    "selector",
    "text",
    "mode",
    "compact",
    "fields",
    "depth",
    "part",
    "xpath",
    "action",
    "xml",
    "dumpVersion",
];

impl Item {
    /// The item as it is echoed with its failure.
    pub(super) fn echo(&self) -> Json {
        let mut fields = Vec::new();
        for name in ECHO {
            let value = match name {
                "command" if !self.command.is_empty() => Some(Json::Str(self.command.clone())),
                "path" => self.path.clone().map(Json::Str),
                "props" => self.props.as_ref().map(|p| {
                    Json::Obj(
                        p.iter()
                            .map(|(k, v)| (k.clone(), Json::Str(v.clone())))
                            .collect(),
                    )
                }),
                "selector" => self.selector.clone().map(Json::Str),
                "text" => self.text.clone().map(Json::Str),
                "compact" => self.compact.map(Json::Bool),
                "fields" => self.fields.clone().map(Json::Str),
                "depth" => self.depth.map(Json::Int),
                other => self
                    .others
                    .iter()
                    .find(|(k, _)| k.eq_ignore_ascii_case(other))
                    .map(|(_, v)| v.clone()),
            };
            if let Some(v) = value {
                fields.push((name.to_string(), v));
            }
        }
        Json::Obj(fields)
    }
}

/// The items of a batch, or the message its input is refused with.
pub(super) fn items(text: &str) -> Result<Vec<Item>, String> {
    let mut root = Reader {
        s: text.as_bytes(),
        i: 0,
    }
    .document()?;
    if let Json::Obj(fields) = &root {
        if let Some((_, data @ Json::Arr(_))) = fields.iter().find(|(k, _)| k == "data") {
            root = data.clone();
        }
    }
    let list = match root {
        Json::Arr(list) => list,
        Json::Null => return Ok(Vec::new()),
        other => {
            let kind = match other {
                Json::Obj(_) => "object",
                Json::Str(_) => "string",
                Json::Bool(true) => "true",
                Json::Bool(false) => "false",
                _ => "number",
            };
            return Err(format!(
                "Batch input must be a JSON array. Got: {kind}. Wrap a single item like [{{\"command\":\"get\",\"path\":\"/\"}}]."
            ));
        }
    };
    for (i, element) in list.iter().enumerate() {
        if let Json::Obj(fields) = element {
            let unknown: Vec<String> = fields
                .iter()
                .filter(|(k, _)| !FIELDS.contains(&k.to_ascii_lowercase().as_str()))
                .map(|(k, _)| format!("\"{k}\""))
                .collect();
            if !unknown.is_empty() {
                return Err(format!(
                    "batch item[{i}]: unknown field(s) {}. Valid fields: {}",
                    unknown.join(", "),
                    FIELDS.join(", ")
                ));
            }
        }
    }
    let mut out = Vec::new();
    for element in list {
        let fields =
            match element {
                Json::Obj(fields) => fields,
                Json::Null => {
                    return Err("Object reference not set to an instance of an object.".to_string());
                }
                _ => return Err(
                    "The JSON value could not be converted to a batch item: expected an object."
                        .to_string(),
                ),
            };
        let mut item = Item::default();
        for (key, value) in fields {
            let text = |v: &Json| match v {
                Json::Str(s) => Ok(Some(s.clone())),
                Json::Null => Ok(None),
                _ => Err(format!(
                    "The JSON value for \"{key}\" could not be converted to a string."
                )),
            };
            match key.to_ascii_lowercase().as_str() {
                "command" | "op" => item.command = text(&value)?.unwrap_or_default(),
                "path" => item.path = text(&value)?,
                "selector" => item.selector = text(&value)?,
                "text" => item.text = text(&value)?,
                "fields" => item.fields = text(&value)?,
                "depth" => {
                    item.depth = match value {
                        Json::Int(n) => Some(n),
                        Json::Null => None,
                        _ => return Err(
                            "The JSON value for \"depth\" could not be converted to an integer."
                                .to_string(),
                        ),
                    }
                }
                "compact" => {
                    item.compact = match value {
                        Json::Bool(b) => Some(b),
                        Json::Null => None,
                        _ => return Err(
                            "The JSON value for \"compact\" could not be converted to a boolean."
                                .to_string(),
                        ),
                    }
                }
                "props" => item.props = props(value)?,
                _ => item.others.push((key, value)),
            }
        }
        out.push(item);
    }
    Ok(out)
}

/// A props value: an object of values, or an array of `key=value`
/// strings; a later key replaces an earlier one without regard to case.
fn props(value: Json) -> Result<Option<Vec<(String, String)>>, String> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut put =
        |k: String, v: String| match out.iter_mut().find(|(x, _)| x.eq_ignore_ascii_case(&k)) {
            Some(slot) => slot.1 = v,
            None => out.push((k, v)),
        };
    match value {
        Json::Null => return Ok(None),
        Json::Arr(list) => {
            for entry in list {
                let Json::Str(kv) = entry else {
                    return Err("Expected \"key=value\" string in props array".to_string());
                };
                if let Some((k, v)) = kv.split_once('=').filter(|(k, _)| !k.is_empty()) {
                    put(k.to_string(), v.to_string());
                }
            }
        }
        Json::Obj(fields) => {
            for (k, v) in fields {
                let text = match v {
                    Json::Str(s) => s,
                    Json::Int(n) => n.to_string(),
                    Json::Num(n) => super::node::number_text(n),
                    Json::Bool(b) => b.to_string(),
                    Json::Null => String::new(),
                    _ => return Err(format!("Unexpected token for prop value '{k}'")),
                };
                put(k, text);
            }
        }
        _ => return Err("Expected object or [\"key=value\"] array for props".to_string()),
    }
    Ok(Some(out))
}

/// A JSON document read with its members kept in order.
struct Reader<'a> {
    s: &'a [u8],
    i: usize,
}

impl Reader<'_> {
    fn err(&self, what: &str) -> String {
        format!(
            "The batch input is not valid JSON: {what} at byte {}.",
            self.i
        )
    }

    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn document(&mut self) -> Result<Json, String> {
        if self.s.starts_with(b"\xef\xbb\xbf") {
            self.i = 3;
        }
        let v = self.value(0)?;
        self.ws();
        if self.i < self.s.len() {
            return Err(self.err("unexpected text after the value"));
        }
        Ok(v)
    }

    fn value(&mut self, depth: usize) -> Result<Json, String> {
        if depth > 64 {
            return Err(self.err("nesting too deep"));
        }
        self.ws();
        match self.s.get(self.i) {
            None => Err(self.err("unexpected end")),
            Some(b'{') => {
                self.i += 1;
                let mut fields = Vec::new();
                self.ws();
                if self.s.get(self.i) == Some(&b'}') {
                    self.i += 1;
                    return Ok(Json::Obj(fields));
                }
                loop {
                    self.ws();
                    if self.s.get(self.i) != Some(&b'"') {
                        return Err(self.err("expected a property name"));
                    }
                    let key = self.string()?;
                    self.ws();
                    if self.s.get(self.i) != Some(&b':') {
                        return Err(self.err("expected ':'"));
                    }
                    self.i += 1;
                    let v = self.value(depth + 1)?;
                    fields.push((key, v));
                    self.ws();
                    match self.s.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b'}') => {
                            self.i += 1;
                            return Ok(Json::Obj(fields));
                        }
                        _ => return Err(self.err("expected ',' or '}'")),
                    }
                }
            }
            Some(b'[') => {
                self.i += 1;
                let mut items = Vec::new();
                self.ws();
                if self.s.get(self.i) == Some(&b']') {
                    self.i += 1;
                    return Ok(Json::Arr(items));
                }
                loop {
                    items.push(self.value(depth + 1)?);
                    self.ws();
                    match self.s.get(self.i) {
                        Some(b',') => self.i += 1,
                        Some(b']') => {
                            self.i += 1;
                            return Ok(Json::Arr(items));
                        }
                        _ => return Err(self.err("expected ',' or ']'")),
                    }
                }
            }
            Some(b'"') => Ok(Json::Str(self.string()?)),
            Some(b't') if self.s[self.i..].starts_with(b"true") => {
                self.i += 4;
                Ok(Json::Bool(true))
            }
            Some(b'f') if self.s[self.i..].starts_with(b"false") => {
                self.i += 5;
                Ok(Json::Bool(false))
            }
            Some(b'n') if self.s[self.i..].starts_with(b"null") => {
                self.i += 4;
                Ok(Json::Null)
            }
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => Err(self.err("unexpected character")),
        }
    }

    fn number(&mut self) -> Result<Json, String> {
        let start = self.i;
        while self.i < self.s.len()
            && matches!(
                self.s[self.i],
                b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9'
            )
        {
            self.i += 1;
        }
        let text =
            std::str::from_utf8(&self.s[start..self.i]).map_err(|_| self.err("bad number"))?;
        if let Ok(n) = text.parse::<i64>() {
            return Ok(Json::Int(n));
        }
        text.parse::<f64>()
            .map(Json::Num)
            .map_err(|_| self.err("bad number"))
    }

    fn string(&mut self) -> Result<String, String> {
        self.i += 1;
        let mut out: Vec<u8> = Vec::new();
        loop {
            let Some(&b) = self.s.get(self.i) else {
                return Err(self.err("unterminated string"));
            };
            self.i += 1;
            match b {
                b'"' => break,
                b'\\' => {
                    let Some(&e) = self.s.get(self.i) else {
                        return Err(self.err("unterminated string"));
                    };
                    self.i += 1;
                    match e {
                        b'"' => out.push(b'"'),
                        b'\\' => out.push(b'\\'),
                        b'/' => out.push(b'/'),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'u' => {
                            let mut unit = self.hex4()?;
                            let c = if (0xD800..0xDC00).contains(&unit)
                                && self.s[self.i..].starts_with(b"\\u")
                            {
                                self.i += 2;
                                let low = self.hex4()?;
                                unit = 0x10000
                                    + ((unit - 0xD800) << 10)
                                    + (low.wrapping_sub(0xDC00) & 0x3ff);
                                char::from_u32(unit)
                            } else {
                                char::from_u32(unit)
                            };
                            let mut buf = [0u8; 4];
                            out.extend_from_slice(
                                c.unwrap_or('\u{fffd}').encode_utf8(&mut buf).as_bytes(),
                            );
                        }
                        _ => return Err(self.err("bad escape")),
                    }
                }
                b if b < 0x20 => return Err(self.err("control character in a string")),
                b => out.push(b),
            }
        }
        Ok(String::from_utf8_lossy(&out).into_owned())
    }

    fn hex4(&mut self) -> Result<u32, String> {
        let digits = self
            .s
            .get(self.i..self.i + 4)
            .ok_or_else(|| self.err("bad escape"))?;
        let n = u32::from_str_radix(std::str::from_utf8(digits).unwrap_or("x"), 16)
            .map_err(|_| self.err("bad escape"))?;
        self.i += 4;
        Ok(n)
    }
}
