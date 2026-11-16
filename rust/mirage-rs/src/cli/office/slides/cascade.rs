// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! What a paragraph or run inherits, layer by layer, and from where: the
//! theme's fonts, the presentation's default text style, the master's
//! text styles, the master's and layout's matching placeholder, the
//! shape's own list style, then the paragraph and run themselves.

use std::collections::HashMap;

use super::super::node::{Node, Value};
use super::super::tree::{A, E, P, schema_ordered};
use super::super::units::f2;
use super::color::read_color;
use super::int;
use super::text::{
    hundredths_points, line_spacing_percent, percent_val, strike_name, underline_name,
};

/// Whether a slide placeholder takes its frame and styles from a layout or master one.
pub(super) fn placeholder_matches(slide_ph: E<'_>, layout_ph: E<'_>) -> bool {
    let si = super::long(slide_ph.attr("idx"));
    let li = super::long(layout_ph.attr("idx"));
    let st = slide_ph.attr("type");
    let lt = layout_ph.attr("type");
    if let (Some(a), Some(b)) = (si, li) {
        return a == b;
    }
    if let (Some(a), Some(b)) = (st, lt) {
        return same_family(a, b);
    }
    if si.is_some() && st.is_none() && li.is_none() {
        if let Some(lt) = lt {
            return lt == "body" || lt == "obj";
        }
    }
    if st.is_none() && si.is_none() {
        if let Some(lt) = lt {
            return matches!(lt, "title" | "ctrTitle" | "subTitle" | "body");
        }
    }
    false
}

fn same_family(a: &str, b: &str) -> bool {
    let title = |v: &str| v == "title" || v == "ctrTitle";
    let body = |v: &str| v == "body" || v == "subTitle" || v == "obj";
    a == b || (title(a) && title(b)) || (body(a) && body(b))
}

/// Whether a transform states its offset and extent in full.
pub(super) fn complete_frame(xfrm: Option<E<'_>>) -> bool {
    let off = xfrm.and_then(|x| x.child(A, "off"));
    let ext = xfrm.and_then(|x| x.child(A, "ext"));
    super::long(off.and_then(|o| o.attr("x"))).is_some()
        && super::long(off.and_then(|o| o.attr("y"))).is_some()
        && super::long(ext.and_then(|e| e.attr("cx"))).is_some()
        && super::long(ext.and_then(|e| e.attr("cy"))).is_some()
}

/// What a resolved paragraph and run inherit, and from where.
#[derive(Default)]
pub(super) struct Resolved<'t> {
    pub(super) size: Option<i64>,
    pub(super) color: Option<String>,
    pub(super) bold: Option<bool>,
    pub(super) italic: Option<bool>,
    pub(super) underline: Option<String>,
    pub(super) strike: Option<String>,
    pub(super) font_latin: Option<String>,
    pub(super) font_ea: Option<String>,
    pub(super) font_cs: Option<String>,
    pub(super) align: Option<String>,
    pub(super) line_spacing: Option<String>,
    pub(super) space_before: Option<String>,
    pub(super) space_after: Option<String>,
    pub(super) font_scheme: Option<E<'t>>,
    pub(super) sources: HashMap<&'static str, String>,
}

const LEVELS: [&str; 9] = [
    "lvl1pPr", "lvl2pPr", "lvl3pPr", "lvl4pPr", "lvl5pPr", "lvl6pPr", "lvl7pPr", "lvl8pPr",
    "lvl9pPr",
];

impl<'t> Resolved<'t> {
    /// A style list's level, its paragraph properties then its default run's.
    pub(super) fn apply_level(&mut self, list: Option<E<'_>>, level: usize, layer: &str) {
        let Some(list) = list else { return };
        let Some(ppr) = list.child(A, LEVELS.get(level).copied().unwrap_or("lvl1pPr")) else {
            return;
        };
        self.apply_paragraph(ppr, layer);
        if let Some(def) = ppr.child(A, "defRPr") {
            self.apply_run(def, layer);
        }
    }

