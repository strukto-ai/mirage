// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! The PowerPoint handler's own pass over a selector, as OfficeCLI's
//! `QueryDispatch` makes it: comma unions, slide gates, the element type
//! a selector names, its `:contains`, title, font and alt filters, and the
//! node each kind of element answers with. Comments, OLE objects, zooms,
//! 3D models and animations answer with none.

use fancy_regex::Regex;

use super::super::Fail;
use super::super::node::{Node, Value};
use super::super::package::{
    contains_ci, contains_text, generic_query, predicates, take_nth, word_char,
};
use super::super::query::{emu, filter_selector};
use super::super::tree::{A, E, M, MC, P};
use super::super::units::format_emu_lossy;
use super::deck::{Graphic, Slide};
use super::text::shape_text;
use super::{A14, Deck, cnvpr_of, fail, id_of, is_title_shape, long, ph_of, segment};

/// A selector as `ParseShapeSelector` reads it.
#[derive(Default)]
struct Selector {
    element: Option<String>,
    slide: Option<usize>,
    contains: Option<String>,
    font_eq: Option<String>,
    font_ne: Option<String>,
    title: Option<bool>,
    alt: Option<bool>,
    /// Key, expected value (`\x01~=` prefixed for a contains match), negated.
    attrs: Vec<(String, String, bool)>,
}

const SHAPE_TYPES: [&str; 23] = [
    "shape",
    "textbox",
    "title",
    "picture",
    "pic",
    "video",
    "audio",
    "equation",
    "math",
    "formula",
    "table",
    "chart",
    "placeholder",
    "connector",
    "connection",
    "group",
    "notes",
    "zoom",
    "slidezoom",
    "tr",
    "row",
    "tc",
    "cell",
];

const KNOWN: [&str; 47] = [
    "slide",
    "shape",
    "textbox",
    "title",
    "picture",
    "pic",
    "video",
    "audio",
    "equation",
    "math",
    "formula",
    "table",
    "chart",
    "placeholder",
    "notes",
    "connector",
    "connection",
    "group",
    "zoom",
    "model3d",
    "3dmodel",
    "slidemaster",
    "slidelayout",
    "theme",
    "media",
    "image",
    "ole",
    "oleobject",
    "object",
    "embed",
    "animation",
    "animate",
    "tc",
    "cell",
    "tr",
    "row",
    "comment",
    "moderncomment",
    "modern-comment",
    "thread",
    "threadedcomment",
    "paragraph",
    "p",
    "run",
    "r",
    "",
    "",
];

fn starts_ci(s: &str, prefix: &str) -> bool {
    s.len() >= prefix.len()
        && s.is_char_boundary(prefix.len())
        && s[..prefix.len()].eq_ignore_ascii_case(prefix)
}

/// `slide[N]` anywhere in `s`: N and what follows `]`.
fn slide_index(s: &str) -> Option<(usize, &str)> {
    let mut from = 0;
    while let Some(at) = s[from..].find("slide[").map(|i| from + i) {
        let rest = &s[at + 6..];
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits > 0 && rest[digits..].starts_with(']') {
            let n = rest[..digits].parse().unwrap_or(usize::MAX);
            return Some((n, &rest[digits + 1..]));
        }
        from = at + 1;
    }
    None
}

/// `slide >` (any case) at the head of `s`: what follows.
fn unindexed_child(s: &str) -> Option<&str> {
    let t = s.trim_start();
    if !starts_ci(t, "slide") {
        return None;
    }
    let rest = t[5..].trim_start().strip_prefix('>')?.trim_start();
    (!rest.is_empty()).then_some(rest)
}

/// `slide X` (any case) at the head of `s`, X starting with a word character: X onward.
fn unindexed_descendant(s: &str) -> Option<&str> {
    let t = s.trim_start();
    if !starts_ci(t, "slide") {
        return None;
    }
    let after = &t[5..];
    let rest = after.trim_start();
    (rest.len() < after.len() && rest.chars().next().is_some_and(word_char)).then_some(rest)
}

/// `A > B` where A is a simple element with predicates: B.
fn remaining_child(s: &str) -> Option<String> {
    let gt = s.find('>')?;
    let head = s[..gt].trim_start();
    let ok = head.chars().next().is_some_and(word_char)
        && head.chars().all(|c| {
            word_char(c) || c.is_whitespace() || matches!(c, '[' | ']' | '=' | '@' | '\'' | '"')
        });
    let rest = s[gt + 1..].trim_start();
    (ok && !rest.is_empty()).then(|| rest.trim().to_string())
}

