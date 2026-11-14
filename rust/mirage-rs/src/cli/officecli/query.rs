//! `query`: OfficeCLI 1.0.161's selectors over a workbook. An element
//! type (`cell`, a column letter, `row`, `comment`, `sheet`), a sheet scope
//! (`Sheet1!` or `/Sheet1/`), bracketed predicates joined by `and`, `or`
//! and `not(...)`, the pseudo-classes `:contains`, `:empty` and
//! `:has(formula)`, a positional `[N]`, `,` unions and the `>` child
//! combinator, each matched and diagnosed the way OfficeCLI matches and
//! diagnoses them.

use std::cell::RefCell;

use super::Fail;
use super::node::{Json, Node, Value};
use super::read::{Comment, Doc, Grid, Range, Table, comment_node, type_name};
use super::sheet::cell_ref;

/// The sheets a query reads, each with its comments.
pub(super) struct Scope<'d> {
    pub(super) doc: &'d Doc,
    pub(super) grids: Vec<Grid>,
    pub(super) comments: Vec<Vec<Comment>>,
    pub(super) tables: Vec<Vec<Table>>,
    /// Warnings the handler prints as it reads, before any result.
    pub(super) notes: RefCell<Vec<String>>,
}

/// A filter's warning, as stderr prints it and `--json` carries it.
#[derive(Clone, Debug)]
pub(super) struct Warning {
    pub(super) message: String,
    kind: Option<&'static str>,
    key: Option<String>,
    value: Option<String>,
    available: Option<Vec<String>>,
    suggestion: Option<String>,
}

impl Warning {
    fn plain(message: String, kind: &'static str, key: &str, value: Option<&str>) -> Warning {
        Warning {
            message,
            kind: Some(kind),
            key: Some(key.to_string()),
            value: value.map(str::to_string),
            available: None,
            suggestion: None,
        }
    }

    pub(super) fn json(&self) -> Json {
        let mut fields = vec![
            ("message".to_string(), Json::Str(self.message.clone())),
            ("code".to_string(), Json::Str("filter_warning".to_string())),
        ];
        if let Some(s) = &self.suggestion {
            fields.push(("suggestion".to_string(), Json::Str(s.clone())));
        }
        if let Some(k) = self.kind {
            fields.push(("kind".to_string(), Json::Str(k.to_string())));
        }
        if let Some(k) = &self.key {
            fields.push(("key".to_string(), Json::Str(k.clone())));
        }
        if let Some(v) = &self.value {
            fields.push(("value".to_string(), Json::Str(v.clone())));
        }
        if let Some(a) = &self.available {
            fields.push((
                "available".to_string(),
                Json::Arr(a.iter().map(|s| Json::Str(s.clone())).collect()),
            ));
        }
        Json::Obj(fields)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Op {
    Eq,
    Ne,
    Contains,
    Ge,
    Le,
    Gt,
    Lt,
    Exists,
}

impl Op {
    fn text(self) -> &'static str {
        match self {
            Op::Eq => "=",
            Op::Ne => "!=",
            Op::Contains => "~=",
            Op::Ge => ">=",
            Op::Le => "<=",
            Op::Gt => ">",
            Op::Lt => "<",
            Op::Exists => "(exists)",
        }
    }
}

#[derive(Clone, Debug)]
struct Cond {
    key: String,
    op: Op,
    value: String,
}

#[derive(Clone, Debug)]
enum Expr {
    Pred(Cond),
    And(Vec<Expr>),
    Or(Vec<Expr>),
    Not(Box<Expr>),
}

fn invalid(message: String) -> Fail {
    Fail::coded(message, "invalid_selector")
}

/// Where `target` first stands outside brackets, parentheses and quotes.
fn top_level_index(s: &str, target: char) -> Option<usize> {
    let (mut bracket, mut paren) = (0i32, 0i32);
    let mut quote: Option<char> = None;
    let mut chars = s.char_indices();
    while let Some((i, c)) = chars.next() {
        if let Some(q) = quote {
            if c == '\\' {
                chars.next();
            } else if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => quote = Some(c),
            '[' => bracket += 1,
            ']' => bracket = (bracket - 1).max(0),
            '(' => paren += 1,
            ')' => paren = (paren - 1).max(0),
            c if c == target && bracket == 0 && paren == 0 => return Some(i),
            _ => {}
        }
    }
    None
}

fn split_commas(s: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut rest = s;
    while let Some(at) = top_level_index(rest, ',') {
        parts.push(rest[..at].to_string());
        rest = &rest[at + 1..];
    }
    parts.push(rest.to_string());
    parts.into_iter().filter(|p| !p.trim().is_empty()).collect()
}

/// The contents of each bracket block, and whether the brackets balance.
fn bracket_blocks(s: &str) -> (Vec<String>, bool) {
    let chars: Vec<char> = s.chars().collect();
    let mut blocks = Vec::new();
    let mut quote: Option<char> = None;
    let mut start: Option<usize> = None;
    let mut stray = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if let Some(q) = quote {
            if c == '\\' && i + 1 < chars.len() {
                i += 2;
                continue;
            }
            if c == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        match c {
            '"' | '\'' => quote = Some(c),
            '[' if start.is_none() => start = Some(i + 1),
            ']' => match start.take() {
                Some(st) => blocks.push(chars[st..i].iter().collect()),
                None => stray = true,
            },
            _ => {}
        }
        i += 1;
    }
    (blocks, start.is_none() && !stray && quote.is_none())
}

fn unquote(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    if chars.len() < 2 {
        return raw.to_string();
    }
    let q = chars[0];
    if (q != '"' && q != '\'') || chars[chars.len() - 1] != q {
        return raw.to_string();
    }
    let inner = &chars[1..chars.len() - 1];
    let mut out = String::new();
    let mut i = 0;
    while i < inner.len() {
        if inner[i] == '\\' && i + 1 < inner.len() && (inner[i + 1] == q || inner[i + 1] == '\\') {
            out.push(inner[i + 1]);
            i += 2;
            continue;
        }
        out.push(inner[i]);
        i += 1;
    }
    out
}

fn is_regex_form(raw: &str) -> bool {
    let b = raw.as_bytes();
    b.len() >= 3 && b[0] == b'r' && (b[1] == b'"' || b[1] == b'\'')
}

fn build_condition(key: &str, op: &str, raw: &str) -> Result<Cond, Fail> {
    let regex = is_regex_form(raw);
    let value = if regex { raw.to_string() } else { unquote(raw) };
    if value.starts_with(['=', '~', '!']) {
        return Err(invalid(format!(
            "Malformed selector: invalid operator near \"{key}{op}{value}\". Supported operators: =, !=, ~=, >=, <=, >, <"
        )));
    }
    if !regex && value.contains('*') {
        return Err(invalid(format!(
            "Wildcards (*) are not supported in attribute filters. Use ~= for contains, e.g. {key}~={}.",
            value.trim_matches('*')
        )));
    }
    let op = match op {
        "~=" => Op::Contains,
        ">=" => Op::Ge,
        "<=" => Op::Le,
        ">" => Op::Gt,
        "<" => Op::Lt,
        "!=" => Op::Ne,
        _ => Op::Eq,
    };
    let bare = key.trim_start_matches('@');
    if regex && op != Op::Contains {
        return Err(invalid(format!(
            "Regex values (r\"...\") are only supported with the ~= operator; '{}' would compare the r\"...\" text literally and match nothing. Use [{bare}~={value}].",
            op.text()
        )));
    }
    Ok(Cond {
        key: bare.to_string(),
        op,
        value,
    })
}

/// One bracket's boolean expression.
struct Parser {
    s: Vec<char>,
    i: usize,
}

impl Parser {
    fn err(&self, what: &str) -> Fail {
        invalid(format!(
            "Malformed filter expression: {what} in \"{}\"",
            self.s.iter().collect::<String>()
        ))
    }

    fn rest(&self) -> String {
        self.s[self.i.min(self.s.len())..].iter().collect()
    }

