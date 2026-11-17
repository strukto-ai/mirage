// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! `get` on a deck: a path normalized as OfficeCLI normalizes one (segment
//! names lower-cased, `cell[r,c]` and `row[N]` rewritten, `@id=`/`@name=`
//! and `last()` resolved to positions), then dispatched on its shape.

use fancy_regex::Regex;

use super::super::errors::Fail;
use super::super::node::{Node, Value};
use super::super::tree::{A, C, E, P, outer_xml};
use super::super::units::hex_color;
use super::super::units::{f2, format_emu};
use super::color::{read_color, rotation};
use super::deck::{Deck, Graphic, Slide};
use super::fail;
use super::nodes::cell_anchor;
use super::text::{
    bullets, cell_text, normalize_alignment, run_text, spacing, strike_name, tabs, text_direction,
    underline_name,
};
use super::{boolean, cnvpr_of, content_kids, int, long, nv_of, ph_of, ph_type, segment};

fn caps(pattern: &str, text: &str) -> Option<Vec<Option<String>>> {
    let re = Regex::new(pattern).ok()?;
    let c = re.captures(text).ok()??;
    Some(
        (0..c.len())
            .map(|i| c.get(i).map(|m| m.as_str().to_string()))
            .collect(),
    )
}

fn num(v: &Option<String>) -> usize {
    v.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0)
}

/// A path with every segment's name lower-cased.
fn lower_segments(path: &str) -> String {
    if path.is_empty() || path == "/" {
        return path.to_string();
    }
    let re = Regex::new(r"(^|/)([A-Za-z][A-Za-z0-9]*)").expect("a valid pattern");
    let mut out = String::new();
    let mut last = 0;
    for c in re.captures_iter(path).flatten() {
        let whole = c.get(0).expect("a match");
        out.push_str(&path[last..whole.start()]);
        out.push_str(c.get(1).map_or("", |m| m.as_str()));
        out.push_str(&c.get(2).map_or("", |m| m.as_str()).to_lowercase());
        last = whole.end();
    }
    out.push_str(&path[last..]);
    out
}

fn cell_path(path: &str) -> Result<String, Fail> {
    if path.len() > 1 && path != "/" && path.ends_with('/') {
        return Err(fail(format!(
            "Invalid path '{path}': trailing '/' is not allowed."
        )));
    }
    if path.starts_with("//") {
        return Err(fail(format!(
            "Invalid path '{path}': leading '//' is not allowed."
        )));
    }
    if path.contains("//") {
        return Err(fail(format!(
            "Invalid path '{path}': empty path segment ('//') is not allowed."
        )));
    }
    let sub = |pattern: &str, text: &str, with: &str| -> String {
        Regex::new(pattern)
            .expect("a valid pattern")
            .replace_all(text, with)
            .into_owned()
    };
    let out = sub(r"cell\[(\d+),\s*(\d+)\]", path, "tr[$1]/tc[$2]");
    let out = sub(
        r"(/table\[[^\]]+\](?:/[^/]+)*?)/row\[(\d+)\]",
        &out,
        "$1/tr[$2]",
    );
    let out = sub(r"(/tr\[\d+\])/cell\[(\d+)\]", &out, "$1/tc[$2]");
    Ok(sub(
        r"(/table\[[^\]]+\])/column\[(\d+)\]",
        &out,
        "$1/col[$2]",
    ))
}

fn name_matches(actual: Option<&str>, expected: &str) -> bool {
    let Some(actual) = actual else { return false };
    let a = actual.to_lowercase();
    let e = expected.to_lowercase();
    a == e || a.strip_prefix("!!") == Some(e.as_str()) || e.strip_prefix("!!") == Some(a.as_str())
}

fn placeholder_type_of(name: &str) -> Option<&'static str> {
    Some(match name.to_lowercase().as_str() {
        "title" => "title",
        "centertitle" | "centeredtitle" | "ctitle" | "ctrtitle" => "ctrTitle",
        "body" | "content" => "body",
        "subtitle" | "sub" | "subtitlepres" => "subTitle",
        "date" | "datetime" | "dt" => "dt",
        "footer" => "ftr",
        "slidenum" | "slidenumber" | "sldnum" => "sldNum",
        "object" | "obj" => "obj",
        "chart" => "chart",
        "table" => "tbl",
        "clipart" => "clipArt",
        "diagram" | "dgm" => "dgm",
        "media" => "media",
        "picture" | "pic" => "pic",
        "header" => "hdr",
        _ => return None,
    })
}

fn rebase(node: &mut Node, from: &str, to: &str) {
    if from == to {
        return;
    }
    for child in &mut node.children {
        if let Some(rest) = child.path.strip_prefix(from) {
            child.path = format!("{to}{rest}");
        }
        rebase(child, from, to);
    }
}

fn inventory(tree: E<'_>) -> String {
    let frames = tree.children(P, "graphicFrame");
    let counts = [
        (tree.children(P, "sp").len(), "shape(s)"),
        (
            frames
                .iter()
                .filter(|g| g.first_named(A, "tbl").is_some())
                .count(),
            "table(s)",
        ),
        (
            frames
                .iter()
                .filter(|g| g.first_named(C, "chart").is_some())
                .count(),
            "chart(s)",
        ),
        (tree.children(P, "pic").len(), "picture(s)"),
        (tree.children(P, "cxnSp").len(), "connector(s)"),
        (tree.children(P, "grpSp").len(), "group(s)"),
    ];
    let parts: Vec<String> = counts
        .iter()
        .filter(|(n, _)| *n > 0)
        .map(|(n, label)| format!("{n} {label}"))
        .collect();
    if parts.is_empty() {
        "(empty slide)".to_string()
    } else {
        parts.join(", ")
    }
}

fn tables<'t>(tree: E<'t>) -> Vec<E<'t>> {
    tree.children(P, "graphicFrame")
        .into_iter()
        .filter(|g| g.first_named(A, "tbl").is_some())
        .collect()
}

fn charts<'t>(tree: E<'t>) -> Vec<E<'t>> {
    tree.children(P, "graphicFrame")
        .into_iter()
        .filter(|g| Deck::graphic_kind(*g) == Some(Graphic::Chart))
        .collect()
}