fn parse_selector(input: &str) -> Selector {
    let mut sel = Selector::default();
    let mut s = input.to_string();
    if let Some((n, rest)) = slide_index(&s) {
        sel.slide = Some(n);
        s = rest
            .trim_start()
            .trim_start_matches(['>', '/', ' '])
            .to_string();
    } else if let Some(rest) = unindexed_child(&s) {
        s = rest.to_string();
    } else if let Some(rest) = unindexed_descendant(&s) {
        s = rest.to_string();
    }
    if let Some(rest) = remaining_child(&s) {
        s = rest;
    }
    let ty: String = s
        .chars()
        .take_while(|c| word_char(*c))
        .collect::<String>()
        .to_lowercase();
    if SHAPE_TYPES.contains(&ty.as_str()) {
        sel.element = Some(ty);
    }
    for (key, op, raw) in predicates(&s) {
        let key = key.to_lowercase();
        let regex_form =
            raw.len() >= 3 && raw.starts_with('r') && matches!(raw.as_bytes()[1], b'"' | b'\'');
        let val = if regex_form {
            raw
        } else {
            raw.trim_matches(['\'', '"']).to_string()
        };
        match (key.as_str(), op.as_str()) {
            ("font", "=") => sel.font_eq = Some(val),
            ("font", "!=") => sel.font_ne = Some(val),
            ("title" | "istitle", _) => sel.title = Some(val.to_lowercase() != "false"),
            ("alt", _) => sel.alt = Some(!val.is_empty() && val.to_lowercase() != "false"),
            _ => {
                let entry = if op == "~=" {
                    (format!("\u{1}~={val}"), false)
                } else {
                    (val, op == "!=")
                };
                match sel.attrs.iter_mut().find(|(k, _, _)| *k == key) {
                    Some(slot) => (slot.1, slot.2) = entry,
                    None => sel.attrs.push((key, entry.0, entry.1)),
                }
            }
        }
    }
    sel.contains = contains_text(&s);
    if sel.contains.is_none() {
        let word: usize = s
            .chars()
            .take_while(|c| word_char(*c))
            .map(char::len_utf8)
            .sum();
        if let Some(rest) = s[word..].strip_prefix(':') {
            let blocked = ["contains", "empty", "no-alt", "has"]
                .iter()
                .any(|p| rest.starts_with(p));
            if !blocked && !rest.is_empty() {
                sel.contains = Some(rest.to_string());
            }
        }
    }
    if sel.element.as_deref() == Some("title") {
        sel.title = Some(true);
    }
    if s.contains(":no-alt") {
        sel.alt = Some(false);
    }
    sel
}

/// The element type `QueryDispatch` dispatches on.
fn raw_type(selector: &str) -> String {
    let mut s = selector.to_string();
    for pseudo in [":empty", ":no-alt"] {
        s = s.replace(pseudo, "");
    }
    while let Some(at) = s.find(":contains(") {
        match s[at..].find(')') {
            Some(end) => s.replace_range(at..at + end + 1, ""),
            None => break,
        }
    }
    let mut cut = None;
    for (i, c) in s.char_indices() {
        if c == ':' && !s[i + 1..].starts_with(['[', '(']) {
            cut = Some(i);
            break;
        }
    }
    if let Some(i) = cut {
        s.truncate(i);
    }
    let mut source: &str = &s;
    let t = source.trim_start();
    let t2 = t.strip_prefix('/').unwrap_or(t);
    let prefixed = t2.strip_prefix("slide[").and_then(|r| {
        let d = r.bytes().take_while(u8::is_ascii_digit).count();
        (d > 0 && r[d..].starts_with(']')).then(|| &r[d + 1..])
    });
    if let Some(rest) = prefixed {
        let rest = rest.trim_start();
        let rest = rest.strip_prefix(['>', '/']).unwrap_or(rest);
        source = rest.trim_start();
    } else if let Some(rest) = unindexed_child(source) {
        source = rest;
    } else if let Some(rest) = unindexed_descendant(source) {
        source = rest;
    }
    source
        .chars()
        .take_while(|c| word_char(*c))
        .collect::<String>()
        .to_lowercase()
}

/// A top-level `,`, outside brackets, parentheses and quotes.
fn top_level_commas(selector: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let (mut bracket, mut paren) = (0i32, 0i32);
    let mut quote: Option<char> = None;
    let mut cur = String::new();
    for c in selector.chars() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            cur.push(c);
            continue;
        }
        match c {
            '"' | '\'' => quote = Some(c),
            '[' => bracket += 1,
            ']' => bracket = (bracket - 1).max(0),
            '(' => paren += 1,
            ')' => paren = (paren - 1).max(0),
            ',' if bracket == 0 && paren == 0 => {
                parts.push(std::mem::take(&mut cur));
                continue;
            }
            _ => {}
        }
        cur.push(c);
    }
    parts.push(cur);
    parts
}

fn unsupported_combinator(selector: &str) -> Option<char> {
    let (mut bracket, mut paren) = (0i32, 0i32);
    let mut quote: Option<char> = None;
    let chars: Vec<char> = selector.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
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
            _ if bracket == 0 && paren == 0 => {
                if c == '+' {
                    return Some('+');
                }
                if c == '~' && chars.get(i + 1) != Some(&'=') {
                    return Some('~');
                }
            }
            _ => {}
        }
    }
    None
}