    fn skip_ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i].is_whitespace() {
            self.i += 1;
        }
    }

    fn keyword_at(&self, at: usize, kw: &str) -> bool {
        let k: Vec<char> = kw.chars().collect();
        if at + k.len() > self.s.len() {
            return false;
        }
        if !self.s[at..at + k.len()]
            .iter()
            .zip(&k)
            .all(|(a, b)| a.eq_ignore_ascii_case(b))
        {
            return false;
        }
        let after = at + k.len();
        after >= self.s.len() || self.s[after].is_whitespace() || self.s[after] == '('
    }

    fn keyword(&mut self, kw: &str) -> bool {
        self.skip_ws();
        if self.keyword_at(self.i, kw) {
            self.i += kw.len();
            return true;
        }
        false
    }

    fn top(&mut self) -> Result<Expr, Fail> {
        let e = self.or()?;
        self.skip_ws();
        if self.i < self.s.len() {
            return Err(self.err(&format!("unexpected '{}'", self.rest())));
        }
        Ok(e)
    }

    fn or(&mut self) -> Result<Expr, Fail> {
        let mut parts = vec![self.and()?];
        while self.keyword("or") {
            parts.push(self.and()?);
        }
        Ok(if parts.len() == 1 {
            parts.remove(0)
        } else {
            Expr::Or(parts)
        })
    }

    fn and(&mut self) -> Result<Expr, Fail> {
        let mut parts = vec![self.factor()?];
        while self.keyword("and") {
            parts.push(self.factor()?);
        }
        Ok(if parts.len() == 1 {
            parts.remove(0)
        } else {
            Expr::And(parts)
        })
    }

    fn expect(&mut self, c: char) -> Result<(), Fail> {
        self.skip_ws();
        if self.i >= self.s.len() || self.s[self.i] != c {
            return Err(self.err(&format!("expected '{c}'")));
        }
        self.i += 1;
        Ok(())
    }

    fn factor(&mut self) -> Result<Expr, Fail> {
        self.skip_ws();
        if self.keyword("not") {
            self.skip_ws();
            self.expect('(')?;
            let inner = self.or()?;
            self.expect(')')?;
            return Ok(Expr::Not(Box::new(inner)));
        }
        self.skip_ws();
        if self.s.get(self.i) == Some(&'(') {
            self.i += 1;
            let inner = self.or()?;
            self.expect(')')?;
            return Ok(inner);
        }
        Ok(Expr::Pred(self.predicate()?))
    }

    fn op_start(c: char) -> bool {
        matches!(c, '>' | '<' | '=' | '!' | '~' | '\\')
    }

    fn predicate(&mut self) -> Result<Cond, Fail> {
        self.skip_ws();
        let key: String;
        if self.i < self.s.len() && matches!(self.s[self.i], '"' | '\'') {
            let q = self.s[self.i];
            self.i += 1;
            let start = self.i;
            while self.i < self.s.len() && self.s[self.i] != q {
                self.i += if self.s[self.i] == '\\' && self.i + 1 < self.s.len() {
                    2
                } else {
                    1
                };
            }
            if self.i >= self.s.len() {
                return Err(self.err(&format!(
                    "unterminated quoted key in '{}'",
                    self.s[start..].iter().collect::<String>()
                )));
            }
            let raw: String = std::iter::once(q)
                .chain(self.s[start..self.i].iter().copied())
                .chain(std::iter::once(q))
                .collect();
            key = unquote(&raw);
            self.i += 1;
        } else {
            let start = self.i;
            if self.s.get(self.i) == Some(&'@') {
                self.i += 1;
            }
            while self.i < self.s.len()
                && (self.s[self.i].is_alphanumeric() || matches!(self.s[self.i], '.' | '_'))
            {
                self.i += 1;
            }
            key = self.s[start..self.i].iter().collect();
            if !key.is_empty()
                && self.i < self.s.len()
                && !self.s[self.i].is_whitespace()
                && self.s[self.i] != ')'
                && !Self::op_start(self.s[self.i])
            {
                let peek: String = self.s[self.i..(self.i + 4).min(self.s.len())]
                    .iter()
                    .collect();
                return Err(self.err(&format!("key '{key}' stops at '{peek}' — a name with characters outside letters/digits/._ must be quoted, e.g. [\"{key}…\">90]")));
            }
        }
        if key.is_empty() || key == "@" {
            return Err(self.err(&format!(
                "expected a predicate (key op value) at '{}'",
                self.rest()
            )));
        }
        self.skip_ws();
        if self.i >= self.s.len() || self.s[self.i] == ')' || !Self::op_start(self.s[self.i]) {
            return Ok(Cond {
                key: key.trim_start_matches('@').to_string(),
                op: Op::Exists,
                value: String::new(),
            });
        }
        let op = self.read_op()?;
        let raw = self.read_value()?;
        build_condition(&key, &op, &raw)
    }

    fn read_op(&mut self) -> Result<String, Fail> {
        let rest: String = self.rest();
        if rest.starts_with("\\!=") {
            self.i += 3;
            return Ok("!=".to_string());
        }
        for op in [">=", "<=", "!=", "~=", "=", ">", "<"] {
            if rest.starts_with(op) {
                self.i += op.len();
                return Ok(op.to_string());
            }
        }
        Err(self.err(&format!(
            "expected an operator (=, !=, ~=, >, <, >=, <=) at '{}'",
            if rest.is_empty() {
                "end".to_string()
            } else {
                rest
            }
        )))
    }

    fn connective_ahead(&self, ws: usize) -> bool {
        let mut j = ws;
        while j < self.s.len() && self.s[j].is_whitespace() {
            j += 1;
        }
        self.keyword_at(j, "and") || self.keyword_at(j, "or")
    }

    fn read_value(&mut self) -> Result<String, Fail> {
        self.skip_ws();
        if self.i < self.s.len() {
            let c = self.s[self.i];
            let r =
                c == 'r' && self.i + 1 < self.s.len() && matches!(self.s[self.i + 1], '"' | '\'');
            if c == '"' || c == '\'' || r {
                let start = self.i;
                if r {
                    self.i += 1;
                }
                let q = self.s[self.i];
                self.i += 1;
                while self.i < self.s.len() && self.s[self.i] != q {
                    self.i += if self.s[self.i] == '\\' && self.i + 1 < self.s.len() {
                        2
                    } else {
                        1
                    };
                }
                if self.i >= self.s.len() {
                    return Err(self.err(&format!(
                        "unterminated quoted value in '{}'",
                        self.s[start..].iter().collect::<String>()
                    )));
                }
                self.i += 1;
                return Ok(self.s[start..self.i].iter().collect());
            }
        }
        let start = self.i;
        while self.i < self.s.len() {
            let c = self.s[self.i];
            if c == ')' || (c.is_whitespace() && self.connective_ahead(self.i)) {
                break;
            }
            self.i += 1;
        }
        let v: String = self.s[start..self.i]
            .iter()
            .collect::<String>()
            .trim_end()
            .to_string();
        if v.is_empty() {
            return Err(self.err("expected a value after the operator"));
        }
        Ok(v)
    }
}

fn parse_expr(selector: &str) -> Result<Option<Expr>, Fail> {
    let (blocks, balanced) = bracket_blocks(selector);
    if !balanced {
        return Err(invalid(format!(
            "Malformed selector: unclosed bracket in \"{selector}\""
        )));
    }
    let mut parts = Vec::new();
    for content in blocks {
        if content.trim().is_empty() {
            return Err(invalid(format!(
                "Malformed selector: empty brackets \"[]\" in \"{selector}\""
            )));
        }
        if content.trim().parse::<i64>().is_ok() {
            continue;
        }
        parts.push(
            Parser {
                s: content.chars().collect(),
                i: 0,
            }
            .top()?,
        );
    }
    Ok(match parts.len() {
        0 => None,
        1 => parts.pop(),
        _ => Some(Expr::And(parts)),
    })
}

fn flatten(expr: &Expr, into: &mut Vec<Cond>) -> bool {
    match expr {
        Expr::Pred(c) => {
            into.push(c.clone());
            true
        }
        Expr::And(parts) => parts.iter().all(|p| flatten(p, into)),
        _ => false,
    }
}

fn leaves(expr: &Expr, into: &mut Vec<Cond>) {
    match expr {
        Expr::Pred(c) => into.push(c.clone()),
        Expr::And(p) | Expr::Or(p) => p.iter().for_each(|e| leaves(e, into)),
        Expr::Not(e) => leaves(e, into),
    }
}

fn resolve_keys(expr: &mut Expr) {
    match expr {
        Expr::Pred(c) => c.key = alias(&c.key),
        Expr::And(p) | Expr::Or(p) => p.iter_mut().for_each(resolve_keys),
        Expr::Not(e) => resolve_keys(e),
    }
}

/// A cell property's short name as its full key.
fn alias(key: &str) -> String {
    match key.to_ascii_lowercase().as_str() {
        "bold" => "font.bold".to_string(),
        "italic" => "font.italic".to_string(),
        "underline" => "underline".to_string(),
        "strike" => "strike".to_string(),
        "font" => "font.name".to_string(),
        "size" => "font.size".to_string(),
        "color" => "font.color".to_string(),
        _ => key.to_string(),
    }
}

fn resolve(node: &Node, key: &str) -> (bool, String) {
    if let Some(v) = node.get(key) {
        return (true, v.text());
    }
    if key.eq_ignore_ascii_case("text") {
        return (node.text.is_some(), node.text.clone().unwrap_or_default());
    }
    if key.eq_ignore_ascii_case("type") {
        return (!node.kind.is_empty(), node.kind.clone());
    }
    if key.eq_ignore_ascii_case("value") && node.kind == "cell" {
        return (node.text.is_some(), node.text.clone().unwrap_or_default());
    }
    (false, String::new())
}

fn same(a: &str, b: &str) -> bool {
    if a.eq_ignore_ascii_case(b) {
        return true;
    }
    let (an, bn) = (a.trim_start_matches('#'), b.trim_start_matches('#'));
    (an.len() != a.len() || bn.len() != b.len()) && an.eq_ignore_ascii_case(bn)
}

const UNITS: [&str; 6] = ["pt", "px", "cm", "in", "em", "%"];

