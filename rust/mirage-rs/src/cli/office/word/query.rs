// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! The Word handler's own pass over a selector, as OfficeCLI's
//! `QueryDispatch` makes it: sections, headers, footers and styles, the
//! generic XML query for names it does not know, hyperlinks, bookmarks,
//! content controls, rows and cells, table combinators, then one walk over
//! the body for paragraphs, runs, pictures, equations and tables, and the
//! paragraphs and runs of headers, footers, notes and comments. Fields,
//! comments, notes, charts, revisions, OLE objects and numbering
//! definitions answer with none.

use super::super::errors::Fail;
use super::super::node::{Node, Value};
use super::super::package::{contains_ci, generic_attr, generic_query, word_char};
use super::super::tree::{E, W, WP, is_on, on_off};
use super::super::units::{f2, hex_color};
use super::doc::Word;
use super::{
    all_runs, fail, is_math_wrapper, math_text, para_segment, paragraph_text, row_cells, run_text,
    sdt_segment, t_text, w_child, w_val,
};

/// The element names the handler reads itself; any other goes to the
/// generic XML query.
const KNOWN: [&str; 49] = [
    "",
    "p",
    "paragraph",
    "r",
    "run",
    "picture",
    "image",
    "img",
    "equation",
    "math",
    "formula",
    "bookmark",
    "sdt",
    "contentcontrol",
    "chart",
    "comment",
    "footnote",
    "endnote",
    "field",
    "formfield",
    "editable",
    "table",
    "tbl",
    "row",
    "tr",
    "cell",
    "tc",
    "toc",
    "tableofcontents",
    "style",
    "styles",
    "watermark",
    "revision",
    "media",
    "hyperlink",
    "section",
    "ole",
    "oleobject",
    "object",
    "embed",
    "ptab",
    "positionaltab",
    "fieldchar",
    "fldchar",
    "instrtext",
    "tab",
    "break",
    "br",
    "pagebreak",
];

const RUN_KINDS: [&str; 11] = [
    "r",
    "run",
    "ptab",
    "positionaltab",
    "fieldchar",
    "fldchar",
    "instrtext",
    "tab",
    "break",
    "br",
    "pagebreak",
];

/// A selector as `ParseSelector` reads it.
struct Part {
    element: Option<String>,
    /// Key and expected value, `!` leading a negated one, in selector order.
    attrs: Vec<(String, String)>,
    contains: Option<String>,
    child: Option<Box<Part>>,
}

impl Part {
    fn has(&self, key: &str) -> bool {
        self.attrs.iter().any(|(k, _)| k == key)
    }

    fn is(&self, names: &[&str]) -> bool {
        self.element.as_deref().is_some_and(|e| names.contains(&e))
    }
}

fn parse(selector: &str) -> Result<Part, Fail> {
    let mut depth = 0i32;
    for (i, c) in selector.char_indices() {
        match c {
            '[' => depth += 1,
            ']' => depth -= 1,
            '>' if depth == 0 => {
                let mut main = parse_single(selector[..i].trim())?;
                main.child = Some(Box::new(parse_single(selector[i + 1..].trim())?));
                return Ok(main);
            }
            _ => {}
        }
    }
    parse_single(selector)
}

/// Every `[@key op value]`, as `\[@?(\w+)(\\?!?=)([^\]]+)\]` finds them.
fn predicates(s: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let mut i = 0;
    while let Some(at) = s[i..].find('[').map(|x| i + x) {
        let mut rest = &s[at + 1..];
        rest = rest.strip_prefix('@').unwrap_or(rest);
        let key_len: usize = rest
            .chars()
            .take_while(|c| word_char(*c))
            .map(char::len_utf8)
            .sum();
        let after = &rest[key_len..];
        let t = after.strip_prefix('\\').unwrap_or(after);
        let (negate, op_len) = if t.starts_with("!=") {
            (true, after.len() - t.len() + 2)
        } else if t.starts_with('=') {
            (false, after.len() - t.len() + 1)
        } else {
            (false, 0)
        };
        if key_len > 0 && op_len > 0 {
            let value = &after[op_len..];
            if let Some(end) = value.find(']').filter(|e| *e > 0) {
                let key = rest[..key_len].to_string();
                let val = format!(
                    "{}{}",
                    if negate { "!" } else { "" },
                    value[..end].trim_matches(['\'', '"'])
                );
                match out.iter_mut().find(|(k, _)| *k == key) {
                    Some(slot) => slot.1 = val,
                    None => out.push((key, val)),
                }
                i = at + 1 + (s[at + 1..].len() - value.len()) + end + 1;
                continue;
            }
        }
        i = at + 1;
    }
    out
}

