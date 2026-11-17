// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! The body's children, and a paragraph: its properties, the run
//! properties its mark and first run carry, its inline section break and
//! its children in document order.

use std::collections::HashMap;

use super::super::node::{Node, Value};
use super::super::tree::{E, M, Tree, W, is_on, on_off, outer_xml};
use super::super::units::{f2, half_points, hex_color, word_line_spacing, word_spacing};
use super::doc::Word;
use super::{
    all_runs, clip, color_with_theme_tail, complex_script, fill_unknown, is_digits, is_int,
    is_math_wrapper, jsn, math_text, num_text, num_value, packed_field, para_id, para_segment,
    paragraph_text, read_border, shading_canonical, t_text, w_child, w_val,
};

const SHADING_THEME_TAIL: [&str; 6] = [
    "themeFill",
    "themeFillShade",
    "themeFillTint",
    "themeColor",
    "themeShade",
    "themeTint",
];

fn set_if_absent(node: &mut Node, key: &str, value: Value) {
    if !node.has(key) {
        node.set(key, value);
    }
}

/// The ascii/hAnsi pair as one `latin` key when equal, two keys when not.
pub(super) fn latin_pair(
    node: &mut Node,
    prefix: &str,
    ascii: Option<&str>,
    h_ansi: Option<&str>,
    only_absent: bool,
) {
    let mut put = |key: String, v: &str| {
        if !only_absent || !node.has(&key) {
            node.str(&key, v);
        }
    };
    match (ascii, h_ansi) {
        (Some(a), Some(h)) if a == h => put(format!("{prefix}font.latin"), a),
        (Some(a), Some(h)) => {
            put(format!("{prefix}font.ascii"), a);
            put(format!("{prefix}font.hAnsi"), h);
        }
        (Some(a), None) => put(format!("{prefix}font.ascii"), a),
        (None, Some(h)) => put(format!("{prefix}font.hAnsi"), h),
        (None, None) => {}
    }
}

/// A run border as one `val;sz;color;space[;shadow][;frame]` value.
pub(super) fn border_spec(bdr: E<'_>) -> Option<String> {
    let bv = bdr.w("val")?;
    let color = bdr.w("color");
    let mut segs = vec![
        bv.to_string(),
        bdr.w("sz").unwrap_or_default().to_string(),
        color
            .filter(|c| !c.is_empty())
            .map(hex_color)
            .unwrap_or_default(),
        bdr.w("space").unwrap_or("0").to_string(),
    ];
    let shadow = bdr.w("shadow");
    let frame = bdr.w("frame");
    if shadow.is_some() || frame.is_some() {
        segs.push(
            if shadow.is_some() && on_off(shadow) == Some(true) {
                "true"
            } else {
                "false"
            }
            .to_string(),
        );
    }
    if let Some(f) = frame {
        segs.push(
            if on_off(Some(f)) == Some(true) {
                "true"
            } else {
                "false"
            }
            .to_string(),
        );
    }
    Some(segs.join(";"))
}

impl<'p> Word<'p> {
    pub(super) fn body_node(&self, body: E<'_>, mut node: Node, path: &str, depth: usize) -> Node {
        node.child_count = body.elements().count();
        if depth == 0 {
            return node;
        }
        let mut counts = [0usize; 4];
        for child in body.elements() {
            self.body_child(child, &mut node, path, depth, &mut counts);
        }
        node
    }

    fn body_child(
        &self,
        child: E<'_>,
        node: &mut Node,
        path: &str,
        depth: usize,
        counts: &mut [usize; 4],
    ) {
        let [p, tbl, math, sdt] = counts;
        if child.is(M, "oMathPara") || (child.is(W, "p") && is_math_wrapper(child)) {
            *math += 1;
            node.children.push(self.element(
                child,
                &format!("{path}/oMathPara[{math}]"),
                depth - 1,
            ));
        } else if child.is(W, "p") {
            *p += 1;
            node.children.push(self.element(
                child,
                &format!("{path}/{}", para_segment(child, *p)),
                depth - 1,
            ));
        } else if child.is(W, "tbl") {
            *tbl += 1;
            node.children
                .push(self.element(child, &format!("{path}/tbl[{tbl}]"), depth - 1));
        } else if child.is(W, "sdt") {
            *sdt += 1;
            node.children
                .push(self.element(child, &format!("{path}/sdt[{sdt}]"), depth - 1));
        } else if child.is(W, "customXml") {
            for inner in child.elements() {
                self.body_child(inner, node, path, depth, counts);
            }
        } else if child.is(W, "bookmarkEnd") {
            let mut end = self.element(child, &format!("{path}/bookmarkEnd[1]"), depth - 1);
            if let Some(start) = self.bookmark_start_of(child) {
                if let Some(name) = start.w("name").filter(|n| !n.is_empty()) {
                    if Self::spans_content(start) {
                        end.str("name", name);
                    }
                }
            }
            node.children.push(end);
        } else {
            node.children.push(self.element(
                child,
                &format!("{path}/{}[1]", child.name()),
                depth - 1,
            ));
        }
    }

