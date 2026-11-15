// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! What `get` and `query` answer with: a node of the workbook's tree, its
//! one-line text form and its JSON form, written the way OfficeCLI's own
//! serializer writes them (two-space indent, only quotes, backslashes and
//! control characters escaped).

/// A property's value as the node carries it.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Value {
    Str(String),
    Bool(bool),
    Int(i64),
    Num(f64),
    List(Vec<Value>),
    Map(Vec<(String, Value)>),
}

impl Value {
    /// The value as text: what the line shows and a filter compares.
    pub(super) fn text(&self) -> String {
        match self {
            Value::Str(s) => s.clone(),
            Value::Bool(b) => (if *b { "true" } else { "false" }).to_string(),
            Value::Int(n) => n.to_string(),
            Value::Num(n) => number_text(*n),
            Value::List(items) => format!(
                "[{}]",
                items
                    .iter()
                    .map(|item| match item {
                        Value::Map(m) => format!("{{{}}}", pairs_text(m)),
                        v => v.text(),
                    })
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            Value::Map(m) => pairs_text(m),
        }
    }

    fn json(&self) -> Json {
        match self {
            Value::Str(s) => Json::Str(s.clone()),
            Value::Bool(b) => Json::Bool(*b),
            Value::Int(n) => Json::Int(*n),
            Value::Num(n) => Json::Num(*n),
            Value::List(items) => Json::Arr(items.iter().map(Value::json).collect()),
            Value::Map(m) => Json::Obj(m.iter().map(|(k, v)| (k.clone(), v.json())).collect()),
        }
    }
}

fn pairs_text(m: &[(String, Value)]) -> String {
    m.iter()
        .map(|(k, v)| format!("{k}={}", v.text()))
        .collect::<Vec<_>>()
        .join(",")
}

/// A double as its shortest text that reads back the same.
pub(super) fn number_text(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

#[derive(Clone, Debug, Default)]
pub(super) struct Node {
    pub(super) path: String,
    pub(super) kind: String,
    pub(super) text: Option<String>,
    pub(super) preview: Option<String>,
    /// A paragraph's style, which the line shows before the properties.
    pub(super) style: Option<String>,
    pub(super) child_count: usize,
    pub(super) format: Vec<(String, Value)>,
    pub(super) children: Vec<Node>,
    /// Keys a filter accepts though no node of the set carries them.
    pub(super) declared: &'static [&'static str],
    /// The text a `:contains` filter also searches, for a node that shows
    /// none of its own.
    pub(super) search: Option<String>,
    /// Slots a removed key left, the most recent last: a key set next
    /// takes the most recent, as a .NET dictionary reuses them.
    pub(super) holes: Vec<usize>,
}

impl Node {
    pub(super) fn new(path: impl Into<String>, kind: &str) -> Node {
        Node {
            path: path.into(),
            kind: kind.to_string(),
            ..Node::default()
        }
    }

    /// Set `key`, in its place when the node has it already.
    pub(super) fn set(&mut self, key: &str, value: Value) {
        match self.format.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value,
            None => match self.holes.pop() {
                Some(at) => self.format[at] = (key.to_string(), value),
                None => self.format.push((key.to_string(), value)),
            },
        }
    }

    /// Drop `key`, leaving its slot for the next key set.
    pub(super) fn remove(&mut self, key: &str) -> bool {
        match self.format.iter().position(|(k, _)| k == key) {
            Some(at) => {
                self.format[at] = (String::new(), Value::Bool(false));
                self.holes.push(at);
                true
            }
            None => false,
        }
    }

    /// The properties in order, removed slots skipped.
    pub(super) fn props(&self) -> impl Iterator<Item = &(String, Value)> {
        self.format.iter().filter(|(k, _)| !k.is_empty())
    }

    /// Drop the keys OfficeCLI keeps for itself (`_`-prefixed), here and below.
    pub(super) fn strip_internal(&mut self) {
        let internal: Vec<String> = self
            .props()
            .filter(|(k, _)| k.starts_with('_'))
            .map(|(k, _)| k.clone())
            .collect();
        for k in internal {
            self.remove(&k);
        }
        for c in &mut self.children {
            c.strip_internal();
        }
    }

    pub(super) fn str(&mut self, key: &str, value: impl Into<String>) {
        self.set(key, Value::Str(value.into()));
    }

    pub(super) fn flag(&mut self, key: &str) {
        self.set(key, Value::Bool(true));
    }

    pub(super) fn has(&self, key: &str) -> bool {
        !key.is_empty() && self.format.iter().any(|(k, _)| k == key)
    }