/// `s` without its ASCII `suffix`, matched without case.
fn strip_suffix_ci<'a>(s: &'a str, suffix: &str) -> Option<&'a str> {
    let at = s.len().checked_sub(suffix.len())?;
    (s.is_char_boundary(at) && s[at..].eq_ignore_ascii_case(suffix)).then(|| &s[..at])
}

/// Whether `s` starts with `prefix`, matched without case.
fn starts_ci(s: &str, prefix: &str) -> bool {
    s.get(..prefix.len())
        .is_some_and(|h| h.eq_ignore_ascii_case(prefix))
}

fn unit(v: &str) -> &'static str {
    UNITS
        .iter()
        .find(|u| strip_suffix_ci(v, u).is_some())
        .copied()
        .unwrap_or("")
}

fn number(v: &str) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    let t = v.trim_end();
    let t = strip_suffix_ci(t, unit(t)).unwrap_or(t);
    t.trim().parse::<f64>().ok().filter(|n| n.is_finite())
}

/// A length in English Metric Units.
fn emu(v: &str) -> Option<f64> {
    let t = v.trim();
    let scale = [
        ("cm", 360_000.0),
        ("in", 914_400.0),
        ("pt", 12_700.0),
        ("px", 9_525.0),
        ("emu", 1.0),
    ];
    for (suffix, factor) in scale {
        if let Some(number) = strip_suffix_ci(t, suffix).filter(|n| !n.is_empty()) {
            return number.trim().parse::<f64>().ok().map(|n| n * factor);
        }
    }
    None
}

fn compare(actual: &str, expected: &str) -> Option<std::cmp::Ordering> {
    let (a, e) = (number(actual), number(expected));
    if let (Some(a), Some(e)) = (a, e) {
        let (ua, ue) = (unit(actual), unit(expected));
        if ua.eq_ignore_ascii_case(ue) || ua.is_empty() || ue.is_empty() {
            return a.partial_cmp(&e);
        }
    }
    if let (Some(a), Some(e)) = (emu(actual), emu(expected)) {
        return a.partial_cmp(&e);
    }
    match (a, e) {
        (Some(a), Some(e)) => a.partial_cmp(&e),
        _ => None,
    }
}

fn dimension_equal(actual: &str, expected: &str) -> bool {
    if unit(actual).is_empty() && unit(expected).is_empty() {
        return false;
    }
    matches!((emu(actual), emu(expected)), (Some(a), Some(b)) if (a - b).abs() <= 500.0)
}

/// Whether `find` matches `text`: an `r"..."` pattern without case, else
/// a substring without case.
pub(super) fn text_matches(text: &str, find: &str) -> Result<bool, Fail> {
    if is_regex_form(find) {
        let q = find.as_bytes()[1] as char;
        if let Some(end) = find.rfind(q).filter(|e| *e > 1) {
            let pattern = &find[2..end];
            let re = fancy_regex::RegexBuilder::new(pattern)
                .case_insensitive(true)
                .build()
                .map_err(|e| invalid(format!("Malformed regex pattern in \"{find}\": {e}")))?;
            return Ok(re.is_match(text).unwrap_or(false));
        }
    }
    Ok(text.to_lowercase().contains(&find.to_lowercase()))
}

fn matches_one(node: &Node, cond: &Cond) -> bool {
    let (has, actual) = resolve(node, &cond.key);
    let display = || {
        cond.key.eq_ignore_ascii_case("value")
            && node.kind == "cell"
            && node.text.as_deref().is_some_and(|t| same(t, &cond.value))
    };
    match cond.op {
        Op::Exists => has && !actual.is_empty(),
        Op::Eq => {
            has && (same(&actual, &cond.value)
                || dimension_equal(&actual, &cond.value)
                || compare(&actual, &cond.value) == Some(std::cmp::Ordering::Equal)
                || display())
        }
        Op::Ne => {
            !has || !(same(&actual, &cond.value)
                || dimension_equal(&actual, &cond.value)
                || compare(&actual, &cond.value) == Some(std::cmp::Ordering::Equal)
                || display())
        }
        Op::Contains => has && text_matches(&actual, &cond.value).unwrap_or(false),
        Op::Ge => has && compare(&actual, &cond.value).is_some_and(|o| o.is_ge()),
        Op::Le => has && compare(&actual, &cond.value).is_some_and(|o| o.is_le()),
        Op::Gt => has && compare(&actual, &cond.value).is_some_and(|o| o.is_gt()),
        Op::Lt => has && compare(&actual, &cond.value).is_some_and(|o| o.is_lt()),
    }
}

fn matches_expr(node: &Node, expr: &Expr) -> bool {
    match expr {
        Expr::Pred(c) => matches_one(node, c),
        Expr::And(p) => p.iter().all(|e| matches_expr(node, e)),
        Expr::Or(p) => p.iter().any(|e| matches_expr(node, e)),
        Expr::Not(e) => !matches_expr(node, e),
    }
}

fn declared(nodes: &[Node], key: &str) -> bool {
    nodes
        .iter()
        .any(|n| n.declared.iter().any(|k| k.eq_ignore_ascii_case(key)))
}

fn all_keys(nodes: &[Node], sorted: bool) -> Vec<String> {
    let mut keys: Vec<String> = Vec::new();
    let mut add = |k: &str| {
        if !keys.iter().any(|x| x.eq_ignore_ascii_case(k)) {
            keys.push(k.to_string());
        }
    };
    for n in nodes {
        for (k, _) in &n.format {
            add(k);
        }
        if n.text.is_some() {
            add("text");
        }
        if !n.kind.is_empty() {
            add("type");
        }
    }
    if sorted {
        keys.sort_by_key(|k| k.to_lowercase());
    }
    keys
}

fn ordered(op: Op) -> bool {
    matches!(op, Op::Ge | Op::Le | Op::Gt | Op::Lt)
}

fn non_numeric(value: &str) -> bool {
    number(value).is_none() && emu(value).is_none()
}

/// Optimal string alignment distance.
fn distance(a: &str, b: &str) -> usize {
    let (s, t): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if s.is_empty() {
        return t.len();
    }
    if t.is_empty() {
        return s.len();
    }
    let mut d = vec![vec![0usize; t.len() + 1]; s.len() + 1];
    for (i, row) in d.iter_mut().enumerate() {
        row[0] = i;
    }
    for (j, cell) in d[0].iter_mut().enumerate() {
        *cell = j;
    }
    for i in 1..=s.len() {
        for j in 1..=t.len() {
            let cost = usize::from(s[i - 1] != t[j - 1]);
            d[i][j] = (d[i - 1][j] + 1)
                .min(d[i][j - 1] + 1)
                .min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && s[i - 1] == t[j - 2] && s[i - 2] == t[j - 1] {
                d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1);
            }
        }
    }
    d[s.len()][t.len()]
}

fn nearest(input: &str, candidates: &[String], segment: bool) -> Option<String> {
    if input.is_empty() {
        return None;
    }
    let lower = input.to_lowercase();
    let threshold = 2.max(input.encode_utf16().count() / 3);
    let (mut best, mut best_d, mut tie) = (None, usize::MAX, 0);
    for c in candidates {
        let lc = c.to_lowercase();
        if lc == lower {
            continue;
        }
        let mut d = distance(&lower, &lc);
        if segment {
            if let Some(dot) = lc.rfind('.').filter(|dot| *dot < lc.len() - 1) {
                d = d.min(distance(&lower, &lc[dot + 1..]));
            }
        }
        if d > threshold {
            continue;
        }
        if d < best_d {
            (best, best_d, tie) = (Some(c.clone()), d, 1);
        } else if d == best_d {
            tie += 1;
        }
    }
    if tie == 1 { best } else { None }
}

fn apply_flat(nodes: Vec<Node>, conds: &[Cond]) -> (Vec<Node>, Vec<Warning>) {
    let mut warnings = Vec::new();
    if conds.is_empty() {
        return (nodes, warnings);
    }
    for c in conds.iter().filter(|c| c.op != Op::Ne) {
        if !nodes.iter().any(|n| resolve(n, &c.key).0)
            && !nodes.is_empty()
            && !declared(&nodes, &c.key)
        {
            let keys = all_keys(&nodes, false);
            let mut w = Warning::plain(
                format!(
                    "Warning: unknown key '{}'. Available: {}",
                    c.key,
                    keys.join(", ")
                ),
                "unknown_key",
                &c.key,
                None,
            );
            w.available = Some(keys);
            warnings.push(w);
        }
    }
    for c in conds.iter().filter(|c| ordered(c.op)) {
        if non_numeric(&c.value) {
            warnings.push(Warning::plain(
                format!(
                    "Warning: non-numeric '{}' in [{}{}{}]",
                    c.value,
                    c.key,
                    c.op.text(),
                    c.value
                ),
                "non_numeric",
                &c.key,
                Some(&c.value),
            ));
        }
        for n in &nodes {
            let (has, actual) = resolve(n, &c.key);
            if has && non_numeric(&actual) {
                warnings.push(Warning::plain(
                    format!(
                        "Warning: non-numeric '{actual}' for '{}' at {}",
                        c.key, n.path
                    ),
                    "non_numeric",
                    &c.key,
                    Some(&actual),
                ));
                break;
            }
        }
    }
    let kept = nodes
        .into_iter()
        .filter(|n| conds.iter().all(|c| matches_one(n, c)))
        .collect();
    (kept, warnings)
}