    fn mark_run_props(node: &mut Node, src: E<'_>, prefix: &str) {
        let emit = |node: &mut Node, key: &str, val: Value| {
            set_if_absent(node, &format!("{prefix}{key}"), val)
        };
        for (el, key) in [
            ("caps", "caps"),
            ("smallCaps", "smallcaps"),
            ("dstrike", "dstrike"),
            ("outline", "outline"),
            ("shadow", "shadow"),
            ("emboss", "emboss"),
            ("imprint", "imprint"),
            ("vanish", "vanish"),
            ("specVanish", "specVanish"),
        ] {
            if let Some(e) = src.child(W, el) {
                emit(node, key, Value::Bool(is_on(Some(e))));
            }
        }
        match w_val(src.child(W, "vertAlign")) {
            Some("superscript") => emit(node, "superscript", Value::Bool(true)),
            Some("subscript") => emit(node, "subscript", Value::Bool(true)),
            _ => {}
        }
        if let Some(pos) = w_val(src.child(W, "position")).filter(|p| is_int(p)) {
            emit(
                node,
                "position",
                Value::Str(format!("{}pt", f2(jsn(pos) / 2.0))),
            );
        }
        if let Some(spec) = src.child(W, "bdr").and_then(border_spec) {
            emit(node, "bdr", Value::Str(spec));
        }
    }

    pub(super) fn shading_folded(shd: E<'_>) -> Option<String> {
        let v0 = shd.w("val");
        let fill = shd.w("fill").filter(|f| !f.is_empty());
        let color = shd.w("color").filter(|c| !c.is_empty());
        if v0.is_some_and(|v| v.eq_ignore_ascii_case("clear")) && fill.is_none() && color.is_none()
        {
            return None;
        }
        let v = v0.filter(|v| !v.is_empty()).unwrap_or("clear");
        Some(match (fill, color) {
            (f, Some(c)) => format!(
                "{v};{};{}",
                f.map(hex_color).unwrap_or_default(),
                hex_color(c)
            ),
            (Some(f), None) => format!("{v};{}", hex_color(f)),
            (None, None) => v.to_string(),
        })
    }

    pub(super) fn paragraph(&self, p: E<'_>, mut node: Node, path: &str, depth: usize) -> Node {
        node.kind = "paragraph".to_string();
        let text = paragraph_text(p);
        node.style = Some(self.style_name(p));
        node.preview = Some(clip(&text, 50));
        node.text = Some(text);
        let runs = all_runs(p);
        node.child_count = runs.len();
        if let Some(id) = para_id(p) {
            node.str("paraId", id);
        }
        let ppr = p.child(W, "pPr");
        if let Some(ppr) = ppr {
            self.paragraph_props(p, ppr, &mut node);
        }
        let mark_rp = w_child(ppr, "rPr");
        let has_text_run = p
            .children(W, "r")
            .iter()
            .any(|r| r.child(W, "t").is_some_and(|t| !t.text().is_empty()));
        let has_any_run = !p.descendants_named(W, "r").is_empty();
        if let Some(mark) = mark_rp {
            if has_text_run || has_any_run {
                Self::mark_props(p, mark, &mut node);
            }
        }
        let first_run = p
            .children(W, "r")
            .into_iter()
            .find(|r| r.child(W, "t").is_some());
        let rp = w_child(first_run, "rPr");
        let mark = if first_run.is_none() && !has_any_run {
            mark_rp
        } else {
            None
        };
        if let Some(src) = rp.or(mark) {
            Self::first_run_props(&mut node, src, rp, mark);
        }
        self.emit_effective_paragraph(&mut node, p);
        if depth > 0 {
            self.paragraph_children(p, &mut node, path, depth, &runs);
        }
        node
    }