impl<'p> Deck<'p> {
    /// `@id=`, `@name=` and placeholder bindings resolved to positions.
    fn resolve_ids(&self, path: &str) -> Result<String, Fail> {
        if !path.contains("[@") {
            return Ok(path.to_string());
        }
        let re = Regex::new(r#"(\w+)((?:\[@\w+=(?:'[^']*'|"[^"]*"|[^\]]+)\])+)"#)
            .expect("a valid pattern");
        let pred_re =
            Regex::new(r#"\[@(\w+)=(?:'([^']*)'|"([^"]*)"|([^\]]+))\]"#).expect("a valid pattern");
        let mut out = String::new();
        let mut cursor = 0;
        for m in re.captures_iter(path) {
            let Ok(m) = m else { continue };
            let whole = m.get(0).expect("a match");
            let kind = m.get(1).map_or("", |x| x.as_str()).to_lowercase();
            let mut preds: Vec<(String, String)> = Vec::new();
            for pm in pred_re
                .captures_iter(m.get(2).map_or("", |x| x.as_str()))
                .flatten()
            {
                let v = pm
                    .get(2)
                    .or_else(|| pm.get(3))
                    .map(|g| g.as_str().to_string())
                    .unwrap_or_else(|| {
                        pm.get(4)
                            .map_or("", |g| g.as_str())
                            .trim_matches(|c| c == '"' || c == '\'' || c == ' ')
                            .to_string()
                    });
                preds.push((pm.get(1).map_or("", |x| x.as_str()).to_lowercase(), v));
            }
            let placeholder = kind == "placeholder";
            let simple = preds.len() == 1 && matches!(preds[0].0.as_str(), "id" | "name");
            if !placeholder && !simple {
                out.push_str(&path[cursor..whole.end()]);
                cursor = whole.end();
                continue;
            }
            out.push_str(&path[cursor..whole.start()]);
            let attr = preds.first().map_or("", |p| p.0.as_str()).to_string();
            let mut scope = self.scope_tree(&out, &attr, path)?;
            let group_re = Regex::new(r"/group\[(\d+)\]").expect("a valid pattern");
            for gm in group_re.captures_iter(&out.clone()).flatten() {
                let gi: usize = gm.get(1).map_or("", |x| x.as_str()).parse().unwrap_or(0);
                let groups = scope.children(P, "grpSp");
                if gi < 1 || gi > groups.len() {
                    return Err(fail(format!(
                        "Group {gi} not found in scope (total: {})",
                        groups.len()
                    )));
                }
                scope = groups[gi - 1];
            }
            let position = if placeholder {
                Self::placeholder_by_binding(scope, &preds)?
            } else {
                Self::by_attr(scope, &kind, &attr, &preds[0].1)?
            };
            out.push_str(&format!(
                "{}[{position}]",
                m.get(1).map_or("", |x| x.as_str())
            ));
            cursor = whole.end();
        }
        out.push_str(&path[cursor..]);
        Ok(out)
    }

    fn scope_tree(&self, prefix: &str, attr: &str, path: &str) -> Result<E<'p>, Fail> {
        if let Some(c) = caps(r"(?i)^/slidemaster\[(\d+)\]/slidelayout\[(\d+)\]", prefix) {
            let (mi, li) = (num(&c[1]), num(&c[2]));
            let masters = self.masters();
            if mi < 1 || mi > masters.len() {
                return Err(fail(format!(
                    "Slide master {mi} not found (total: {})",
                    masters.len()
                )));
            }
            let layouts = self.layouts_of(&masters[mi - 1]);
            if li < 1 || li > layouts.len() {
                return Err(fail(format!(
                    "Slide layout {li} not found under master {mi} (total: {})",
                    layouts.len()
                )));
            }
            return Self::sp_tree(self.root_of(&layouts[li - 1]))
                .ok_or_else(|| fail(format!("Slide layout {li} has no shape tree")));
        }
        if let Some(c) = caps(r"(?i)^/slidemaster\[(\d+)\]", prefix) {
            if !prefix.to_lowercase().contains("/slidelayout[") {
                let mi = num(&c[1]);
                let masters = self.masters();
                if mi < 1 || mi > masters.len() {
                    return Err(fail(format!(
                        "Slide master {mi} not found (total: {})",
                        masters.len()
                    )));
                }
                return Self::sp_tree(self.root_of(&masters[mi - 1]))
                    .ok_or_else(|| fail(format!("Slide master {mi} has no shape tree")));
            }
        }
        if let Some(c) = caps(r"(?i)^/slidelayout\[(\d+)\]", prefix) {
            let li = num(&c[1]);
            let layouts = self.all_layouts();
            if li < 1 || li > layouts.len() {
                return Err(fail(format!(
                    "Slide layout {li} not found (total: {})",
                    layouts.len()
                )));
            }
            return Self::sp_tree(self.root_of(&layouts[li - 1]))
                .ok_or_else(|| fail(format!("Slide layout {li} has no shape tree")));
        }
        let Some(c) = caps(r"/slide\[(\d+)\]", prefix) else {
            return Err(fail(format!(
                "Cannot resolve @{attr}= outside of a slide context: {path}"
            )));
        };
        let si = num(&c[1]);
        let parts = self.slide_parts();
        if si < 1 || si > parts.len() {
            return Err(fail(format!(
                "Slide {si} not found (total: {})",
                parts.len()
            )));
        }
        Self::sp_tree(Some(self.slide(&parts[si - 1])?))
            .ok_or_else(|| fail(format!("Slide {si} has no shape tree")))
    }

    fn by_attr(scope: E<'_>, kind: &str, attr: &str, value: &str) -> Result<usize, Fail> {
        let list = match kind {
            "shape" | "textbox" | "title" | "equation" => scope.children(P, "sp"),
            "picture" | "pic" | "image" | "video" | "audio" => scope.children(P, "pic"),
            "table" => tables(scope),
            "chart" => charts(scope),
            "connector" | "connection" => scope.children(P, "cxnSp"),
            "group" => scope.children(P, "grpSp"),
            _ => {
                return Err(fail(format!(
                    "Unknown element type '{kind}' for @{attr}= addressing"
                )));
            }
        };
        for (i, e) in list.iter().enumerate() {
            let Some(c) = cnvpr_of(*e) else { continue };
            if attr == "id" && long(c.attr("id")).map(|v| v.to_string()).as_deref() == Some(value) {
                return Ok(i + 1);
            }
            if attr == "name" && name_matches(c.attr("name"), value) {
                return Ok(i + 1);
            }
        }
        Err(fail(format!("No {kind} found with @{attr}={value}")))
    }

    fn placeholder_by_binding(scope: E<'_>, preds: &[(String, String)]) -> Result<usize, Fail> {
        for (key, _) in preds {
            if !matches!(key.as_str(), "idx" | "type" | "id" | "name") {
                return Err(fail(format!(
                    "Unsupported placeholder attribute selector '@{key}='. Supported: @idx=, @type=, @id=, @name=."
                )));
            }
        }
        let phs: Vec<(E<'_>, E<'_>)> = scope
            .children(P, "sp")
            .into_iter()
            .filter_map(|s| ph_of(s).map(|ph| (s, ph)))
            .collect();
        let idx = |ph: E<'_>| long(ph.attr("idx")).unwrap_or(0).to_string();
        let ty = |ph: E<'_>| ph.attr("type").unwrap_or("body").to_string();
        let describe = |(s, ph): (E<'_>, E<'_>)| {
            let mut d = format!("type={} idx={}", ty(ph), idx(ph));
            if let Some(n) = cnvpr_of(s)
                .and_then(|c| c.attr("name"))
                .filter(|n| !n.is_empty())
            {
                d.push_str(&format!(" name=\"{n}\""));
            }
            d
        };
        let hits: Vec<usize> = phs
            .iter()
            .enumerate()
            .filter(|(_, (s, ph))| {
                preds.iter().all(|(key, value)| {
                    let actual = match key.as_str() {
                        "idx" => Some(idx(*ph)),
                        "type" => Some(ty(*ph)),
                        "id" => cnvpr_of(*s).and_then(|c| c.attr("id")).map(str::to_string),
                        _ => cnvpr_of(*s)
                            .and_then(|c| c.attr("name"))
                            .map(str::to_string),
                    };
                    actual.is_some_and(|a| a.eq_ignore_ascii_case(value))
                })
            })
            .map(|(i, _)| i + 1)
            .collect();
        let selector: String = preds.iter().map(|(k, v)| format!("[@{k}={v}]")).collect();
        if hits.is_empty() {
            let available = if phs.is_empty() {
                "(none)".to_string()
            } else {
                phs.iter()
                    .enumerate()
                    .map(|(i, t)| format!("placeholder[{}] ({})", i + 1, describe(*t)))
                    .collect::<Vec<_>>()
                    .join(", ")
            };
            return Err(fail(format!(
                "No placeholder matches placeholder{selector}. Available: {available}"
            )));
        }
        if hits.len() > 1 {
            let list = hits
                .iter()
                .map(|h| format!("placeholder[{h}] ({})", describe(phs[h - 1])))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(fail(format!(
                "placeholder{selector} is ambiguous — matches {list}. Narrow it with a combined selector, e.g. placeholder[@type=body][@idx=1]."
            )));
        }
        Ok(hits[0])
    }

    fn last_predicates(&self, path: &str) -> Result<String, Fail> {
        if !path.to_lowercase().contains("[last()]") {
            return Ok(path.to_string());
        }
        let mut rebuilt = String::new();
        for seg in path.trim_start_matches('/').split('/') {
            let mut seg = seg.to_string();
            if let Some(b) = seg.find('[').filter(|b| *b > 0) {
                if seg.ends_with(']') && seg[b + 1..seg.len() - 1].eq_ignore_ascii_case("last()") {
                    let name = seg[..b].to_string();
                    let count = self.count_siblings(&rebuilt, &name.to_lowercase())?;
                    if count == 0 {
                        return Err(fail(format!(
                            "Cannot resolve [last()] in segment '{seg}': no '{name}' siblings found at '{}'.",
                            if rebuilt.is_empty() { "/" } else { &rebuilt }
                        )));
                    }
                    seg = format!("{name}[{count}]");
                }
            }
            rebuilt.push('/');
            rebuilt.push_str(&seg);
        }
        Ok(rebuilt)
    }

    fn count_siblings(&self, prefix: &str, kind: &str) -> Result<usize, Fail> {
        if prefix.is_empty() {
            return Ok(match kind {
                "slide" => self.slide_parts().len(),
                "slidemaster" => self.pkg.related(&self.pkg.main, "slideMaster").len(),
                _ => 0,
            });
        }
        let Some(c) = caps(r"^/slide\[(\d+)\](.*)$", prefix) else {
            return Ok(0);
        };
        let parts = self.slide_parts();
        let si = num(&c[1]);
        if si < 1 || si > parts.len() {
            return Ok(0);
        }
        let Some(mut scope) = Self::sp_tree(Some(self.slide(&parts[si - 1])?)) else {
            return Ok(0);
        };
        let rest = c[2].clone().unwrap_or_default();
        let mut consumed = 0;
        let group_re = Regex::new(r"/group\[(\d+)\]").expect("a valid pattern");
        for gm in group_re.captures_iter(&rest).flatten() {
            let whole = gm.get(0).expect("a match");
            if whole.start() != consumed {
                break;
            }
            let groups = scope.children(P, "grpSp");
            let gi: usize = gm.get(1).map_or("", |x| x.as_str()).parse().unwrap_or(0);
            if gi < 1 || gi > groups.len() {
                return Ok(0);
            }
            scope = groups[gi - 1];
            consumed = whole.end();
        }
        let tail = &rest[consumed..];
        if tail.is_empty() {
            return Ok(match kind {
                "shape" | "textbox" | "title" | "equation" => scope.children(P, "sp").len(),
                "picture" | "pic" | "image" => scope.children(P, "pic").len(),
                "table" => tables(scope).len(),
                "chart" => charts(scope).len(),
                "connector" | "connection" => scope.children(P, "cxnSp").len(),
                "group" => scope.children(P, "grpSp").len(),
                "placeholder" | "ph" => scope
                    .children(P, "sp")
                    .iter()
                    .filter(|s| ph_of(**s).is_some())
                    .count(),
                _ => 0,
            });
        }
        let Some(t) = caps(r"^/table\[(\d+)\](.*)$", tail) else {
            return Ok(0);
        };
        let list = tables(scope);
        let ti = num(&t[1]);
        if ti < 1 || ti > list.len() {
            return Ok(0);
        }
        let Some(table) = list[ti - 1].first_named(A, "tbl") else {
            return Ok(0);
        };
        let tt = t[2].clone().unwrap_or_default();
        if tt.is_empty() {
            return Ok(if kind == "tr" || kind == "row" {
                table.children(A, "tr").len()
            } else {
                0
            });
        }
        if let Some(tr) = caps(r"^/tr\[(\d+)\]$", &tt) {
            if kind == "tc" || kind == "cell" {
                let rows = table.children(A, "tr");
                let ri = num(&tr[1]);
                if ri < 1 || ri > rows.len() {
                    return Ok(0);
                }
                return Ok(rows[ri - 1].children(A, "tc").len());
            }
        }
        Ok(0)
    }

    fn slide_at(&self, si: usize) -> Result<String, Fail> {
        let parts = self.slide_parts();
        if si < 1 || si > parts.len() {
            return Err(fail(format!(
                "Slide {si} not found (total: {})",
                parts.len()
            )));
        }
        Ok(parts[si - 1].clone())
    }

    fn shape_at(&self, si: usize, shi: usize) -> Result<(String, E<'p>), Fail> {
        let part = self.slide_at(si)?;
        let shapes = Self::sp_tree(Some(self.slide(&part)?))
            .map(|t| t.children(P, "sp"))
            .unwrap_or_default();
        if shi < 1 || shi > shapes.len() {
            return Err(fail(format!(
                "Shape {shi} not found (total: {})",
                shapes.len()
            )));
        }
        Ok((part, shapes[shi - 1]))
    }

    fn placeholder_shape(&self, part: &str, id: &str) -> Result<E<'p>, Fail> {
        let tree = Self::sp_tree(Some(self.slide(part)?))
            .ok_or_else(|| fail("Slide has no shape tree".to_string()))?;
        if let Some(n) = int(Some(id)) {
            let all: Vec<E<'p>> = tree
                .children(P, "sp")
                .into_iter()
                .filter(|s| ph_of(*s).is_some())
                .collect();
            if n >= 1 && (n as usize) <= all.len() {
                return Ok(all[n as usize - 1]);
            }
            return Err(fail(format!("Placeholder index {n} not found")));
        }
        let Some(t) = placeholder_type_of(id) else {
            return Err(fail(format!(
                "Unknown placeholder type: '{id}'. Known types: title, body, subtitle, date, footer, slidenum, object, picture, centerTitle"
            )));
        };
        tree.children(P, "sp")
            .into_iter()
            .find(|s| ph_type(ph_of(*s)) == Some(t))
            .ok_or_else(|| {
                fail(format!(
                    "Placeholder '{id}' not found on slide or its layout"
                ))
            })
    }