fn unsupported_descendant(selector: &str) -> Option<String> {
    let t = selector.trim_start();
    if t.is_empty() {
        return None;
    }
    if starts_ci(t, "slide")
        && t[5..].starts_with(|c: char| c.is_whitespace() || c == '>' || c == '[')
    {
        return None;
    }
    let (mut bracket, mut paren) = (0i32, 0i32);
    let mut quote: Option<char> = None;
    let mut saw = false;
    let chars: Vec<(usize, char)> = t.char_indices().collect();
    for (k, &(_, c)) in chars.iter().enumerate() {
        if let Some(q) = quote {
            if c == q {
                quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' => quote = Some(c),
            '[' | '(' => {
                if c == '[' {
                    bracket += 1;
                } else {
                    paren += 1;
                }
                saw = true;
            }
            ']' => bracket = (bracket - 1).max(0),
            ')' => paren = (paren - 1).max(0),
            _ if bracket > 0 || paren > 0 => {}
            _ if c.is_whitespace() => {
                if !saw {
                    continue;
                }
                let mut j = k + 1;
                while j < chars.len() && chars[j].1.is_whitespace() {
                    j += 1;
                }
                let &(pos, next) = chars.get(j)?;
                if matches!(next, '>' | '+' | '~' | ',') {
                    return None;
                }
                if next.is_alphabetic() || matches!(next, '[' | '#' | '.' | ':') {
                    return Some(format!("{}…", &t[..pos]));
                }
            }
            _ => saw = true,
        }
    }
    None
}

fn invalid(message: String, suggestion: &str) -> Fail {
    let mut f = Fail::of(message);
    f.code = Some("invalid_selector");
    f.suggestion = Some(suggestion.to_string());
    f
}

fn normalized_equals(a: &str, b: &str) -> bool {
    if a.eq_ignore_ascii_case(b) {
        return true;
    }
    let (an, bn) = (a.trim_start_matches('#'), b.trim_start_matches('#'));
    (an.len() != a.len() || bn.len() != b.len()) && an.eq_ignore_ascii_case(bn)
}

fn shape_name_matches(actual: &str, expected: &str) -> bool {
    actual.eq_ignore_ascii_case(expected)
        || actual
            .strip_prefix("!!")
            .is_some_and(|a| a.eq_ignore_ascii_case(expected))
        || expected
            .strip_prefix("!!")
            .is_some_and(|e| actual.eq_ignore_ascii_case(e))
}

fn dimension(s: &str) -> bool {
    let l = s.to_lowercase();
    ["cm", "mm", "in", "pt", "px", "emu"]
        .iter()
        .any(|u| l.ends_with(u))
}

/// `MatchesGenericAttributes`: the handler's own pass over a selector's predicates.
fn attrs_match(node: &Node, attrs: &[(String, String, bool)]) -> bool {
    for (key, expected, negate) in attrs {
        let text_key = key.eq_ignore_ascii_case("text");
        let found = node.props().find(|(k, _)| k.eq_ignore_ascii_case(key));
        let has = found.is_some() || (text_key && node.text.is_some());
        let actual = match found {
            Some((_, v)) => v.text(),
            None if text_key => node.text.clone().unwrap_or_default(),
            None => String::new(),
        };
        if let Some(pattern) = expected.strip_prefix("\u{1}~=") {
            if !has {
                return false;
            }
            if pattern.len() >= 3
                && pattern.starts_with('r')
                && matches!(pattern.as_bytes()[1], b'"' | b'\'')
            {
                let q = pattern.as_bytes()[1] as char;
                if let Some(end) = pattern.rfind(q).filter(|e| *e > 1) {
                    if let Ok(rx) = Regex::new(&format!("(?i){}", &pattern[2..end])) {
                        if !rx.is_match(&actual).unwrap_or(false) {
                            return false;
                        }
                        continue;
                    }
                }
            }
            if !contains_ci(&actual, pattern) {
                return false;
            }
            continue;
        }
        let name_key = key.eq_ignore_ascii_case("name");
        let matches = if name_key {
            shape_name_matches(&actual, expected)
        } else {
            normalized_equals(&actual, expected)
        };
        if *negate {
            if has && matches {
                return false;
            }
        } else if has && !matches {
            let close = dimension(&actual)
                && dimension(expected)
                && matches!((emu(&actual), emu(expected)), (Some(a), Some(b)) if (a - b).abs() <= 500.0);
            if !close {
                return false;
            }
        }
    }
    true
}

fn run_font<'t>(run: E<'t>) -> Option<&'t str> {
    let rpr = run.child(A, "rPr")?;
    rpr.child(A, "latin")
        .and_then(|l| l.attr("typeface"))
        .or_else(|| rpr.child(A, "ea").and_then(|l| l.attr("typeface")))
}