    fn paragraph_props(&self, p: E<'_>, ppr: E<'_>, node: &mut Node) {
        if let Some(style_id) = w_val(ppr.child(W, "pStyle")) {
            node.str("style", style_id);
            node.str("styleId", style_id);
            let display = self.style_name(p);
            if !display.is_empty() {
                node.str("styleName", display);
            }
        }
        if let Some(jc) = w_val(ppr.child(W, "jc")) {
            node.str("align", if jc == "both" { "justify" } else { jc });
        }
        if let Some(sp) = ppr.child(W, "spacing") {
            if let Some(b) = sp.w("before") {
                node.str("spaceBefore", word_spacing(b, true));
            }
            if let Some(a) = sp.w("after") {
                node.str("spaceAfter", word_spacing(a, true));
            }
            if let Some(l) = sp.w("line") {
                node.str("lineSpacing", word_line_spacing(l, sp.w("lineRule")));
            }
            if let Some(rule) = sp.w("lineRule") {
                node.str("lineRule", rule);
            }
            if let Some(bl) = sp.w("beforeLines") {
                node.set("spaceBeforeLines", num_value(bl));
            }
            if let Some(al) = sp.w("afterLines") {
                node.set("spaceAfterLines", num_value(al));
            }
            if let Some(ba) = sp.w("beforeAutospacing") {
                node.set(
                    "spaceBeforeAuto",
                    Value::Bool(on_off(Some(ba)) == Some(true)),
                );
            }
            if let Some(aa) = sp.w("afterAutospacing") {
                node.set(
                    "spaceAfterAuto",
                    Value::Bool(on_off(Some(aa)) == Some(true)),
                );
            }
        }
        let inds = ppr.children(W, "ind");
        if !inds.is_empty() {
            let pick = |names: &[&str]| -> Option<String> {
                inds.iter()
                    .find_map(|ind| names.iter().find_map(|n| ind.w(n)))
                    .map(str::to_string)
            };
            let either = |a: &str, b: &str| -> Option<String> {
                inds.iter()
                    .find_map(|i| i.w(a).or_else(|| i.w(b)))
                    .map(str::to_string)
            };
            if let Some(fl) = pick(&["firstLine"]) {
                node.str("firstLineIndent", word_spacing(&fl, false));
            }
            if let Some(hg) = pick(&["hanging"]) {
                node.str("hangingIndent", word_spacing(&hg, false));
            }
            if let Some(left) = either("left", "start") {
                node.str("indent", word_spacing(&left, false));
            }
            if let Some(right) = either("right", "end") {
                node.str("rightIndent", word_spacing(&right, false));
            }
            if let Some(v) = pick(&["firstLineChars"]) {
                node.set("firstLineChars", num_value(&v));
            }
            if let Some(v) = pick(&["hangingChars"]) {
                node.set("hangingChars", num_value(&v));
            }
            if let Some(v) = either("leftChars", "startChars") {
                node.set("leftChars", num_value(&v));
            }
            if let Some(v) = either("rightChars", "endChars") {
                node.set("rightChars", num_value(&v));
            }
        }
        for name in ["keepNext", "keepLines", "pageBreakBefore", "widowControl"] {
            if let Some(e) = ppr.child(W, name) {
                node.set(name, Value::Bool(is_on(Some(e))));
            }
        }
        if let Some(bidi) = ppr.child(W, "bidi") {
            if let Some(on) = on_off(bidi.w("val")) {
                node.str("direction", if on { "rtl" } else { "ltr" });
            }
        }
        if let Some(cs) = ppr.child(W, "contextualSpacing") {
            node.set("contextualSpacing", Value::Bool(is_on(Some(cs))));
        }
        if let Some(shd) = ppr.child(W, "shd") {
            shading_canonical(shd, node);
        }
        if let Some(pbdr) = ppr.child(W, "pBdr") {
            for side in ["top", "bottom", "left", "right", "between", "bar"] {
                read_border(pbdr.child(W, side), &format!("pbdr.{side}"), node);
            }
        }
        let num_pr = ppr.child(W, "numPr");
        let num_id = w_val(w_child(num_pr, "numId"));
        if let (Some(num_pr), Some(num_id)) = (num_pr, num_id) {
            node.str("numId", num_text(num_id));
            let ilvl_raw = w_val(num_pr.child(W, "ilvl")).unwrap_or("0");
            node.str("numLevel", num_text(ilvl_raw));
            let nid = jsn(num_id);
            if nid != 0.0 {
                let (nid, ilvl) = (int_of(nid), int_of(jsn(ilvl_raw)));
                self.list_props(node, nid, ilvl);
            }
        } else if let Some(num_pr) = num_pr {
            if let Some(bare) = w_val(num_pr.child(W, "ilvl")) {
                node.str("numLevel", num_text(bare));
            }
        } else if let Some((nid, ilvl)) = self.num_pr_from_style(p) {
            node.str("numId", nid.to_string());
            node.str("numLevel", ilvl.to_string());
            node.str("numInherited", "true");
            self.list_props(node, nid, ilvl);
        }
        if let Some(outline) = w_val(ppr.child(W, "outlineLvl")) {
            node.set("outlineLvl", num_value(outline));
        }
        if let Some(tabs) = ppr.child(W, "tabs") {
            let mut list = Vec::new();
            for tab in tabs.children(W, "tab") {
                let mut t = Vec::new();
                if let Some(pos) = tab.w("pos") {
                    t.push(("pos".to_string(), num_value(pos)));
                }
                if let Some(val) = tab.w("val") {
                    t.push(("val".to_string(), Value::Str(val.to_string())));
                }
                if let Some(leader) = tab.w("leader") {
                    t.push(("leader".to_string(), Value::Str(leader.to_string())));
                }
                if !t.is_empty() {
                    list.push(Value::Map(t));
                }
            }
            if !list.is_empty() {
                node.set("tabs", Value::List(list));
            }
        }
        fill_unknown(Some(ppr), node);
        if let Some(inline) = ppr.child(W, "sectPr") {
            Self::section_break(inline, node);
        }
    }