    fn placeholder_node(
        &self,
        part: &str,
        si: usize,
        phi: usize,
        depth: usize,
    ) -> Result<Node, Fail> {
        let tree = Self::sp_tree(Some(self.slide(part)?))
            .ok_or_else(|| fail("Slide has no shape tree".to_string()))?;
        let phs: Vec<E<'p>> = tree
            .children(P, "sp")
            .into_iter()
            .filter(|s| ph_of(*s).is_some())
            .collect();
        if phi < 1 || phi > phs.len() {
            return Err(fail(format!(
                "Placeholder {phi} not found (total: {})",
                phs.len()
            )));
        }
        let shape = phs[phi - 1];
        let ph = ph_of(shape).expect("a placeholder");
        let mut node = self.shape_node(shape, si, phi, depth, None, None);
        let path = format!("/slide[{si}]/placeholder[{phi}]");
        let old = node.path.clone();
        rebase(&mut node, &old, &path);
        node.path = path;
        node.kind = "placeholder".to_string();
        if let Some(t) = ph.attr("type") {
            node.str("phType", t);
        }
        if let Some(i) = long(ph.attr("idx")) {
            node.set("phIndex", Value::Int(i));
        }
        Ok(node)
    }

    fn direct_paragraph(&self, para: E<'_>, path: &str, depth: usize, slide: Slide<'_>) -> Node {
        let runs = para.children(A, "r");
        let mut node = Node::new(path, "paragraph");
        node.text = Some(runs.iter().map(|r| run_text(*r)).collect());
        let ppr = para.child(A, "pPr");
        if let Some(algn) = ppr.and_then(|p| p.attr("algn")) {
            node.str("align", normalize_alignment(algn));
        }
        if let Some(lvl) = int(ppr.and_then(|p| p.attr("lvl"))) {
            node.str("level", lvl.to_string());
        }
        for (attr, key) in [
            ("indent", "indent"),
            ("marL", "marginLeft"),
            ("marR", "marginRight"),
        ] {
            if let Some(v) = long(ppr.and_then(|p| p.attr(attr))) {
                node.str(key, super::text::indent_points(v));
            }
        }
        if let Some(ppr) = ppr {
            bullets(ppr, &mut node);
            if let Some(t) = tabs(ppr) {
                node.str("tabs", t);
            }
        }
        spacing(ppr, &mut node);
        if let Some(rtl) = boolean(ppr.and_then(|p| p.attr("rtl"))) {
            node.str("direction", if rtl { "rtl" } else { "ltr" });
        }
        node.child_count = runs.len();
        if depth > 0 {
            for (i, run) in runs.iter().enumerate() {
                node.children.push(self.run_node(
                    *run,
                    &format!("{path}/run[{}]", i + 1),
                    Some(slide),
                    Some(slide.part),
                ));
            }
        }
        node
    }

