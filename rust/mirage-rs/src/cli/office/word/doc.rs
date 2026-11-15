// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! The opened document: its main part and the parts a path can reach,
//! the style chain, what a run and paragraph inherit from the document
//! defaults and their styles, and the numbering a list paragraph uses.

use std::collections::HashMap;

use super::super::Fail;
use super::super::node::{Node, Value};
use super::super::package::Pkg;
use super::super::tree::{E, Tree, W, on_off};
use super::super::units::{half_points, hex_color, js_number, word_line_spacing, word_spacing};
use super::{fail, num_value, w_child, w_val};

/// The run properties a cascade settles on, and the layer each came from.
#[derive(Default)]
pub(super) struct Effective {
    pub(super) ascii: Option<String>,
    pub(super) east_asia: Option<String>,
    pub(super) h_ansi: Option<String>,
    pub(super) cs: Option<String>,
    pub(super) size: Option<String>,
    pub(super) bold: bool,
    pub(super) italic: bool,
    pub(super) strike: bool,
    /// The settling `w:u`'s `w:val`, none when it has no value.
    pub(super) underline: Option<Option<String>>,
    /// The settling `w:color`'s value and theme color.
    pub(super) color: Option<(Option<String>, Option<String>)>,
    pub(super) highlight: Option<Option<String>>,
    pub(super) rtl: Option<bool>,
    pub(super) sources: HashMap<String, String>,
}

/// A number as JavaScript's `Number()` reads it, NaN as none.
pub(super) fn number(v: Option<&str>) -> Option<i64> {
    js_number(v?).filter(|n| n.is_finite()).map(|n| n as i64)
}

pub(crate) struct Word<'p> {
    pub(super) pkg: &'p Pkg<'p>,
    pub(super) main_part: String,
    pub(super) styles_part: Option<String>,
    pub(super) numbering_part: Option<String>,
    pub(super) settings_part: Option<String>,
    pub(super) header_parts: Vec<String>,
    pub(super) footer_parts: Vec<String>,
    style_index: HashMap<String, E<'p>>,
}

