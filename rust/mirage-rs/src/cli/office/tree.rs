//! A Word or PowerPoint part as a tree: each element with its authored
//! prefix, its namespace resolved, its attributes in authored order and
//! its text as written, read the way the Open XML SDK reads a part and
//! written back the way it writes one. The parser refuses a document type
//! declaration, so no entity expands, and bounds nesting and element
//! count.

use std::sync::Arc;

use super::xml::{attribute_spaces, line_ends};

pub(super) const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
pub(super) const W14: &str = "http://schemas.microsoft.com/office/word/2010/wordml";
pub(super) const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
pub(super) const A: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
pub(super) const P: &str = "http://schemas.openxmlformats.org/presentationml/2006/main";
pub(super) const WP: &str =
    "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
pub(super) const PIC: &str = "http://schemas.openxmlformats.org/drawingml/2006/picture";
pub(super) const M: &str = "http://schemas.openxmlformats.org/officeDocument/2006/math";
pub(super) const MC: &str = "http://schemas.openxmlformats.org/markup-compatibility/2006";
pub(super) const C: &str = "http://schemas.openxmlformats.org/drawingml/2006/chart";
pub(super) const CP: &str =
    "http://schemas.openxmlformats.org/package/2006/metadata/core-properties";
pub(super) const DC: &str = "http://purl.org/dc/elements/1.1/";
pub(super) const DCTERMS: &str = "http://purl.org/dc/terms/";
pub(super) const EP: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/extended-properties";
pub(super) const REL: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
pub(super) const CT: &str = "http://schemas.openxmlformats.org/package/2006/content-types";
pub(super) const XML: &str = "http://www.w3.org/XML/1998/namespace";
pub(super) const P14: &str = "http://schemas.microsoft.com/office/powerpoint/2010/main";

/// The prefix the writer gives a namespace an element was created in.
pub(super) fn prefix_for(ns: &str) -> &'static str {
    match ns {
        W => "w",
        W14 => "w14",
        R => "r",
        A => "a",
        P => "p",
        WP => "wp",
        PIC => "pic",
        M => "m",
        MC => "mc",
        C => "c",
        XML => "xml",
        P14 => "p14",
        _ => "",
    }
}

const MAX_DEPTH: usize = 512;
const MAX_ELEMENTS: usize = 4_000_000;

pub(super) type Id = usize;

#[derive(Clone, Debug)]
pub(super) enum Kid {
    El(Id),
    Text(String),
}

#[derive(Clone, Debug)]
pub(super) struct Attr {
    pub(super) ns: Arc<str>,
    pub(super) name: String,
    pub(super) prefix: String,
    pub(super) value: String,
}

#[derive(Clone, Debug)]
pub(super) struct Elem {
    pub(super) ns: Arc<str>,
    pub(super) name: String,
    pub(super) prefix: String,
    pub(super) attrs: Vec<Attr>,
    pub(super) kids: Vec<Kid>,
    pub(super) parent: Option<Id>,
    /// The namespace declarations the element carries, as authored.
    pub(super) decls: Vec<(String, String)>,
}

/// A parsed part.
#[derive(Clone, Debug)]
pub(super) struct Tree {
    pub(super) nodes: Vec<Elem>,
    pub(super) root: Id,
    /// The XML declaration as written, with what followed it up to the root.
    pub(super) declaration: String,
}

/// A read handle on one element of a tree.
#[derive(Clone, Copy)]
pub(super) struct E<'t> {
    pub(super) t: &'t Tree,
    pub(super) id: Id,
}

impl PartialEq for E<'_> {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id && std::ptr::eq(self.t, other.t)
    }
}

impl std::fmt::Debug for E<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "<{}:{}#{}>", self.prefix(), self.name(), self.id)
    }
}