    pub(super) fn apply_paragraph(&mut self, ppr: E<'_>, layer: &str) {
        if let Some(algn) = ppr.attr("algn") {
            self.align = Some(
                match algn {
                    "l" => "left",
                    "ctr" => "center",
                    "r" => "right",
                    "just" => "justify",
                    other => other,
                }
                .to_string(),
            );
            self.sources.insert("align", layer.to_string());
        }
        if let Some(ln) = ppr.child(A, "lnSpc") {
            if let Some(pct) = percent_val(ln.child(A, "spcPct")) {
                self.line_spacing = Some(line_spacing_percent(pct));
                self.sources.insert("lineSpacing", layer.to_string());
            } else if let Some(pts) = int(ln.child(A, "spcPts").and_then(|p| p.attr("val"))) {
                self.line_spacing = Some(hundredths_points(pts));
                self.sources.insert("lineSpacing", layer.to_string());
            }
        }
        let pts = |name: &str| {
            int(ppr
                .child(A, name)
                .and_then(|s| s.child(A, "spcPts"))
                .and_then(|p| p.attr("val")))
        };
        if let Some(sb) = pts("spcBef") {
            self.space_before = Some(hundredths_points(sb));
            self.sources.insert("spaceBefore", layer.to_string());
        }
        if let Some(sa) = pts("spcAft") {
            self.space_after = Some(hundredths_points(sa));
            self.sources.insert("spaceAfter", layer.to_string());
        }
    }

    pub(super) fn apply_run(&mut self, rpr: E<'_>, layer: &str) {
        for a in schema_ordered(rpr) {
            if !a.ns.is_empty() {
                continue;
            }
            let v = a.value.as_str();
            match a.name.as_str() {
                "sz" => {
                    if let Some(sz) = int(Some(v)) {
                        self.size = Some(sz);
                        self.sources.insert("size", layer.to_string());
                    }
                }
                "b" => {
                    self.bold = Some(v == "1" || v.eq_ignore_ascii_case("true"));
                    self.sources.insert("bold", layer.to_string());
                }
                "i" => {
                    self.italic = Some(v == "1" || v.eq_ignore_ascii_case("true"));
                    self.sources.insert("italic", layer.to_string());
                }
                "u" if v != "none" => {
                    self.underline = Some(underline_name(v));
                    self.sources.insert("underline", layer.to_string());
                }
                "strike" => {
                    self.strike = Some(strike_name(v).to_string());
                    self.sources.insert("strike", layer.to_string());
                }
                _ => {}
            }
        }
        for (child, key) in [
            ("latin", "font.latin"),
            ("ea", "font.ea"),
            ("cs", "font.cs"),
        ] {
            let face = rpr.child(A, child).and_then(|c| c.attr("typeface"));
            self.themed_font(face, key, layer);
        }
        if let Some(color) = read_color(rpr.child(A, "solidFill")) {
            self.color = Some(color);
            self.sources.insert("color", layer.to_string());
        }
    }

    fn slot(&mut self, key: &str) -> &mut Option<String> {
        match key {
            "font.ea" => &mut self.font_ea,
            "font.cs" => &mut self.font_cs,
            _ => &mut self.font_latin,
        }
    }

    fn themed_font(&mut self, face: Option<&str>, key: &'static str, layer: &str) {
        let Some(face) = face.filter(|f| !f.is_empty()) else {
            return;
        };
        if !face.starts_with('+') {
            *self.slot(key) = Some(face.to_string());
            self.sources.insert(key, layer.to_string());
            return;
        }
        let Some(scheme) = self.font_scheme else {
            return;
        };
        let major = face.starts_with("+mj");
        let font = scheme.child(A, if major { "majorFont" } else { "minorFont" });
        let child = match key {
            "font.ea" => "ea",
            "font.cs" => "cs",
            _ => "latin",
        };
        let resolved = font
            .and_then(|f| f.child(A, child))
            .and_then(|c| c.attr("typeface"));
        if let Some(r) = resolved.filter(|r| !r.is_empty() && !r.starts_with('+')) {
            *self.slot(key) = Some(r.to_string());
            self.sources.insert(
                key,
                if major {
                    "/theme/majorFont"
                } else {
                    "/theme/minorFont"
                }
                .to_string(),
            );
        }
    }