fn apply_expr(nodes: Vec<Node>, expr: &Expr) -> (Vec<Node>, Vec<Warning>) {
    let mut warnings = Vec::new();
    let mut conds = Vec::new();
    leaves(expr, &mut conds);
    for c in &conds {
        if c.op != Op::Ne
            && !nodes.iter().any(|n| resolve(n, &c.key).0)
            && !nodes.is_empty()
            && !declared(&nodes, &c.key)
        {
            let keys = all_keys(&nodes, false);
            let mut w = Warning::plain(
                format!(
                    "Warning: unknown key '{}'. Available: {}",
                    c.key,
                    keys.join(", ")
                ),
                "unknown_key",
                &c.key,
                None,
            );
            w.available = Some(keys);
            warnings.push(w);
        }
        if ordered(c.op) && non_numeric(&c.value) {
            warnings.push(Warning::plain(
                format!(
                    "Warning: non-numeric '{}' in [{}{}{}]",
                    c.value,
                    c.key,
                    c.op.text(),
                    c.value
                ),
                "non_numeric",
                &c.key,
                Some(&c.value),
            ));
        }
    }
    let kept = nodes
        .into_iter()
        .filter(|n| matches_expr(n, expr))
        .collect();
    (kept, warnings)
}

fn diagnose(candidates: &[Node], conds: &[Cond]) -> Vec<Warning> {
    let mut out = Vec::new();
    for c in conds.iter().filter(|c| c.op != Op::Exists) {
        if !candidates.iter().any(|n| resolve(n, &c.key).0) {
            if c.op == Op::Ne || declared(candidates, &c.key) {
                continue;
            }
            let keys = all_keys(candidates, true);
            let near = nearest(&c.key, &keys, true);
            let mut message = format!(
                "Warning: unknown key '{}'. Available: {}",
                c.key,
                keys.join(", ")
            );
            if let Some(n) = &near {
                message.push_str(&format!(" (did you mean '{n}'?)"));
            }
            out.push(Warning {
                message,
                kind: Some("unknown_key"),
                key: Some(c.key.clone()),
                value: None,
                available: Some(keys),
                suggestion: near,
            });
            continue;
        }
        if ordered(c.op) && non_numeric(&c.value) {
            out.push(Warning::plain(
                format!(
                    "Warning: non-numeric '{}' in [{}{}{}]",
                    c.value,
                    c.key,
                    c.op.text(),
                    c.value
                ),
                "non_numeric",
                &c.key,
                Some(&c.value),
            ));
            continue;
        }
        if matches!(c.op, Op::Eq | Op::Contains) && !candidates.iter().any(|n| matches_one(n, c)) {
            let mut values: Vec<String> = Vec::new();
            for n in candidates {
                let (has, v) = resolve(n, &c.key);
                if has && !v.is_empty() && !values.iter().any(|x| x.eq_ignore_ascii_case(&v)) {
                    values.push(v);
                }
            }
            values.sort_by(|a, b| ordinal_ignore_case(a, b));
            if values.is_empty() {
                continue;
            }
            let near = nearest(&c.value, &values, false);
            let mut shown = values
                .iter()
                .take(20)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ");
            if values.len() > 20 {
                shown.push_str(&format!(", … (+{} more)", values.len() - 20));
            }
            let mut message = format!(
                "Warning: no match for {}='{}'. Available: {shown}",
                c.key, c.value
            );
            if let Some(n) = &near {
                message.push_str(&format!(" (did you mean '{n}'?)"));
            }
            out.push(Warning {
                message,
                kind: Some("value_no_match"),
                key: Some(c.key.clone()),
                value: Some(c.value.clone()),
                available: Some(values.into_iter().take(50).collect()),
                suggestion: near,
            });
        }
    }
    out
}

/// Two strings ordered as .NET's ordinal comparison without case orders
/// them: each UTF-16 unit upper-cased.
fn ordinal_ignore_case(a: &str, b: &str) -> std::cmp::Ordering {
    let up = |s: &str| {
        s.encode_utf16()
            .map(|u| {
                if (0x61..=0x7a).contains(&u) {
                    u - 32
                } else {
                    u
                }
            })
            .collect::<Vec<u16>>()
    };
    up(a).cmp(&up(b))
}

fn strip_filter_brackets(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(open) = rest.find('[') {
        let Some(close) = rest[open..].find(']').map(|c| c + open) else {
            break;
        };
        out.push_str(&rest[..open]);
        let inner = &rest[open + 1..close];
        if inner.trim().parse::<i64>().is_ok() {
            out.push_str(&rest[open..=close]);
        }
        rest = &rest[close + 1..];
    }
    out.push_str(rest);
    out
}

/// The selector past a `Sheet!` or `/Sheet/` scope.
fn past_scope(s: &str) -> &str {
    let t = s.trim_start();
    if let Some(rest) = t.strip_prefix('/') {
        if let Some(at) = rest.find('/') {
            return &rest[at + 1..];
        }
        return t;
    }
    match t.find(['/', '!', '[']) {
        Some(at) if t.as_bytes()[at] == b'!' && at > 0 => &t[at + 1..],
        _ => t,
    }
}

fn targets_cells(selector: &str) -> bool {
    past_scope(selector)
        .to_ascii_lowercase()
        .starts_with("cell")
}

fn resolves_own_boolean(selector: &str) -> bool {
    let s = past_scope(selector).to_ascii_lowercase();
    s.starts_with("row[") || s.starts_with("col[") || s.starts_with("column[")
}

fn reject_garbage(selector: &str) -> Result<(), Fail> {
    let s = selector.trim_start();
    let Some(c) = s.chars().next() else {
        return Ok(());
    };
    if !(c.is_alphanumeric()
        || matches!(
            c,
            '_' | '\'' | '"' | '/' | '[' | ':' | '*' | '.' | '#' | '@' | '$' | '('
        ))
    {
        return Err(invalid(format!(
            "Malformed selector: \"{selector}\" does not start with an element name, a cell reference or a path."
        )));
    }
    let mut outside = String::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        let close = match c {
            '[' => Some(']'),
            '\'' => Some('\''),
            '"' => Some('"'),
            _ => None,
        };
        if let Some(close) = close {
            if let Some(end) = chars[i + 1..].iter().position(|&x| x == close) {
                i += end + 2;
                continue;
            }
        }
        outside.push(c);
        i += 1;
    }
    let outside = outside.trim_end();
    let last = outside.chars().last();
    if !outside.is_empty()
        && (matches!(last, Some('>' | '!' | ':' | ',')) || outside.contains(">>"))
    {
        let what = if outside.contains(">>") {
            ">>".to_string()
        } else {
            last.map(String::from).unwrap_or_default()
        };
        return Err(invalid(format!(
            "Malformed selector: \"{selector}\" has no element name after '{what}'."
        )));
    }
    Ok(())
}

/// The first `>` outside brackets.
fn child_combinator(s: &str) -> Option<usize> {
    let mut depth = 0i32;
    for (i, c) in s.char_indices() {
        match c {
            '[' => depth += 1,
            ']' => depth -= 1,
            '>' if depth == 0 => return Some(i),
            _ => {}
        }
    }
    None
}

fn row_path(path: &str) -> Option<(&str, &str)> {
    let at = path.rfind("/row[")?;
    let n = path[at + 5..].strip_suffix(']')?;
    (n.bytes().all(|b| b.is_ascii_digit()) && !n.is_empty()).then(|| (&path[..at], n))
}

fn cell_path(path: &str) -> Option<(&str, String)> {
    let at = path.rfind('/')?;
    let (row, _) = cell_ref(&path[at + 1..])?;
    (path[at + 1..]
        .bytes()
        .next()
        .is_some_and(|b| b.is_ascii_uppercase()))
    .then(|| (&path[..at], row.to_string()))
}

fn inside(child: &str, parent: &str) -> bool {
    let parent = parent.trim_end_matches('/');
    if starts_ci(child, parent) && child.as_bytes().get(parent.len()) == Some(&b'/') {
        return true;
    }
    match (cell_path(child), row_path(parent)) {
        (Some((sheet, row)), Some((psheet, prow))) => {
            sheet.eq_ignore_ascii_case(psheet) && row == prow
        }
        _ => false,
    }
}

/// The row properties a row query filters on.
const ROW_PROPS: [&str; 5] = [
    "height",
    "hidden",
    "outlineLevel",
    "collapsed",
    "customHeight",
];

