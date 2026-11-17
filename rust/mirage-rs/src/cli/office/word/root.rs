// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! The document node with its settings, compatibility flags and defaults,
//! and the section nodes.

use super::super::node::{Node, Value, number_text};
use super::super::package::{core_properties, extended_properties, theme_properties};
use super::super::tree::{E, R, W, is_on, on_off};
use super::super::units::{f2, hex_color, twips_to_cm, twips_to_pt};
use super::doc::Word;
use super::{
    COMPAT_FLAGS, float_value, is_digits, is_int, jsn, num_value, read_border, w_child, w_val,
};

const MARGINS: [(&str, &str, bool); 7] = [
    ("top", "marginTop", true),
    ("bottom", "marginBottom", true),
    ("left", "marginLeft", false),
    ("right", "marginRight", false),
    ("header", "marginHeader", false),
    ("footer", "marginFooter", false),
    ("gutter", "marginGutter", false),
];

fn margin_cm(raw: &str, abs: bool) -> String {
    let n = jsn(raw);
    twips_to_cm(if abs { n.abs() } else { n })
}

fn page_number_props(sect: E<'_>, node: &mut Node) {
    let pg_num = sect.child(W, "pgNumType");
    if let Some(start) = pg_num.and_then(|p| p.w("start")) {
        node.set("pageStart", num_value(start));
    }
    if let Some(pnf) = pg_num.and_then(|p| p.w("fmt")) {
        node.str("pageNumFmt", pnf);
    }
    if let Some(cs) = pg_num.and_then(|p| p.w("chapStyle")) {
        node.set("chapStyle", num_value(cs));
    }
    if let Some(sep) = pg_num.and_then(|p| p.w("chapSep")) {
        node.str("chapSep", sep);
    }
    if is_on(sect.child(W, "titlePg")) {
        node.flag("titlePage");
    }
    let paper = sect.child(W, "paperSrc");
    if let Some(first) = paper.and_then(|p| p.w("first")) {
        node.set("paperSrc.first", num_value(first));
    }
    if let Some(other) = paper.and_then(|p| p.w("other")) {
        node.set("paperSrc.other", num_value(other));
    }
}

fn column_props(cols: E<'_>, node: &mut Node, columns: Option<Value>) {
    if let Some(c) = columns {
        node.set("columns", c);
    }
    if let Some(space) = cols.w("space").filter(|s| is_digits(s)) {
        node.str("columnSpace", twips_to_cm(jsn(space)));
    }
    if let Some(eq) = cols.w("equalWidth") {
        node.set(
            "columns.equalWidth",
            Value::Bool(on_off(Some(eq)) == Some(true)),
        );
    }
    if let Some(sep) = cols.w("sep") {
        if on_off(Some(sep)) == Some(true) {
            node.flag("columns.separator");
        }
    }
    let defs = cols.children(W, "col");
    if !defs.is_empty() {
        node.str(
            "colWidths",
            defs.iter()
                .map(|c| c.w("w").unwrap_or("0"))
                .collect::<Vec<_>>()
                .join(","),
        );
        node.str(
            "colSpaces",
            defs.iter()
                .map(|c| c.w("space").unwrap_or("0"))
                .collect::<Vec<_>>()
                .join(","),
        );
    }
}