    fn list_props(&self, node: &mut Node, nid: i64, ilvl: i64) {
        let num_fmt = self.numbering_format(nid, ilvl);
        let style = if num_fmt.eq_ignore_ascii_case("bullet") {
            "bullet"
        } else {
            "ordered"
        };
        node.str("numFmt", num_fmt);
        node.str("listStyle", style);
        if let Some(start) = self.start_value(nid, ilvl) {
            node.set("start", start);
        }
    }

    fn mark_props(p: E<'_>, mark: E<'_>, node: &mut Node) {
        if let Some(b) = mark.child(W, "b") {
            node.set("markRPr.bold", Value::Bool(is_on(Some(b))));
        }
        if let Some(i) = mark.child(W, "i") {
            node.set("markRPr.italic", Value::Bool(is_on(Some(i))));
        }
        if let Some(s) = mark.child(W, "strike") {
            node.set("markRPr.strike", Value::Bool(is_on(Some(s))));
        }
        if let Some(u) = w_val(mark.child(W, "u")) {
            node.str("markRPr.underline", u);
        }
        if let Some(sz) = half_points(w_val(mark.child(W, "sz"))) {
            node.str("markRPr.size", sz);
        }
        if let Some(sz) = half_points(w_val(mark.child(W, "szCs"))) {
            node.str("markRPr.size.cs", sz);
        }
        if is_on(mark.child(W, "bCs")) {
            node.flag("markRPr.bold.cs");
        }
        if is_on(mark.child(W, "iCs")) {
            node.flag("markRPr.italic.cs");
        }
        if let Some(kern) = w_val(mark.child(W, "kern")) {
            node.str("markRPr.kern", kern);
        }
        if let Some(c) = mark.child(W, "color").and_then(color_with_theme_tail) {
            node.str("markRPr.color", c);
        }
        let rf = mark.child(W, "rFonts");
        latin_pair(
            node,
            "markRPr.",
            rf.and_then(|f| f.w("ascii")),
            rf.and_then(|f| f.w("hAnsi")),
            false,
        );
        for (attr, key) in [
            ("eastAsia", "markRPr.font.ea"),
            ("cs", "markRPr.font.cs"),
            ("asciiTheme", "markRPr.font.asciiTheme"),
            ("hAnsiTheme", "markRPr.font.hAnsiTheme"),
            ("eastAsiaTheme", "markRPr.font.eaTheme"),
            ("cstheme", "markRPr.font.csTheme"),
            ("hint", "markRPr.font.hint"),
        ] {
            if let Some(v) = rf.and_then(|f| f.w(attr)) {
                node.str(key, v);
            }
        }
        if let Some(spacing) = w_val(mark.child(W, "spacing")) {
            node.str(
                "markRPr.charSpacing",
                format!("{}pt", f2(jsn(spacing) / 20.0)),
            );
        }
        if let Some(pos) = w_val(mark.child(W, "position")).filter(|p| !p.is_empty()) {
            node.str("markRPr.position", pos);
        }
        if let Some(rtl) = mark.child(W, "rtl") {
            node.set(
                "markRPr.rtl",
                Value::Bool(on_off(rtl.w("val")) != Some(false)),
            );
        }
        if let Some(snap) = mark.child(W, "snapToGrid") {
            node.set(
                "markRPr.snapToGrid",
                Value::Bool(on_off(snap.w("val")) != Some(false)),
            );
        }
        Self::mark_run_props(node, mark, "markRPr.");
        if let Some(hl) = w_val(mark.child(W, "highlight")) {
            node.str("markRPr.highlight", hl);
        }
        if let Some(shd) = mark.child(W, "shd") {
            if let Some(mut folded) = Self::shading_folded(shd) {
                for a in SHADING_THEME_TAIL {
                    if let Some(v) = shd.w(a) {
                        folded.push_str(&format!(";{a}={v}"));
                    }
                }
                node.str("markRPr.shading", folded);
            }
        }
        if let Some(lang) = mark.child(W, "lang") {
            for (attr, key) in [
                ("val", "markRPr.lang.latin"),
                ("eastAsia", "markRPr.lang.ea"),
                ("bidi", "markRPr.lang.cs"),
            ] {
                if let Some(v) = lang.w(attr) {
                    node.str(key, v);
                }
            }
        }
        if let Some(rs) = w_val(mark.child(W, "rStyle")) {
            let first_text = p
                .children(W, "r")
                .into_iter()
                .find(|r| r.child(W, "t").is_some());
            let run_rs = w_val(w_child(w_child(first_text, "rPr"), "rStyle"));
            node.str(
                if run_rs == Some(rs) {
                    "rStyle"
                } else {
                    "markRPr.rStyle"
                },
                rs,
            );
        }
        if mark.elements().next().is_some() {
            node.str("markRPr.xml", outer_xml(mark));
        }
    }