impl<'t> E<'t> {
    fn el(&self) -> &'t Elem {
        &self.t.nodes[self.id]
    }

    pub(super) fn ns(&self) -> &'t str {
        &self.el().ns
    }

    pub(super) fn name(&self) -> &'t str {
        &self.el().name
    }

    pub(super) fn prefix(&self) -> &'t str {
        &self.el().prefix
    }

    pub(super) fn is(&self, ns: &str, name: &str) -> bool {
        &*self.el().ns == ns && self.el().name == name
    }

    pub(super) fn attrs(&self) -> &'t [Attr] {
        &self.el().attrs
    }

    pub(super) fn kids(&self) -> &'t [Kid] {
        &self.el().kids
    }

    pub(super) fn handle(&self, id: Id) -> E<'t> {
        E { t: self.t, id }
    }

    /// The element's child elements, in order.
    pub(super) fn elements(&self) -> impl Iterator<Item = E<'t>> + 't {
        let t = self.t;
        self.el().kids.iter().filter_map(move |k| match k {
            Kid::El(id) => Some(E { t, id: *id }),
            Kid::Text(_) => None,
        })
    }

    pub(super) fn child(&self, ns: &str, name: &str) -> Option<E<'t>> {
        self.elements().find(|e| e.is(ns, name))
    }

    pub(super) fn children(&self, ns: &str, name: &str) -> Vec<E<'t>> {
        self.elements().filter(|e| e.is(ns, name)).collect()
    }

    /// The first child in `ns` named any of `names`.
    pub(super) fn child_of(&self, ns: &str, names: &[&str]) -> Option<E<'t>> {
        self.elements()
            .find(|e| e.ns() == ns && names.contains(&e.name()))
    }

    /// An unqualified attribute.
    pub(super) fn attr(&self, name: &str) -> Option<&'t str> {
        self.attr_ns(name, "")
    }

    pub(super) fn attr_ns(&self, name: &str, ns: &str) -> Option<&'t str> {
        self.el()
            .attrs
            .iter()
            .find(|a| a.name == name && &*a.ns == ns)
            .map(|a| a.value.as_str())
    }

    /// A WordprocessingML attribute, `w:name`.
    pub(super) fn w(&self, name: &str) -> Option<&'t str> {
        self.attr_ns(name, W)
    }

    /// The text of every text node below, in document order.
    pub(super) fn text(&self) -> String {
        let mut out = String::new();
        self.collect_text(&mut out);
        out
    }

    fn collect_text(&self, out: &mut String) {
        for k in &self.el().kids {
            match k {
                Kid::Text(s) => out.push_str(s),
                Kid::El(id) => self.handle(*id).collect_text(out),
            }
        }
    }

    /// Every element below, in document order.
    pub(super) fn descendants(&self) -> Vec<E<'t>> {
        let mut out = Vec::new();
        self.collect_descendants(&mut out);
        out
    }

    fn collect_descendants(&self, out: &mut Vec<E<'t>>) {
        for e in self.elements() {
            out.push(e);
            e.collect_descendants(out);
        }
    }

    pub(super) fn descendants_named(&self, ns: &str, name: &str) -> Vec<E<'t>> {
        let mut out = Vec::new();
        self.collect_named(ns, name, &mut out);
        out
    }

    fn collect_named(&self, ns: &str, name: &str, out: &mut Vec<E<'t>>) {
        for e in self.elements() {
            if e.is(ns, name) {
                out.push(e);
            }
            e.collect_named(ns, name, out);
        }
    }

    /// The first element below named so, in document order.
    pub(super) fn first_named(&self, ns: &str, name: &str) -> Option<E<'t>> {
        for e in self.elements() {
            if e.is(ns, name) {
                return Some(e);
            }
            if let Some(found) = e.first_named(ns, name) {
                return Some(found);
            }
        }
        None
    }

    pub(super) fn parent(&self) -> Option<E<'t>> {
        self.el().parent.map(|id| self.handle(id))
    }

    pub(super) fn ancestors(&self) -> Vec<E<'t>> {
        let mut out = Vec::new();
        let mut at = self.parent();
        while let Some(p) = at {
            out.push(p);
            at = p.parent();
        }
        out
    }

    pub(super) fn ancestor(&self, ns: &str, name: &str) -> Option<E<'t>> {
        let mut at = self.parent();
        while let Some(p) = at {
            if p.is(ns, name) {
                return Some(p);
            }
            at = p.parent();
        }
        None
    }
}