impl Scope<'_> {
    /// The nodes `selector` names, with the warnings its filters raise.
    pub(super) fn filter(&self, selector: &str) -> Result<(Vec<Node>, Vec<Warning>), Fail> {
        let parts = split_commas(selector);
        if parts.len() > 1 {
            let mut results: Vec<Node> = Vec::new();
            let mut warnings = Vec::new();
            for part in parts {
                let (r, w) = self.filter(part.trim())?;
                for n in r {
                    if !results.iter().any(|x| x.path.eq_ignore_ascii_case(&n.path)) {
                        results.push(n);
                    }
                }
                warnings.extend(w);
            }
            return Ok((results, warnings));
        }
        reject_garbage(selector)?;
        if let Some((parent, child)) = filtered_combinator(selector) {
            return self.combinator(&parent, &child);
        }
        let mut expr = parse_expr(selector)?;
        if targets_cells(selector) {
            if let Some(e) = expr.as_mut() {
                resolve_keys(e);
            }
        }
        let mut flat = Vec::new();
        let flattened = expr.as_ref().is_none_or(|e| flatten(e, &mut flat));
        let (results, mut warnings, conds) = if flattened {
            let (r, w) = apply_flat(self.query(selector)?, &flat);
            (r, w, flat)
        } else {
            let e = expr.as_ref().expect("an expression that does not flatten");
            let q = if resolves_own_boolean(selector) {
                selector.to_string()
            } else {
                strip_filter_brackets(selector)
            };
            let (r, w) = apply_expr(self.query(&q)?, e);
            let mut conds = Vec::new();
            leaves(e, &mut conds);
            (r, w, conds)
        };
        if results.is_empty() && !conds.is_empty() && !resolves_own_boolean(selector) {
            if let Ok(full) = self.query(&strip_filter_brackets(selector)) {
                if !full.is_empty() {
                    warnings = diagnose(&full, &conds);
                }
            }
        }
        Ok((results, warnings))
    }

    fn combinator(&self, parent: &str, child: &str) -> Result<(Vec<Node>, Vec<Warning>), Fail> {
        let (scope, parent_query) = split_scope(parent);
        let (mut parents, parent_warnings) = self.filter(&parent_query)?;
        if !scope.is_empty() {
            parents.retain(|p| {
                starts_ci(&p.path, &scope) && p.path.as_bytes().get(scope.len()) == Some(&b'/')
            });
        }
        if parents.is_empty() {
            return Ok((Vec::new(), parent_warnings));
        }
        let (child, position) = child_position(child);
        let (children, warnings) = self.filter(&format!(
            "{} > {child}",
            strip_filter_brackets(&parent_query).trim_end()
        ))?;
        let mut kept: Vec<Node> = Vec::new();
        for p in &parents {
            let mine: Vec<&Node> = children
                .iter()
                .filter(|c| inside(&c.path, &p.path) && !kept.iter().any(|k| k.path == c.path))
                .collect();
            match position {
                None => kept.extend(mine.into_iter().cloned()),
                Some(usize::MAX) => {
                    if let Some(last) = mine.last() {
                        kept.push((*last).clone());
                    }
                }
                Some(n) if n >= 1 && n <= mine.len() => kept.push(mine[n - 1].clone()),
                Some(_) => {}
            }
        }
        Ok((kept, warnings))
    }

    /// The handler's own pass: the nodes of the selector's element type,
    /// narrowed by its sheet, its column, its `:contains` text and a
    /// positional `[N]`.
    fn query(&self, selector: &str) -> Result<Vec<Node>, Fail> {
        let found = self.dispatch(selector)?;
        let found = self.contains_filter(selector, found);
        Ok(positional(selector, found))
    }

    fn contains_filter(&self, selector: &str, nodes: Vec<Node>) -> Vec<Node> {
        if nodes.is_empty() {
            return nodes;
        }
        let Some(colon) = top_level_index(selector, ':') else {
            return nodes;
        };
        let head = strip_sheet_prefix(&selector[..colon]);
        let head = head.trim_start_matches('/');
        let word: String = head
            .chars()
            .rev()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect::<String>()
            .chars()
            .rev()
            .collect();
        if !word.is_empty() && !KNOWN.contains(&word.to_ascii_lowercase().as_str()) {
            return nodes;
        }
        let Some(needle) = parse_cells(selector).contains.filter(|n| !n.is_empty()) else {
            return nodes;
        };
        let has =
            |s: Option<&str>| s.is_some_and(|s| s.to_lowercase().contains(&needle.to_lowercase()));
        nodes
            .into_iter()
            .filter(|n| {
                has(n.text.as_deref())
                    || has(n.preview.as_deref())
                    || has(n.get("name").map(Value::text).as_deref())
                    || has(n.search.as_deref())
            })
            .collect()
    }

    fn dispatch(&self, selector: &str) -> Result<Vec<Node>, Fail> {
        let doc = self.doc;
        let mut selector = selector.to_string();
        if !selector.starts_with('/') && top_level_index(&selector, '/').is_some() {
            selector = format!("/{selector}");
        }
        if let Some((sheet, range)) = native_ref(&selector) {
            let sheet = sheet
                .strip_prefix('\'')
                .and_then(|s| s.strip_suffix('\''))
                .unwrap_or(&sheet)
                .to_string();
            let Some((index, entry)) = doc.sheet(&sheet) else {
                return Err(Fail::of(doc.missing(
                    &sheet,
                    cell_ref(range.split(':').next().unwrap_or("A1")),
                )));
            };
            let _ = entry;
            let grid = &self.grids[index];
            return Ok(match range.split_once(':') {
                Some((a, b)) => {
                    let (Some(start), Some(end)) = (cell_ref(a), cell_ref(b)) else {
                        return Ok(Vec::new());
                    };
                    doc.range_node(grid, &sheet, start, end).children
                }
                None => {
                    let Some((r, c)) = cell_ref(&range) else {
                        return Ok(Vec::new());
                    };
                    vec![match grid.find(r, c) {
                        Some(cell) => doc.cell_node(grid, &sheet, cell, 1),
                        None => doc.empty_cell(grid, &sheet, r, c),
                    }]
                }
            });
        }
        if has_top_level_equals(&selector) {
            return Err(invalid(format!(
                "'{selector}' is not a valid selector: a predicate must be inside brackets, e.g. row[col.2024>150] to filter table rows by a column, or cell[value>150] to filter cells."
            )));
        }
        separator_warning(&selector, self);
        let mut for_type = strip_sheet_prefix(&selector).to_string();
        if let Some(rest) = for_type.strip_prefix('/') {
            let trimmed = rest.trim_start_matches('/');
            for_type = match trimmed.find('/') {
                Some(at) => trimmed[at + 1..].to_string(),
                None => trimmed.to_string(),
            };
        }
        let element: String = for_type
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect::<String>()
            .to_lowercase();
        let column_like = element.len() <= 3
            && !element.is_empty()
            && element.chars().all(|c| c.is_ascii_alphabetic());
        let known = element.is_empty() || KNOWN.contains(&element.as_str()) || column_like;
        if !known || element == "merge" || element == "mergedrange" {
            return Ok(Vec::new());
        }
        if let Some(rhs) = combinator_rhs(&for_type) {
            let rhs_type: String = rhs
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect::<String>()
                .to_lowercase();
            if rhs_type == "cell" {
                return self.query(&rhs);
            }
        }
        let parsed = parse_cells(&selector);
        let in_scope = |name: &str| {
            parsed
                .sheet
                .as_ref()
                .is_none_or(|s| s.eq_ignore_ascii_case(name))
        };
        let mut out = Vec::new();
        match element.as_str() {
            "comment" | "note" => {
                for (i, entry) in doc.sheets.iter().enumerate() {
                    if in_scope(&entry.name) {
                        for (n, c) in self.comments[i].iter().enumerate() {
                            out.push(comment_node(&entry.name, c, n + 1));
                        }
                    }
                }
            }
            "sheet" => {
                for (i, entry) in doc.sheets.iter().enumerate() {
                    if in_scope(&entry.name) {
                        let mut node = Node::new(format!("/{}", entry.name), "sheet");
                        node.preview = Some(entry.name.clone());
                        node.child_count = self.grids[i].rows.len() + self.grids[i].charts;
                        out.push(node);
                    }
                }
            }
            "row" => {
                if let Some(expr) = parse_expr(&selector)? {
                    let mut conds = Vec::new();
                    leaves(&expr, &mut conds);
                    let forced: Vec<String> = selector
                        .match_indices('@')
                        .map(|(at, _)| {
                            selector[at + 1..]
                                .chars()
                                .take_while(|c| c.is_alphanumeric() || matches!(c, '.' | '_'))
                                .collect()
                        })
                        .collect();
                    let (mut columns, mut props) = (0, 0);
                    let mut collisions = Vec::new();
                    for c in &conds {
                        let col_forced = starts_ci(&c.key, "col.") || starts_ci(&c.key, "column.");
                        if !col_forced && c.key.parse::<i64>().is_ok() {
                            return Err(invalid(format!(
                                "row[{} …] is ambiguous: a bare number is the row index, not a column filter. Use 'row[col.{}{}{}]' to filter by a column named '{}', or 'row[{}]' (no operator) for that row.",
                                c.key,
                                c.key,
                                c.op.text(),
                                c.value,
                                c.key,
                                c.key
                            )));
                        }
                        let is_forced = forced.iter().any(|f| f.eq_ignore_ascii_case(&c.key));
                        let is_prop = ROW_PROPS.iter().any(|p| p.eq_ignore_ascii_case(&c.key));
                        if !col_forced && is_forced && !is_prop {
                            let mut keys = ROW_PROPS.to_vec();
                            keys.sort_by_key(|k| k.to_lowercase());
                            return Err(invalid(format!(
                                "row[@{} …]: '{}' is not a row property. Row properties: {}. For the table column, drop the '@' (row[{} …]) or force it with row[col.{} …].",
                                c.key,
                                c.key,
                                keys.join(", "),
                                c.key,
                                c.key
                            )));
                        }
                        if !col_forced && (is_forced || is_prop) {
                            props += 1;
                            if !is_forced {
                                collisions.push(c.key.clone());
                            }
                        } else {
                            columns += 1;
                        }
                    }
                    for key in collisions {
                        if self.column_named(parsed.sheet.as_deref(), &key) {
                            return Err(invalid(format!(
                                "row[{key} …] is ambiguous: '{key}' names both a row property and a table column. Use 'row[col.{key} …]' to match the column, or 'row[@{key} …]' to match the row property."
                            )));
                        }
                    }
                    if columns > 0 && props > 0 {
                        return Err(invalid("row[...] cannot mix table columns and row properties in one expression. Split into separate queries.".to_string()));
                    }
                    if columns > 0 {
                        return self.rows_by_column(parsed.sheet.as_deref(), &expr, &conds);
                    }
                }
                for (i, entry) in doc.sheets.iter().enumerate() {
                    if in_scope(&entry.name) {
                        out.extend(
                            doc.query_rows(&self.grids[i], &entry.name)
                                .into_iter()
                                .filter(|n| parsed.formats_match(n)),
                        );
                    }
                }
            }
            "cell" | "" => out = self.cells(&parsed),
            e if column_like && !KNOWN.contains(&e) => out = self.cells(&parsed),
            _ => {}
        }
        Ok(out)
    }

    fn cells(&self, parsed: &Parsed) -> Vec<Node> {
        let doc = self.doc;
        let mut out = Vec::new();
        for (i, entry) in doc.sheets.iter().enumerate() {
            if parsed
                .sheet
                .as_ref()
                .is_some_and(|s| !s.eq_ignore_ascii_case(&entry.name))
            {
                continue;
            }
            let grid = &self.grids[i];
            for cell in grid.cells() {
                if !parsed.cell_matches(doc, cell) {
                    continue;
                }
                let mut node = doc.cell_node(grid, &entry.name, cell, 1);
                node.str("value", doc.compared(cell));
                if parsed.formats_match(&node) {
                    out.push(node);
                }
            }
        }
        out
    }
}