fn shape_matches(shape: E<'_>, sel: &Selector) -> bool {
    let ty = sel.element.as_deref();
    if matches!(
        ty,
        Some(
            "picture"
                | "pic"
                | "video"
                | "audio"
                | "table"
                | "chart"
                | "placeholder"
                | "connector"
                | "connection"
                | "group"
                | "notes"
                | "zoom"
                | "tr"
                | "row"
                | "tc"
                | "cell"
        )
    ) {
        return false;
    }
    if ty == Some("textbox") {
        let text_box = super::nv_of(shape)
            .and_then(|n| n.child(P, "cNvSpPr"))
            .and_then(|c| c.attr("txBox"));
        if is_title_shape(shape) || super::boolean(text_box) != Some(true) {
            return false;
        }
    }
    if let Some(t) = sel.title {
        if t != is_title_shape(shape) {
            return false;
        }
    }
    if let Some(c) = &sel.contains {
        if !contains_ci(&shape_text(shape), c) {
            return false;
        }
    }
    let runs = shape.descendants_named(A, "r");
    if let Some(f) = &sel.font_eq {
        if !runs
            .iter()
            .any(|r| run_font(*r).is_some_and(|x| x.eq_ignore_ascii_case(f)))
        {
            return false;
        }
    }
    if let Some(f) = &sel.font_ne {
        if !runs
            .iter()
            .any(|r| run_font(*r).is_some_and(|x| !x.eq_ignore_ascii_case(f)))
        {
            return false;
        }
    }
    true
}

fn picture_matches(pic: E<'_>, sel: &Selector) -> bool {
    if sel
        .element
        .as_deref()
        .is_some_and(|t| !matches!(t, "picture" | "pic" | "video" | "audio"))
    {
        return false;
    }
    if sel.title.is_some() {
        return false;
    }
    if let Some(want) = sel.alt {
        let alt = cnvpr_of(pic)
            .and_then(|c| c.attr("descr"))
            .is_some_and(|a| !a.is_empty());
        if want != alt {
            return false;
        }
    }
    true
}

/// One element a slide renders, with the path of its container and its
/// place among the container's elements of its kind.
struct Renderable<'t> {
    element: E<'t>,
    parent: String,
    kind: &'static str,
    index: usize,
}

fn renderables<'t>(container: E<'t>, parent: &str, out: &mut Vec<Renderable<'t>>) {
    let (mut shape, mut pic, mut tbl, mut chart, mut cxn, mut grp) = (0, 0, 0, 0, 0, 0);
    for child in container.elements() {
        if child.ns() == MC && child.name() == "AlternateContent" {
            continue;
        }
        if child.ns() != P {
            continue;
        }
        let mut push = |element: E<'t>, kind: &'static str, index: usize| {
            out.push(Renderable {
                element,
                parent: parent.to_string(),
                kind,
                index,
            });
        };
        match child.name() {
            "sp" => {
                shape += 1;
                push(child, "shape", shape);
            }
            "pic" => {
                pic += 1;
                push(child, "picture", pic);
            }
            "cxnSp" => {
                cxn += 1;
                push(child, "connector", cxn);
            }
            "graphicFrame" => match Deck::graphic_kind(child) {
                Some(Graphic::Table) => {
                    tbl += 1;
                    push(child, "table", tbl);
                }
                Some(Graphic::Chart) => {
                    chart += 1;
                    push(child, "chart", chart);
                }
                Some(Graphic::Picture) => {
                    let wrapped = child
                        .descendants_named(A, "graphicData")
                        .into_iter()
                        .find(|d| d.attr("uri") == Some(super::PICTURE_URI))
                        .and_then(|d| d.first_named(P, "pic"));
                    if let Some(w) = wrapped {
                        pic += 1;
                        push(w, "picture", pic);
                    }
                }
                Some(Graphic::SmartArt) => {
                    shape += 1;
                    push(child, "smartart", shape);
                }
                None => {}
            },
            "grpSp" => {
                grp += 1;
                push(child, "group", grp);
                let nested = format!("{parent}/{}", segment("group", child, grp));
                renderables(child, &nested, out);
            }
            _ => {}
        }
    }
}

fn direct_content(container: Option<E<'_>>) -> usize {
    container.map_or(0, |c| {
        c.elements()
            .filter(|e| {
                e.ns() == P && matches!(e.name(), "sp" | "pic" | "graphicFrame" | "cxnSp" | "grpSp")
            })
            .count()
    })
}

/// The math elements of a shape's paragraphs: `a14:m`, or one inside an
/// `mc:AlternateContent` choice.
fn shape_math<'t>(shape: E<'t>) -> Vec<E<'t>> {
    let mut out = Vec::new();
    let Some(body) = shape.child(P, "txBody") else {
        return out;
    };
    for para in body.children(A, "p") {
        for child in para.elements() {
            if child.is(A14, "m") {
                out.push(child);
            } else if child.ns() == MC && child.name() == "AlternateContent" {
                if let Some(m) = child.descendants().into_iter().find(|d| d.is(A14, "m")) {
                    out.push(m);
                }
            }
        }
    }
    out
}

fn math_plain(e: E<'_>) -> String {
    e.descendants_named(M, "t")
        .iter()
        .map(|t| t.text())
        .collect()
}