impl<'p> Word<'p> {
    pub(super) fn new(pkg: &'p Pkg<'p>) -> Word<'p> {
        let main = pkg.main.clone();
        let first = |kind: &str| pkg.related(&main, kind).into_iter().next();
        let styles_part = first("styles");
        let mut style_index = HashMap::new();
        if let Some(styles) = styles_part
            .as_deref()
            .and_then(|s| pkg.xml(s))
            .map(Tree::root)
        {
            for s in styles.children(W, "style") {
                if let Some(id) = s.w("styleId") {
                    style_index.entry(id.to_string()).or_insert(s);
                }
            }
        }
        Word {
            pkg,
            numbering_part: first("numbering"),
            settings_part: first("settings"),
            header_parts: pkg.related(&main, "header"),
            footer_parts: pkg.related(&main, "footer"),
            styles_part,
            main_part: main,
            style_index,
        }
    }

    pub(super) fn document(&self) -> Result<E<'p>, Fail> {
        self.pkg
            .xml(&self.main_part)
            .map(Tree::root)
            .ok_or_else(|| fail("Not a document 'office' reads".to_string()))
    }

    pub(super) fn body(&self) -> Option<E<'p>> {
        self.document().ok()?.child(W, "body")
    }

    fn root_of(&self, part: Option<&str>) -> Option<E<'p>> {
        self.pkg.xml(part?).map(Tree::root)
    }

    pub(super) fn styles(&self) -> Option<E<'p>> {
        self.root_of(self.styles_part.as_deref())
    }

    pub(super) fn numbering(&self) -> Option<E<'p>> {
        self.root_of(self.numbering_part.as_deref())
    }

    pub(super) fn settings(&self) -> Option<E<'p>> {
        self.root_of(self.settings_part.as_deref())
    }

    pub(super) fn part_of(&self, kind: &str) -> Option<E<'p>> {
        let name = self.pkg.related(&self.main_part, kind).into_iter().next();
        self.root_of(name.as_deref())
    }

    pub(super) fn part_root(&self, part: &str) -> Option<E<'p>> {
        self.root_of(Some(part))
    }

    pub(super) fn style_by_id(&self, id: Option<&str>) -> Option<E<'p>> {
        self.style_index.get(id?).copied()
    }

    pub(super) fn style_name(&self, p: E<'_>) -> String {
        let Some(id) = w_val(w_child(w_child(Some(p), "pPr"), "pStyle")) else {
            return "Normal".to_string();
        };
        let style = self.styles().and_then(|s| {
            s.children(W, "style")
                .into_iter()
                .find(|x| x.w("styleId") == Some(id))
        });
        w_val(w_child(style, "name")).unwrap_or(id).to_string()
    }

    pub(super) fn style_chain(&self, id: Option<&str>) -> Vec<E<'p>> {
        let mut chain = Vec::new();
        let mut seen: Vec<String> = Vec::new();
        let mut cur = id.map(str::to_string);
        while let Some(c) = cur {
            if seen.contains(&c) {
                break;
            }
            seen.push(c.clone());
            let Some(s) = self.style_by_id(Some(&c)) else {
                break;
            };
            chain.push(s);
            cur = w_val(w_child(Some(s), "basedOn")).map(str::to_string);
        }
        chain
    }

    fn merge(target: &mut Effective, source: Option<E<'_>>, layer: &str) {
        let Some(source) = source else { return };
        if let Some(fonts) = source.child(W, "rFonts") {
            for (attr, prop) in [
                ("ascii", "font.ascii"),
                ("eastAsia", "font.eastAsia"),
                ("hAnsi", "font.hAnsi"),
                ("cs", "font.cs"),
            ] {
                if let Some(v) = fonts.w(attr) {
                    let slot = match attr {
                        "ascii" => &mut target.ascii,
                        "eastAsia" => &mut target.east_asia,
                        "hAnsi" => &mut target.h_ansi,
                        _ => &mut target.cs,
                    };
                    *slot = Some(v.to_string());
                    target.sources.insert(prop.to_string(), layer.to_string());
                }
            }
        }
        if let Some(sz) = source.child(W, "sz") {
            target.size = sz.w("val").map(str::to_string);
            target.sources.insert("size".to_string(), layer.to_string());
        }
        let val = |e: E<'_>| e.w("val").map(str::to_string);
        for (name, prop) in [
            ("b", "bold"),
            ("i", "italic"),
            ("u", "underline"),
            ("strike", "strike"),
            ("color", "color"),
            ("highlight", "highlight"),
        ] {
            let Some(e) = source.child(W, name) else {
                continue;
            };
            match prop {
                "bold" => target.bold = true,
                "italic" => target.italic = true,
                "strike" => target.strike = true,
                "underline" => target.underline = Some(val(e)),
                "highlight" => target.highlight = Some(val(e)),
                _ => target.color = Some((val(e), e.w("themeColor").map(str::to_string))),
            }
            target.sources.insert(prop.to_string(), layer.to_string());
        }
        if let Some(rtl) = source.child(W, "rtl") {
            target.rtl = Some(on_off(rtl.w("val")) != Some(false));
        }
    }

    fn bidi_on(v: Option<&str>) -> bool {
        matches!(v, None | Some("1" | "true")) || on_off(v) == Some(true)
    }

    /// What a run inherits: document defaults, the paragraph's style
    /// chain, the run's character style chain, then its own properties.
    pub(super) fn resolve_run<'a>(&self, run: Option<E<'a>>, p: E<'a>) -> Effective {
        let mut eff = Effective::default();
        let styles = self.styles();
        let defaults = w_child(w_child(w_child(styles, "docDefaults"), "rPrDefault"), "rPr");
        Self::merge(&mut eff, defaults, "/docDefaults");
        let mut style_id = w_val(w_child(w_child(Some(p), "pPr"), "pStyle")).map(str::to_string);
        if style_id.is_none() {
            style_id = styles
                .and_then(|s| {
                    s.children(W, "style").into_iter().find(|x| {
                        x.w("type") == Some("paragraph") && on_off(x.w("default")) == Some(true)
                    })
                })
                .and_then(|d| d.w("styleId"))
                .map(str::to_string);
        }
        for style in self.style_chain(style_id.as_deref()).into_iter().rev() {
            let layer = format!("/styles/{}", style.w("styleId").unwrap_or_default());
            Self::merge(&mut eff, style.child(W, "rPr"), &layer);
            if let Some(bidi) = w_child(style.child(W, "pPr"), "bidi") {
                eff.rtl = Some(Self::bidi_on(bidi.w("val")));
                eff.sources.insert("effective.rtl".to_string(), layer);
            }
        }
        let r_style = w_val(w_child(w_child(run, "rPr"), "rStyle"));
        for style in self.style_chain(r_style).into_iter().rev() {
            let layer = format!("/styles/{}", style.w("styleId").unwrap_or_default());
            Self::merge(&mut eff, style.child(W, "rPr"), &layer);
        }
        if let Some(bidi) = w_child(w_child(Some(p), "pPr"), "bidi") {
            eff.rtl = Some(Self::bidi_on(bidi.w("val")));
            eff.sources
                .insert("effective.rtl".to_string(), "/direct".to_string());
        }
        Self::merge(&mut eff, w_child(run, "rPr"), "/direct");
        eff
    }

    pub(super) fn emit_effective_run(node: &mut Node, eff: &Effective) {
        let src = |node: &mut Node, key: &str, prop: &str| {
            if let Some(s) = eff.sources.get(prop).filter(|s| s.as_str() != "/direct") {
                node.str(&format!("{key}.src"), s.clone());
            }
        };
        if !node.has("size") {
            if let Some(sz) = &eff.size {
                node.str("effective.size", half_points(Some(sz)).unwrap_or_default());
                src(node, "effective.size", "size");
            }
        }
        for (value, key) in [
            (&eff.ascii, "ascii"),
            (&eff.east_asia, "eastAsia"),
            (&eff.h_ansi, "hAnsi"),
            (&eff.cs, "cs"),
        ] {
            if let Some(v) = value {
                if !node.has(&format!("font.{key}")) && !node.has("font") {
                    node.str(&format!("effective.font.{key}"), v.clone());
                    src(
                        node,
                        &format!("effective.font.{key}"),
                        &format!("font.{key}"),
                    );
                }
            }
        }
        if !node.has("bold") && eff.bold {
            node.set("effective.bold", Value::Bool(true));
            src(node, "effective.bold", "bold");
        }
        if !node.has("italic") && eff.italic {
            node.set("effective.italic", Value::Bool(true));
            src(node, "effective.italic", "italic");
        }
        if let Some(rtl) = eff.rtl {
            node.set("effective.rtl", Value::Bool(rtl));
            src(node, "effective.rtl", "rtl");
        }
        if !node.has("color") {
            if let Some((val, theme)) = &eff.color {
                if let Some(v) = val {
                    node.str("effective.color", hex_color(v));
                    src(node, "effective.color", "color");
                } else if let Some(t) = theme {
                    node.str("effective.color", t.clone());
                    src(node, "effective.color", "color");
                }
            }
        }
        if let Some(Some(u)) = &eff.underline {
            if !node.has("underline") {
                node.str("effective.underline", u.clone());
                src(node, "effective.underline", "underline");
            }
        }
        if !node.has("strike") && eff.strike {
            node.set("effective.strike", Value::Bool(true));
            src(node, "effective.strike", "strike");
        }
        if let Some(Some(hl)) = &eff.highlight {
            if !node.has("highlight") {
                node.str("effective.highlight", hl.clone());
                src(node, "effective.highlight", "highlight");
            }
        }
    }

    /// The run and paragraph values a paragraph inherits, with their sources.
    pub(super) fn emit_effective_paragraph(&self, node: &mut Node, p: E<'_>) {
        let first = p
            .children(W, "r")
            .into_iter()
            .find(|r| r.child(W, "t").is_some());
        Self::emit_effective_run(node, &self.resolve_run(first, p));
        let chain = self.style_chain(w_val(w_child(w_child(Some(p), "pPr"), "pStyle")));
        let mut align: Option<(String, String)> = None;
        let mut before: Option<(String, String)> = None;
        let mut after: Option<(String, String)> = None;
        let mut line: Option<(String, String)> = None;
        let mut direction: Option<(String, String)> = None;
        for style in chain.iter().rev() {
            let Some(ppr) = style.child(W, "pPr") else {
                continue;
            };
            let layer = format!("/styles/{}", style.w("styleId").unwrap_or_default());
            if let Some(jc) = w_val(ppr.child(W, "jc")) {
                align = Some((
                    if jc == "both" {
                        "justify".to_string()
                    } else {
                        jc.to_string()
                    },
                    layer.clone(),
                ));
            }
            let sp = ppr.child(W, "spacing");
            if let Some(b) = sp.and_then(|s| s.w("before")) {
                before = Some((word_spacing(b, true), layer.clone()));
            }
            if let Some(a) = sp.and_then(|s| s.w("after")) {
                after = Some((word_spacing(a, true), layer.clone()));
            }
            if let Some(l) = sp.and_then(|s| s.w("line")) {
                line = Some((
                    word_line_spacing(l, sp.and_then(|s| s.w("lineRule"))),
                    layer.clone(),
                ));
            }
            if let Some(bidi) = ppr.child(W, "bidi") {
                if let Some(on) = on_off(bidi.w("val")) {
                    direction = Some((if on { "rtl" } else { "ltr" }.to_string(), layer.clone()));
                }
            }
        }
        if !node.has("align") && !node.has("alignment") {
            if let Some((v, s)) = &align {
                node.str("effective.alignment", v.clone());
                node.str("effective.alignment.src", s.clone());
            }
        }
        for (has, value, key) in [
            ("spaceBefore", &before, "effective.spaceBefore"),
            ("spaceAfter", &after, "effective.spaceAfter"),
            ("lineSpacing", &line, "effective.lineSpacing"),
        ] {
            if !node.has(has) {
                if let Some((v, s)) = value {
                    node.str(key, v.clone());
                    node.str(&format!("{key}.src"), s.clone());
                }
            }
        }
        if !node.has("direction") && direction.is_none() {
            if let Some((num_id, ilvl)) = self.num_pr_from_style(p) {
                let inst = self.num_instance(num_id);
                let abs_id = w_val(w_child(inst, "abstractNumId"));
                let lvl = self.abstract_num(abs_id).and_then(|a| {
                    a.children(W, "lvl")
                        .into_iter()
                        .find(|x| x.w("ilvl") == Some(ilvl.to_string().as_str()))
                });
                if let Some(bidi) = w_child(w_child(lvl, "pPr"), "bidi") {
                    if let Some(on) = on_off(bidi.w("val")) {
                        direction = Some((
                            if on { "rtl" } else { "ltr" }.to_string(),
                            format!(
                                "/numbering/abstractNum[@id={}]/level[{ilvl}]",
                                abs_id.unwrap_or_default()
                            ),
                        ));
                    }
                }
            }
        }
        if !node.has("direction") && direction.is_none() {
            let tbl = p.ancestor(W, "tbl");
            let style_id = w_val(w_child(w_child(tbl, "tblPr"), "tblStyle"));
            if let (Some(id), Some(bidi)) = (
                style_id,
                w_child(w_child(self.style_by_id(style_id), "pPr"), "bidi"),
            ) {
                if let Some(on) = on_off(bidi.w("val")) {
                    direction = Some((
                        if on { "rtl" } else { "ltr" }.to_string(),
                        format!("/styles/{id}"),
                    ));
                }
            }
        }
        if !node.has("direction") && direction.is_none() {
            if let Some(own) = p.ancestor(W, "tbl") {
                if w_child(own.child(W, "tblPr"), "bidiVisual").is_some() {
                    let all = self
                        .body()
                        .map(|b| b.descendants_named(W, "tbl"))
                        .unwrap_or_default();
                    let src = match all.iter().position(|t| *t == own) {
                        Some(at) => format!("/body/tbl[{}]", at + 1),
                        None => "/body/tbl".to_string(),
                    };
                    direction = Some(("rtl".to_string(), src));
                }
            }
        }
        if !node.has("direction") && direction.is_none() {
            let ppr = w_child(
                w_child(w_child(self.styles(), "docDefaults"), "pPrDefault"),
                "pPr",
            );
            if let Some(bidi) = w_child(ppr, "bidi") {
                if let Some(on) = on_off(bidi.w("val")) {
                    direction = Some((
                        if on { "rtl" } else { "ltr" }.to_string(),
                        "/docDefaults".to_string(),
                    ));
                }
            }
        }
        if !node.has("direction") {
            if let Some((dir, src)) = direction {
                node.str("effective.direction", dir.clone());
                node.str("effective.direction.src", src.clone());
                if !node.has("effective.rtl") {
                    node.set("effective.rtl", Value::Bool(dir == "rtl"));
                    node.str("effective.rtl.src", src);
                }
            }
        } else if let Some(own) = w_child(w_child(Some(p), "pPr"), "bidi") {
            if let Some(on) = on_off(own.w("val")) {
                node.str("effective.direction", if on { "rtl" } else { "ltr" });
                let paras = self
                    .body()
                    .map(|b| b.descendants_named(W, "p"))
                    .unwrap_or_default();
                let src = match paras.iter().position(|x| *x == p) {
                    Some(at) => format!("/body/p[{}]", at + 1),
                    None => "/body/p".to_string(),
                };
                node.str("effective.direction.src", src);
            }
        }
    }

    pub(super) fn abstract_num(&self, id: Option<&str>) -> Option<E<'p>> {
        let id = id?;
        let all = self.numbering()?.children(W, "abstractNum");
        let abs = all
            .iter()
            .copied()
            .find(|a| a.w("abstractNumId") == Some(id))?;
        match w_val(abs.child(W, "numStyleLink")).filter(|l| !l.is_empty()) {
            None => Some(abs),
            Some(link) => Some(
                all.iter()
                    .copied()
                    .find(|a| w_val(a.child(W, "styleLink")) == Some(link))
                    .unwrap_or(abs),
            ),
        }
    }

    pub(super) fn num_instance(&self, num_id: i64) -> Option<E<'p>> {
        let want = num_id.to_string();
        self.numbering()?
            .children(W, "num")
            .into_iter()
            .find(|n| n.w("numId") == Some(want.as_str()))
    }

    fn override_of(inst: E<'p>, ilvl: i64) -> Option<E<'p>> {
        let want = ilvl.to_string();
        inst.children(W, "lvlOverride")
            .into_iter()
            .find(|o| o.w("ilvl") == Some(want.as_str()))
    }

    pub(super) fn level(&self, num_id: i64, ilvl: i64) -> Option<E<'p>> {
        let inst = self.num_instance(num_id)?;
        if let Some(l) = w_child(Self::override_of(inst, ilvl), "lvl") {
            return Some(l);
        }
        let want = ilvl.to_string();
        self.abstract_num(w_val(inst.child(W, "abstractNumId")))?
            .children(W, "lvl")
            .into_iter()
            .find(|l| l.w("ilvl") == Some(want.as_str()))
    }

    pub(super) fn numbering_format(&self, num_id: i64, ilvl: i64) -> String {
        w_val(w_child(self.level(num_id, ilvl), "numFmt"))
            .unwrap_or("bullet")
            .to_string()
    }

    pub(super) fn start_value(&self, num_id: i64, ilvl: i64) -> Option<Value> {
        let inst = self.num_instance(num_id)?;
        let over = Self::override_of(inst, ilvl);
        if let Some(embedded) = w_child(over, "lvl") {
            return w_val(embedded.child(W, "start")).map(num_value);
        }
        if let Some(so) = w_val(w_child(over, "startOverride")) {
            return Some(num_value(so));
        }
        let abs_id = w_val(inst.child(W, "abstractNumId"))?;
        let want = ilvl.to_string();
        let lvl = self
            .abstract_num(Some(abs_id))?
            .children(W, "lvl")
            .into_iter()
            .find(|l| l.w("ilvl") == Some(want.as_str()))?;
        Some(w_val(lvl.child(W, "start")).map_or(Value::Int(0), num_value))
    }

    /// The list a paragraph is in, from its own numbering or its style chain's.
    pub(super) fn num_pr_from_style(&self, p: E<'_>) -> Option<(i64, i64)> {
        let mut ilvl: Option<i64> = None;
        if let Some(num_pr) = w_child(w_child(Some(p), "pPr"), "numPr") {
            let nid = w_val(num_pr.child(W, "numId"));
            if nid == Some("0") {
                return None;
            }
            ilvl = w_val(num_pr.child(W, "ilvl")).map(|v| number(Some(v)).unwrap_or(i64::MIN));
            if let Some(nid) = nid {
                return Some((number(Some(nid)).unwrap_or(i64::MIN), ilvl.unwrap_or(0)));
            }
        }
        let mut style_id = w_val(w_child(w_child(Some(p), "pPr"), "pStyle")).map(str::to_string);
        self.styles()?;
        let mut seen: Vec<String> = Vec::new();
        while let Some(id) = style_id {
            if seen.contains(&id) {
                break;
            }
            seen.push(id.clone());
            let style = self.style_by_id(Some(&id))?;
            if let Some(s_num) = w_child(style.child(W, "pPr"), "numPr") {
                let nid = w_val(s_num.child(W, "numId"));
                if nid == Some("0") {
                    return None;
                }
                if ilvl.is_none() {
                    ilvl =
                        w_val(s_num.child(W, "ilvl")).map(|v| number(Some(v)).unwrap_or(i64::MIN));
                }
                if let Some(nid) = nid {
                    return Some((number(Some(nid)).unwrap_or(i64::MIN), ilvl.unwrap_or(0)));
                }
            }
            style_id = w_val(style.child(W, "basedOn")).map(str::to_string);
        }
        None
    }
}