impl Tree {
    pub(super) fn root(&self) -> E<'_> {
        E {
            t: self,
            id: self.root,
        }
    }

    /// A new detached element; `prefix` empty takes the writer's prefix for `ns`.
    pub(super) fn create(&mut self, ns: &str, name: &str, prefix: &str) -> Id {
        let prefix = if prefix.is_empty() {
            prefix_for(ns).to_string()
        } else {
            prefix.to_string()
        };
        self.nodes.push(Elem {
            ns: Arc::from(ns),
            name: name.to_string(),
            prefix,
            attrs: Vec::new(),
            kids: Vec::new(),
            parent: None,
            decls: Vec::new(),
        });
        self.nodes.len() - 1
    }

    pub(super) fn detach(&mut self, id: Id) {
        if let Some(parent) = self.nodes[id].parent.take() {
            self.nodes[parent]
                .kids
                .retain(|k| !matches!(k, Kid::El(x) if *x == id));
        }
    }

    pub(super) fn append(&mut self, parent: Id, child: Id) {
        self.detach(child);
        self.nodes[child].parent = Some(parent);
        self.nodes[parent].kids.push(Kid::El(child));
    }

    /// A tree of one new element, its root.
    pub(super) fn fragment(ns: &str, name: &str, prefix: &str) -> Tree {
        let mut t = Tree {
            nodes: Vec::new(),
            root: 0,
            declaration: String::new(),
        };
        t.root = t.create(ns, name, prefix);
        t
    }

    /// A deep copy of `from`, an element of any tree, detached here.
    pub(super) fn adopt(&mut self, from: E<'_>) -> Id {
        let mut el = from.el().clone();
        el.parent = None;
        el.kids = Vec::new();
        self.nodes.push(el);
        let copy = self.nodes.len() - 1;
        for k in from.kids() {
            match k {
                Kid::Text(s) => self.nodes[copy].kids.push(Kid::Text(s.clone())),
                Kid::El(c) => {
                    let cc = self.adopt(from.handle(*c));
                    self.nodes[cc].parent = Some(copy);
                    self.nodes[copy].kids.push(Kid::El(cc));
                }
            }
        }
        copy
    }
}

/// Why a part did not parse.
#[derive(Debug)]
pub(super) struct Malformed;

struct Parser<'a> {
    s: &'a str,
    at: usize,
    nodes: Vec<Elem>,
}

fn is_name_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, ':' | '_' | '-' | '.') || (c as u32) > 0x7f
}