fn parse_single(selector: &str) -> Result<Part, Fail> {
    let bracket = selector.find('[');
    let first = [bracket, selector.find(':')]
        .into_iter()
        .flatten()
        .min()
        .unwrap_or(selector.len());
    let element = selector[..first].trim().to_lowercase();
    let mut attrs = Vec::new();
    if let Some(b) = bracket {
        let tail = &selector[b..];
        if tail.matches('[').count() != tail.matches(']').count() {
            return Err(fail(format!(
                "Malformed selector: unclosed bracket in '{selector}'"
            )));
        }
        attrs = predicates(tail);
    }
    let contains = selector.find(":contains(").and_then(|at| {
        selector[at + 10..].find(')').map(|end| {
            selector[at + 10..at + 10 + end]
                .trim_matches(['\'', '"'])
                .to_string()
        })
    });
    for (pseudo, key) in [(":empty", "__empty"), (":no-alt", "__no-alt")] {
        if selector.contains(pseudo) {
            match attrs.iter_mut().find(|(k, _)| k == key) {
                Some(slot) => slot.1 = "true".to_string(),
                None => attrs.push((key.to_string(), "true".to_string())),
            }
        }
    }
    Ok(Part {
        element: (!element.is_empty()).then_some(element),
        attrs,
        contains,
        child: None,
    })
}

/// The element name `GenericXmlQuery.ParseSelector` reads off a selector.
fn generic_element(selector: &str) -> String {
    let first = [
        selector.find('['),
        selector.find(":contains("),
        selector.find(":empty"),
        selector.find(":no-alt"),
    ]
    .into_iter()
    .flatten()
    .min()
    .unwrap_or(selector.len());
    selector[..first].trim().to_lowercase()
}

/// A handler-level predicate pass over a node's own properties, keys
/// matched exactly, values without case.
fn handler_attrs_ok(node: &Node, attrs: &[(String, String)]) -> bool {
    attrs.iter().all(|(key, raw)| {
        let (negate, want) = match raw.strip_prefix('!') {
            Some(v) => (true, v),
            None => (false, raw.as_str()),
        };
        let hit = node
            .props()
            .find(|(k, _)| k == key)
            .is_some_and(|(_, v)| v.text().eq_ignore_ascii_case(want));
        hit != negate
    })
}

fn text_ok(node: &Node, contains: Option<&str>) -> bool {
    contains.is_none_or(|c| contains_ci(node.text.as_deref().unwrap_or_default(), c))
}

fn first_text_run<'t>(para: E<'t>) -> Option<E<'t>> {
    para.children(W, "r")
        .into_iter()
        .find(|r| r.child(W, "t").is_some())
}

fn run_font(run: E<'_>) -> Option<String> {
    let fonts = w_child(run.child(W, "rPr"), "rFonts")?;
    fonts
        .w("ascii")
        .or_else(|| fonts.w("hAnsi"))
        .or_else(|| fonts.w("eastAsia"))
        .map(str::to_string)
}

fn run_font_size(run: E<'_>) -> Option<String> {
    let size: i64 = w_val(w_child(run.child(W, "rPr"), "sz"))?
        .trim()
        .parse()
        .ok()?;
    Some(format!("{}pt", f2(size as f64 / 2.0)))
}

fn color_key(raw: Option<String>) -> Option<String> {
    raw.map(|s| {
        let t = s.trim();
        t.strip_prefix('#').unwrap_or(t).to_uppercase()
    })
}