const KNOWN: [&str; 28] = [
    "cell",
    "row",
    "col",
    "column",
    "sheet",
    "validation",
    "comment",
    "note",
    "table",
    "listobject",
    "chart",
    "pivottable",
    "pivot",
    "slicer",
    "shape",
    "picture",
    "sparkline",
    "namedrange",
    "definedname",
    "media",
    "image",
    "ole",
    "oleobject",
    "object",
    "embed",
    "hyperlink",
    "rowbreak",
    "colbreak",
];

const POSITIONAL: [&str; 26] = [
    "row",
    "col",
    "column",
    "shape",
    "picture",
    "image",
    "media",
    "chart",
    "table",
    "listobject",
    "ole",
    "oleobject",
    "object",
    "embed",
    "comment",
    "note",
    "slicer",
    "pivottable",
    "pivot",
    "namedrange",
    "definedname",
    "sparkline",
    "validation",
    "datavalidation",
    "rowbreak",
    "colbreak",
];

fn positional(selector: &str, results: Vec<Node>) -> Vec<Node> {
    if results.is_empty() {
        return results;
    }
    let mut s = strip_sheet_prefix(selector).to_string();
    if let Some(t) = s.strip_prefix('/') {
        let t = t.trim_start_matches('/');
        s = match t.find('/') {
            Some(at) => t[at + 1..].to_string(),
            None => t.to_string(),
        };
    }
    let Some(open) = s.find('[') else {
        return results;
    };
    let elem = &s[..open];
    if elem.is_empty()
        || !elem.chars().all(|c| c.is_alphanumeric() || c == '_')
        || !s.ends_with(']')
    {
        return results;
    }
    let token = s[open + 1..s.len() - 1].trim();
    if token.is_empty() || !token.chars().all(|c| c.is_ascii_alphanumeric()) {
        return results;
    }
    let elem = elem.to_ascii_lowercase();
    if !POSITIONAL.contains(&elem.as_str()) {
        return results;
    }
    let wanted = if elem == "col" || elem == "column" {
        match token.parse::<u32>() {
            Ok(n) => super::sheet::col_name(n),
            Err(_) if token.len() <= 3 && token.chars().all(|c| c.is_ascii_alphabetic()) => {
                token.to_ascii_uppercase()
            }
            Err(_) => return results,
        }
    } else {
        if token.parse::<i64>().is_err() {
            return results;
        }
        token.to_string()
    };
    let tail = format!("[{wanted}]");
    results
        .into_iter()
        .filter(|n| strip_suffix_ci(&n.path, &tail).is_some())
        .collect()
}

fn strip_sheet_prefix(s: &str) -> &str {
    match top_level_index(s, '!') {
        Some(at) if s.as_bytes().get(at + 1) != Some(&b'=') => &s[at + 1..],
        _ => s,
    }
}

fn has_top_level_equals(s: &str) -> bool {
    let (mut bracket, mut paren) = (0i32, 0i32);
    let mut quote: Option<char> = None;
    for c in s.chars() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => quote = Some(c),
            '[' => bracket += 1,
            ']' => bracket = (bracket - 1).max(0),
            '(' => paren += 1,
            ')' => paren = (paren - 1).max(0),
            '=' if bracket == 0 && paren == 0 => return true,
            _ => {}
        }
    }
    false
}

/// `Sheet!A1` or `Sheet!A1:B2`: the sheet and the reference.
fn native_ref(s: &str) -> Option<(String, String)> {
    let (sheet, reference) = s.split_once('!')?;
    if sheet.is_empty() || sheet.contains('/') || reference.contains('!') {
        return None;
    }
    let ok = |r: &str| {
        let letters = r.bytes().take_while(u8::is_ascii_alphabetic).count();
        letters > 0 && letters < r.len() && r[letters..].bytes().all(|b| b.is_ascii_digit())
    };
    let valid = match reference.split_once(':') {
        Some((a, b)) => ok(a) && ok(b),
        None => ok(reference),
    };
    valid.then(|| (sheet.to_string(), reference.to_ascii_uppercase()))
}

fn separator_warning(s: &str, scope: &Scope<'_>) {
    let Some(gt) = s.find('>') else { return };
    let prefix = &s[..gt];
    if prefix.is_empty() || prefix.contains(['/', '!', '>']) {
        return;
    }
    let suffix: String = s[gt + 1..]
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if suffix.is_empty() {
        return;
    }
    let lower = suffix.to_lowercase();
    const TYPES: [&str; 21] = [
        "ole",
        "oleobject",
        "object",
        "embed",
        "cell",
        "row",
        "chart",
        "pivottable",
        "pivot",
        "slicer",
        "shape",
        "picture",
        "table",
        "listobject",
        "comment",
        "note",
        "validation",
        "namedrange",
        "definedname",
        "media",
        "image",
    ];
    if TYPES.contains(&lower.as_str()) || lower == "sparkline" {
        scope.note(format!("Warning: Excel uses '!' not '>' as sheet separator (e.g. '{prefix}!{lower}' not '{prefix}>{lower}')."));
    }
}

/// The selector after a leading `X > ` or `X ` combinator.
fn combinator_rhs(s: &str) -> Option<String> {
    let chars: Vec<char> = s.chars().collect();
    if !chars
        .first()
        .is_some_and(|c| c.is_alphanumeric() || *c == '_')
    {
        return None;
    }
    let mut i = 1;
    while i < chars.len()
        && (chars[i].is_alphanumeric()
            || matches!(
                chars[i],
                '_' | '[' | ']' | '!' | '=' | '@' | '\'' | '"' | '.'
            ))
    {
        i += 1;
    }
    let mut j = i;
    while j < chars.len() && chars[j].is_whitespace() {
        j += 1;
    }
    let sep_at = if j < chars.len() && chars[j] == '>' {
        j + 1
    } else if j > i {
        j
    } else {
        return None;
    };
    let rest: String = chars[sep_at..]
        .iter()
        .collect::<String>()
        .trim()
        .to_string();
    (!rest.is_empty()).then_some(rest)
}

fn filtered_combinator(s: &str) -> Option<(String, String)> {
    let at = child_combinator(s)?;
    let (blocks, balanced) = bracket_blocks(&s[..at]);
    if !balanced
        || !blocks
            .iter()
            .any(|b| !b.trim().is_empty() && b.trim().parse::<i64>().is_err())
    {
        return None;
    }
    let (parent, child) = (s[..at].trim().to_string(), s[at + 1..].trim().to_string());
    (!parent.is_empty() && !child.is_empty()).then_some((parent, child))
}

