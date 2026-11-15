// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! A run: its text, revision, fonts and toggles, the picture, tab, field
//! or break it stands for, and what it inherits; and a hyperlink.

use super::super::node::{Node, Value};
use super::super::tree::{E, R, W, is_on, on_off};
use super::super::units::{f2, half_points, hex_color, round_trip};
use super::paragraph::{border_spec, latin_pair};
use super::{
    FIELD_KEEP, TYPOGRAPHY_ONLY, Word, color_with_theme_tail, complex_script, fill_unknown, is_int,
    jsn, run_text, shading_canonical, t_text, w_child, w_val,
};

impl<'p> Word<'p> {
    pub(super) fn run(&self, run: E<'_>, mut node: Node) -> Node {
        node.kind = "run".to_string();
        node.text = Some(run_text(run));
        let rpr = run.child(W, "rPr");
        if run.child(W, "annotationRef").is_some() {
            node.flag("annotationRef");
        }
        if let Some(sym) = run.child(W, "sym") {
            if let Some(ch) = sym.w("char") {
                node.str("sym", format!("{}:{ch}", sym.w("font").unwrap_or_default()));
            }
        }
        let revision = |node: &mut Node, anc: E<'_>, ty: &str| {
            node.str("revision.type", ty);
            if let Some(author) = anc.w("author").filter(|a| !a.is_empty()) {
                node.str("revision.author", author);
            }
            if let Some(date) = anc.w("date") {
                node.str("revision.date", round_trip(date));
            }
            if let Some(id) = anc.w("id") {
                node.str("revision.id", id);
            }
        };
        if let Some(ins) = run.ancestor(W, "ins") {
            revision(&mut node, ins, "ins");
        } else if let Some(del) = run.ancestor(W, "del") {
            revision(&mut node, del, "del");
        }
        if let Some(rf) = w_child(rpr, "rFonts") {
            latin_pair(
                &mut node,
                "",
                rf.w("ascii").filter(|v| !v.is_empty()),
                rf.w("hAnsi").filter(|v| !v.is_empty()),
                false,
            );
            if let Some(ea) = rf.w("eastAsia").filter(|e| !e.is_empty()) {
                node.str("font.ea", ea);
            }
            for (attr, key) in [
                ("asciiTheme", "font.asciiTheme"),
                ("hAnsiTheme", "font.hAnsiTheme"),
                ("eastAsiaTheme", "font.eaTheme"),
                ("cstheme", "font.csTheme"),
                ("hint", "font.hint"),
            ] {
                if let Some(v) = rf.w(attr) {
                    node.str(key, v);
                }
            }
        }
        if let Some(lang) = w_child(rpr, "lang") {
            for (attr, key) in [
                ("val", "lang.latin"),
                ("eastAsia", "lang.ea"),
                ("bidi", "lang.cs"),
            ] {
                if let Some(v) = lang.w(attr) {
                    node.str(key, v);
                }
            }
        }
        if let Some(size) = half_points(w_val(w_child(rpr, "sz"))) {
            node.str("size", size);
        }
        if let Some(b) = w_child(rpr, "b") {
            node.set("bold", Value::Bool(is_on(Some(b))));
        }
        if let Some(i) = w_child(rpr, "i") {
            node.set("italic", Value::Bool(is_on(Some(i))));
        }
        complex_script(rpr, None, &mut node);
        if let Some(c) = w_child(rpr, "color").and_then(color_with_theme_tail) {
            node.str("color", c);
        }
        let u = w_child(rpr, "u");
        if let Some(uv) = u.and_then(|u| u.w("val")) {
            node.str("underline", uv);
        }
        if let Some(uc) = u.and_then(|u| u.w("color")) {
            node.str("underline.color", hex_color(uc));
        }
        if let Some(e) = w_child(rpr, "strike") {
            node.set("strike", Value::Bool(is_on(Some(e))));
        }
        if let Some(hl) = w_val(w_child(rpr, "highlight")) {
            node.str("highlight", hl);
        }
        for (el, key) in [
            ("caps", "caps"),
            ("smallCaps", "smallcaps"),
            ("dstrike", "dstrike"),
            ("vanish", "vanish"),
            ("outline", "outline"),
            ("shadow", "shadow"),
            ("emboss", "emboss"),
            ("imprint", "imprint"),
            ("noProof", "noproof"),
        ] {
            if let Some(e) = w_child(rpr, el) {
                node.set(key, Value::Bool(is_on(Some(e))));
            }
        }
        if let Some(rtl) = w_child(rpr, "rtl") {
            node.str(
                "direction",
                if on_off(rtl.w("val")) != Some(false) {
                    "rtl"
                } else {
                    "ltr"
                },
            );
        }
        match w_val(w_child(rpr, "vertAlign")) {
            Some("superscript") => node.flag("superscript"),
            Some("subscript") => node.flag("subscript"),
            _ => {}
        }
        if let Some(pos) = w_val(w_child(rpr, "position")).filter(|p| is_int(p)) {
            node.str("position", format!("{}pt", f2(jsn(pos) / 2.0)));
        }
        if let Some(spc) = w_val(w_child(rpr, "spacing")) {
            node.str("charSpacing", format!("{}pt", f2(jsn(spc) / 20.0)));
        }
        if let Some(spec) = w_child(rpr, "bdr").and_then(border_spec) {
            node.str("bdr", spec);
        }
        if let Some(shd) = w_child(rpr, "shd") {
            shading_canonical(shd, &mut node);
        }
        fill_unknown(rpr, &mut node);
        if let Some(drawing) = run.child(W, "drawing") {
            let pic = self.image(drawing);
            node.kind = pic.kind.clone();
            if let Some(t) = pic.text.filter(|t| !t.is_empty()) {
                node.text = Some(t);
            }
            for (k, v) in pic.format.into_iter().filter(|(k, _)| !k.is_empty()) {
                node.set(&k, v);
            }
        }
        if node.kind == "run" {
            if let Some(ptab) = run.child(W, "ptab") {
                let align = ptab.w("alignment");
                let rel_to = ptab.w("relativeTo");
                let leader = ptab.w("leader");
                if run.child(W, "t").is_some() || run.child(W, "delText").is_some() {
                    node.str("ptabInline", "true");
                    for (v, key) in [
                        (align, "ptabInline.align"),
                        (rel_to, "ptabInline.relativeTo"),
                        (leader, "ptabInline.leader"),
                    ] {
                        if let Some(v) = v {
                            node.str(key, v);
                        }
                    }
                } else {
                    node.kind = "ptab".to_string();
                    for (v, key) in [(align, "align"), (rel_to, "relativeTo"), (leader, "leader")] {
                        if let Some(v) = v {
                            node.str(key, v);
                        }
                    }
                }
            }
        }
        if node.kind == "run" {
            if let Some(fc) = run.child(W, "fldChar") {
                node.kind = "fieldChar".to_string();
                if let Some(t) = fc.w("fldCharType") {
                    node.str("fieldCharType", t);
                }
                if fc.w("dirty").is_some() && on_off(fc.w("dirty")) == Some(true) {
                    node.flag("dirty");
                }
                if fc.w("fldLock").is_some() && on_off(fc.w("fldLock")) == Some(true) {
                    node.flag("fldLock");
                }
                if fc.child(W, "ffData").is_some() {
                    node.flag("hasFormFieldData");
                }
            }
        }
        if node.kind == "run" {
            if let Some(instr) = run
                .child(W, "instrText")
                .or_else(|| run.child(W, "delInstrText"))
            {
                node.kind = "instrText".to_string();
                node.str("instruction", instr.text());
                node.text = Some(instr.text());
            }
        }
        let no_text = run.child(W, "t").is_none() && run.child(W, "delText").is_none();
        if node.kind == "run" && no_text && run.children(W, "tab").len() == 1 {
            node.kind = "tab".to_string();
            node.text = Some(String::new());
        }
        if node.kind == "run" && no_text {
            if let Some(br) = run.child(W, "br") {
                let brs = run.children(W, "br");
                let line_like = brs
                    .iter()
                    .filter(|x| matches!(x.w("type"), None | Some("textWrapping")))
                    .count()
                    + run.children(W, "cr").len();
                let non_line = brs
                    .iter()
                    .any(|x| !matches!(x.w("type"), None | Some("textWrapping")));
                if !(line_like > 1 && !non_line) {
                    node.kind = "break".to_string();
                    node.text = Some(String::new());
                    if let Some(bt) = br.w("type") {
                        node.str(
                            "breakType",
                            if bt.eq_ignore_ascii_case("textwrapping") {
                                "line"
                            } else {
                                bt
                            },
                        );
                    }
                    if let Some(clear) = br.w("clear") {
                        node.str("breakClear", clear);
                    }
                }
            }
        }
        if let Some(parent) = run.parent().filter(|p| p.is(W, "hyperlink")) {
            node.flag("isHyperlink");
            self.hyperlink_props(parent, &mut node);
        }
        if node.kind == "run" {
            if let Some(para) = run.ancestor(W, "p") {
                Self::emit_effective_run(&mut node, &self.resolve_run(Some(run), para));
            }
        }
        if matches!(node.kind.as_str(), "fieldChar" | "instrText" | "break") {
            let keep = node.has("hasFormFieldData");
            for key in TYPOGRAPHY_ONLY {
                if keep && FIELD_KEEP.contains(key) {
                    continue;
                }
                node.remove(key);
            }
        }
        node
    }

    fn hyperlink_props(&self, h: E<'_>, node: &mut Node) {
        if let Some(id) = h.attr_ns("id", R) {
            if let Some(rel) = self.pkg.rel(&self.owner_part(h), id) {
                node.str("url", rel.target);
            }
        }
        for attr in ["anchor", "docLocation", "tooltip", "tgtFrame"] {
            if let Some(v) = h.w(attr) {
                node.str(attr, v);
            }
        }
        if let Some(history) = h.w("history") {
            node.set("history", Value::Bool(on_off(Some(history)) == Some(true)));
        }
    }

    /// The part an element of a header, footer or note lives in.
    pub(super) fn owner_part(&self, e: E<'_>) -> String {
        let same = |name: &str| self.pkg.xml(name).is_some_and(|t| std::ptr::eq(t, e.t));
        for name in self.header_parts.iter().chain(&self.footer_parts) {
            if same(name) {
                return name.clone();
            }
        }
        for kind in ["footnotes", "endnotes", "comments"] {
            if let Some(name) = self.pkg.related(&self.main_part, kind).into_iter().next() {
                if same(&name) {
                    return name;
                }
            }
        }
        self.main_part.clone()
    }

    pub(super) fn hyperlink(&self, h: E<'_>, mut node: Node) -> Node {
        node.kind = "hyperlink".to_string();
        node.text = Some(t_text(h));
        self.hyperlink_props(h, &mut node);
        let run = h
            .children(W, "r")
            .into_iter()
            .find(|r| r.child(W, "t").is_some());
        let Some(rp) = w_child(run, "rPr") else {
            return node;
        };
        let rf = rp.child(W, "rFonts");
        if let Some(ascii) = rf.and_then(|f| f.w("ascii")) {
            node.str("font", ascii);
        }
        if let Some(cs) = rf.and_then(|f| f.w("cs")) {
            node.str("font.cs", cs);
        }
        if let Some(sz) = half_points(w_val(rp.child(W, "sz"))) {
            node.str("size", sz);
        }
        if let Some(b) = rp.child(W, "b") {
            node.set("bold", Value::Bool(is_on(Some(b))));
        }
        if let Some(i) = rp.child(W, "i") {
            node.set("italic", Value::Bool(is_on(Some(i))));
        }
        let color = rp.child(W, "color");
        if let Some(theme) = color.and_then(|c| c.w("themeColor")) {
            node.str("color", theme);
        } else if let Some(cv) = color.and_then(|c| c.w("val")) {
            node.str("color", hex_color(cv));
        }
        let u = rp.child(W, "u");
        if let Some(uv) = u.and_then(|u| u.w("val")) {
            node.str("underline", uv);
        }
        if let Some(uc) = u.and_then(|u| u.w("color")) {
            node.str("underline.color", hex_color(uc));
        }
        if let Some(s) = rp.child(W, "strike") {
            node.set("strike", Value::Bool(is_on(Some(s))));
        }
        if let Some(hl) = w_val(rp.child(W, "highlight")) {
            node.str("highlight", hl);
        }
        if let Some(rs) = w_val(rp.child(W, "rStyle")) {
            node.str("rStyle", rs);
        }
        node
    }
}