    /// Any element as OfficeCLI's generic reader shows one.
    fn element_node(e: E<'_>, path: &str, depth: usize) -> Node {
        let mut node = Node::new(path, e.name());
        node.child_count = e.elements().count();
        let text = e.text();
        if !text.is_empty() {
            let units: Vec<u16> = text.encode_utf16().collect();
            node.text = Some(if units.len() > 200 {
                format!("{}...", String::from_utf16_lossy(&units[..200]))
            } else {
                text
            });
        } else {
            let xml = outer_xml(e);
            let units: Vec<u16> = xml.encode_utf16().collect();
            node.preview = Some(if units.len() > 200 {
                format!("{}...", String::from_utf16_lossy(&units[..200]))
            } else {
                xml
            });
        }
        for a in e.attrs() {
            node.str(&a.name, a.value.clone());
        }
        for c in e.elements() {
            if c.elements().next().is_some() {
                continue;
            }
            if let Some(v) = c
                .attrs()
                .iter()
                .find(|a| a.name.eq_ignore_ascii_case("val"))
            {
                node.str(c.name(), v.value.clone());
            }
        }
        if depth > 0 {
            let mut counters: Vec<(String, usize)> = Vec::new();
            for c in e.elements() {
                let n = match counters.iter_mut().find(|(k, _)| k == c.name()) {
                    Some(slot) => {
                        slot.1 += 1;
                        slot.1
                    }
                    None => {
                        counters.push((c.name().to_string(), 1));
                        1
                    }
                };
                node.children.push(Self::element_node(
                    c,
                    &format!("{path}/{}[{n}]", c.name()),
                    depth - 1,
                ));
            }
        }
        node
    }

    fn master_node(&self, index: usize) -> Result<Node, Fail> {
        let masters = self.masters();
        if index < 1 || index > masters.len() {
            return Err(fail(format!(
                "Slide master {index} not found (total: {})",
                masters.len()
            )));
        }
        let part = &masters[index - 1];
        let root = self.root_of(part);
        let mut node = Node::new(format!("/slidemaster[{index}]"), "slidemaster");
        let name = root
            .and_then(|r| r.child(P, "cSld"))
            .and_then(|c| c.attr("name"))
            .unwrap_or("(unnamed)")
            .to_string();
        node.preview = Some(name.clone());
        node.str("name", name);
        node.set(
            "layoutCount",
            Value::Int(self.pkg.related(part, "slideLayout").len() as i64),
        );
        if let Some(t) = self
            .theme_of_master(Some(part))
            .and_then(|t| t.attr("name"))
        {
            node.str("theme", t);
        }
        let tree = Self::sp_tree(root);
        let shapes = tree.map_or(0, |t| {
            t.children(P, "sp").len() + t.children(P, "pic").len()
        });
        node.set("shapeCount", Value::Int(shapes as i64));
        self.background(root.and_then(|r| r.child(P, "cSld")), &mut node, Some(part));
        let styles = root.and_then(|r| r.child(P, "txStyles"));
        let lvl1 = |name: &str| {
            boolean(
                styles
                    .and_then(|s| s.child(P, name))
                    .and_then(|s| s.child(A, "lvl1pPr"))
                    .and_then(|l| l.attr("rtl")),
            )
        };
        let rtl = lvl1("bodyStyle")
            .or_else(|| lvl1("titleStyle"))
            .or_else(|| lvl1("otherStyle"));
        if rtl == Some(true) {
            node.str("direction", "rtl");
        }
        for (i, lp) in self.layouts_of(part).iter().enumerate() {
            let lroot = self.root_of(lp);
            let mut l = Node::new(
                format!("/slidemaster[{index}]/slidelayout[{}]", i + 1),
                "slidelayout",
            );
            let lname = lroot
                .and_then(|r| r.child(P, "cSld"))
                .and_then(|c| c.attr("name"))
                .unwrap_or("(unnamed)")
                .to_string();
            l.preview = Some(lname.clone());
            l.str("name", lname);
            if let Some(t) = lroot.and_then(|r| r.attr("type")) {
                l.str("type", t);
            }
            node.children.push(l);
        }
        node.child_count = node.children.len();
        Ok(node)
    }

    fn layout_node(&self, part: &str, path: &str) -> Node {
        let root = self.root_of(part);
        let mut node = Node::new(path, "slidelayout");
        let name = root
            .and_then(|r| r.child(P, "cSld"))
            .and_then(|c| c.attr("name"))
            .unwrap_or("(unnamed)")
            .to_string();
        node.preview = Some(name.clone());
        node.str("name", name);
        if let Some(t) = root.and_then(|r| r.attr("type")) {
            node.str("type", t);
        }
        self.background(root.and_then(|r| r.child(P, "cSld")), &mut node, Some(part));
        if let Some(tree) = Self::sp_tree(root) {
            for (i, sp) in tree.children(P, "sp").iter().enumerate() {
                node.children
                    .push(self.shape_node(*sp, 0, i + 1, 0, None, Some(path)));
            }
            node.child_count = node.children.len();
        }
        node
    }

    fn master_or_layout_shape(
        &self,
        tree: Option<E<'_>>,
        index: usize,
        prefix: &str,
        depth: usize,
    ) -> Result<Node, Fail> {
        let tree = tree.ok_or_else(|| fail(format!("No shape tree found at {prefix}")))?;
        let shapes = tree.children(P, "sp");
        if index < 1 || index > shapes.len() {
            return Err(fail(format!(
                "Shape {index} not found at {prefix} (total: {})",
                shapes.len()
            )));
        }
        Ok(self.shape_node(shapes[index - 1], 0, index, depth, None, Some(prefix)))
    }

    fn master_layout_tree(
        &self,
        mi: usize,
        li: Option<usize>,
    ) -> Result<(Option<E<'p>>, String), Fail> {
        let masters = self.masters();
        if mi < 1 || mi > masters.len() {
            return Err(fail(format!(
                "Slide master {mi} not found (total: {})",
                masters.len()
            )));
        }
        let Some(li) = li else {
            return Ok((
                Self::sp_tree(self.root_of(&masters[mi - 1])),
                format!("/slidemaster[{mi}]"),
            ));
        };
        let layouts = self.layouts_of(&masters[mi - 1]);
        if li < 1 || li > layouts.len() {
            return Err(fail(format!(
                "Slide layout {li} not found under master {mi} (total: {})",
                layouts.len()
            )));
        }
        Ok((
            Self::sp_tree(self.root_of(&layouts[li - 1])),
            format!("/slidemaster[{mi}]/slidelayout[{li}]"),
        ))
    }