/// Decode the five predefined entities and character references.
fn decode(raw: &str) -> Result<String, Malformed> {
    if !raw.contains('&') {
        return Ok(raw.to_string());
    }
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        let tail = &rest[amp + 1..];
        let Some(semi) = tail.find(';') else {
            return Err(Malformed);
        };
        let name = &tail[..semi];
        let ch = match name {
            "lt" => '<',
            "gt" => '>',
            "amp" => '&',
            "quot" => '"',
            "apos" => '\'',
            _ => {
                let code = if let Some(hex) = name.strip_prefix("#x").or(name.strip_prefix("#X")) {
                    u32::from_str_radix(hex, 16).ok()
                } else if let Some(dec) = name.strip_prefix('#') {
                    dec.parse::<u32>().ok()
                } else {
                    None
                };
                match code.and_then(char::from_u32) {
                    Some(c) => c,
                    None => return Err(Malformed),
                }
            }
        };
        out.push(ch);
        rest = &tail[semi + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

impl<'a> Parser<'a> {
    fn rest(&self) -> &'a str {
        &self.s[self.at..]
    }

    fn skip_ws(&mut self) {
        let r = self.rest();
        let trimmed = r.trim_start_matches(|c: char| c.is_ascii_whitespace());
        self.at += r.len() - trimmed.len();
    }

    fn name(&mut self) -> &'a str {
        let r = self.rest();
        let end = r
            .char_indices()
            .find(|(_, c)| !is_name_char(*c))
            .map_or(r.len(), |(i, _)| i);
        self.at += end;
        &r[..end]
    }

    /// Skip a comment, processing instruction or CDATA-free misc item;
    /// true when one was skipped.
    fn misc(&mut self) -> Result<bool, Malformed> {
        let r = self.rest();
        if let Some(body) = r.strip_prefix("<!--") {
            let end = body.find("-->").ok_or(Malformed)?;
            self.at += 4 + end + 3;
            return Ok(true);
        }
        if r.starts_with("<?") {
            let end = r.find("?>").ok_or(Malformed)?;
            self.at += end + 2;
            return Ok(true);
        }
        if r.starts_with("<!DOCTYPE") || r.starts_with("<!doctype") {
            return Err(Malformed);
        }
        Ok(false)
    }

    fn element(
        &mut self,
        scope: &[(String, Arc<str>)],
        parent: Option<Id>,
        depth: usize,
    ) -> Result<Id, Malformed> {
        if depth > MAX_DEPTH {
            return Err(Malformed);
        }
        if self.nodes.len() >= MAX_ELEMENTS {
            return Err(Malformed);
        }
        self.at += 1;
        let qname = self.name().to_string();
        if qname.is_empty() {
            return Err(Malformed);
        }
        let mut raw_attrs: Vec<(String, String)> = Vec::new();
        let empty;
        loop {
            self.skip_ws();
            let r = self.rest();
            if r.starts_with("/>") {
                self.at += 2;
                empty = true;
                break;
            }
            if r.starts_with('>') {
                self.at += 1;
                empty = false;
                break;
            }
            let key = self.name().to_string();
            if key.is_empty() {
                return Err(Malformed);
            }
            self.skip_ws();
            if !self.rest().starts_with('=') {
                return Err(Malformed);
            }
            self.at += 1;
            self.skip_ws();
            let quote = self
                .rest()
                .chars()
                .next()
                .filter(|c| *c == '"' || *c == '\'')
                .ok_or(Malformed)?;
            self.at += 1;
            let r = self.rest();
            let end = r.find(quote).ok_or(Malformed)?;
            let value = decode(&attribute_spaces(&r[..end]))?;
            self.at += end + 1;
            raw_attrs.push((key, value));
        }
        let mut local: Vec<(String, Arc<str>)> = Vec::new();
        let mut decls = Vec::new();
        for (k, v) in &raw_attrs {
            if k == "xmlns" {
                local.push((String::new(), Arc::from(v.as_str())));
                decls.push((String::new(), v.clone()));
            } else if let Some(p) = k.strip_prefix("xmlns:") {
                local.push((p.to_string(), Arc::from(v.as_str())));
                decls.push((p.to_string(), v.clone()));
            }
        }
        let lookup = |prefix: &str| -> Arc<str> {
            if prefix == "xml" {
                return Arc::from(XML);
            }
            for (p, ns) in local.iter().rev().chain(scope.iter().rev()) {
                if p == prefix {
                    return ns.clone();
                }
            }
            Arc::from("")
        };
        let (prefix, name) = match qname.split_once(':') {
            Some((p, n)) => (p.to_string(), n.to_string()),
            None => (String::new(), qname.clone()),
        };
        let mut attrs = Vec::new();
        for (k, v) in raw_attrs {
            if k == "xmlns" || k.starts_with("xmlns:") {
                continue;
            }
            match k.split_once(':') {
                Some((p, n)) => attrs.push(Attr {
                    ns: lookup(p),
                    name: n.to_string(),
                    prefix: p.to_string(),
                    value: v,
                }),
                None => attrs.push(Attr {
                    ns: Arc::from(""),
                    name: k,
                    prefix: String::new(),
                    value: v,
                }),
            }
        }
        let id = self.nodes.len();
        self.nodes.push(Elem {
            ns: lookup(&prefix),
            name,
            prefix,
            attrs,
            kids: Vec::new(),
            parent,
            decls,
        });
        if empty {
            return Ok(id);
        }
        let mut inner: Vec<(String, Arc<str>)>;
        let scope: &[(String, Arc<str>)] = if local.is_empty() {
            scope
        } else {
            inner = scope.to_vec();
            inner.extend(local);
            &inner
        };
        let mut text = String::new();
        loop {
            let r = self.rest();
            if r.is_empty() {
                return Err(Malformed);
            }
            if let Some(stripped) = r.strip_prefix("</") {
                let end = stripped.find('>').ok_or(Malformed)?;
                if stripped[..end].trim_end() != qname {
                    return Err(Malformed);
                }
                self.at += 2 + end + 1;
                break;
            }
            if r.starts_with("<![CDATA[") {
                let end = r.find("]]>").ok_or(Malformed)?;
                text.push_str(&line_ends(&r[9..end]));
                self.at += end + 3;
                continue;
            }
            if r.starts_with("<!--") || r.starts_with("<?") || r.starts_with("<!") {
                if !self.misc()? {
                    return Err(Malformed);
                }
                continue;
            }
            if r.starts_with('<') {
                if !text.is_empty() {
                    self.nodes[id]
                        .kids
                        .push(Kid::Text(std::mem::take(&mut text)));
                }
                let child = self.element(scope, Some(id), depth + 1)?;
                self.nodes[id].kids.push(Kid::El(child));
                continue;
            }
            let end = r.find('<').unwrap_or(r.len());
            text.push_str(&decode(&line_ends(&r[..end]))?);
            self.at += end;
        }
        if !text.is_empty() {
            self.nodes[id].kids.push(Kid::Text(text));
        }
        Ok(id)
    }
}