    fn first_run_props(node: &mut Node, src: E<'_>, rp: Option<E<'_>>, mark: Option<E<'_>>) {
        let mark_only = mark.filter(|_| rp.is_none());
        if let Some(mark) = mark_only {
            if let Some(rs) = w_val(mark.child(W, "rStyle")) {
                if !node.has("rStyle") && !node.has("markRPr.rStyle") {
                    node.str("rStyle", rs);
                }
            }
        }
        if let Some(rf) = src.child(W, "rFonts") {
            latin_pair(node, "", rf.w("ascii"), rf.w("hAnsi"), true);
            if let Some(ea) = rf.w("eastAsia").filter(|e| !e.is_empty()) {
                set_if_absent(node, "font.ea", Value::Str(ea.to_string()));
            }
            for (attr, key) in [
                ("asciiTheme", "font.asciiTheme"),
                ("hAnsiTheme", "font.hAnsiTheme"),
                ("eastAsiaTheme", "font.eaTheme"),
                ("cstheme", "font.csTheme"),
                ("hint", "font.hint"),
            ] {
                if let Some(v) = rf.w(attr) {
                    set_if_absent(node, key, Value::Str(v.to_string()));
                }
            }
        }
        if let Some(sz) = half_points(w_val(src.child(W, "sz"))) {
            set_if_absent(node, "size", Value::Str(sz));
        }
        if let Some(b) = src.child(W, "b") {
            set_if_absent(node, "bold", Value::Bool(is_on(Some(b))));
        }
        if let Some(i) = src.child(W, "i") {
            set_if_absent(node, "italic", Value::Bool(is_on(Some(i))));
        }
        complex_script(rp, mark, node);
        if let Some(color) = src.child(W, "color") {
            if !node.has("color") {
                if let Some(c) = color_with_theme_tail(color) {
                    node.str("color", c);
                }
            }
        }
        let u = src.child(W, "u");
        if let Some(uv) = u.and_then(|u| u.w("val")) {
            set_if_absent(node, "underline", Value::Str(uv.to_string()));
        }
        if let Some(uc) = u.and_then(|u| u.w("color")) {
            set_if_absent(node, "underline.color", Value::Str(hex_color(uc)));
        }
        if src.child(W, "strike").is_some() {
            set_if_absent(node, "strike", Value::Bool(true));
        }
        if is_on(src.child(W, "vanish")) {
            set_if_absent(node, "vanish", Value::Bool(true));
        }
        if let Some(hl) = w_val(src.child(W, "highlight")) {
            set_if_absent(node, "highlight", Value::Str(hl.to_string()));
        }
        let Some(mark) = mark_only else { return };
        if let Some(kern) = w_val(mark.child(W, "kern")) {
            set_if_absent(node, "kern", Value::Str(kern.to_string()));
        }
        if let Some(shd) = mark.child(W, "shd") {
            if !node.has("markRPr.shading") {
                if let Some(folded) = Self::shading_folded(shd) {
                    node.str("markRPr.shading", folded);
                }
            }
        }
        if let Some(spc) = w_val(mark.child(W, "spacing")) {
            set_if_absent(
                node,
                "markRPr.charSpacing",
                Value::Str(format!("{}pt", f2(jsn(spc) / 20.0))),
            );
        }
        if let Some(lang) = mark.child(W, "lang") {
            for (attr, key) in [
                ("val", "lang.latin"),
                ("eastAsia", "lang.ea"),
                ("bidi", "lang.cs"),
            ] {
                if let Some(v) = lang.w(attr) {
                    set_if_absent(node, key, Value::Str(v.to_string()));
                }
            }
        }
        if let Some(rtl) = mark.child(W, "rtl") {
            set_if_absent(
                node,
                "markRPr.rtl",
                Value::Bool(on_off(rtl.w("val")) != Some(false)),
            );
        }
        Self::mark_run_props(node, mark, "");
    }