    pub(crate) fn get(&self, input: &str, depth: usize) -> Result<Node, Fail> {
        if input.is_empty() {
            return Err(fail("Path cannot be empty.".to_string()));
        }
        let path = lower_segments(input);
        let path = cell_path(&path)?;
        let path = self.resolve_ids(&path)?;
        let path = self.last_predicates(&path)?;
        if path == "/" {
            return self.root(depth);
        }
        if path.eq_ignore_ascii_case("/theme") {
            return Ok(self.theme());
        }
        if let Some(c) = caps(r"(?i)^/slidemaster\[(\d+)\]$", &path) {
            return self.master_node(num(&c[1]));
        }
        if let Some(c) = caps(r"(?i)^/slidemaster\[(\d+)\]/slidelayout\[(\d+)\]$", &path) {
            let (mi, li) = (num(&c[1]), num(&c[2]));
            let masters = self.masters();
            if mi < 1 || mi > masters.len() {
                return Err(fail(format!(
                    "Slide master {mi} not found (total: {})",
                    masters.len()
                )));
            }
            let layouts = self.layouts_of(&masters[mi - 1]);
            if li < 1 || li > layouts.len() {
                return Err(fail(format!(
                    "Slide layout {li} not found under master {mi} (total: {})",
                    layouts.len()
                )));
            }
            return Ok(self.layout_node(
                &layouts[li - 1],
                &format!("/slidemaster[{mi}]/slidelayout[{li}]"),
            ));
        }
        if let Some(c) = caps(r"(?i)^/slidelayout\[(\d+)\]$", &path) {
            let li = num(&c[1]);
            let layouts = self.all_layouts();
            if li < 1 || li > layouts.len() {
                return Err(fail(format!(
                    "Slide layout {li} not found (total: {})",
                    layouts.len()
                )));
            }
            return Ok(self.layout_node(&layouts[li - 1], &format!("/slidelayout[{li}]")));
        }
        let sub = r"(?:/paragraph\[(\d+)\](?:/run\[(\d+)\])?)?";
        let nested = caps(
            &format!(r"(?i)^/slidemaster\[(\d+)\]/slidelayout\[(\d+)\]/shape\[(\d+)\]{sub}$"),
            &path,
        );
        let ml = caps(
            &format!(r"(?i)^/(slidemaster|slidelayout)\[(\d+)\]/shape\[(\d+)\]{sub}$"),
            &path,
        );
        if nested.is_some() || ml.is_some() {
            let active = nested.clone().or(ml.clone()).expect("a match");
            let ml_depth = if active[5].is_some() {
                depth.max(2)
            } else if active[4].is_some() {
                depth.max(1)
            } else {
                depth
            };
            let shape_node = if let Some(n) = &nested {
                let (tree, prefix) = self.master_layout_tree(num(&n[1]), Some(num(&n[2])))?;
                self.master_or_layout_shape(tree, num(&n[3]), &prefix, ml_depth)?
            } else {
                let m = ml.expect("a match");
                let kind = m[1].as_deref().unwrap_or_default().to_lowercase();
                let pi = num(&m[2]);
                let (tree, prefix) = if kind == "slidemaster" {
                    self.master_layout_tree(pi, None)?
                } else {
                    let layouts = self.all_layouts();
                    if pi < 1 || pi > layouts.len() {
                        return Err(fail(format!(
                            "Slide layout {pi} not found (total: {})",
                            layouts.len()
                        )));
                    }
                    (
                        Self::sp_tree(self.root_of(&layouts[pi - 1])),
                        format!("/slidelayout[{pi}]"),
                    )
                };
                self.master_or_layout_shape(tree, num(&m[3]), &prefix, ml_depth)?
            };
            let Some(pa) = &active[4] else {
                return Ok(shape_node);
            };
            let paras: Vec<&Node> = shape_node
                .children
                .iter()
                .filter(|c| c.kind == "paragraph")
                .collect();
            let pi: usize = pa.parse().unwrap_or(0);
            if pi < 1 || pi > paras.len() {
                return Err(fail(format!(
                    "Paragraph {pi} not found at {} (total: {})",
                    shape_node.path,
                    paras.len()
                )));
            }
            let para = paras[pi - 1].clone();
            let Some(ra) = &active[5] else {
                return Ok(para);
            };
            let runs: Vec<&Node> = para.children.iter().filter(|c| c.kind == "run").collect();
            let ri: usize = ra.parse().unwrap_or(0);
            if ri < 1 || ri > runs.len() {
                return Err(fail(format!(
                    "Run {ri} not found at {} (total: {})",
                    para.path,
                    runs.len()
                )));
            }
            return Ok(runs[ri - 1].clone());
        }
        if let Some(c) = caps(r"^/slide\[(\d+)\]/notes$", &path) {
            let si = num(&c[1]);
            let part = self.slide_at(si)?;
            let Some(text) = self.notes_text(&part) else {
                return Err(fail(format!(
                    "Notes not found at /slide[{si}]/notes (slide has no speaker notes)"
                )));
            };
            let mut node = Node::new(path.clone(), "notes");
            node.text = Some(text.clone());
            node.str("text", text);
            let notes = self
                .pkg
                .related(&part, "notesSlide")
                .into_iter()
                .next()
                .unwrap_or_default();
            let paras = self
                .notes_bodies(&notes)
                .first()
                .and_then(|b| b.child(P, "txBody"))
                .map(|b| b.children(A, "p"))
                .unwrap_or_default();
            if let Some(first) = paras.iter().flat_map(|p| p.children(A, "r")).next() {
                let run = self.run_node(first, &format!("{path}/run[1]"), None, Some(&notes));
                for (k, v) in run.props() {
                    if k != "text" {
                        node.set(k, v.clone());
                    }
                }
                if boolean(paras[0].child(A, "pPr").and_then(|p| p.attr("rtl"))) == Some(true) {
                    node.str("direction", "rtl");
                }
            }
            return Ok(node);
        }
        if let Some(c) = caps(
            r"(?i)^/slide\[(\d+)\]/shape\[(\d+)\]/(?:hyperlink|hlink)$",
            &path,
        ) {
            let (si, shi) = (num(&c[1]), num(&c[2]));
            let (part, shape) = self.shape_at(si, shi)?;
            let seg = segment("shape", shape, shi);
            let mut h = cnvpr_of(shape).and_then(|c| c.child(A, "hlinkClick"));
            let mut url = self.hyperlink(h, &part);
            if url.is_none() {
                h = shape
                    .child(P, "txBody")
                    .and_then(|b| b.first_named(A, "r"))
                    .and_then(|r| r.child(A, "rPr"))
                    .and_then(|r| r.child(A, "hlinkClick"));
                url = self.hyperlink(h, &part);
            }
            let Some(url) = url else {
                return Err(fail(format!(
                    "Hyperlink not found at /slide[{si}]/{seg}/hyperlink (shape has no hyperlink)"
                )));
            };
            let mut node = Node::new(format!("/slide[{si}]/{seg}/hyperlink"), "hyperlink");
            node.text = Some(url.clone());
            node.str("link", url);
            if let Some(tip) = h.and_then(|h| h.attr("tooltip")).filter(|t| !t.is_empty()) {
                node.str("tooltip", tip);
            }
            return Ok(node);
        }
        if let Some(c) = caps(
            r"^/slide\[(\d+)\]/shape\[(\d+)\]/(?:run|r)\[(\d+)\]$",
            &path,
        ) {
            let (si, shi, ri) = (num(&c[1]), num(&c[2]), num(&c[3]));
            let (part, shape) = self.shape_at(si, shi)?;
            let runs: Vec<E<'_>> = shape
                .child(P, "txBody")
                .map(|b| b.children(A, "p"))
                .unwrap_or_default()
                .iter()
                .flat_map(|p| p.children(A, "r"))
                .collect();
            if ri < 1 || ri > runs.len() {
                return Err(fail(format!(
                    "Run {ri} not found (shape has {} runs)",
                    runs.len()
                )));
            }
            let slide = Slide {
                part: &part,
                num: si,
            };
            return Ok(self.run_node(
                runs[ri - 1],
                &format!("/slide[{si}]/{}/run[{ri}]", segment("shape", shape, shi)),
                Some(slide),
                Some(&part),
            ));
        }
        if let Some(c) = caps(
            r"^/slide\[(\d+)\]/shape\[(\d+)\]/(?:paragraph|p)\[(\d+)\](?:/(?:run|r)\[(\d+)\])?$",
            &path,
        ) {
            let (si, shi, pi) = (num(&c[1]), num(&c[2]), num(&c[3]));
            let (part, shape) = self.shape_at(si, shi)?;
            let seg = segment("shape", shape, shi);
            let body = shape
                .child(P, "txBody")
                .ok_or_else(|| fail("Shape has no text body".to_string()))?;
            let paras = body.children(A, "p");
            if pi < 1 || pi > paras.len() {
                return Err(fail(format!(
                    "Paragraph {pi} not found (shape has {} paragraphs)",
                    paras.len()
                )));
            }
            let para = paras[pi - 1];
            let slide = Slide {
                part: &part,
                num: si,
            };
            if c[4].is_some() {
                let ri = num(&c[4]);
                let runs = para.children(A, "r");
                if ri < 1 || ri > runs.len() {
                    return Err(fail(format!(
                        "Run {ri} not found (paragraph has {} runs)",
                        runs.len()
                    )));
                }
                return Ok(self.run_node(
                    runs[ri - 1],
                    &format!("/slide[{si}]/{seg}/paragraph[{pi}]/run[{ri}]"),
                    Some(slide),
                    Some(&part),
                ));
            }
            return Ok(self.direct_paragraph(
                para,
                &format!("/slide[{si}]/{seg}/paragraph[{pi}]"),
                depth,
                slide,
            ));
        }
        if let Some(c) = caps(
            r"^/slide\[(\d+)\]/placeholder\[(\w+)\]/(?:run|r)\[(\d+)\]$",
            &path,
        ) {
            let (si, ri) = (num(&c[1]), num(&c[3]));
            let id = c[2].clone().unwrap_or_default();
            let part = self.slide_at(si)?;
            let shape = self.placeholder_shape(&part, &id)?;
            let runs: Vec<E<'_>> = shape
                .child(P, "txBody")
                .map(|b| b.children(A, "p"))
                .unwrap_or_default()
                .iter()
                .flat_map(|p| p.children(A, "r"))
                .collect();
            if ri < 1 || ri > runs.len() {
                return Err(fail(format!(
                    "Run {ri} not found (placeholder has {} runs)",
                    runs.len()
                )));
            }
            let slide = Slide {
                part: &part,
                num: si,
            };
            return Ok(self.run_node(
                runs[ri - 1],
                &format!("/slide[{si}]/placeholder[{id}]/run[{ri}]"),
                Some(slide),
                Some(&part),
            ));
        }
        if let Some(c) = caps(
            r"^/slide\[(\d+)\]/placeholder\[(\w+)\]/(?:paragraph|p)\[(\d+)\](?:/(?:run|r)\[(\d+)\])?$",
            &path,
        ) {
            let (si, pi) = (num(&c[1]), num(&c[3]));
            let id = c[2].clone().unwrap_or_default();
            let part = self.slide_at(si)?;
            let shape = self.placeholder_shape(&part, &id)?;
            let body = shape
                .child(P, "txBody")
                .ok_or_else(|| fail("Placeholder has no text body".to_string()))?;
            let paras = body.children(A, "p");
            if pi < 1 || pi > paras.len() {
                return Err(fail(format!(
                    "Paragraph {pi} not found (placeholder has {} paragraphs)",
                    paras.len()
                )));
            }
            let para = paras[pi - 1];
            let slide = Slide {
                part: &part,
                num: si,
            };
            if c[4].is_some() {
                let ri = num(&c[4]);
                let runs = para.children(A, "r");
                if ri < 1 || ri > runs.len() {
                    return Err(fail(format!(
                        "Run {ri} not found (paragraph has {} runs)",
                        runs.len()
                    )));
                }
                return Ok(self.run_node(
                    runs[ri - 1],
                    &format!("/slide[{si}]/placeholder[{id}]/paragraph[{pi}]/run[{ri}]"),
                    Some(slide),
                    Some(&part),
                ));
            }
            return Ok(self.direct_paragraph(
                para,
                &format!("/slide[{si}]/placeholder[{id}]/paragraph[{pi}]"),
                depth,
                slide,
            ));
        }
        if let Some(c) = caps(
            r"^/slide\[(\d+)\]/table\[(\d+)\]/tr\[(\d+)\]/tc\[(\d+)\]$",
            &path,
        ) {
            let (si, ti, ri, ci) = (num(&c[1]), num(&c[2]), num(&c[3]), num(&c[4]));
            let (gf, table) = self.table_at(si, ti)?;
            let rows = table.children(A, "tr");
            if ri < 1 || ri > rows.len() {
                return Err(fail(format!(
                    "Row {ri} not found (table has {} rows)",
                    rows.len()
                )));
            }
            let cells = rows[ri - 1].children(A, "tc");
            if ci < 1 || ci > cells.len() {
                return Err(fail(format!(
                    "Cell {ci} not found (row has {} cells)",
                    cells.len()
                )));
            }
            return Ok(Self::direct_cell(
                cells[ci - 1],
                &format!(
                    "/slide[{si}]/{}/tr[{ri}]/tc[{ci}]",
                    segment("table", gf, ti)
                ),
            ));
        }
        let ph_match = caps(r"^/slide\[(\d+)\]/placeholder\[(\w+)\]$", &path);
        if let Some(c) =
            ph_match.filter(|_| caps(r"^/slide\[\d+\](?:/\w+\[\d+\])?$", &path).is_none())
        {
            let si = num(&c[1]);
            let id = c[2].clone().unwrap_or_default();
            let part = self.slide_at(si)?;
            if let Some(n) = int(Some(&id)) {
                return self.placeholder_node(&part, si, n as usize, depth);
            }
            let shape = self.placeholder_shape(&part, &id)?;
            let ph = ph_of(shape);
            let tree = Self::sp_tree(Some(self.slide(&part)?));
            let at = tree
                .and_then(|t| t.children(P, "sp").iter().position(|s| *s == shape))
                .unwrap_or(0);
            let slide = Slide {
                part: &part,
                num: si,
            };
            let mut node = self.shape_node(shape, si, at + 1, depth, Some(slide), None);
            let old = node.path.clone();
            rebase(&mut node, &old, &path);
            node.path = path.clone();
            node.kind = "placeholder".to_string();
            if let Some(t) = ph.and_then(|p| p.attr("type")) {
                node.str("phType", t);
            }
            if let Some(i) = long(ph.and_then(|p| p.attr("idx"))) {
                node.set("phIndex", Value::Int(i));
            }
            return Ok(node);
        }
        if let Some(c) = caps(
            r"^/slide\[(\d+)\]/table\[(\d+)\]/(\w+)\[(\d+)\](?:/(\w+)\[(\d+)\])?$",
            &path,
        ) {
            let (si, ti, sub) = (num(&c[1]), num(&c[2]), num(&c[4]));
            let kind = c[3].clone().unwrap_or_default().to_lowercase();
            let part = self.slide_at(si)?;
            let tree = Self::sp_tree(Some(self.slide(&part)?))
                .ok_or_else(|| fail(format!("Slide {si} has no shapes")))?;
            let list = tables(tree);
            if ti < 1 || ti > list.len() {
                return Err(fail(format!(
                    "Table {ti} not found (total: {})",
                    list.len()
                )));
            }
            let table_node = self.table_node(list[ti - 1], si, ti, 2, None);
            if kind == "tr" {
                let rows: Vec<&Node> = table_node
                    .children
                    .iter()
                    .filter(|c| c.kind == "tr")
                    .collect();
                if sub < 1 || sub > rows.len() {
                    return Err(fail(format!("Row {sub} not found (total: {})", rows.len())));
                }
                let row = rows[sub - 1].clone();
                if c[5]
                    .as_deref()
                    .is_some_and(|k| k.eq_ignore_ascii_case("tc"))
                {
                    let cells: Vec<&Node> =
                        row.children.iter().filter(|c| c.kind == "tc").collect();
                    let ci = num(&c[6]);
                    if ci < 1 || ci > cells.len() {
                        return Err(fail(format!(
                            "Cell {ci} not found (total: {})",
                            cells.len()
                        )));
                    }
                    return Ok(cells[ci - 1].clone());
                }
                return Ok(row);
            }
            if kind == "col" {
                let cols = list[ti - 1]
                    .first_named(A, "tbl")
                    .and_then(|t| t.child(A, "tblGrid"))
                    .map(|g| g.children(A, "gridCol"))
                    .unwrap_or_default();
                if sub < 1 || sub > cols.len() {
                    return Err(fail(format!(
                        "Column {sub} not found (total: {})",
                        cols.len()
                    )));
                }
                let mut node = Node::new(path.clone(), "col");
                if let Some(w) = long(cols[sub - 1].attr("w")) {
                    node.str("width", format_emu(w));
                }
                return Ok(node);
            }
            return Err(fail(format!("Unknown table sub-element: {kind}")));
        }
        if let Some(c) = caps(
            r"^/slide\[(\d+)\]/group\[(\d+)\]((?:/group\[\d+\])*)(?:/(shape|picture|pic|table|chart|connector|connection)\[(\d+)\])?$",
            &path,
        ) {
            if c[3].as_deref().is_some_and(|s| !s.is_empty()) || c[4].is_some() {
                return self.nested_group(&c, depth);
            }
        }
        if caps(r"(?i)^/theme\[\d+\]$", &path).is_some() {
            return Err(fail(
                "theme is a singleton; use /theme (no index).".to_string(),
            ));
        }
        if caps(r"(?i)^/presentation\[\d+\]$", &path).is_some() {
            return Err(fail(
                "presentation is the pptx root; use / (no index).".to_string(),
            ));
        }
        let Some(c) = caps(r"^/slide\[(\d+)\](?:/(\w+)\[(\d+)\])?$", &path) else {
            return self.fallback(&path, depth);
        };
        let Some(si) = int(c[1].as_deref()).map(|n| n as usize) else {
            return Err(fail(format!(
                "Invalid slide index '{}'. Must be a positive integer.",
                c[1].clone().unwrap_or_default()
            )));
        };
        let part = self.slide_at(si)?;
        let Some(kind) = c[2].clone() else {
            return self.slide_node(&path, &part, si, depth);
        };
        let index = num(&c[3]);
        let tree = Self::sp_tree(Some(self.slide(&part)?))
            .ok_or_else(|| fail(format!("Slide {si} has no shapes")))?;
        let slide = Slide {
            part: &part,
            num: si,
        };
        if kind.eq_ignore_ascii_case("notes") {
            return Err(fail(format!(
                "notes is a singleton per slide; use /slide[{si}]/notes (no index)."
            )));
        }
        let check = |n: usize, what: &str| -> Result<(), Fail> {
            if index < 1 || index > n {
                Err(fail(format!("{what} {index} not found (total: {n})")))
            } else {
                Ok(())
            }
        };
        match kind.as_str() {
            "shape" => {
                let shapes = tree.children(P, "sp");
                check(shapes.len(), "Shape")?;
                return Ok(self.shape_node(shapes[index - 1], si, index, depth, Some(slide), None));
            }
            "table" => {
                let list = tables(tree);
                check(list.len(), "Table")?;
                return Ok(self.table_node(list[index - 1], si, index, depth, None));
            }
            "placeholder" => return self.placeholder_node(&part, si, index, depth),
            "chart" => {
                let list = charts(tree);
                check(list.len(), "Chart")?;
                return Ok(self.chart_node(list[index - 1], slide, index, None));
            }
            "picture" | "pic" => {
                let pics = tree.children(P, "pic");
                check(pics.len(), "Picture")?;
                return Ok(self.picture_node(pics[index - 1], si, index, Some(slide), None));
            }
            "audio" | "video" => {
                let all = tree.children(P, "pic");
                let file = if kind == "video" {
                    "videoFile"
                } else {
                    "audioFile"
                };
                let media: Vec<E<'_>> = all
                    .iter()
                    .copied()
                    .filter(|p| {
                        nv_of(*p)
                            .and_then(|n| n.child(P, "nvPr"))
                            .and_then(|n| n.child(A, file))
                            .is_some()
                    })
                    .collect();
                if index < 1 || index > media.len() {
                    return Err(fail(format!(
                        "{kind} {index} not found (total: {}). Slide {si} contains: {} picture(s)",
                        media.len(),
                        all.len()
                    )));
                }
                let pic = media[index - 1];
                let at = all.iter().position(|x| *x == pic).unwrap_or(0) + 1;
                let mut node = self.picture_node(pic, si, at, Some(slide), None);
                node.path = format!("/slide[{si}]/{}", segment(&kind, pic, index));
                return Ok(node);
            }
            "connector" | "connection" => {
                let list = tree.children(P, "cxnSp");
                check(list.len(), "Connector")?;
                return Ok(self.connector_node(
                    list[index - 1],
                    si,
                    index,
                    None,
                    depth,
                    Some(slide),
                ));
            }
            "group" => {
                let groups = tree.children(P, "grpSp");
                check(groups.len(), "Group")?;
                return Ok(self.top_group(groups[index - 1], slide, index, depth));
            }
            _ => {}
        }
        let matches: Vec<E<'_>> = tree
            .elements()
            .filter(|e| e.name().eq_ignore_ascii_case(&kind))
            .collect();
        if index < 1 || index > matches.len() {
            return Err(fail(format!(
                "{kind} {index} not found (total: {}). Slide {si} contains: {}",
                matches.len(),
                inventory(tree)
            )));
        }
        Ok(Self::element_node(matches[index - 1], &path, depth))
    }