/// A part's bytes as a tree.
pub(super) fn parse(bytes: &[u8]) -> Result<Tree, Malformed> {
    let s = std::str::from_utf8(bytes).map_err(|_| Malformed)?;
    let s = s.strip_prefix('\u{feff}').unwrap_or(s);
    let mut p = Parser {
        s,
        at: 0,
        nodes: Vec::new(),
    };
    let mut declaration = String::new();
    if s.starts_with("<?xml") {
        let end = s.find("?>").ok_or(Malformed)?;
        p.at = end + 2;
        let after = s[p.at..].len() - s[p.at..].trim_start().len();
        declaration = s[..p.at + after].to_string();
    }
    loop {
        p.skip_ws();
        if !p.misc()? {
            break;
        }
    }
    if !p.rest().starts_with('<') {
        return Err(Malformed);
    }
    let root = p.element(&[], None, 0)?;
    Ok(Tree {
        nodes: p.nodes,
        root,
        declaration,
    })
}

fn escape_text(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_attr(s: &str) -> String {
    escape_text(s).replace('"', "&quot;")
}

/// DrawingML run properties' attributes in schema order.
const RUN_ATTRS: [&str; 19] = [
    "kumimoji",
    "lang",
    "altLang",
    "sz",
    "b",
    "i",
    "u",
    "strike",
    "kern",
    "cap",
    "spc",
    "normalizeH",
    "baseline",
    "noProof",
    "dirty",
    "err",
    "smtClean",
    "smtId",
    "bmk",
];

/// An element's attributes in the order the Open XML SDK writes a parsed
/// element: those its schema declares first, in schema order, then any it
/// does not know, as authored.
pub(super) fn schema_ordered<'t>(e: E<'t>) -> Vec<&'t Attr> {
    let attrs = e.attrs();
    if e.ns() != A || !matches!(e.name(), "rPr" | "defRPr" | "endParaRPr") {
        return attrs.iter().collect();
    }
    let known = |a: &Attr| -> Option<usize> {
        if a.ns.is_empty() {
            RUN_ATTRS.iter().position(|n| *n == a.name)
        } else {
            None
        }
    };
    let mut ordered: Vec<&Attr> = attrs.iter().filter(|a| known(a).is_some()).collect();
    ordered.sort_by_key(|a| known(a));
    ordered.extend(attrs.iter().filter(|a| known(a).is_none()));
    ordered
}

fn qualified(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}:{name}")
    }
}

/// The element as the SDK's `OuterXml` writes it: its prefixes as
/// authored, each namespace declared where first used, after the
/// element's attributes, an empty element closed with ` />`, and the
/// whitespace between child elements dropped.
pub(super) fn outer_xml(e: E<'_>) -> String {
    let mut out = String::new();
    write_outer(e, &[], &mut out, false);
    out
}

/// `outer_xml` with each element's namespace declarations first and its
/// attributes sorted by namespace, then name, as OfficeCLI canonicalizes
/// XML it compares.
pub(super) fn canonical_xml(e: E<'_>) -> String {
    let mut out = String::new();
    write_outer(e, &[], &mut out, true);
    out
}