impl<'p> Word<'p> {
    pub(super) fn root(&self) -> Node {
        let mut node = Node::new("/", "document");
        let mut children = Vec::new();
        let body = self.body();
        if let Some(b) = body {
            let mut n = Node::new("/body", "body");
            n.child_count = b.elements().count();
            children.push(n);
        }
        if self.styles_part.is_some() {
            let mut n = Node::new("/styles", "styles");
            n.child_count = self.styles().map_or(0, |s| s.elements().count());
            children.push(n);
        }
        for i in 0..self.header_parts.len() {
            children.push(Node::new(format!("/header[{}]", i + 1), "header"));
        }
        for i in 0..self.footer_parts.len() {
            children.push(Node::new(format!("/footer[{}]", i + 1), "footer"));
        }
        if self.numbering_part.is_some() {
            children.push(Node::new("/numbering", "numbering"));
        }
        for (kind, child, path) in [
            ("footnotes", "footnote", "/footnotes"),
            ("endnotes", "endnote", "/endnotes"),
        ] {
            let Some(part) = self.part_of(kind) else {
                continue;
            };
            let n = part
                .children(W, child)
                .iter()
                .filter(|x| jsn(x.w("id").unwrap_or("0")) > 0.0)
                .count();
            if n > 0 {
                let mut d = Node::new(path, kind);
                d.child_count = n;
                children.push(d);
            }
        }
        if let Some(comments) = self.part_of("comments") {
            let n = comments.children(W, "comment").len();
            if n > 0 {
                let mut d = Node::new("/comments", "comments");
                d.child_count = n;
                children.push(d);
            }
        }
        let core = self.pkg.related("/", "core-properties").into_iter().next();
        core_properties(core.as_deref().and_then(|c| self.part_root(c)), &mut node);
        if let Some(bg) = w_child(self.document().ok(), "background")
            .and_then(|b| b.w("color"))
            .filter(|b| !b.is_empty())
        {
            node.str("background", hex_color(bg));
        }
        let sect = w_child(body, "sectPr")
            .or_else(|| body.and_then(|b| b.descendants_named(W, "sectPr").last().copied()));
        if let Some(s) = sect {
            self.section_doc_props(s, &mut node);
        }
        match w_child(self.settings(), "documentProtection") {
            Some(protection) => {
                let edit = protection.w("edit");
                node.str(
                    "protection",
                    edit.filter(|e| {
                        ["readOnly", "comments", "trackedChanges", "forms"].contains(e)
                    })
                    .unwrap_or("none"),
                );
                let enforced = protection.w("enforcement");
                node.set(
                    "protectionEnforced",
                    Value::Bool(
                        (enforced.is_some() && on_off(enforced) == Some(true))
                            || (enforced.is_none() && edit.is_some()),
                    ),
                );
            }
            None => {
                node.str("protection", "none");
                node.set("protectionEnforced", Value::Bool(false));
            }
        }
        self.doc_settings(&mut node, sect);
        self.compatibility(&mut node);
        self.doc_defaults(&mut node);
        let theme = self
            .pkg
            .related(&self.main_part, "theme")
            .into_iter()
            .next();
        theme_properties(theme.as_deref().and_then(|t| self.part_root(t)), &mut node);
        let app = self
            .pkg
            .related("/", "extended-properties")
            .into_iter()
            .next();
        extended_properties(app.as_deref().and_then(|a| self.part_root(a)), &mut node);
        node.child_count = children.len();
        node.children = children;
        node
    }

    fn header_footer_refs(&self, sect: E<'_>, node: &mut Node) {
        for (kind, parts) in [
            ("header", &self.header_parts),
            ("footer", &self.footer_parts),
        ] {
            let mut primary: Option<String> = None;
            for r in sect.children(W, &format!("{kind}Reference")) {
                let Some(id) = r.attr_ns("id", R) else {
                    continue;
                };
                let ty = r.w("type").unwrap_or("default");
                let Some(idx) = self
                    .pkg
                    .rel_part(&self.main_part, id)
                    .and_then(|part| parts.iter().position(|x| *x == part))
                else {
                    continue;
                };
                let path_ref = format!("/{kind}[{}]", idx + 1);
                node.str(&format!("{kind}Ref.{ty}"), path_ref.clone());
                if primary.is_none() || ty == "default" {
                    primary = Some(path_ref);
                }
            }
            if let Some(p) = primary {
                node.str(&format!("{kind}Ref"), p);
            }
        }
    }

    fn line_numbers(sect: E<'_>, node: &mut Node) {
        let Some(ln) = sect.child(W, "lnNumType") else {
            return;
        };
        let count_by = ln.w("countBy").unwrap_or("1");
        if let Some(restart) = ln.w("restart") {
            node.str(
                "lineNumbers",
                match restart {
                    "newPage" => "restartPage",
                    "newSection" => "restartSection",
                    _ => "continuous",
                },
            );
        }
        if jsn(count_by) != 1.0 {
            node.set("lineNumberCountBy", num_value(count_by));
        }
        if let Some(start) = ln.w("start") {
            node.set("lineNumberStart", num_value(start));
        }
        if let Some(dist) = ln.w("distance").filter(|d| is_int(d)) {
            node.set("lineNumberDistance", num_value(dist));
        }
    }