fn collect_text_nodes(
    node: &Node,
    want_run: bool,
    contains: Option<&str>,
    attrs: &[(String, String, bool)],
    out: &mut Vec<Node>,
) {
    for child in &node.children {
        let is_para = matches!(child.kind.as_str(), "paragraph" | "p");
        let is_run = matches!(child.kind.as_str(), "run" | "r");
        if if want_run { is_run } else { is_para } {
            let text_ok =
                contains.is_none_or(|c| contains_ci(child.text.as_deref().unwrap_or_default(), c));
            if text_ok && attrs_match(child, attrs) {
                out.push(child.clone());
            }
        }
        collect_text_nodes(child, want_run, contains, attrs, out);
    }
}

impl<'p> Deck<'p> {
    /// `Query`: the dispatch, then a trailing `[N]` taking the Nth result.
    pub(crate) fn query(&self, selector: &str) -> Result<Vec<Node>, Fail> {
        let results = self.dispatch(selector)?;
        if selector.is_empty() || selector.starts_with('/') || top_level_commas(selector).len() > 1
        {
            return Ok(results);
        }
        let t = selector.trim_end();
        if let Some(body) = t.strip_suffix(']') {
            if let Some(open) = body.rfind('[') {
                let digits = &body[open + 1..];
                let name: String = body[..open]
                    .chars()
                    .rev()
                    .take_while(|c| word_char(*c))
                    .collect();
                if !digits.is_empty()
                    && digits.bytes().all(|b| b.is_ascii_digit())
                    && name
                        .chars()
                        .rev()
                        .collect::<String>()
                        .eq_ignore_ascii_case("slide")
                {
                    return Ok(results);
                }
            }
        }
        Ok(take_nth(selector, results))
    }