    /// A key's value, its name matched without case.
    pub(super) fn get(&self, key: &str) -> Option<&Value> {
        self.props()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v)
    }

    /// The node's line: path, type, text, a child count when the children
    /// are not listed, then each property.
    pub(super) fn line(&self) -> String {
        let mut out = format!("{} ({})", self.path, self.kind);
        if let Some(text) = &self.text {
            let shown = text
                .replace('\\', "\\\\")
                .replace('"', "\\\"")
                .replace('\r', "")
                .replace('\n', "\\n");
            out.push_str(&format!(" \"{shown}\""));
        }
        if self.child_count > 0 && self.children.is_empty() {
            out.push_str(&format!(" children={}", self.child_count));
        }
        if let Some(style) = &self.style {
            out.push_str(&format!(" style={style}"));
        }
        for (key, value) in self.props() {
            if key == "style" && self.style.is_some() {
                continue;
            }
            out.push_str(&format!(" {key}={}", value.text()));
        }
        out
    }

    /// The node and its children, a line each, each line ended.
    pub(super) fn tree(&self) -> String {
        let mut out = self.line();
        out.push('\n');
        for child in &self.children {
            out.push_str(&child.tree());
        }
        out
    }

    pub(super) fn json(&self) -> Json {
        let mut fields = vec![
            ("path".to_string(), Json::Str(self.path.clone())),
            ("type".to_string(), Json::Str(self.kind.clone())),
        ];
        if let Some(text) = &self.text {
            fields.push(("text".to_string(), Json::Str(text.clone())));
        }
        if let Some(preview) = &self.preview {
            fields.push(("preview".to_string(), Json::Str(preview.clone())));
        }
        if let Some(style) = &self.style {
            fields.push(("style".to_string(), Json::Str(style.clone())));
        }
        fields.push(("childCount".to_string(), Json::Int(self.child_count as i64)));
        fields.push((
            "format".to_string(),
            Json::Obj(self.props().map(|(k, v)| (k.clone(), v.json())).collect()),
        ));
        fields.push((
            "children".to_string(),
            Json::Arr(self.children.iter().map(Node::json).collect()),
        ));
        Json::Obj(fields)
    }
}

/// Nodes as one line each, the last unended, as a query lists them.
pub(super) fn lines(nodes: &[Node]) -> String {
    nodes.iter().map(Node::line).collect::<Vec<_>>().join("\n")
}

/// Nodes as `{"matches": N, "results": [...]}`.
pub(super) fn matches(nodes: &[Node]) -> Json {
    Json::Obj(vec![
        ("matches".to_string(), Json::Int(nodes.len() as i64)),
        (
            "results".to_string(),
            Json::Arr(nodes.iter().map(Node::json).collect()),
        ),
    ])
}

/// A JSON value with its members in the order they were put.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Json {
    Null,
    Bool(bool),
    Int(i64),
    Num(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub(super) fn obj(fields: Vec<(&str, Json)>) -> Json {
        Json::Obj(
            fields
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
        )
    }

    /// Written indented, as OfficeCLI prints an envelope.
    pub(super) fn pretty(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, Some(0), false);
        out
    }

    /// Written on one line, every character past ASCII and each of
    /// `"&'+<>` and the backtick escaped, as a value nested in a property.
    pub(super) fn compact_escaped(&self) -> String {
        let mut out = String::new();
        self.write(&mut out, None, true);
        out
    }

    fn write(&self, out: &mut String, indent: Option<usize>, strict: bool) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Json::Int(n) => out.push_str(&n.to_string()),
            Json::Num(n) => out.push_str(&number_text(*n)),
            Json::Str(s) => quote(out, s, strict),
            Json::Arr(items) => {
                if items.is_empty() {
                    out.push_str("[]");
                    return;
                }
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    newline(out, indent.map(|n| n + 1));
                    item.write(out, indent.map(|n| n + 1), strict);
                }
                newline(out, indent);
                out.push(']');
            }
            Json::Obj(fields) => {
                if fields.is_empty() {
                    out.push_str("{}");
                    return;
                }
                out.push('{');
                for (i, (key, value)) in fields.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    newline(out, indent.map(|n| n + 1));
                    quote(out, key, strict);
                    out.push_str(if indent.is_some() { ": " } else { ":" });
                    value.write(out, indent.map(|n| n + 1), strict);
                }
                newline(out, indent);
                out.push('}');
            }
        }
    }
}

fn newline(out: &mut String, indent: Option<usize>) {
    if let Some(n) = indent {
        out.push('\n');
        out.push_str(&"  ".repeat(n));
    }
}

fn quote(out: &mut String, s: &str, strict: bool) {
    out.push('"');
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' if !strict => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04X}", c as u32)),
            c if strict
                && (matches!(c, '"' | '&' | '\'' | '+' | '<' | '>' | '`') || (c as u32) > 0x7e) =>
            {
                let mut units = [0u16; 2];
                for unit in c.encode_utf16(&mut units) {
                    out.push_str(&format!("\\u{:04X}", unit));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}