    pub(super) fn page_borders(pg: Option<E<'_>>, node: &mut Node, prefix: &str) {
        let Some(pg) = pg else { return };
        for side in ["top", "left", "bottom", "right"] {
            read_border(pg.child(W, side), &format!("{prefix}.{side}"), node);
        }
        for attr in ["offsetFrom", "zOrder", "display"] {
            if let Some(v) = pg.w(attr) {
                node.str(&format!("{prefix}.{attr}"), v);
            }
        }
    }

    fn section_doc_props(&self, sect: E<'_>, node: &mut Node) {
        let pg_sz = sect.child(W, "pgSz");
        if let Some(w) = pg_sz.and_then(|p| p.w("w")) {
            node.str("pageWidth", twips_to_cm(jsn(w)));
        }
        if let Some(h) = pg_sz.and_then(|p| p.w("h")) {
            node.str("pageHeight", twips_to_cm(jsn(h)));
        }
        if let Some(o) = pg_sz.and_then(|p| p.w("orient")) {
            node.str("orientation", o);
        }
        if let Some(mar) = sect.child(W, "pgMar") {
            for (attr, key, abs) in MARGINS {
                if let Some(v) = mar.w(attr) {
                    node.str(key, margin_cm(v, abs));
                }
            }
        }
        page_number_props(sect, node);
        Self::page_borders(sect.child(W, "pgBorders"), node, "pgBorders");
        if is_on(sect.child(W, "bidi")) {
            node.str("direction", "rtl");
        }
        if is_on(sect.child(W, "rtlGutter")) {
            node.flag("rtlGutter");
        }
        if is_on(sect.child(W, "noEndnote")) {
            node.flag("noEndnote");
        }
        if let Some(fp) = sect.child(W, "formProt") {
            node.set("formProt", Value::Bool(is_on(Some(fp))));
        }
        Self::line_numbers(sect, node);
        self.header_footer_refs(sect, node);
    }

    pub(super) fn note_props(sect: E<'_>, node: &mut Node, prefix: &str) {
        for kind in ["footnote", "endnote"] {
            let Some(pr) = sect.child(W, &format!("{kind}Pr")) else {
                continue;
            };
            if let Some(v) = w_val(pr.child(W, "numFmt")) {
                node.str(&format!("{prefix}{kind}Pr.numFmt"), v);
            }
            if let Some(v) = w_val(pr.child(W, "numRestart")) {
                node.str(&format!("{prefix}{kind}Pr.numRestart"), v);
            }
            if let Some(v) = w_val(pr.child(W, "numStart")) {
                node.set(&format!("{prefix}{kind}Pr.numStart"), num_value(v));
            }
            if let Some(v) = w_val(pr.child(W, "pos")) {
                node.str(&format!("{prefix}{kind}Pr.pos"), v);
            }
        }
    }

    pub(super) fn doc_grid(sect: E<'_>, node: &mut Node, prefix: &str) {
        let Some(grid) = sect.child(W, "docGrid") else {
            return;
        };
        if let Some(t) = grid.w("type") {
            node.str(&format!("{prefix}docGrid.type"), t);
        }
        if let Some(p) = grid.w("linePitch") {
            node.set(&format!("{prefix}docGrid.linePitch"), num_value(p));
        }
        if let Some(cs) = grid.w("charSpace").filter(|c| is_int(c)) {
            let mut v = jsn(cs);
            if v > 2_147_483_647.0 {
                v -= 4_294_967_296.0;
            }
            node.set(&format!("{prefix}docGrid.charSpace"), float_value(v));
        }
    }