fn split_scope(s: &str) -> (String, String) {
    if !s.starts_with('/') {
        return (String::new(), s.to_string());
    }
    let mut depth = 0i32;
    let mut last = None;
    for (i, c) in s.char_indices() {
        match c {
            '[' => depth += 1,
            ']' => depth -= 1,
            '/' if depth == 0 => last = Some(i),
            _ => {}
        }
    }
    match last {
        Some(at) if at > 0 => (s[..at].to_string(), s[at + 1..].to_string()),
        _ => (String::new(), s.trim_start_matches('/').to_string()),
    }
}

fn child_position(child: &str) -> (String, Option<usize>) {
    let mut rest = child;
    let mut offset = 0;
    while let Some(open) = rest.find('[') {
        let Some(close) = rest[open..].find(']').map(|c| c + open) else {
            break;
        };
        let inner = rest[open + 1..close].trim();
        let position = if inner.eq_ignore_ascii_case("last()") {
            Some(usize::MAX)
        } else {
            inner
                .parse::<usize>()
                .ok()
                .filter(|_| inner.bytes().all(|b| b.is_ascii_digit()))
        };
        if let Some(p) = position {
            let start = offset + open;
            let end = offset + close + 1;
            return (format!("{}{}", &child[..start], &child[end..]), Some(p));
        }
        offset += close + 1;
        rest = &rest[close + 1..];
    }
    (child.to_string(), None)
}

/// The handler's reading of a cell selector.
#[derive(Debug, Default)]
struct Parsed {
    sheet: Option<String>,
    column: Option<String>,
    value_eq: Option<String>,
    value_ne: Option<String>,
    contains: Option<String>,
    has_formula: Option<bool>,
    empty: Option<bool>,
    type_eq: Option<String>,
    type_ne: Option<String>,
    format_eq: Vec<(String, String)>,
    format_ne: Vec<(String, String)>,
}

fn parse_cells(selector: &str) -> Parsed {
    let mut p = Parsed::default();
    let mut s = selector.to_string();
    if let Some(rest) = s.strip_prefix('/') {
        match rest.find('/') {
            Some(at) => {
                p.sheet = Some(rest[..at].to_string());
                s = rest[at + 1..].to_string();
            }
            None => s = rest.to_string(),
        }
    }
    if let Some(bang) =
        top_level_index(&s, '!').filter(|b| *b > 0 && s.as_bytes().get(b + 1) != Some(&b'='))
    {
        let sheet = &s[..bang];
        p.sheet = Some(
            sheet
                .strip_prefix('\'')
                .and_then(|x| x.strip_suffix('\''))
                .unwrap_or(sheet)
                .to_string(),
        );
        s = s[bang + 1..].to_string();
    }
    let element: String = s
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if !element.is_empty()
        && element.len() <= 3
        && element.chars().all(|c| c.is_ascii_alphabetic())
        && !matches!(
            element.to_ascii_lowercase().as_str(),
            "row" | "cell" | "col"
        )
    {
        p.column = Some(element.to_ascii_uppercase());
    }
    let mut rest = s.as_str();
    while let Some(open) = rest.find('[') {
        let block = &rest[open + 1..];
        let key: String = block
            .chars()
            .take_while(|c| c.is_alphanumeric() || matches!(c, '_' | '.'))
            .collect();
        let after = &block[key.len()..];
        let (op, tail) = if let Some(t) = after.strip_prefix("\\!=") {
            ("!=", t)
        } else if let Some(t) = after.strip_prefix("!=") {
            ("!=", t)
        } else if let Some(t) = after.strip_prefix("\\=") {
            ("=", t)
        } else if let Some(t) = after.strip_prefix('=') {
            ("=", t)
        } else {
            rest = block;
            continue;
        };
        let Some(close) = tail.find(']') else {
            rest = block;
            continue;
        };
        if key.is_empty() {
            rest = block;
            continue;
        }
        let value = tail[..close].trim_matches(['\'', '"']).to_string();
        match (key.to_ascii_lowercase().as_str(), op) {
            ("value", "=") => p.value_eq = Some(value),
            ("value", _) => p.value_ne = Some(value),
            ("type", "=") => p.type_eq = Some(value),
            ("type", _) => p.type_ne = Some(value),
            ("formula", _) => p.has_formula = Some(!value.eq_ignore_ascii_case("false")),
            ("empty", _) => p.empty = Some(!value.eq_ignore_ascii_case("false")),
            (_, "=") => p.format_eq.push((key.clone(), value)),
            _ => p.format_ne.push((key.clone(), value)),
        }
        rest = &tail[close + 1..];
    }
    if let Some(at) = s.find(":contains(") {
        let inner = &s[at + ":contains(".len()..];
        if let Some(close) = inner.find(')').filter(|c| *c > 0) {
            let mut v = &inner[..close];
            v = v.strip_prefix(['\'', '"']).unwrap_or(v);
            v = v.strip_suffix(['\'', '"']).unwrap_or(v);
            if !v.is_empty() {
                p.contains = Some(v.to_string());
            }
        }
    }
    if p.contains.is_none() {
        let head: String = s
            .chars()
            .take_while(|c| c.is_alphanumeric() || *c == '_')
            .collect();
        if let Some(rest) = s[head.len()..].strip_prefix(':') {
            let lower = rest.to_ascii_lowercase();
            if !rest.is_empty()
                && !["contains", "empty", "has", "not"]
                    .iter()
                    .any(|k| lower.starts_with(k))
            {
                p.contains = Some(rest.to_string());
            }
        }
    }
    if s.contains(":not(:empty)") {
        p.empty = Some(false);
    } else if s.contains(":empty") {
        p.empty = Some(true);
    }
    if s.contains(":not(:has(formula))") {
        p.has_formula = Some(false);
    } else if s.contains(":has(formula)") {
        p.has_formula = Some(true);
    }
    p
}

impl Parsed {
    fn cell_matches(&self, doc: &Doc, cell: &super::read::CellData) -> bool {
        if let Some(col) = &self.column {
            if !super::sheet::col_name(cell.col).eq_ignore_ascii_case(col) {
                return false;
            }
        }
        let value = doc.display(cell);
        let raw = doc.compared(cell);
        let hit = |t: &str| value.eq_ignore_ascii_case(t) || raw.eq_ignore_ascii_case(t);
        if self.value_eq.as_deref().is_some_and(|t| !hit(t))
            || self.value_ne.as_deref().is_some_and(hit)
        {
            return false;
        }
        if self
            .contains
            .as_deref()
            .is_some_and(|c| !value.to_lowercase().contains(&c.to_lowercase()))
        {
            return false;
        }
        if self.has_formula.is_some_and(|f| f != cell.has_formula()) {
            return false;
        }
        if self.empty.is_some_and(|e| e != value.is_empty()) {
            return false;
        }
        let kind = type_name(cell);
        if self
            .type_eq
            .as_deref()
            .is_some_and(|t| !kind.eq_ignore_ascii_case(t))
            || self
                .type_ne
                .as_deref()
                .is_some_and(|t| kind.eq_ignore_ascii_case(t))
        {
            return false;
        }
        true
    }

    fn formats_match(&self, node: &Node) -> bool {
        let color_same = |a: &str, b: &str| {
            a.eq_ignore_ascii_case(b)
                || a.trim_start_matches('#')
                    .eq_ignore_ascii_case(b.trim_start_matches('#'))
        };
        for (key, expected) in &self.format_eq {
            match node.get(&alias(key)) {
                Some(v) if color_same(&v.text(), expected) => {}
                _ => return false,
            }
        }
        for (key, expected) in &self.format_ne {
            let actual = node.get(&alias(key)).map(Value::text).unwrap_or_default();
            if color_same(&actual, expected) {
                return false;
            }
        }
        true
    }
}

fn strip_col(key: &str) -> &str {
    for prefix in ["col.", "column."] {
        if starts_ci(key, prefix) && key.len() > prefix.len() {
            return &key[prefix.len()..];
        }
    }
    key
}

/// A table on a sheet: its label, whether its cells form it rather than
/// a definition, its range, whether it has a header row and a totals row,
/// and its column names.
struct Found {
    label: String,
    detected: bool,
    range: Range,
    header: bool,
    totals: bool,
    names: Vec<String>,
}

/// A table a row query may read, its rows of data and its columns found.
struct Candidate {
    sheet: usize,
    label: String,
    detected: bool,
    rows: (u32, u32),
    columns: Vec<(String, u32)>,
}