    fn section_break(inline: E<'_>, node: &mut Node) {
        let mark = w_val(inline.child(W, "type"));
        node.str("sectionBreak", mark.unwrap_or("nextPage"));
        if let Some(m) = mark {
            node.str("sectionBreak.type", m);
        }
        if inline.elements().next().is_none() {
            node.flag("sectionBreak.empty");
        } else if mark.is_none() {
            node.flag("sectionBreak.notype");
        }
        let pg_sz = inline.child(W, "pgSz");
        if let Some(w) = pg_sz.and_then(|p| p.w("w")) {
            node.str("sectionBreak.pageWidth", num_text(w));
        }
        if let Some(h) = pg_sz.and_then(|p| p.w("h")) {
            node.str("sectionBreak.pageHeight", num_text(h));
        }
        if let Some(o) = pg_sz.and_then(|p| p.w("orient")) {
            node.str("sectionBreak.orientation", o);
        }
        if let Some(mar) = inline.child(W, "pgMar") {
            for (attr, key, abs) in [
                ("top", "marginTop", true),
                ("bottom", "marginBottom", true),
                ("left", "marginLeft", false),
                ("right", "marginRight", false),
                ("header", "marginHeader", false),
                ("footer", "marginFooter", false),
                ("gutter", "marginGutter", false),
            ] {
                if let Some(v) = mar.w(attr) {
                    let text = if abs {
                        super::super::node::number_text(jsn(v).abs())
                    } else {
                        num_text(v)
                    };
                    node.str(&format!("sectionBreak.{key}"), text);
                }
            }
        }
        let pg_num = inline.child(W, "pgNumType");
        if let Some(start) = pg_num.and_then(|p| p.w("start")) {
            node.set("sectionBreak.pageStart", num_value(start));
        }
        if let Some(pnf) = pg_num.and_then(|p| p.w("fmt")) {
            node.str("sectionBreak.pageNumFmt", pnf);
        }
        if inline.child(W, "titlePg").is_some() {
            node.flag("sectionBreak.titlePage");
        }
        if is_on(inline.child(W, "noEndnote")) {
            node.str("sectionBreak.noEndnote", "true");
        }
        if let Some(cols) = inline.child(W, "cols") {
            if let Some(num) = cols.w("num") {
                node.set("sectionBreak.columns", num_value(num));
            }
            if let Some(space) = cols.w("space").filter(|s| is_digits(s)) {
                node.str("sectionBreak.columnSpace", num_text(space));
            }
            if let Some(eq) = cols.w("equalWidth") {
                node.set(
                    "sectionBreak.columns.equalWidth",
                    Value::Bool(on_off(Some(eq)) == Some(true)),
                );
            }
            if let Some(sep) = cols.w("sep") {
                if on_off(Some(sep)) == Some(true) {
                    node.flag("sectionBreak.columns.separator");
                }
            }
            let defs = cols.children(W, "col");
            if !defs.is_empty() {
                node.str(
                    "sectionBreak.colWidths",
                    defs.iter()
                        .map(|c| c.w("w").unwrap_or("0"))
                        .collect::<Vec<_>>()
                        .join(","),
                );
                node.str(
                    "sectionBreak.colSpaces",
                    defs.iter()
                        .map(|c| c.w("space").unwrap_or("0"))
                        .collect::<Vec<_>>()
                        .join(","),
                );
            }
        }
        if let Some(v) = w_val(inline.child(W, "vAlign")) {
            node.str("sectionBreak.vAlign", v);
        }
        if let Some(v) = w_val(inline.child(W, "textDirection")) {
            node.str("sectionBreak.textDirection", v);
        }
        if is_on(inline.child(W, "bidi")) {
            node.str("sectionBreak.bidi", "rtl");
        }
        if is_on(inline.child(W, "rtlGutter")) {
            node.str("sectionBreak.rtlGutter", "true");
        }
        Self::page_borders(inline.child(W, "pgBorders"), node, "sectionBreak.pgBorders");
        Self::note_props(inline, node, "sectionBreak.");
        Self::doc_grid(inline, node, "sectionBreak.");
    }