fn write_outer(e: E<'_>, scope: &[(String, String)], out: &mut String, canonical: bool) {
    let mut local: Vec<(String, String)> = scope.to_vec();
    let mut declared: Vec<(String, String)> = Vec::new();
    let mut need = |prefix: &str, ns: &str, local: &mut Vec<(String, String)>| {
        if prefix.is_empty() || prefix == "xml" || ns.is_empty() {
            return;
        }
        if local.iter().rev().any(|(p, n)| p == prefix && n == ns) {
            return;
        }
        local.push((prefix.to_string(), ns.to_string()));
        declared.push((prefix.to_string(), ns.to_string()));
    };
    need(e.prefix(), e.ns(), &mut local);
    let tag = qualified(e.prefix(), e.name());
    out.push('<');
    out.push_str(&tag);
    let mut attrs = schema_ordered(e);
    for a in &attrs {
        need(&a.prefix, &a.ns, &mut local);
    }
    let mut body = String::new();
    if canonical {
        attrs.sort_by(|x, y| (&*x.ns, &x.name).cmp(&(&*y.ns, &y.name)));
    }
    for a in attrs {
        body.push(' ');
        body.push_str(&qualified(
            if a.ns.is_empty() { "" } else { &a.prefix },
            &a.name,
        ));
        body.push_str("=\"");
        body.push_str(&escape_attr(&a.value));
        body.push('"');
    }
    let mut decls = String::new();
    for (p, ns) in &declared {
        decls.push_str(&format!(" xmlns:{p}=\"{}\"", escape_attr(ns)));
    }
    if canonical {
        out.push_str(&decls);
        out.push_str(&body);
    } else {
        out.push_str(&body);
        out.push_str(&decls);
    }
    let mixed = e.kids().iter().any(|k| matches!(k, Kid::El(_)));
    let kids: Vec<&Kid> = e
        .kids()
        .iter()
        .filter(|k| !mixed || !matches!(k, Kid::Text(s) if s.trim().is_empty()))
        .collect();
    if kids.is_empty() {
        out.push_str(" />");
        return;
    }
    out.push('>');
    for k in kids {
        match k {
            Kid::Text(s) => out.push_str(&escape_text(s)),
            Kid::El(id) => write_outer(e.handle(*id), &local, out, canonical),
        }
    }
    out.push_str("</");
    out.push_str(&tag);
    out.push('>');
}

/// The whole part as bytes to save: the declaration, then the root with
/// every element's authored prefix and declarations, a namespace declared
/// where an element added later needs one.
pub(super) fn serialize(t: &Tree) -> Vec<u8> {
    let mut out = if t.declaration.is_empty() {
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\r\n".to_string()
    } else {
        t.declaration.clone()
    };
    write_part(t.root(), &[], &mut out);
    out.into_bytes()
}

fn write_part(e: E<'_>, scope: &[(String, String)], out: &mut String) {
    let el = &e.t.nodes[e.id];
    let mut local: Vec<(String, String)> = scope.to_vec();
    for (p, ns) in &el.decls {
        local.push((p.clone(), ns.clone()));
    }
    let mut extra: Vec<(String, String)> = Vec::new();
    let mut need = |prefix: &str, ns: &str, local: &mut Vec<(String, String)>| {
        if prefix == "xml" || ns.is_empty() {
            return;
        }
        if local.iter().rev().any(|(p, n)| p == prefix && n == ns) {
            return;
        }
        local.push((prefix.to_string(), ns.to_string()));
        extra.push((prefix.to_string(), ns.to_string()));
    };
    need(&el.prefix, &el.ns, &mut local);
    for a in &el.attrs {
        if !a.ns.is_empty() {
            need(&a.prefix, &a.ns, &mut local);
        }
    }
    let tag = qualified(&el.prefix, &el.name);
    out.push('<');
    out.push_str(&tag);
    for (p, ns) in el.decls.iter().chain(extra.iter()) {
        if p.is_empty() {
            out.push_str(&format!(" xmlns=\"{}\"", escape_attr(ns)));
        } else {
            out.push_str(&format!(" xmlns:{p}=\"{}\"", escape_attr(ns)));
        }
    }
    for a in &el.attrs {
        out.push(' ');
        out.push_str(&qualified(
            if a.ns.is_empty() { "" } else { &a.prefix },
            &a.name,
        ));
        out.push_str("=\"");
        out.push_str(&escape_attr(&a.value));
        out.push('"');
    }
    if el.kids.is_empty() {
        out.push_str("/>");
        return;
    }
    out.push('>');
    for k in &el.kids {
        match k {
            Kid::Text(s) => out.push_str(&escape_text(s)),
            Kid::El(id) => write_part(e.handle(*id), &local, out),
        }
    }
    out.push_str("</");
    out.push_str(&tag);
    out.push('>');
}

/// Whether a WordprocessingML on/off property (`<w:b/>`, `<w:b w:val="0"/>`) is on.
pub(super) fn is_on(e: Option<E<'_>>) -> bool {
    match e {
        None => false,
        Some(e) => matches!(e.w("val"), None | Some("true" | "1" | "on")),
    }
}

/// An on/off value as OfficeCLI reads one: true, false, or none when unparseable.
pub(super) fn on_off(v: Option<&str>) -> Option<bool> {
    let Some(v) = v else { return Some(true) };
    match v.to_lowercase().as_str() {
        "true" | "1" | "on" => Some(true),
        "false" | "0" | "off" => Some(false),
        _ => None,
    }
}