    fn dispatch(&self, selector: &str) -> Result<Vec<Node>, Fail> {
        if selector.starts_with('/') {
            let t = selector.trim_start();
            let scoped = t
                .get(..7)
                .is_some_and(|h| h.eq_ignore_ascii_case("/slide["))
                && t[7..].bytes().take_while(u8::is_ascii_digit).count() > 0;
            if !scoped {
                return Err(fail(format!(
                    "Invalid selector '{selector}': path-style selectors starting with '/' are not allowed in query. Use the element name (e.g. 'shape', 'slide') or a typed selector (e.g. 'shape[text=Hello]')."
                )));
            }
        }
        let parts = top_level_commas(selector);
        if !selector.is_empty() && parts.len() > 1 {
            let mut union: Vec<Node> = Vec::new();
            let mut seen: Vec<(String, String)> = Vec::new();
            for part in parts {
                let part = part.trim();
                if part.is_empty() {
                    continue;
                }
                for n in self.query(part)? {
                    let key = (n.path.clone(), n.kind.clone());
                    if !seen.contains(&key) {
                        seen.push(key);
                        union.push(n);
                    }
                }
            }
            return Ok(union);
        }
        if let Some(c) = unsupported_combinator(selector) {
            return Err(invalid(
                format!(
                    "Unsupported combinator '{c}' in selector '{selector}'. `+` (adjacent sibling) and `~` (general sibling) are not supported."
                ),
                "Use a comma list (`chart, table`) for union, or filter on a single element type and post-filter.",
            ));
        }
        if let Some((pred, child)) = slide_gate(selector) {
            let (gated, _) = filter_selector(&format!("slide[{pred}]"), &|s| self.query(s), false)?;
            let mut out = Vec::new();
            for slide in gated {
                let Some(n) = slide
                    .path
                    .strip_prefix("/slide[")
                    .and_then(|r| r.split(']').next())
                    .filter(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
                else {
                    continue;
                };
                out.extend(self.query(&format!("slide[{n}]>{child}"))?);
            }
            return Ok(out);
        }
        if let Some(bad) = unsupported_descendant(selector) {
            return Err(invalid(
                format!(
                    "Unsupported descendant combinator in selector '{selector}': only `slide X` ancestor scoping is supported, not `{bad}`."
                ),
                "Use a slide-scoped form (`slide chart`) or query the inner element directly.",
            ));
        }
        let sel = parse_selector(selector);
        let equation = matches!(
            sel.element.as_deref(),
            Some("equation" | "math" | "formula")
        );
        let raw = raw_type(selector);
        let mut results = Vec::new();
        if !KNOWN.contains(&raw.as_str()) {
            for part in self.slide_parts() {
                generic_query(self.slide(&part)?, selector, &mut results);
            }
            return Ok(results);
        }
        let parts = self.slide_parts();
        let wanted = |num: usize| sel.slide.is_none_or(|s| s == num);
        match raw.as_str() {
            "theme" => {
                results.push(self.theme());
                return Ok(results);
            }
            "slide" => {
                for (i, part) in parts.iter().enumerate() {
                    let num = i + 1;
                    if !wanted(num) {
                        continue;
                    }
                    let node = self.slide_stub(part, num)?;
                    if let Some(c) = &sel.contains {
                        let tree = Self::sp_tree(Some(self.slide(part)?));
                        let all: String = tree
                            .map(|t| {
                                t.descendants_named(A, "t")
                                    .iter()
                                    .map(|x| x.text())
                                    .collect()
                            })
                            .unwrap_or_default();
                        if !contains_ci(&all, c) {
                            continue;
                        }
                    }
                    if attrs_match(&node, &sel.attrs) {
                        results.push(node);
                    }
                }
                return Ok(results);
            }
            "paragraph" | "p" | "run" | "r" => {
                let want_run = matches!(raw.as_str(), "run" | "r");
                for num in 1..=parts.len() {
                    if !wanted(num) {
                        continue;
                    }
                    let slide = self.get(&format!("/slide[{num}]"), 3)?;
                    collect_text_nodes(
                        &slide,
                        want_run,
                        sel.contains.as_deref(),
                        &sel.attrs,
                        &mut results,
                    );
                }
                return Ok(results);
            }
            "slidemaster" => {
                for (mi, master) in self.masters().iter().enumerate() {
                    let root = self.root_of(master);
                    let name = root
                        .and_then(|r| r.child(P, "cSld"))
                        .and_then(|c| c.attr("name"))
                        .unwrap_or("(unnamed)")
                        .to_string();
                    let mut node = Node::new(format!("/slidemaster[{}]", mi + 1), "slidemaster");
                    node.preview = Some(name.clone());
                    node.str("name", name);
                    node.set(
                        "layoutCount",
                        Value::Int(self.layouts_of(master).len() as i64),
                    );
                    if let Some(theme) = self
                        .theme_of_master(Some(master))
                        .and_then(|t| t.attr("name"))
                    {
                        node.str("theme", theme);
                    }
                    let tree = Self::sp_tree(root);
                    let count = tree.map_or(0, |t| {
                        t.children(P, "sp").len() + t.children(P, "pic").len()
                    });
                    node.set("shapeCount", Value::Int(count as i64));
                    results.push(node);
                }
                return Ok(results);
            }
            "slidelayout" => {
                for (i, layout) in self.all_layouts().iter().enumerate() {
                    let root = self.root_of(layout);
                    let name = root
                        .and_then(|r| r.child(P, "cSld"))
                        .and_then(|c| c.attr("name"))
                        .unwrap_or("(unnamed)")
                        .to_string();
                    let mut node = Node::new(format!("/slidelayout[{}]", i + 1), "slidelayout");
                    node.preview = Some(name.clone());
                    node.str("name", name);
                    if let Some(t) = root.and_then(|r| r.attr("type")) {
                        node.str("type", t);
                    }
                    results.push(node);
                }
                return Ok(results);
            }
            "media" | "image" => {
                for (i, part) in parts.iter().enumerate() {
                    let num = i + 1;
                    let Some(tree) = Self::sp_tree(Some(self.slide(part)?)) else {
                        continue;
                    };
                    let (mut pic_idx, mut video_idx, mut audio_idx) = (0, 0, 0);
                    for pic in tree.children(P, "pic") {
                        pic_idx += 1;
                        let nvpr = super::nv_of(pic).and_then(|n| n.child(P, "nvPr"));
                        let video = nvpr.and_then(|n| n.child(A, "videoFile")).is_some();
                        let audio = nvpr.and_then(|n| n.child(A, "audioFile")).is_some();
                        let media = if video {
                            "video"
                        } else if audio {
                            "audio"
                        } else {
                            "picture"
                        };
                        if video {
                            video_idx += 1;
                        } else if audio {
                            audio_idx += 1;
                        }
                        if raw == "image" && media != "picture" {
                            continue;
                        }
                        let mut node =
                            self.picture_node(pic, num, pic_idx, Some(Slide { part, num }), None);
                        node.str("mediaType", media);
                        if raw == "media" && media != "picture" {
                            node.path = format!(
                                "/slide[{num}]/{media}[{}]",
                                if video { video_idx } else { audio_idx }
                            );
                            node.kind = media.to_string();
                        }
                        results.push(node);
                    }
                }
                return Ok(results);
            }
            "notes" => {
                for (i, part) in parts.iter().enumerate() {
                    let num = i + 1;
                    let Some(text) = self.notes_text(part).filter(|t| !t.is_empty()) else {
                        continue;
                    };
                    if sel
                        .contains
                        .as_deref()
                        .is_some_and(|c| !contains_ci(&text, c))
                    {
                        continue;
                    }
                    let mut node = Node::new(format!("/slide[{num}]/notes"), "notes");
                    node.str("text", text.clone());
                    node.text = Some(text);
                    results.push(node);
                }
                return Ok(results);
            }
            "comment" | "moderncomment" | "modern-comment" | "thread" | "threadedcomment"
            | "model3d" | "3dmodel" | "ole" | "oleobject" | "object" | "embed" | "animation"
            | "animate" => {
                return Ok(results);
            }
            _ => {}
        }
        let ty = sel.element.as_deref();
        for (i, part) in parts.iter().enumerate() {
            let num = i + 1;
            if !wanted(num) {
                continue;
            }
            let slide = Slide { part, num };
            let Some(tree) = Self::sp_tree(Some(self.slide(part)?)) else {
                continue;
            };
            let mut all = Vec::new();
            renderables(tree, &format!("/slide[{num}]"), &mut all);
            for y in all.iter().filter(|y| y.kind == "shape") {
                let shape = y.element;
                if equation {
                    for m in shape_math(shape) {
                        let text = math_plain(m);
                        if sel.contains.as_deref().is_none_or(|c| text.contains(c)) {
                            let mut node = Node::new(
                                format!("{}/{}", y.parent, segment("shape", shape, y.index)),
                                "equation",
                            );
                            node.text = Some(text);
                            node.str("mode", "display");
                            results.push(node);
                        }
                    }
                } else if shape_matches(shape, &sel) {
                    let node =
                        self.shape_node(shape, num, y.index, 0, Some(slide), Some(&y.parent));
                    if attrs_match(&node, &sel.attrs) {
                        results.push(node);
                    }
                }
            }
            if matches!(ty, Some("picture" | "pic" | "video" | "audio") | None) {
                for y in all.iter().filter(|y| y.kind == "picture") {
                    let pic = y.element;
                    let nvpr = super::nv_of(pic).and_then(|n| n.child(P, "nvPr"));
                    let video = nvpr.and_then(|n| n.child(A, "videoFile")).is_some();
                    let audio = nvpr.and_then(|n| n.child(A, "audioFile")).is_some();
                    if (ty == Some("video") && !video)
                        || (ty == Some("audio") && !audio)
                        || (matches!(ty, Some("picture" | "pic")) && (video || audio))
                    {
                        continue;
                    }
                    if picture_matches(pic, &sel) {
                        let node =
                            self.picture_node(pic, num, y.index, Some(slide), Some(&y.parent));
                        if attrs_match(&node, &sel.attrs) {
                            results.push(node);
                        }
                    }
                }
            }
            if ty == Some("table") || (ty.is_none() && !equation) {
                for y in all.iter().filter(|y| y.kind == "table") {
                    let node = self.table_node(y.element, num, y.index, 0, Some(&y.parent));
                    if let Some(c) = &sel.contains {
                        let text: String = y
                            .element
                            .descendants_named(A, "t")
                            .iter()
                            .map(|t| t.text())
                            .collect();
                        if !contains_ci(&text, c) {
                            continue;
                        }
                    }
                    results.push(node);
                }
            }
            if matches!(ty, Some("tc" | "cell" | "tr" | "row")) {
                let want_row = matches!(ty, Some("tr" | "row"));
                for y in all.iter().filter(|y| y.kind == "table") {
                    let Some(tbl) = y.element.first_named(A, "tbl") else {
                        continue;
                    };
                    let tbl_path = format!("{}/{}", y.parent, segment("table", y.element, y.index));
                    for (ri, row) in tbl.children(A, "tr").into_iter().enumerate() {
                        let cells = row.children(A, "tc");
                        let cell_text =
                            |c: E<'_>| c.child(A, "txBody").map(|b| b.text()).unwrap_or_default();
                        if want_row {
                            let text = cells
                                .iter()
                                .map(|c| cell_text(*c))
                                .collect::<Vec<_>>()
                                .join(" | ");
                            let mut node = Node::new(format!("{tbl_path}/tr[{}]", ri + 1), "tr");
                            node.child_count = cells.len();
                            if let Some(h) = long(row.attr("h")) {
                                node.str("height", format_emu_lossy(h));
                            }
                            node.text = Some(text.clone());
                            if sel
                                .contains
                                .as_deref()
                                .is_none_or(|c| contains_ci(&text, c))
                                && attrs_match(&node, &sel.attrs)
                            {
                                results.push(node);
                            }
                        } else {
                            for (ci, cell) in cells.iter().enumerate() {
                                let text = cell_text(*cell);
                                let mut node = Node::new(
                                    format!("{tbl_path}/tr[{}]/tc[{}]", ri + 1, ci + 1),
                                    "tc",
                                );
                                node.text = Some(text.clone());
                                if sel
                                    .contains
                                    .as_deref()
                                    .is_none_or(|c| contains_ci(&text, c))
                                    && attrs_match(&node, &sel.attrs)
                                {
                                    results.push(node);
                                }
                            }
                        }
                    }
                }
            }
            if ty == Some("chart") || (ty.is_none() && !equation) {
                for y in all.iter().filter(|y| y.kind == "chart") {
                    let node = self.chart_node(y.element, slide, y.index, Some(&y.parent));
                    if let Some(c) = &sel.contains {
                        let title = node.get("title").map(|v| v.text()).unwrap_or_default();
                        if !contains_ci(&title, c) {
                            continue;
                        }
                    }
                    results.push(node);
                }
            }
            if matches!(ty, Some("connector" | "connection")) || (ty.is_none() && !equation) {
                for y in all.iter().filter(|y| y.kind == "connector") {
                    let node =
                        self.connector_node(y.element, num, y.index, Some(&y.parent), 0, None);
                    if attrs_match(&node, &sel.attrs) {
                        results.push(node);
                    }
                }
            }
            if ty == Some("group") || (ty.is_none() && !equation) {
                for y in all.iter().filter(|y| y.kind == "group") {
                    let grp = y.element;
                    let name = cnvpr_of(grp)
                        .and_then(|c| c.attr("name"))
                        .unwrap_or("Group")
                        .to_string();
                    let mut node = Node::new(
                        format!("{}/{}", y.parent, segment("group", grp, y.index)),
                        "group",
                    );
                    node.preview = Some(name.clone());
                    node.child_count = direct_content(Some(grp));
                    node.str("name", name);
                    if let Some(id) = id_of(grp) {
                        node.set("id", Value::Int(id));
                    }
                    if attrs_match(&node, &sel.attrs) {
                        results.push(node);
                    }
                }
            }
            if ty == Some("placeholder") {
                self.placeholders(tree, slide, &sel, &mut results);
            }
        }
        Ok(results)
    }

    fn placeholders(&self, tree: E<'_>, slide: Slide<'_>, sel: &Selector, out: &mut Vec<Node>) {
        let num = slide.num;
        let mut idx = 0;
        let mut seen: Vec<String> = Vec::new();
        let key = |ph: E<'_>| {
            format!(
                "{}|{}",
                ph.attr("type").unwrap_or_default(),
                ph.attr("idx").unwrap_or_default()
            )
        };
        for shape in tree.children(P, "sp") {
            let Some(ph) = ph_of(shape) else { continue };
            idx += 1;
            seen.push(key(ph));
            if sel
                .contains
                .as_deref()
                .is_some_and(|c| !contains_ci(&shape_text(shape), c))
            {
                continue;
            }
            let mut node = self.shape_node(shape, num, idx, 0, Some(slide), None);
            node.path = format!("/slide[{num}]/placeholder[{idx}]");
            node.kind = "placeholder".to_string();
            if let Some(t) = ph.attr("type") {
                node.str("phType", t);
            }
            if let Some(i) = long(ph.attr("idx")) {
                node.set("phIndex", Value::Int(i));
            }
            out.push(node);
        }
        let layout_tree = self
            .layout_of(slide.part)
            .and_then(|l| self.root_of(&l))
            .and_then(|r| Self::sp_tree(Some(r)));
        let Some(layout_tree) = layout_tree else {
            return;
        };
        for shape in layout_tree.children(P, "sp") {
            let Some(ph) = ph_of(shape) else { continue };
            if seen.contains(&key(ph)) {
                continue;
            }
            idx += 1;
            if sel
                .contains
                .as_deref()
                .is_some_and(|c| !contains_ci(&shape_text(shape), c))
            {
                continue;
            }
            let mut node = self.shape_node(shape, num, idx, 0, Some(slide), None);
            node.path = match ph.attr("type").filter(|t| !t.is_empty()) {
                Some(t) => format!("/slide[{num}]/placeholder[{t}]"),
                None => format!("/slide[{num}]/placeholder[{idx}]"),
            };
            node.kind = "placeholder".to_string();
            if let Some(t) = ph.attr("type") {
                node.str("phType", t);
            }
            if let Some(i) = long(ph.attr("idx")) {
                node.set("phIndex", Value::Int(i));
            }
            node.str("inheritedFrom", "layout");
            out.push(node);
        }
    }