    fn src(&self, node: &mut Node, key: &str, source: &str) {
        if let Some(s) = self.sources.get(source).filter(|s| s.as_str() != "/direct") {
            node.str(&format!("{key}.src"), s.clone());
        }
    }

    /// The run values a node does not state itself, as `effective.*` with their sources.
    pub(super) fn emit_run(&self, node: &mut Node) {
        if !node.has("size") {
            if let Some(size) = self.size {
                node.str("effective.size", format!("{}pt", f2(size as f64 / 100.0)));
                self.src(node, "effective.size", "size");
            }
        }
        let bare = node.has("font");
        for (has, value, key, source) in [
            (
                "font.latin",
                &self.font_latin,
                "effective.font.latin",
                "font.latin",
            ),
            ("font.ea", &self.font_ea, "effective.font.ea", "font.ea"),
            ("font.cs", &self.font_cs, "effective.font.cs", "font.cs"),
        ] {
            if !bare && !node.has(has) {
                if let Some(v) = value {
                    node.str(key, v.clone());
                    self.src(node, key, source);
                }
            }
        }
        if !bare {
            if let Some(v) = &self.font_latin {
                node.str("effective.font", v.clone());
                self.src(node, "effective.font", "font.latin");
            }
        }
        if !node.has("bold") && self.bold == Some(true) {
            node.set("effective.bold", Value::Bool(true));
            self.src(node, "effective.bold", "bold");
        }
        if !node.has("italic") && self.italic == Some(true) {
            node.set("effective.italic", Value::Bool(true));
            self.src(node, "effective.italic", "italic");
        }
        for (has, value, key) in [
            ("underline", &self.underline, "effective.underline"),
            ("strike", &self.strike, "effective.strike"),
            ("color", &self.color, "effective.color"),
        ] {
            if !node.has(has) {
                if let Some(v) = value {
                    node.str(key, v.clone());
                    self.src(node, key, has);
                }
            }
        }
    }

    /// The paragraph values a node does not state itself.
    pub(super) fn emit_paragraph(&self, node: &mut Node) {
        for (has, value, key) in [
            ("align", &self.align, "effective.align"),
            ("lineSpacing", &self.line_spacing, "effective.lineSpacing"),
            ("spaceBefore", &self.space_before, "effective.spaceBefore"),
            ("spaceAfter", &self.space_after, "effective.spaceAfter"),
        ] {
            if !node.has(has) {
                if let Some(v) = value {
                    node.str(key, v.clone());
                    self.src(node, key, has);
                }
            }
        }
    }
}

/// A placeholder's path in a layer, for a source: `/master[1]/ph[@type=title]/lvl1pPr`.
pub(super) fn ph_path(root: &str, candidate: E<'_>, level: usize) -> String {
    let mut path = format!("{root}/ph");
    if let Some(t) = candidate.attr("type") {
        path.push_str(&format!("[@type={t}]"));
    }
    if let Some(i) = super::long(candidate.attr("idx")) {
        path.push_str(&format!("[@idx={i}]"));
    }
    path.push_str(&format!("/lvl{}pPr", level + 1));
    path
}

/// The style list of the first placeholder in `tree` that `ph` matches,
/// with its source path; the search stops at the first match.
pub(super) fn ph_layer<'t>(
    tree: Option<E<'t>>,
    ph: E<'_>,
    level: usize,
    root: &str,
) -> Option<(Option<E<'t>>, String)> {
    for candidate in tree?.children(P, "sp") {
        let Some(cph) = super::ph_of(candidate) else {
            continue;
        };
        if !placeholder_matches(ph, cph) {
            continue;
        }
        let list = candidate
            .child(P, "txBody")
            .and_then(|b| b.child(A, "lstStyle"));
        return Some((list, ph_path(root, cph, level)));
    }
    None
}