    fn top_group(&self, grp: E<'_>, slide: Slide<'_>, index: usize, depth: usize) -> Node {
        let name = cnvpr_of(grp)
            .and_then(|c| c.attr("name"))
            .unwrap_or("Group")
            .to_string();
        let path = format!("/slide[{}]/{}", slide.num, segment("group", grp, index));
        let mut node = Node::new(path.clone(), "group");
        node.preview = Some(name.clone());
        node.child_count = content_kids(grp).len();
        node.str("name", name);
        let props = grp.child(P, "grpSpPr");
        let xfrm = props.and_then(|p| p.child(A, "xfrm"));
        Self::frame(xfrm, &mut node, false);
        if let Some(rot) = int(xfrm.and_then(|x| x.attr("rot"))).filter(|r| *r != 0) {
            node.str("rotation", rotation(rot, 2));
        }
        Self::child_frame(xfrm, &mut node);
        if let Some(fill) = read_color(props.and_then(|p| p.child(A, "solidFill"))) {
            node.str("fill", fill);
        } else if props.and_then(|p| p.child(A, "noFill")).is_some() {
            node.str("fill", "none");
        } else if props.and_then(|p| p.child(A, "gradFill")).is_some() {
            node.str("fill", "gradient");
        }
        let h = cnvpr_of(grp).and_then(|c| c.child(A, "hlinkClick"));
        if let Some(link) = self.hyperlink(h, slide.part) {
            node.str("link", link);
        }
        if let Some(tip) = h.and_then(|h| h.attr("tooltip")).filter(|t| !t.is_empty()) {
            node.str("tooltip", tip);
        }
        if depth > 0 {
            self.children(&mut node.children, grp, slide, depth - 1, &path);
        }
        node
    }