    fn paragraph_children(
        &self,
        p: E<'_>,
        node: &mut Node,
        path: &str,
        depth: usize,
        runs: &[E<'_>],
    ) {
        let order: HashMap<usize, usize> = p
            .descendants()
            .iter()
            .enumerate()
            .map(|(i, d)| (d.id, i))
            .collect();
        let at = |e: E<'_>| order.get(&e.id).copied().unwrap_or(usize::MAX);
        let hyperlinks = p.children(W, "hyperlink");
        let nested = |name: &str, ns: &str| -> Vec<E<'_>> {
            let mut out = p.children(ns, name);
            for wrap in ["ins", "del"] {
                for x in p.children(W, wrap) {
                    out.extend(x.children(ns, name));
                }
            }
            for h in &hyperlinks {
                out.extend(h.children(ns, name));
            }
            out
        };
        let equations = nested("oMath", M);
        let bookmarks = nested("bookmarkStart", W);
        let ends: Vec<E<'_>> = nested("bookmarkEnd", W)
            .into_iter()
            .filter(|e| {
                e.w("id").is_some() && self.bookmark_start_of(*e).is_some_and(Self::spans_content)
            })
            .collect();
        let simple_fields = p.children(W, "fldSimple");
        #[derive(Clone, Copy, PartialEq)]
        enum Kind {
            Run,
            Eq,
            Field,
            Bookmark,
            End,
        }
        let mut entries: Vec<(usize, Kind, E<'_>)> = Vec::new();
        entries.extend(
            runs.iter()
                .filter(|r| r.child(W, "ruby").is_none())
                .map(|r| (at(*r), Kind::Run, *r)),
        );
        entries.extend(equations.iter().map(|e| (at(*e), Kind::Eq, *e)));
        entries.extend(simple_fields.iter().map(|e| (at(*e), Kind::Field, *e)));
        entries.extend(bookmarks.iter().map(|e| (at(*e), Kind::Bookmark, *e)));
        entries.extend(ends.iter().map(|e| (at(*e), Kind::End, *e)));
        entries.sort_by_key(|e| e.0);
        let (mut run_idx, mut eq_idx, mut field_idx) = (0usize, 0usize, 0usize);
        for (_, kind, el) in entries {
            match kind {
                Kind::Field => {
                    field_idx += 1;
                    node.children.push(Self::simple_field(
                        el,
                        &format!("{path}/field[{field_idx}]"),
                    ));
                }
                Kind::Run if packed_field(el) => {
                    let rpr = el.child(W, "rPr");
                    for child in el.elements() {
                        if child.is(W, "rPr") || child.is(W, "lastRenderedPageBreak") {
                            continue;
                        }
                        let mut synth = Tree::fragment(W, "r", "w");
                        let root = synth.root;
                        if let Some(rpr) = rpr {
                            let copy = synth.adopt(rpr);
                            synth.append(root, copy);
                        }
                        let copy = synth.adopt(child);
                        synth.append(root, copy);
                        run_idx += 1;
                        node.children.push(self.element(
                            synth.root(),
                            &format!("{path}/r[{run_idx}]"),
                            depth - 1,
                        ));
                    }
                }
                Kind::Run => {
                    run_idx += 1;
                    node.children.push(self.element(
                        el,
                        &format!("{path}/r[{run_idx}]"),
                        depth - 1,
                    ));
                }
                Kind::Eq => {
                    let eq_path = match el.parent().filter(|x| x.is(W, "hyperlink")) {
                        Some(parent) => format!(
                            "{path}/hyperlink[{}]/oMath[{}]",
                            hyperlinks
                                .iter()
                                .position(|h| *h == parent)
                                .map_or(0, |i| i + 1),
                            parent
                                .children(M, "oMath")
                                .iter()
                                .position(|m| *m == el)
                                .map_or(0, |i| i + 1),
                        ),
                        None => {
                            eq_idx += 1;
                            format!("{path}/oMath[{eq_idx}]")
                        }
                    };
                    let mut eq = Node::new(eq_path, "equation");
                    eq.str("mode", "inline");
                    eq.text = Some(math_text(el));
                    node.children.push(eq);
                }
                Kind::Bookmark => {
                    let idx = bookmarks.iter().position(|b| *b == el).map_or(0, |i| i + 1);
                    node.children.push(self.element(
                        el,
                        &format!("{path}/bookmark[{idx}]"),
                        depth - 1,
                    ));
                }
                Kind::End => {
                    let mut end = Node::new(
                        format!("{path}/bookmarkEnd[@id={}]", el.w("id").unwrap_or_default()),
                        "bookmarkEnd",
                    );
                    if let Some(name) = self
                        .bookmark_start_of(el)
                        .and_then(|s| s.w("name"))
                        .filter(|n| !n.is_empty())
                    {
                        end.str("name", name);
                    }
                    node.children.push(end);
                }
            }
        }
        for (i, sdt) in p.children(W, "sdt").into_iter().enumerate() {
            node.children
                .push(self.element(sdt, &format!("{path}/sdt[{}]", i + 1), depth - 1));
        }
        for bare in p.elements() {
            if bare.ns() != W || !matches!(bare.name(), "br" | "cr") {
                continue;
            }
            let mut b = Node::new(format!("{path}/r[{}]", node.children.len() + 1), "break");
            b.str(
                "breakType",
                bare.w("type").filter(|t| !t.is_empty()).unwrap_or("line"),
            );
            node.children.push(b);
        }
        for (hi, h) in hyperlinks.iter().enumerate() {
            for (fi, fld) in h.children(W, "fldSimple").into_iter().enumerate() {
                node.children.push(Self::simple_field(
                    fld,
                    &format!("{path}/hyperlink[{}]/field[{}]", hi + 1, fi + 1),
                ));
            }
        }
    }

    fn simple_field(fld: E<'_>, path: &str) -> Node {
        let instr = fld.w("instr").unwrap_or_default();
        let display = t_text(fld);
        let mut node = Node::new(path, "field");
        node.str("instruction", instr.trim());
        let head = instr
            .trim()
            .split(' ')
            .next()
            .unwrap_or_default()
            .to_uppercase();
        if !head.is_empty() {
            node.str("fieldType", head.to_lowercase());
        }
        if fld.w("dirty").is_some() && on_off(fld.w("dirty")) == Some(true) {
            node.flag("dirty");
        }
        if fld.w("fldLock").is_some() && on_off(fld.w("fldLock")) == Some(true) {
            node.flag("fldLock");
        }
        node.set("evaluated", Value::Bool(!display.is_empty()));
        node.text = Some(display);
        node
    }
}

/// A JavaScript number as the integer a numbering lookup compares, NaN as none that matches.
fn int_of(n: f64) -> i64 {
    if n.is_finite() { n as i64 } else { i64::MIN }
}