    fn doc_settings(&self, node: &mut Node, sect: Option<E<'_>>) {
        if let Some(sect) = sect {
            Self::doc_grid(sect, node, "");
            if let Some(cols) = sect.child(W, "cols") {
                column_props(cols, node, cols.w("num").map(num_value));
            }
            if let Some(t) = w_val(sect.child(W, "type")) {
                node.str("section.type", t);
            }
            if let Some(v) = w_val(sect.child(W, "vAlign")) {
                node.str("vAlign", v);
            }
            if let Some(v) = w_val(sect.child(W, "textDirection")) {
                node.str("textDirection", v);
            }
            Self::note_props(sect, node, "");
        }
        let base = w_child(
            w_child(w_child(self.styles(), "docDefaults"), "pPrDefault"),
            "pPr",
        );
        if let Some(base) = base {
            for name in ["autoSpaceDE", "autoSpaceDN", "kinsoku", "overflowPunct"] {
                if let Some(e) = base.child(W, name) {
                    node.set(name, Value::Bool(on_off(e.w("val")) != Some(false)));
                }
            }
        }
        let Some(settings) = self.settings() else {
            return;
        };
        if let Some(v) = w_val(settings.child(W, "characterSpacingControl")) {
            node.str("charSpacingControl", v);
        }
        for (el, key) in [
            ("displayBackgroundShape", "displayBackgroundShape"),
            ("doNotDisplayPageBoundaries", "doNotDisplayPageBoundaries"),
            ("printFormsData", "printFormsData"),
            ("printPostScriptOverText", "printPostScriptOverText"),
            (
                "printFractionalCharacterWidth",
                "printFractionalCharacterWidth",
            ),
            ("removePersonalInformation", "removePersonalInformation"),
            ("removeDateAndTime", "removeDateAndTime"),
            ("embedTrueTypeFonts", "embedFonts"),
            ("embedSystemFonts", "embedSystemFonts"),
            ("saveSubsetFonts", "saveSubsetFonts"),
            ("mirrorMargins", "mirrorMargins"),
            ("gutterAtTop", "gutterAtTop"),
            ("bookFoldPrinting", "bookFoldPrinting"),
            ("bookFoldRevPrinting", "bookFoldReversePrinting"),
        ] {
            if settings.child(W, el).is_some() {
                node.flag(key);
            }
        }
        if let Some(v) = w_val(settings.child(W, "bookFoldPrintingSheets")) {
            node.set("bookFoldPrintingSheets", num_value(v));
        }
        for el in [
            "evenAndOddHeaders",
            "updateFields",
            "autoHyphenation",
            "trackRevisions",
        ] {
            if settings.child(W, el).is_some() {
                node.flag(el);
            }
        }
        if let Some(v) = w_val(settings.child(W, "defaultTabStop")) {
            node.str("defaultTabStop", twips_to_cm(jsn(v)));
        }
        if let Some(tfl) = settings.child(W, "themeFontLang") {
            let val = tfl.w("val");
            let ea = tfl.w("eastAsia");
            let bidi = tfl.w("bidi");
            if let Some(v) = val {
                node.str("lang.latin", v);
            }
            if let Some(v) = ea {
                node.str("lang.ea", v);
            }
            if let Some(v) = bidi {
                node.str("lang.cs", v);
            }
            if let Some(locale) = bidi.or(val).or(ea) {
                node.str("locale", locale);
            }
        }
    }

    fn compatibility(&self, node: &mut Node) {
        let Some(compat) = w_child(self.settings(), "compat") else {
            return;
        };
        let mode = compat.children(W, "compatSetting").into_iter().find(|c| {
            c.w("name") == Some("compatibilityMode")
                && c.w("uri") == Some("http://schemas.microsoft.com/office/word")
        });
        if let Some(mv) = mode.and_then(|m| m.w("val")) {
            node.set(
                "compatibility.mode",
                if is_int(mv) {
                    num_value(mv)
                } else {
                    Value::Str(mv.to_string())
                },
            );
        }
        for (flag, el) in COMPAT_FLAGS {
            if let Some(e) = compat.child(W, el) {
                node.set(
                    &format!("compatibility.{flag}"),
                    Value::Bool(on_off(e.w("val")) != Some(false)),
                );
            }
        }
    }