    fn nested_group(&self, c: &[Option<String>], depth: usize) -> Result<Node, Fail> {
        let (si, gi) = (num(&c[1]), num(&c[2]));
        let part = self.slide_at(si)?;
        let tree = Self::sp_tree(Some(self.slide(&part)?))
            .ok_or_else(|| fail("Slide has no shape tree".to_string()))?;
        let roots = tree.children(P, "grpSp");
        if gi < 1 || gi > roots.len() {
            return Err(fail(format!(
                "Group {gi} not found (total: {})",
                roots.len()
            )));
        }
        let mut current = roots[gi - 1];
        let mut prefix = format!("/slide[{si}]/{}", segment("group", current, gi));
        let group_re = Regex::new(r"/group\[(\d+)\]").expect("a valid pattern");
        for seg in group_re
            .captures_iter(c[3].as_deref().unwrap_or_default())
            .flatten()
        {
            let n: usize = seg.get(1).map_or("", |x| x.as_str()).parse().unwrap_or(0);
            let subs = current.children(P, "grpSp");
            if n < 1 || n > subs.len() {
                return Err(fail(format!(
                    "Nested group {n} not found at {prefix} (total: {})",
                    subs.len()
                )));
            }
            current = subs[n - 1];
            prefix = format!("{prefix}/{}", segment("group", current, n));
        }
        let slide = Slide {
            part: &part,
            num: si,
        };
        let Some(kind) = c[4].as_deref().map(str::to_lowercase) else {
            let name = cnvpr_of(current)
                .and_then(|x| x.attr("name"))
                .unwrap_or("Group")
                .to_string();
            let mut node = Node::new(prefix.clone(), "group");
            node.preview = Some(name.clone());
            node.child_count = content_kids(current).len();
            node.str("name", name);
            let xfrm = current.child(P, "grpSpPr").and_then(|g| g.child(A, "xfrm"));
            Self::frame(xfrm, &mut node, false);
            if let Some(rot) = int(xfrm.and_then(|x| x.attr("rot"))).filter(|r| *r != 0) {
                node.str("rotation", rotation(rot, 2));
            }
            Self::child_frame(xfrm, &mut node);
            if depth > 0 {
                self.children(&mut node.children, current, slide, depth - 1, &prefix);
            }
            return Ok(node);
        };
        let li = num(&c[5]);
        let pick = |list: Vec<E<'p>>, what: &str| -> Result<E<'p>, Fail> {
            if li < 1 || li > list.len() {
                return Err(fail(format!(
                    "{what} {li} not found in group {prefix} (total: {})",
                    list.len()
                )));
            }
            Ok(list[li - 1])
        };
        Ok(match kind.as_str() {
            "shape" => {
                let e = pick(current.children(P, "sp"), "Shape")?;
                let mut node = self.shape_node(e, si, li, depth, Some(slide), Some(&prefix));
                node.path = format!("{prefix}/{}", segment("shape", e, li));
                node
            }
            "picture" | "pic" => {
                let e = pick(current.children(P, "pic"), "Picture")?;
                self.picture_node(e, si, li, Some(slide), Some(&prefix))
            }
            "connector" | "connection" => {
                let e = pick(current.children(P, "cxnSp"), "Connector")?;
                self.connector_node(e, si, li, Some(&prefix), depth, Some(slide))
            }
            "table" => {
                let e = pick(tables(current), "Table")?;
                self.table_node(e, si, li, depth, Some(&prefix))
            }
            _ => {
                let e = pick(charts(current), "Chart")?;
                self.chart_node(e, slide, li, Some(&prefix))
            }
        })
    }