fn has_rpr(run: Option<E<'_>>, name: &str) -> &'static str {
    if w_child(w_child(run, "rPr"), name).is_some() {
        "true"
    } else {
        "false"
    }
}

fn run_matches(run: E<'_>, part: &Part) -> bool {
    let element = part.element.as_deref();
    if element.is_some_and(|e| !RUN_KINDS.contains(&e)) {
        return false;
    }
    let no_text = run.child(W, "t").is_none();
    let ok = match element {
        Some("ptab" | "positionaltab") => run.child(W, "ptab").is_some(),
        Some("fieldchar" | "fldchar") => run.child(W, "fldChar").is_some(),
        Some("instrtext") => run.child(W, "instrText").is_some(),
        Some("tab") => run.child(W, "tab").is_some() && no_text,
        Some("break" | "br" | "pagebreak") => run.child(W, "br").is_some() && no_text,
        _ => true,
    };
    if !ok {
        return false;
    }
    let rpr = run.child(W, "rPr");
    let ptab = run.child(W, "ptab");
    for (key, raw) in &part.attrs {
        if key.eq_ignore_ascii_case("text") || key.eq_ignore_ascii_case("type") {
            continue;
        }
        let (negate, mut want) = match raw.strip_prefix('!') {
            Some(v) => (true, v.to_string()),
            None => (false, raw.clone()),
        };
        let lower = key.to_lowercase();
        let mut actual: Option<String> = match lower.as_str() {
            "font" => run_font(run),
            "size" => run_font_size(run),
            "bold" => Some(has_rpr(Some(run), "b").to_string()),
            "italic" => Some(has_rpr(Some(run), "i").to_string()),
            "align" | "alignment" => ptab.and_then(|p| p.w("alignment")).map(str::to_string),
            "relativeto" => ptab.and_then(|p| p.w("relativeTo")).map(str::to_string),
            "leader" => ptab.and_then(|p| p.w("leader")).map(str::to_string),
            "rtl" | "direction" | "dir" | "bidi" => w_child(rpr, "rtl").map(|r| {
                let rtl_key = lower == "rtl";
                match on_off(r.w("val")) {
                    Some(on) if rtl_key => (if on { "true" } else { "false" }).to_string(),
                    Some(on) => (if on { "rtl" } else { "ltr" }).to_string(),
                    None if rtl_key => "true".to_string(),
                    None => "rtl".to_string(),
                }
            }),
            "fieldchartype" => run
                .child(W, "fldChar")
                .and_then(|f| f.w("fldCharType"))
                .map(str::to_string),
            "instr" => run.child(W, "instrText").map(|i| i.text()),
            "breaktype" => run
                .child(W, "br")
                .and_then(|b| b.w("type"))
                .map(str::to_string),
            _ => generic_attr(run, key).or_else(|| rpr.and_then(|r| generic_attr(r, key))),
        };
        if lower == "color" {
            actual = color_key(actual);
            want = color_key(Some(want.clone())).unwrap_or(want);
        }
        let hit = actual.is_some_and(|a| a.eq_ignore_ascii_case(&want));
        if hit == negate {
            return false;
        }
    }
    part.contains
        .as_deref()
        .is_none_or(|c| run_text(run).contains(c))
}

impl<'p> Word<'p> {
    fn list_style(&self, para: E<'_>) -> Option<String> {
        let num_pr = w_child(para.child(W, "pPr"), "numPr");
        let direct: Option<i64> =
            w_val(w_child(num_pr, "numId")).and_then(|v| v.trim().parse().ok());
        if num_pr.is_some() && direct == Some(0) {
            return None;
        }
        let kind = |fmt: String| {
            if fmt.eq_ignore_ascii_case("bullet") {
                "bullet"
            } else {
                "ordered"
            }
            .to_string()
        };
        if let Some(nid) = direct.filter(|n| *n != 0) {
            let ilvl: i64 = w_val(w_child(num_pr, "ilvl"))
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(0);
            return Some(kind(self.numbering_format(nid, ilvl.clamp(0, 8))));
        }
        let name = self.style_name(para);
        if !name.is_empty()
            && (name.contains("Heading")
                || name.contains("标题")
                || name.to_lowercase().starts_with("heading")
                || name == "Title"
                || name == "Subtitle")
        {
            return None;
        }
        let (nid, ilvl) = self.num_pr_from_style(para)?;
        if nid == 0 {
            return None;
        }
        Some(kind(self.numbering_format(nid, ilvl.clamp(0, 8))))
    }

    fn paragraph_attrs_match(&self, para: E<'_>, attrs: &[(String, String)], meta: bool) -> bool {
        let ppr = para.child(W, "pPr");
        let first = first_text_run(para);
        for (key, raw) in attrs {
            if key == "__empty" {
                continue;
            }
            let (negate, want) = match raw.strip_prefix('!') {
                Some(v) => (true, v),
                None => (false, raw.as_str()),
            };
            if key.eq_ignore_ascii_case("text") || key.eq_ignore_ascii_case("type") {
                if !meta {
                    continue;
                }
                let hit = if key.eq_ignore_ascii_case("type") {
                    want.eq_ignore_ascii_case("paragraph") || want.eq_ignore_ascii_case("p")
                } else {
                    paragraph_text(para).eq_ignore_ascii_case(want)
                };
                if hit == negate {
                    return false;
                }
                continue;
            }
            let lower = key.to_lowercase();
            let bidi = w_child(ppr, "bidi");
            let actual: Option<String> = match lower.as_str() {
                "style" | "stylename" => Some(self.style_name(para)),
                "styleid" => w_val(w_child(ppr, "pStyle")).map(str::to_string),
                "align" | "alignment" => w_val(w_child(ppr, "jc")).map(str::to_string),
                "firstlineindent" => w_child(ppr, "ind")
                    .and_then(|i| i.w("firstLine"))
                    .map(str::to_string),
                "numid" => w_val(w_child(w_child(ppr, "numPr"), "numId"))
                    .and_then(|v| v.trim().parse::<i64>().ok())
                    .map(|n| n.to_string()),
                "numlevel" | "ilvl" => w_val(w_child(w_child(ppr, "numPr"), "ilvl"))
                    .and_then(|v| v.trim().parse::<i64>().ok())
                    .map(|n| n.to_string()),
                "liststyle" => self.list_style(para),
                "direction" | "dir" | "bidi" => bidi
                    .and_then(|b| on_off(b.w("val")))
                    .map(|on| (if on { "rtl" } else { "ltr" }).to_string()),
                "rtl" => Some(
                    match bidi {
                        None => "false",
                        Some(b) => match on_off(b.w("val")) {
                            Some(false) => "false",
                            _ => "true",
                        },
                    }
                    .to_string(),
                ),
                "bold" => Some(has_rpr(first, "b").to_string()),
                "italic" => Some(has_rpr(first, "i").to_string()),
                "font" => first.and_then(run_font),
                "size" => first.and_then(run_font_size),
                "color" => w_val(w_child(w_child(first, "rPr"), "color")).map(hex_color),
                "underline" => w_val(w_child(w_child(first, "rPr"), "u")).map(str::to_string),
                "strike" => Some(has_rpr(first, "strike").to_string()),
                "highlight" => {
                    w_val(w_child(w_child(first, "rPr"), "highlight")).map(str::to_string)
                }
                _ => generic_attr(para, key).or_else(|| ppr.and_then(|p| generic_attr(p, key))),
            };
            let mut hit = actual
                .as_deref()
                .is_some_and(|a| a.eq_ignore_ascii_case(want));
            if lower == "style" {
                hit = hit
                    || w_val(w_child(ppr, "pStyle")).is_some_and(|s| s.eq_ignore_ascii_case(want));
            }
            if hit == negate {
                return false;
            }
        }
        true
    }

    fn paragraph_matches(&self, para: E<'_>, part: &Part) -> bool {
        let para_element = part.element.is_none() || part.is(&["p", "paragraph"]);
        if part.child.is_some() {
            return para_element && self.paragraph_attrs_match(para, &part.attrs, true);
        }
        if !para_element || !self.paragraph_attrs_match(para, &part.attrs, false) {
            return false;
        }
        if part.has("__empty") {
            return paragraph_text(para).trim().is_empty();
        }
        part.contains
            .as_deref()
            .is_none_or(|c| paragraph_text(para).contains(c))
    }

    fn picture_node(&self, drawing: E<'_>, path: String) -> Node {
        let mut node = self.image(drawing);
        node.path = path;
        node
    }

    fn no_alt(drawing: E<'_>) -> bool {
        drawing
            .descendants()
            .into_iter()
            .find(|d| d.is(WP, "docPr"))
            .and_then(|d| d.attr("descr"))
            .is_none_or(str::is_empty)
    }

    /// The handler's own pass over a selector.
    pub(crate) fn query(&self, selector: &str) -> Result<Vec<Node>, Fail> {
        let Some(body) = self.body() else {
            return Ok(Vec::new());
        };
        if selector.trim() == "*" {
            let mut paras: std::collections::VecDeque<Node> = self
                .query("paragraph")?
                .into_iter()
                .filter(|n| n.path.starts_with("/body/p["))
                .collect();
            let mut tables: std::collections::VecDeque<Node> = self
                .query("table")?
                .into_iter()
                .filter(|n| n.path.to_lowercase().starts_with("/body/tbl["))
                .collect();
            let mut out = Vec::new();
            for child in body.elements() {
                if child.is(W, "p") {
                    if let Some(n) = paras.pop_front() {
                        out.push(n);
                    }
                } else if child.is(W, "tbl") {
                    if let Some(n) = tables.pop_front() {
                        out.push(n);
                    }
                }
            }
            out.extend(paras);
            out.extend(tables);
            return Ok(out);
        }
        if ole_scope(selector) {
            return Ok(Vec::new());
        }
        let part = parse(selector)?;
        let element = part.element.as_deref().unwrap_or_default();
        let contains_cs = |n: &Node| {
            part.contains
                .as_deref()
                .is_none_or(|c| n.text.as_deref().unwrap_or_default().contains(c))
        };
        match element {
            "section" => {
                return Ok(self
                    .sections()
                    .into_iter()
                    .enumerate()
                    .map(|(i, s)| self.section(s, &format!("/section[{}]", i + 1)))
                    .filter(|n| contains_cs(n))
                    .collect());
            }
            "header" | "footer" => {
                let count = if element == "header" {
                    self.header_parts.len()
                } else {
                    self.footer_parts.len()
                };
                let mut out = Vec::new();
                for i in 0..count {
                    if let Ok(node) = self.get(&format!("/{element}[{}]", i + 1), 0) {
                        if node.kind != "error" && contains_cs(&node) {
                            out.push(node);
                        }
                    }
                }
                return Ok(out);
            }
            "style" => {
                let mut out = Vec::new();
                for style in self
                    .styles()
                    .map(|s| s.children(W, "style"))
                    .unwrap_or_default()
                {
                    let id = style.w("styleId").unwrap_or_default();
                    let name = w_val(style.child(W, "name")).unwrap_or(id);
                    if part
                        .contains
                        .as_deref()
                        .is_some_and(|c| !contains_ci(name, c))
                    {
                        continue;
                    }
                    let node = Self::style_stub(style, id, name);
                    if handler_attrs_ok(&node, &part.attrs) {
                        out.push(node);
                    }
                }
                return Ok(out);
            }
            "watermark" | "styles" | "numbering" | "abstractnum" | "num" | "toc"
            | "tableofcontents" | "field" | "formfield" | "editable" => return Ok(Vec::new()),
            _ => {}
        }
        if part.child.is_none() && !KNOWN.contains(&generic_element(selector).as_str()) {
            let mut out = Vec::new();
            if let Ok(doc) = self.document() {
                generic_query(doc, selector, &mut out);
            }
            for n in &mut out {
                if let Some(rest) = n.path.strip_prefix("/document[1]/body[1]") {
                    n.path = format!("/body{rest}");
                } else if n.path == "/document[1]" {
                    n.path = "/".to_string();
                }
            }
            return Ok(out);
        }
        if part.child.is_none() {
            match element {
                "media" | "chart" | "comment" | "footnote" | "endnote" | "revision" => {
                    return Ok(Vec::new());
                }
                "hyperlink" => return Ok(self.hyperlinks(body, &part)),
                "bookmark" => return Ok(self.bookmarks(body, &part)),
                "sdt" | "contentcontrol" => return Ok(self.content_controls(body, &part)),
                "row" | "tr" | "cell" | "tc" => {
                    return Ok(self.rows_or_cells(body, &part, matches!(element, "row" | "tr")));
                }
                _ => {}
            }
        }
        if let Some(child) = &part.child {
            let table = part.is(&["table", "tbl"]);
            let row = part.is(&["row", "tr"]);
            let want_row = table && child.is(&["row", "tr"]);
            let want_cell = (table || row) && child.is(&["cell", "tc"]);
            if want_row || want_cell {
                return Ok(self.combinator(body, child, want_row));
            }
        }
        let mut out = Vec::new();
        self.walk_body(body, &part, &mut out);
        let combinator =
            part.child.is_some() && (part.element.is_none() || part.is(&["p", "paragraph"]));
        let para_sel = part.child.is_none() && part.is(&["p", "paragraph"]);
        let run_sel = part.child.is_none() && part.is(&RUN_KINDS);
        if para_sel || run_sel || combinator {
            for (i, h) in self.header_parts.iter().enumerate() {
                if let Some(root) = self.part_root(h) {
                    self.collect_part(
                        root,
                        &format!("/header[{}]", i + 1),
                        &part,
                        para_sel,
                        run_sel,
                        &mut out,
                    );
                }
            }
            for (i, f) in self.footer_parts.iter().enumerate() {
                if let Some(root) = self.part_root(f) {
                    self.collect_part(
                        root,
                        &format!("/footer[{}]", i + 1),
                        &part,
                        para_sel,
                        run_sel,
                        &mut out,
                    );
                }
            }
            for (kind, child, prefix) in [
                ("footnotes", "footnote", "footnote"),
                ("endnotes", "endnote", "endnote"),
                ("comments", "comment", "comment"),
            ] {
                if let Some(root) = self.part_of(kind) {
                    for (i, note) in root.children(W, child).into_iter().enumerate() {
                        self.collect_part(
                            note,
                            &format!("/{prefix}[{}]", i + 1),
                            &part,
                            para_sel,
                            run_sel,
                            &mut out,
                        );
                    }
                }
            }
        }
        Ok(out)
    }

    fn walk_body(&self, body: E<'p>, part: &Part, out: &mut Vec<Node>) {
        let child_none = part.child.is_none();
        let para_sel = child_none && part.is(&["p", "paragraph"]);
        let run_sel = child_none && part.is(&RUN_KINDS);
        let picture_sel = child_none && part.is(&["picture", "image", "img"]);
        let ole_sel = child_none && part.is(&["ole", "oleobject", "object", "embed"]);
        let equation_sel = child_none && part.is(&["equation", "math", "formula"]);
        let table_sel = child_none && part.is(&["table", "tbl"]);
        let contains = part.contains.as_deref();
        let mut para_idx: usize = 0;
        let mut math_idx: usize = 0;
        let tables = body.children(W, "tbl");
        let sdts = body.children(W, "sdt");
        for element in body.elements() {
            if element.is(W, "sdt") {
                if !para_sel {
                    continue;
                }
                let at = sdts.iter().position(|s| *s == element).map_or(1, |i| i + 1);
                let seg = sdt_segment(element, at);
                let Some(content) = element.child(W, "sdtContent") else {
                    continue;
                };
                for (i, p) in content.children(W, "p").into_iter().enumerate() {
                    let node =
                        self.element(p, &format!("/body/{seg}/{}", para_segment(p, i + 1)), 0);
                    if text_ok(&node, contains) && handler_attrs_ok(&node, &part.attrs) {
                        out.push(node);
                    }
                }
                continue;
            }
            if element.name() == "oMathPara" {
                math_idx += 1;
                if equation_sel {
                    push_equation(
                        out,
                        format!("/body/oMathPara[{math_idx}]"),
                        element,
                        "display",
                        contains,
                    );
                }
                continue;
            }
            if element.is(W, "tbl") {
                let ti = tables
                    .iter()
                    .position(|t| *t == element)
                    .map_or(1, |i| i + 1);
                if table_sel {
                    let node = self.element(element, &format!("/body/tbl[{ti}]"), 0);
                    if contains.is_none_or(|c| contains_ci(&t_text(element), c)) {
                        out.push(node);
                    }
                } else if ole_sel {
                } else if equation_sel || para_sel || run_sel || picture_sel {
                    for (ri, row) in element.children(W, "tr").into_iter().enumerate() {
                        for (ci, cell) in row_cells(row).into_iter().enumerate() {
                            let cell_path =
                                format!("/body/tbl[{ti}]/tr[{}]/tc[{}]", ri + 1, ci + 1);
                            for (pi, para) in cell.children(W, "p").into_iter().enumerate() {
                                let pos = pi + 1;
                                if equation_sel {
                                    if let Some(display) =
                                        para.elements().find(|e| e.name() == "oMathPara")
                                    {
                                        math_idx += 1;
                                        push_equation(
                                            out,
                                            format!("{cell_path}/oMathPara[{math_idx}]"),
                                            display,
                                            "display",
                                            contains,
                                        );
                                        continue;
                                    }
                                    for (mi, m) in
                                        para.elements().filter(|e| e.name() == "oMath").enumerate()
                                    {
                                        push_equation(
                                            out,
                                            format!("{cell_path}/p[{pos}]/oMath[{}]", mi + 1),
                                            m,
                                            "inline",
                                            contains,
                                        );
                                    }
                                } else if para_sel {
                                    let node = self.element(
                                        para,
                                        &format!("{cell_path}/{}", para_segment(para, pos)),
                                        0,
                                    );
                                    if text_ok(&node, contains)
                                        && handler_attrs_ok(&node, &part.attrs)
                                    {
                                        out.push(node);
                                    }
                                } else {
                                    for (k, run) in all_runs(para).into_iter().enumerate() {
                                        let path = format!(
                                            "{cell_path}/{}/r[{}]",
                                            para_segment(para, pos),
                                            k + 1
                                        );
                                        if run_sel {
                                            if run_matches(run, part) {
                                                out.push(self.element(run, &path, 0));
                                            }
                                        } else if let Some(drawing) = run.child(W, "drawing") {
                                            if !part.has("__no-alt") || Self::no_alt(drawing) {
                                                out.push(self.picture_node(drawing, path));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                continue;
            }
            if !element.is(W, "p") {
                continue;
            }
            if is_math_wrapper(element) {
                math_idx += 1;
                if equation_sel {
                    if let Some(display) = element.elements().find(|e| e.name() == "oMathPara") {
                        push_equation(
                            out,
                            format!("/body/oMathPara[{math_idx}]"),
                            display,
                            "display",
                            contains,
                        );
                    }
                }
                continue;
            }
            para_idx += 1;
            let seg = para_segment(element, para_idx);
            if equation_sel {
                for (mi, m) in element
                    .elements()
                    .filter(|e| e.name() == "oMath")
                    .enumerate()
                {
                    push_equation(
                        out,
                        format!("/body/{seg}/oMath[{}]", mi + 1),
                        m,
                        "inline",
                        contains,
                    );
                }
            } else if picture_sel {
                for (k, run) in all_runs(element).into_iter().enumerate() {
                    if let Some(drawing) = run.child(W, "drawing") {
                        if !part.has("__no-alt") || Self::no_alt(drawing) {
                            out.push(
                                self.picture_node(drawing, format!("/body/{seg}/r[{}]", k + 1)),
                            );
                        }
                    }
                }
            } else if ole_sel {
            } else if run_sel {
                for (k, run) in all_runs(element).into_iter().enumerate() {
                    if run_matches(run, part) {
                        out.push(self.element(run, &format!("/body/{seg}/r[{}]", k + 1), 0));
                    }
                }
            } else if let Some(child) = &part.child {
                if self.paragraph_matches(element, part) {
                    for (k, run) in all_runs(element).into_iter().enumerate() {
                        if run_matches(run, child) {
                            out.push(self.element(run, &format!("/body/{seg}/r[{}]", k + 1), 0));
                        }
                    }
                }
            } else if self.paragraph_matches(element, part) {
                out.push(self.element(element, &format!("/body/{seg}"), 0));
            }
        }
    }

    fn collect_part(
        &self,
        root: E<'p>,
        prefix: &str,
        part: &Part,
        para_sel: bool,
        run_sel: bool,
        out: &mut Vec<Node>,
    ) {
        for (i, para) in root.children(W, "p").into_iter().enumerate() {
            let seg = format!("{prefix}/{}", para_segment(para, i + 1));
            if para_sel {
                let node = self.element(para, &seg, 0);
                if text_ok(&node, part.contains.as_deref()) && handler_attrs_ok(&node, &part.attrs)
                {
                    out.push(node);
                }
            } else if run_sel {
                for (k, run) in all_runs(para).into_iter().enumerate() {
                    if run_matches(run, part) {
                        out.push(self.element(run, &format!("{seg}/r[{}]", k + 1), 0));
                    }
                }
            } else if let Some(child) = &part.child {
                if !part.attrs.is_empty()
                    && !handler_attrs_ok(&self.element(para, &seg, 0), &part.attrs)
                {
                    continue;
                }
                for (k, run) in all_runs(para).into_iter().enumerate() {
                    if run_matches(run, child) {
                        out.push(self.element(run, &format!("{seg}/r[{}]", k + 1), 0));
                    }
                }
            }
        }
    }

    fn combinator(&self, body: E<'p>, child: &Part, want_row: bool) -> Vec<Node> {
        let mut out = Vec::new();
        let keep = |n: &Node| {
            child
                .contains
                .as_deref()
                .is_none_or(|c| contains_ci(n.text.as_deref().unwrap_or_default(), c))
        };
        for (ti, tbl) in body.children(W, "tbl").into_iter().enumerate() {
            for (ri, row) in tbl.children(W, "tr").into_iter().enumerate() {
                let row_path = format!("/body/tbl[{}]/tr[{}]", ti + 1, ri + 1);
                if want_row {
                    let node = self.element(row, &row_path, 0);
                    if keep(&node) {
                        out.push(node);
                    }
                    continue;
                }
                for (ci, cell) in row_cells(row).into_iter().enumerate() {
                    let node = self.element(cell, &format!("{row_path}/tc[{}]", ci + 1), 0);
                    if keep(&node) {
                        out.push(node);
                    }
                }
            }
        }
        out
    }

    fn hyperlinks(&self, body: E<'p>, part: &Part) -> Vec<Node> {
        let mut out = Vec::new();
        for hl in body.descendants_named(W, "hyperlink") {
            if part
                .contains
                .as_deref()
                .is_some_and(|c| !contains_ci(&t_text(hl), c))
            {
                continue;
            }
            let para = hl.ancestor(W, "p");
            let mut p_idx = 1;
            let mut in_para = 1;
            if let Some(para) = para {
                for el in body.elements() {
                    if el == para {
                        break;
                    }
                    if el.is(W, "p") {
                        p_idx += 1;
                    }
                }
                for child in para.elements() {
                    if child == hl {
                        break;
                    }
                    if child.is(W, "hyperlink") {
                        in_para += 1;
                    }
                }
            }
            let segment = match para {
                Some(p) => para_segment(p, p_idx),
                None => format!("p[{p_idx}]"),
            };
            let node = self.element(hl, &format!("/body/{segment}/hyperlink[{in_para}]"), 0);
            if handler_attrs_ok(&node, &part.attrs) {
                out.push(node);
            }
        }
        out
    }

    fn bookmarks(&self, body: E<'p>, part: &Part) -> Vec<Node> {
        let mut out = Vec::new();
        for bk in body.descendants_named(W, "bookmarkStart") {
            let name = bk.w("name").unwrap_or_default();
            if name.starts_with('_') {
                continue;
            }
            let node = self.element(bk, &format!("/bookmark[@name={name}]"), 0);
            if text_ok(&node, part.contains.as_deref()) {
                out.push(node);
            }
        }
        out
    }

    /// `BuildSdtPath`: a content control's path through the blocks above it.
    fn sdt_path(body: E<'p>, sdt: E<'p>) -> String {
        let mut path = "/body".to_string();
        let mut cursor = body;
        let chain: Vec<E<'p>> = sdt
            .ancestors()
            .into_iter()
            .take_while(|a| *a != body)
            .collect();
        let position = |cursor: E<'p>, name: &str, e: E<'p>| {
            cursor
                .elements()
                .filter(|c| c.is(W, name))
                .take_while(|c| *c != e)
                .count()
                + 1
        };
        for anc in chain.into_iter().rev() {
            if anc.ns() != W {
                continue;
            }
            match anc.name() {
                "sdt" => {
                    let i = position(cursor, "sdt", anc);
                    path.push_str(&format!("/{}", sdt_segment(anc, i)));
                    cursor = anc;
                }
                "sdtContent" => cursor = anc,
                "tbl" | "tr" | "tc" => {
                    let i = position(cursor, anc.name(), anc);
                    path.push_str(&format!("/{}[{i}]", anc.name()));
                    cursor = anc;
                }
                "p" => {
                    let i = position(cursor, "p", anc);
                    path.push_str(&format!("/{}", para_segment(anc, i)));
                    cursor = anc;
                }
                _ => {}
            }
        }
        let i = position(cursor, "sdt", sdt);
        path.push_str(&format!("/{}", sdt_segment(sdt, i)));
        path
    }

    fn content_controls(&self, body: E<'p>, part: &Part) -> Vec<Node> {
        let mut out = Vec::new();
        for sdt in body.descendants_named(W, "sdt") {
            let node = self.element(sdt, &Self::sdt_path(body, sdt), 0);
            if text_ok(&node, part.contains.as_deref()) && handler_attrs_ok(&node, &part.attrs) {
                out.push(node);
            }
        }
        out
    }

    fn rows_or_cells(&self, body: E<'p>, part: &Part, want_row: bool) -> Vec<Node> {
        let mut out = Vec::new();
        let keep =
            |n: &Node| text_ok(n, part.contains.as_deref()) && handler_attrs_ok(n, &part.attrs);
        for (ti, tbl) in body.children(W, "tbl").into_iter().enumerate() {
            for (ri, row) in tbl.children(W, "tr").into_iter().enumerate() {
                let row_path = format!("/body/tbl[{}]/tr[{}]", ti + 1, ri + 1);
                if want_row {
                    let node = self.element(row, &row_path, 0);
                    if keep(&node) {
                        out.push(node);
                    }
                    continue;
                }
                for (ci, cell) in row_cells(row).into_iter().enumerate() {
                    let node = self.element(cell, &format!("{row_path}/tc[{}]", ci + 1), 0);
                    if keep(&node) {
                        out.push(node);
                    }
                }
            }
        }
        out
    }

    /// A style as `query style` lists it: identity, base and latent flags.
    fn style_stub(style: E<'_>, id: &str, name: &str) -> Node {
        let mut node = Node::new(format!("/styles/{id}"), "style");
        node.text = Some(name.to_string());
        node.str("id", id);
        node.str("name", name);
        if let Some(t) = style.w("type") {
            node.str("type", t);
        }
        if style
            .w("default")
            .is_some_and(|d| on_off(Some(d)) == Some(true))
        {
            node.str("default", "true");
        }
        if let Some(based) = w_val(style.child(W, "basedOn")) {
            node.str("basedOn", based);
            node.str("basedOn.path", format!("/styles/{based}"));
        }
        node.set(
            "customStyle",
            Value::Bool(
                style
                    .w("customStyle")
                    .is_some_and(|c| on_off(Some(c)) == Some(true)),
            ),
        );
        if let Some(uip) =
            w_val(style.child(W, "uiPriority")).and_then(|u| u.trim().parse::<i32>().ok())
        {
            node.set("uiPriority", Value::Int(i64::from(uip)));
        }
        for el in ["semiHidden", "unhideWhenUsed", "qFormat", "locked"] {
            if is_on(style.child(W, el)) {
                node.flag(el);
            }
        }
        node
    }
}

/// `/body/ole`, `/header[N]/ole` or `/footer[N]/ole`, any case, with any predicate.
fn ole_scope(selector: &str) -> bool {
    let lower = selector.to_lowercase();
    let rest = if let Some(r) = lower.strip_prefix("/body/") {
        r
    } else {
        let Some(r) = lower
            .strip_prefix("/header[")
            .or_else(|| lower.strip_prefix("/footer["))
        else {
            return false;
        };
        let d = r.bytes().take_while(u8::is_ascii_digit).count();
        match r[d..].strip_prefix("]/") {
            Some(tail) if d > 0 => tail,
            _ => return false,
        }
    };
    ["ole", "oleobject", "object", "embed"].iter().any(|name| {
        rest.strip_prefix(name)
            .is_some_and(|tail| tail.is_empty() || (tail.starts_with('[') && tail.ends_with(']')))
    })
}

fn push_equation(out: &mut Vec<Node>, path: String, e: E<'_>, mode: &str, contains: Option<&str>) {
    let text = math_text(e);
    if contains.is_none_or(|c| text.contains(c)) {
        let mut node = Node::new(path, "equation");
        node.text = Some(text);
        node.str("mode", mode);
        out.push(node);
    }
}