    pub(super) fn doc_defaults(&self, node: &mut Node) {
        let Some(dd) = w_child(self.styles(), "docDefaults") else {
            return;
        };
        if let Some(rpr) = w_child(dd.child(W, "rPrDefault"), "rPr") {
            let fonts = rpr.child(W, "rFonts");
            let ascii = fonts.and_then(|f| f.w("ascii"));
            if let Some(a) = ascii {
                node.str("docDefaults.font", a);
            }
            if let Some(ea) = fonts.and_then(|f| f.w("eastAsia")) {
                node.str("docDefaults.font.eastAsia", ea);
            }
            if let Some(h) = fonts
                .and_then(|f| f.w("hAnsi"))
                .filter(|h| Some(*h) != ascii)
            {
                node.str("docDefaults.font.hAnsi", h);
            }
            if let Some(cs) = fonts.and_then(|f| f.w("cs")) {
                node.str("docDefaults.font.complexScript", cs);
            }
            if let Some(sz) = w_val(rpr.child(W, "sz")) {
                node.str(
                    "docDefaults.fontSize",
                    format!("{}pt", number_text(jsn(sz) / 2.0)),
                );
            }
            if let Some(c) = w_val(rpr.child(W, "color")) {
                node.str("docDefaults.color", hex_color(c));
            }
            if rpr.child(W, "b").is_some() {
                node.flag("docDefaults.bold");
            }
            if rpr.child(W, "i").is_some() {
                node.flag("docDefaults.italic");
            }
        }
        if let Some(ppr) = w_child(dd.child(W, "pPrDefault"), "pPr") {
            if ppr.child(W, "bidi").is_some() {
                node.flag("docDefaults.rtl");
            }
            if let Some(jc) = w_val(ppr.child(W, "jc")) {
                node.str("docDefaults.alignment", jc);
            }
            if let Some(sp) = ppr.child(W, "spacing") {
                if let Some(b) = sp.w("before").filter(|b| is_digits(b)) {
                    node.str("docDefaults.spaceBefore", twips_to_pt(jsn(b)));
                }
                if let Some(a) = sp.w("after").filter(|a| is_digits(a)) {
                    node.str("docDefaults.spaceAfter", twips_to_pt(jsn(a)));
                }
                if let Some(l) = sp.w("line").filter(|l| is_int(l)) {
                    let rule = sp.w("lineRule").unwrap_or("auto");
                    node.str(
                        "docDefaults.lineSpacing",
                        if rule == "auto" {
                            format!("{}x", f2(jsn(l) / 240.0))
                        } else {
                            format!("{}pt", f2(jsn(l) / 20.0))
                        },
                    );
                }
            }
        }
    }

    pub(super) fn section(&self, sect: E<'_>, path: &str) -> Node {
        let mut node = Node::new(path, "section");
        if let Some(t) = w_val(sect.child(W, "type")) {
            node.str("type", t);
            node.str("sectionType", t);
        }
        let pg_sz = sect.child(W, "pgSz");
        node.str(
            "pageWidth",
            twips_to_cm(jsn(pg_sz.and_then(|p| p.w("w")).unwrap_or("11906"))),
        );
        node.str(
            "pageHeight",
            twips_to_cm(jsn(pg_sz.and_then(|p| p.w("h")).unwrap_or("16838"))),
        );
        if let Some(o) = pg_sz.and_then(|p| p.w("orient")) {
            node.str("orientation", o);
        }
        let mar = sect.child(W, "pgMar");
        for (attr, key, abs) in MARGINS {
            if let Some(v) = mar.and_then(|m| m.w(attr)) {
                node.str(key, margin_cm(v, abs));
            }
        }
        page_number_props(sect, &mut node);
        Self::page_borders(sect.child(W, "pgBorders"), &mut node, "pgBorders");
        if sect.child(W, "bidi").is_some() {
            node.str("direction", "rtl");
        }
        if is_on(sect.child(W, "rtlGutter")) {
            node.flag("rtlGutter");
        }
        if is_on(sect.child(W, "noEndnote")) {
            node.flag("noEndnote");
        }
        if let Some(fp) = sect.child(W, "formProt") {
            node.set("formProt", Value::Bool(is_on(Some(fp))));
        }
        self.header_footer_refs(sect, &mut node);
        Self::line_numbers(sect, &mut node);
        if let Some(cols) = sect.child(W, "cols") {
            column_props(
                cols,
                &mut node,
                Some(num_value(cols.w("num").unwrap_or("1"))),
            );
        }
        if let Some(v) = w_val(sect.child(W, "vAlign")) {
            node.str("vAlign", v);
        }
        if let Some(v) = w_val(sect.child(W, "textDirection")) {
            node.str("textDirection", v);
        }
        Self::note_props(sect, &mut node, "");
        Self::doc_grid(sect, &mut node, "");
        node
    }
}