    fn table_at(&self, si: usize, ti: usize) -> Result<(E<'p>, E<'p>), Fail> {
        let part = self.slide_at(si)?;
        let list = Self::sp_tree(Some(self.slide(&part)?))
            .map(tables)
            .unwrap_or_default();
        if ti < 1 || ti > list.len() {
            return Err(fail(format!(
                "Table {ti} not found (total: {})",
                list.len()
            )));
        }
        let gf = list[ti - 1];
        Ok((gf, gf.first_named(A, "tbl").expect("a table")))
    }

    fn direct_cell(cell: E<'_>, path: &str) -> Node {
        let mut node = Node::new(path, "tc");
        node.text = Some(cell_text(cell));
        Self::spans(cell, &mut node);
        let tcpr = cell.child(A, "tcPr");
        Self::cell_fill(tcpr, &mut node, false);
        if let Some(tcpr) = tcpr {
            super::tables::cell_borders(tcpr, &mut node);
        }
        if let Some(anchor) = tcpr.and_then(|t| t.attr("anchor")) {
            node.str("valign", cell_anchor(anchor));
        }
        if let Some(vert) = tcpr.and_then(|t| t.attr("vert")) {
            node.str("textdirection", text_direction(vert));
        }
        if let Some(wrap) = cell
            .child(A, "txBody")
            .and_then(|b| b.child(A, "bodyPr"))
            .and_then(|b| b.attr("wrap"))
        {
            node.set("wrap", Value::Bool(wrap != "none"));
        }
        Self::padding(tcpr, &mut node);
        let ppr = cell
            .child(A, "txBody")
            .and_then(|b| b.children(A, "p").into_iter().next())
            .and_then(|p| p.child(A, "pPr"));
        if let Some(algn) = ppr.and_then(|p| p.attr("algn")) {
            node.str("align", normalize_alignment(algn));
        }
        if let Some(rtl) = boolean(ppr.and_then(|p| p.attr("rtl"))) {
            node.str("direction", if rtl { "rtl" } else { "ltr" });
        }
        spacing(ppr, &mut node);
        if let Some(rpr) = cell.first_named(A, "r").and_then(|r| r.child(A, "rPr")) {
            let font = rpr
                .child(A, "latin")
                .and_then(|l| l.attr("typeface"))
                .or_else(|| rpr.child(A, "ea").and_then(|e| e.attr("typeface")));
            if let Some(f) = font {
                node.str("font", f);
            }
            if let Some(sz) = int(rpr.attr("sz")) {
                node.str("size", format!("{}pt", f2(sz as f64 / 100.0)));
            }
            if boolean(rpr.attr("b")) == Some(true) {
                node.set("bold", Value::Bool(true));
            }
            if boolean(rpr.attr("i")) == Some(true) {
                node.set("italic", Value::Bool(true));
            }
            if let Some(u) = rpr.attr("u").filter(|u| *u != "none") {
                node.str("underline", underline_name(u));
            }
            if let Some(s) = rpr.attr("strike") {
                node.str("strike", strike_name(s));
            }
            if let Some(hex) = rpr
                .child(A, "solidFill")
                .and_then(|s| s.child(A, "srgbClr"))
                .and_then(|c| c.attr("val"))
            {
                node.str("color", hex_color(hex));
            }
        }
        node
    }

    fn fallback(&self, path: &str, depth: usize) -> Result<Node, Fail> {
        let mut segments: Vec<(String, Option<usize>)> = Vec::new();
        for part in path.trim_matches('/').split('/') {
            if part.is_empty() {
                continue;
            }
            match part.find('[') {
                Some(b) => {
                    if part[b + 1..].find(']').is_none() {
                        return Err(fail(format!(
                            "Malformed path segment '{part}'. Bracket '[' is not closed. Expected format: name[index] or name[@attr=value]."
                        )));
                    }
                    let inner = &part[b + 1..part.len() - 1];
                    let Some(idx) = int(Some(inner)) else {
                        return Err(fail(format!(
                            "Invalid path index '{inner}' in segment '{part}'. Expected a numeric index."
                        )));
                    };
                    if idx < 1 {
                        return Err(fail(format!(
                            "Invalid path index '{idx}' in segment '{part}'. Index must be >= 1."
                        )));
                    }
                    segments.push((part[..b].to_string(), Some(idx as usize)));
                }
                None => segments.push((part.to_string(), None)),
            }
        }
        let first = segments.first().cloned();
        let Some((name, Some(si))) =
            first.filter(|(n, i)| n.eq_ignore_ascii_case("slide") && i.is_some())
        else {
            return Err(Fail::coded(
                format!(
                    "Path must start with /slide[N], /slidemaster[N], or /slidelayout[N]: {path}"
                ),
                "invalid_path",
            ));
        };
        let _ = name;
        let parts = self.slide_parts();
        if si < 1 || si > parts.len() {
            return Err(Fail::coded(
                format!("Slide {si} not found (total: {})", parts.len()),
                "path_not_found",
            ));
        }
        let mut current = Some(self.slide(&parts[si - 1])?);
        for (name, idx) in &segments[1..] {
            let Some(cur) = current else { break };
            let list: Vec<E<'_>> = cur
                .elements()
                .filter(|e| e.name().eq_ignore_ascii_case(name))
                .collect();
            current = match idx {
                Some(i) => list.get(i - 1).copied(),
                None => list.first().copied(),
            };
        }
        let current = current.ok_or_else(|| fail(format!("Element not found: {path}")))?;
        Ok(Self::element_node(current, path, depth))
    }
}