/// The column `key` names in a table: its header, or its letter inside
/// the table.
fn column_of(key: &str, names: &[String], c1: u32, c2: u32) -> Result<Option<u32>, Fail> {
    let key = strip_col(key);
    if let Some(at) = names.iter().position(|n| n.eq_ignore_ascii_case(key)) {
        if let Some(dup) = names
            .iter()
            .skip(at + 1)
            .position(|n| n.eq_ignore_ascii_case(key))
            .map(|d| d + at + 1)
        {
            let count = names.iter().filter(|n| n.eq_ignore_ascii_case(key)).count();
            return Err(invalid(format!(
                "Column '{key}' is ambiguous: this table has {count} columns with that header. Address it by column letter instead, e.g. '{}' or '{}'.",
                super::sheet::col_name(c1 + at as u32),
                super::sheet::col_name(c1 + dup as u32)
            )));
        }
        return Ok(Some(c1 + at as u32));
    }
    if (1..=3).contains(&key.len()) && key.chars().all(|c| c.is_ascii_alphabetic()) {
        if let Some((_, col)) = cell_ref(&format!("{}1", key.to_ascii_uppercase())) {
            if (c1..=c2).contains(&col) {
                return Ok(Some(col));
            }
        }
    }
    Ok(None)
}

impl Scope<'_> {
    /// The tables of each sheet in scope: those defined, then those the
    /// cells form, each with its label, range and column names.
    fn all_tables(&self, sheet: Option<&str>) -> Vec<(usize, Vec<Found>)> {
        let mut out = Vec::new();
        for (i, entry) in self.doc.sheets.iter().enumerate() {
            if sheet.is_some_and(|s| !s.eq_ignore_ascii_case(&entry.name)) {
                continue;
            }
            let mut list = Vec::new();
            let defined: Vec<Range> = self.tables[i].iter().map(|t| t.range).collect();
            for t in &self.tables[i] {
                list.push(Found {
                    label: t.name.clone(),
                    detected: false,
                    range: t.range,
                    header: t.header,
                    totals: t.totals,
                    names: t.columns.clone(),
                });
            }
            for (range, names) in self.doc.detect_tables(&self.grids[i], &defined) {
                let label = format!(
                    "{}{}:{}{}",
                    super::sheet::col_name(range.0),
                    range.1,
                    super::sheet::col_name(range.2),
                    range.3
                );
                list.push(Found {
                    label,
                    detected: true,
                    range,
                    header: true,
                    totals: false,
                    names,
                });
            }
            out.push((i, list));
        }
        out
    }

    fn column_named(&self, sheet: Option<&str>, key: &str) -> bool {
        self.all_tables(sheet).iter().any(|(_, list)| {
            list.iter()
                .any(|t| t.names.iter().any(|n| n.eq_ignore_ascii_case(key)))
        })
    }

    /// Rows of the one table whose columns the predicates name, kept when
    /// their cells match.
    fn rows_by_column(
        &self,
        sheet: Option<&str>,
        expr: &Expr,
        conds: &[Cond],
    ) -> Result<Vec<Node>, Fail> {
        let mut defined = Vec::new();
        let mut detected = Vec::new();
        let mut scope_tables: Vec<(String, Vec<String>)> = Vec::new();
        for (i, list) in self.all_tables(sheet) {
            for Found {
                label,
                detected: is_detected,
                range: (c1, r1, c2, r2),
                header,
                totals,
                names,
            } in list
            {
                scope_tables.push((label.clone(), names.clone()));
                let mut columns = Vec::new();
                let mut resolved = true;
                for c in conds {
                    match column_of(&c.key, &names, c1, c2)? {
                        Some(col) => columns.push((c.key.clone(), col)),
                        None => {
                            resolved = false;
                            break;
                        }
                    }
                }
                if !resolved {
                    continue;
                }
                let rows = if is_detected {
                    (r1 + 1, r2)
                } else {
                    (r1 + u32::from(header), r2 - u32::from(totals))
                };
                let cand = Candidate {
                    sheet: i,
                    label,
                    detected: is_detected,
                    rows,
                    columns,
                };
                if is_detected {
                    detected.push(cand)
                } else {
                    defined.push(cand)
                }
            }
        }
        let mut candidates = if defined.is_empty() {
            detected
        } else {
            defined
        };
        let scope = sheet.map_or_else(|| "any sheet".to_string(), |s| format!("sheet '{s}'"));
        if candidates.is_empty() {
            let wanted: Vec<&str> = conds.iter().map(|c| strip_col(&c.key)).collect();
            if scope_tables.is_empty() {
                for (i, entry) in self.doc.sheets.iter().enumerate() {
                    if sheet.is_some_and(|s| !s.eq_ignore_ascii_case(&entry.name)) {
                        continue;
                    }
                    for cell in self.grids[i].cells() {
                        let text = self.doc.display(cell);
                        if let Some(w) = wanted.iter().find(|w| w.eq_ignore_ascii_case(&text)) {
                            let at = format!("{}{}", super::sheet::col_name(cell.col), cell.row);
                            return Err(Fail::coded(
                                format!(
                                    "row[col op val] found no usable table on {scope}: a header '{w}' exists at {}!{at}, but the surrounding cells are not a recognizable table. Auto-detection needs at least 2 adjacent non-empty header columns and at least 1 data row; a blank-header column in the middle or a header-only block breaks it. Create the table explicitly (add <file> /{} --type table --prop ref=<A1:D10>), or address cells directly.",
                                    entry.name, entry.name
                                ),
                                "not_found",
                            ));
                        }
                    }
                }
            }
            let cols = wanted
                .iter()
                .map(|w| format!("'{w}'"))
                .collect::<Vec<_>>()
                .join(", ");
            let mut message = format!(
                "row[col op val] found no table on {scope} with column(s) {cols}. Column predicates resolve header names (or column letters) against a ListObject or a detected (header-row) table."
            );
            let shown: Vec<String> = scope_tables
                .iter()
                .map(|(label, names)| (label, names.iter().filter(|n| !n.trim().is_empty()).cloned().collect::<Vec<_>>()))
                .filter(|(_, names)| !names.is_empty())
                .map(|(label, names)| {
                    if names.len() <= 20 {
                        format!("table '{label}' has columns: {}", names.join(", "))
                    } else {
                        let mut ranked: Vec<(usize, &String)> = names.iter().map(|n| (wanted.iter().map(|w| distance(&w.to_lowercase(), &n.to_lowercase())).min().unwrap_or(usize::MAX), n)).collect();
                        ranked.sort_by_key(|(d, _)| *d);
                        let near: Vec<&str> = ranked.iter().take(5).map(|(_, n)| n.as_str()).collect();
                        format!("table '{label}' has {} columns; did you mean: {}? (use 'query \"table\" --json' to list all)", names.len(), near.join(", "))
                    }
                })
                .collect();
            if !shown.is_empty() {
                message.push_str(&format!(" Available: {}.", shown.join("; ")));
            }
            return Err(Fail::coded(message, "not_found"));
        }
        if candidates.len() > 1 {
            let names = &self.doc.sheets;
            let place = candidates
                .iter()
                .map(|c| format!("{}!{}", names[c.sheet].name, c.label))
                .collect::<Vec<_>>()
                .join(", ");
            let mut sheets: Vec<&str> = candidates
                .iter()
                .map(|c| names[c.sheet].name.as_str())
                .collect();
            sheets.dedup();
            let hint = if sheets.len() > 1 {
                "Scope by sheet, e.g. /SheetName/row[...].".to_string()
            } else {
                format!(
                    "Both tables are on '{}', so a sheet scope cannot disambiguate — address the intended table's rows by its cell range directly (e.g. {}!{}).",
                    sheets[0], sheets[0], candidates[0].label
                )
            };
            return Err(invalid(format!(
                "row[col op val] is ambiguous — column(s) exist in {} tables ({place}). {hint}",
                candidates.len()
            )));
        }
        let cand = candidates.remove(0);
        let grid = &self.grids[cand.sheet];
        let sheet_name = &self.doc.sheets[cand.sheet].name;
        let mut out = Vec::new();
        for r in cand.rows.0..=cand.rows.1 {
            let mut probe = Node::new("", "cell");
            for (key, col) in &cand.columns {
                if probe.has(key) {
                    continue;
                }
                let raw = conds
                    .iter()
                    .filter(|c| &c.key == key)
                    .any(|c| ordered(c.op) || c.value.trim().parse::<f64>().is_ok());
                let value = match grid.find(r, *col) {
                    Some(cell) if raw => self.doc.compared(cell),
                    Some(cell) => self.doc.display(cell),
                    None => String::new(),
                };
                probe.str(key, value);
            }
            if !matches_expr(&probe, expr) {
                continue;
            }
            let mut node = Node::new(format!("/{sheet_name}/row[{r}]"), "row");
            node.preview = Some(r.to_string());
            for c in conds {
                let v = probe.get(&c.key).map(Value::text).unwrap_or_default();
                node.str(&c.key, v);
            }
            if conds.iter().any(|c| {
                probe
                    .get(&c.key)
                    .is_some_and(|v| v.text() == "#OCLI_NOTEVAL!")
            }) {
                node.set("evaluated", Value::Bool(false));
            }
            node.str("matchedTable", cand.label.clone());
            if cand.detected {
                node.str("tableSource", "detected");
            }
            let row = grid.rows.iter().find(|x| x.r == r);
            node.child_count = row.map_or(0, |x| x.cells.len());
            if row.is_some_and(|x| x.hidden()) {
                node.flag("hidden");
            }
            out.push(node);
        }
        Ok(out)
    }

    fn note(&self, message: String) {
        self.notes.borrow_mut().push(message);
    }
}