    /// A slide as `query slide` lists it.
    fn slide_stub(&self, part: &str, num: usize) -> Result<Node, Fail> {
        let root = self.slide(part)?;
        let mut node = Node::new(format!("/slide[{num}]"), "slide");
        node.preview = Some(self.slide_preview(part)?);
        if let Some(layout) = self.layout_name(part) {
            node.str("layout", layout);
        }
        if let Some(t) = self
            .layout_of(part)
            .and_then(|l| self.root_of(&l))
            .and_then(|l| l.attr("type"))
        {
            node.str("layoutType", t);
        }
        if let Some(name) = root
            .child(P, "cSld")
            .and_then(|c| c.attr("name"))
            .filter(|n| !n.is_empty())
        {
            node.str("name", name);
        }
        if super::boolean(root.attr("show")) == Some(false) {
            node.set("hidden", Value::Bool(true));
        }
        self.background(root.child(P, "cSld"), &mut node, Some(part));
        super::motion::transition(root, &mut node);
        self.header_footer(part, &mut node)?;
        if let Some(notes) = self.notes_text(part).filter(|n| !n.is_empty()) {
            node.str("notes", notes);
        }
        node.child_count = direct_content(Self::sp_tree(Some(root)));
        Ok(node)
    }
}

/// `slide[<predicate>] > child`, the predicate not an index: both parts.
fn slide_gate(selector: &str) -> Option<(String, String)> {
    let t = selector.trim_start();
    if !starts_ci(t, "slide[") {
        return None;
    }
    let rest = &t[6..];
    let close = rest.find(']')?;
    let pred = &rest[..close];
    if pred.is_empty() || pred.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let child = rest[close + 1..]
        .trim_start()
        .strip_prefix('>')?
        .trim_start();
    (!child.is_empty()).then(|| (pred.to_string(), child.to_string()))
}
