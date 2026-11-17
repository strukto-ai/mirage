// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! Pictures, content controls, bookmarks, headers and footers, styles,
//! and any other element as OfficeCLI's `ElementToNode` dispatches it.

use super::super::node::{Node, Value, number_text};
use super::super::package::resolve_target;
use super::super::tree::{A, E, M, R, W, W14, WP, is_on, on_off, outer_xml};
use super::super::units::{
    f2, fixed, fmt, half_points, hex_color, word_line_spacing, word_spacing,
};
use super::doc::Word;
use super::{
    WPG, clip, color_with_theme_tail, fill_unknown, is_int, jsn, num_text, num_value, para_segment,
    read_border, sdt_segment, t_text, w_child, w_val,
};

/// The attribute order the Open XML SDK keeps for a typed `w:style`.
const STYLE_ATTRS: [&str; 4] = ["type", "styleId", "default", "customStyle"];

fn rank(name: &str) -> usize {
    STYLE_ATTRS
        .iter()
        .position(|n| *n == name)
        .unwrap_or(STYLE_ATTRS.len())
}

/// `YYYY-MM-DDTHH:MM:SS` at the head of `full`, as `YYYY-MM-DDTHH:MM:SSZ`.
fn full_date(full: &str) -> String {
    let b = full.as_bytes();
    let shape = b"dddd-dd-ddTdd:dd:dd";
    let ok = b.len() >= shape.len()
        && shape.iter().zip(b).all(|(s, c)| match s {
            b'd' => c.is_ascii_digit(),
            other => other == c,
        });
    if ok {
        format!("{}Z", &full[..shape.len()])
    } else {
        full.to_string()
    }
}

impl<'p> Word<'p> {
    /// A picture's node: its name, size and the relationship of its image.
    pub(super) fn image(&self, drawing: E<'_>) -> Node {
        let mut node = Node::new("", "picture");
        let all = drawing.descendants();
        let doc_pr = all.iter().copied().find(|d| d.is(WP, "docPr"));
        let extent = all.iter().copied().find(|d| d.is(WP, "extent"));
        let descr = doc_pr.and_then(|d| d.attr("descr"));
        let name = doc_pr.and_then(|d| d.attr("name"));
        node.text = Some(descr.or(name).unwrap_or_default().to_string());
        if let Some(id) = doc_pr.and_then(|d| d.attr("id")) {
            node.set(
                "id",
                if super::is_digits(id) {
                    num_value(id)
                } else {
                    Value::Str(id.to_string())
                },
            );
        }
        if let Some(n) = name {
            node.str("name", n);
        }
        if doc_pr
            .and_then(|d| d.attr("hidden"))
            .is_some_and(|h| on_off(Some(h)) == Some(true))
        {
            node.flag("hidden");
        }
        if let Some(cx) = extent.and_then(|e| e.attr("cx")) {
            node.str("width", format!("{}cm", fixed(jsn(cx) / 360_000.0, 1)));
        }
        if let Some(cy) = extent.and_then(|e| e.attr("cy")) {
            node.str("height", format!("{}cm", fixed(jsn(cy) / 360_000.0, 1)));
        }
        if let Some(d) = descr {
            node.str("alt", d);
        }
        let click = all.iter().copied().find(|d| d.name() == "hlinkClick");
        if let Some(cid) = click
            .and_then(|c| c.attr_ns("id", R))
            .filter(|c| !c.is_empty())
        {
            if let Some(rel) = self.pkg.rel(&self.owner_part(drawing), cid) {
                node.str("link", rel.target);
            }
        }
        let blip = all.iter().copied().find(|d| d.is(A, "blip"));
        if let Some(embed) = blip.and_then(|b| b.attr_ns("embed", R)) {
            node.str("relId", embed);
        }
        let lum_off = jsn(blip
            .and_then(|b| b.child(A, "lumOff"))
            .and_then(|l| l.attr("val"))
            .unwrap_or("0"));
        if lum_off != 0.0 {
            node.str("brightness", number_text((lum_off / 1000.0).trunc()));
        }
        let lum_mod = jsn(blip
            .and_then(|b| b.child(A, "lumMod"))
            .and_then(|l| l.attr("val"))
            .unwrap_or("100000"));
        if lum_mod != 100_000.0 {
            node.str(
                "contrast",
                number_text(((lum_mod - 100_000.0) / 1000.0).trunc()),
            );
        }
        if let Some(src) = all.iter().copied().find(|d| d.is(A, "srcRect")) {
            let v = |a: &str| jsn(src.attr(a).unwrap_or("0"));
            let sides = [v("l"), v("t"), v("r"), v("b")];
            if sides.iter().any(|x| *x != 0.0) {
                node.str(
                    "crop",
                    sides
                        .iter()
                        .map(|x| fmt(x / 1000.0, 3))
                        .collect::<Vec<_>>()
                        .join(","),
                );
            }
        }
        if drawing.child(WP, "inline").is_some() {
            node.str("wrap", "inline");
        } else if let Some(anchor) = drawing.child(WP, "anchor") {
            node.flag("anchor");
            let wrap = [
                ("wrapNone", "none"),
                ("wrapSquare", "square"),
                ("wrapTight", "tight"),
                ("wrapThrough", "through"),
                ("wrapTopAndBottom", "topandbottom"),
            ]
            .iter()
            .find(|(n, _)| anchor.child(WP, n).is_some())
            .map_or("none", |(_, v)| v);
            node.str("wrap", wrap);
            if let Some(side) = anchor
                .child(WP, "wrapSquare")
                .and_then(|w| w.attr("wrapText"))
                .filter(|s| *s != "bothSides")
            {
                node.str("wrap.side", side);
            }
            if anchor
                .attr("behindDoc")
                .is_some_and(|b| on_off(Some(b)) == Some(true))
            {
                node.flag("behindText");
            }
            if let Some(rh) = anchor.attr("relativeHeight") {
                node.str("relativeHeight", num_text(rh));
            }
            for (axis, key) in [("positionH", "h"), ("positionV", "v")] {
                let Some(pos) = anchor.child(WP, axis) else {
                    continue;
                };
                if let Some(align) = pos
                    .child(WP, "align")
                    .map(|a| a.text())
                    .filter(|a| !a.is_empty())
                {
                    node.str(&format!("{key}Align"), align);
                }
                if let Some(off) = pos.child(WP, "posOffset").map(|o| o.text()) {
                    let body = off.strip_prefix('-').unwrap_or(&off);
                    if super::is_digits(body) && jsn(&off) != 0.0 {
                        node.str(
                            &format!("{key}Position"),
                            format!("{}cm", fixed(jsn(&off) / 360_000.0, 1)),
                        );
                    }
                }
                if let Some(rel) = pos.attr("relativeFrom") {
                    node.str(&format!("{key}Relative"), rel);
                }
            }
        }
        node
    }

    fn sdt_editable(&self, pr: Option<E<'_>>) -> bool {
        if matches!(
            w_val(w_child(pr, "lock")),
            Some("contentLocked" | "sdtContentLocked")
        ) {
            return false;
        }
        let Some(protection) = w_child(self.settings(), "documentProtection") else {
            return true;
        };
        let edit = protection.w("edit").unwrap_or("none");
        let enforced = match protection.w("enforcement") {
            None => true,
            Some(e) => on_off(Some(e)) == Some(true),
        };
        if !enforced || edit == "none" {
            return true;
        }
        !matches!(edit, "readOnly" | "comments" | "trackedChanges")
    }

    pub(super) fn sdt(&self, sdt: E<'_>, mut node: Node) -> Node {
        node.kind = "sdt".to_string();
        if let Some(pr) = sdt.child(W, "sdtPr") {
            for (el, key) in [("alias", "alias"), ("tag", "tag"), ("lock", "lock")] {
                if let Some(v) = w_val(pr.child(W, el)) {
                    node.str(key, v);
                }
            }
            if let Some(id) = w_val(pr.child(W, "id")) {
                node.set(
                    "id",
                    if is_int(id) && !id.starts_with('+') {
                        num_value(id)
                    } else {
                        Value::Str(id.to_string())
                    },
                );
            }
            let checkbox = pr.child(W14, "checkbox");
            let ty = if pr.child(W, "group").is_some() {
                "group"
            } else if pr.child(W, "picture").is_some() {
                "picture"
            } else if checkbox.is_some() {
                "checkbox"
            } else if pr.child(W, "dropDownList").is_some() {
                "dropdown"
            } else if pr.child(W, "comboBox").is_some() {
                "combobox"
            } else if pr.child(W, "date").is_some() {
                "date"
            } else if pr.child(W, "text").is_some() {
                "text"
            } else {
                "richtext"
            };
            node.str("type", ty);
            if let Some(cb) = checkbox {
                let v = cb.child(W14, "checked").and_then(|c| c.attr_ns("val", W14));
                node.set(
                    "checked",
                    Value::Bool(v.is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"))),
                );
            }
            let date = pr.child(W, "date");
            if let Some(df) = w_val(w_child(date, "dateFormat")) {
                node.str("format", df);
            }
            node.set("editable", Value::Bool(self.sdt_editable(Some(pr))));
            if pr.child(W, "showingPlcHdr").is_some() {
                node.flag("placeholder");
            }
            if let Some(plc) = w_val(w_child(pr.child(W, "placeholder"), "docPart")) {
                node.str("placeholderText", plc);
            }
            if let Some(date) = date {
                if let Some(full) = date.w("fullDate") {
                    node.str("date.fullDate", full_date(full));
                }
                for (el, key) in [
                    ("calendar", "date.calendar"),
                    ("lid", "date.lid"),
                    ("storeMappedDataAs", "date.storeMappedDataAs"),
                ] {
                    if let Some(v) = w_val(date.child(W, el)) {
                        node.str(key, v);
                    }
                }
            }
            if let Some(list) = pr
                .child(W, "dropDownList")
                .or_else(|| pr.child(W, "comboBox"))
            {
                let items: Vec<String> = list
                    .children(W, "listItem")
                    .iter()
                    .map(|li| {
                        let disp = li.w("displayText").or(li.w("value")).unwrap_or_default();
                        let val = li.w("value").or(li.w("displayText")).unwrap_or_default();
                        if disp == val {
                            disp.to_string()
                        } else {
                            format!("{disp}|{val}")
                        }
                    })
                    .collect();
                if !items.is_empty() {
                    node.str("items", items.join(","));
                }
            }
            if let Some(last) = pr
                .child(W, "dropDownList")
                .and_then(|d| d.w("lastValue"))
                .filter(|l| !l.is_empty())
            {
                node.str("dropDown.lastValue", last);
            }
            if let Some(last) = pr
                .child(W, "comboBox")
                .and_then(|d| d.w("lastValue"))
                .filter(|l| !l.is_empty())
            {
                node.str("comboBox.lastValue", last);
            }
            if let Some(binding) = pr.child(W, "dataBinding") {
                for (a, k) in [
                    ("xpath", "dataBinding.xpath"),
                    ("storeItemID", "dataBinding.storeItemID"),
                    ("prefixMappings", "dataBinding.prefixMappings"),
                ] {
                    if let Some(v) = binding.w(a).filter(|v| !v.is_empty()) {
                        node.str(k, v);
                    }
                }
            }
        }
        node.text = Some(t_text(sdt));
        let block = sdt
            .parent()
            .is_some_and(|p| !p.is(W, "p") && !p.is(W, "hyperlink"));
        if block {
            node.child_count = sdt
                .child(W, "sdtContent")
                .map_or(0, |c| c.elements().count());
        }
        node
    }

    pub(super) fn bookmark(&self, b: E<'_>, mut node: Node) -> Node {
        node.kind = "bookmark".to_string();
        node.str("name", b.w("name").unwrap_or_default());
        let id = b.w("id").unwrap_or_default();
        node.str("id", id);
        if let Some(start_para) = b.ancestor(W, "p").filter(|_| !id.is_empty()) {
            if let Some(host) = start_para.parent() {
                let siblings = host.children(W, "p");
                if let Some(at) = siblings.iter().position(|s| *s == start_para) {
                    for (i, sib) in siblings.iter().enumerate().skip(at) {
                        if sib
                            .descendants_named(W, "bookmarkEnd")
                            .iter()
                            .any(|e| e.w("id") == Some(id))
                        {
                            if i > at {
                                node.set("endPara", Value::Int((i - at) as i64));
                            }
                            break;
                        }
                    }
                }
            }
        }
        if let Some(c) = b.w("colFirst") {
            node.str("colFirst", num_text(c));
        }
        if let Some(c) = b.w("colLast") {
            node.str("colLast", num_text(c));
        }
        let mut text = String::new();
        if let Some(parent) = b.parent() {
            let kids: Vec<E<'_>> = parent.elements().collect();
            let from = kids.iter().position(|k| *k == b).map_or(0, |i| i + 1);
            for sib in &kids[from..] {
                if sib.is(W, "bookmarkEnd") && sib.w("id") == Some(id) {
                    break;
                }
                if sib.is(W, "r") {
                    text.push_str(&t_text(*sib));
                }
            }
        }
        if !text.is_empty() {
            node.text = Some(text);
        }
        node
    }

    /// The bookmark start a bookmark end closes.
    pub(super) fn bookmark_start_of(&self, end: E<'_>) -> Option<E<'p>> {
        let id = end.w("id").filter(|i| !i.is_empty())?;
        self.body()?
            .descendants_named(W, "bookmarkStart")
            .into_iter()
            .find(|b| b.w("id") == Some(id))
    }

    /// Whether a bookmark wraps content rather than marking a point.
    pub(super) fn spans_content(start: E<'_>) -> bool {
        let Some(id) = start.w("id").filter(|i| !i.is_empty()) else {
            return false;
        };
        let Some(root) = start
            .ancestor(W, "body")
            .or_else(|| start.ancestor(W, "tc"))
            .or_else(|| start.ancestors().last().copied())
        else {
            return false;
        };
        let mut n = start;
        loop {
            let mut next = n.elements().next();
            let mut cur = Some(n);
            while next.is_none() {
                let Some(c) = cur else { break };
                let Some(parent) = c.parent().filter(|p| *p != root) else {
                    return false;
                };
                let sibs: Vec<E<'_>> = parent.elements().collect();
                next = sibs
                    .iter()
                    .position(|s| *s == c)
                    .and_then(|i| sibs.get(i + 1).copied());
                cur = Some(parent);
            }
            let Some(nx) = next else { return false };
            if nx.is(W, "bookmarkEnd") && nx.w("id") == Some(id) {
                let start_anc = start.ancestors();
                let end_anc = nx.ancestors();
                if let Some(end_sdt) = end_anc.iter().find(|a| a.is(W, "sdt")) {
                    if !start_anc.contains(end_sdt) {
                        return true;
                    }
                }
                if let Some(cell) = start.ancestor(W, "tc") {
                    if !end_anc.contains(&cell) {
                        return true;
                    }
                }
                return false;
            }
            if nx.is(W, "r")
                || nx.is(M, "oMath")
                || nx.is(M, "oMathPara")
                || nx.is(W, "fldSimple")
                || nx.is(W, "hyperlink")
            {
                return true;
            }
            n = nx;
        }
    }

    pub(super) fn header_footer(&self, e: E<'_>, mut node: Node, path: &str, depth: usize) -> Node {
        node.kind = if e.name() == "hdr" {
            "header"
        } else {
            "footer"
        }
        .to_string();
        if node.text.is_none() {
            node.text = Some(t_text(e));
        }
        node.child_count =
            e.children(W, "p").len() + e.children(W, "tbl").len() + e.children(W, "sdt").len();
        if depth > 0 {
            let (mut p, mut t, mut s) = (0, 0, 0);
            for c in e.elements() {
                if c.is(W, "p") {
                    p += 1;
                    node.children.push(self.element(
                        c,
                        &format!("{path}/{}", para_segment(c, p)),
                        depth - 1,
                    ));
                } else if c.is(W, "tbl") {
                    t += 1;
                    node.children
                        .push(self.element(c, &format!("{path}/tbl[{t}]"), depth - 1));
                } else if c.is(W, "sdt") {
                    s += 1;
                    node.children.push(self.element(
                        c,
                        &format!("{path}/{}", sdt_segment(c, s)),
                        depth - 1,
                    ));
                }
            }
        }
        node
    }

    /// `/header[N]` or `/footer[N]`: its type and the look of its first run.
    pub(super) fn header_footer_node(
        &self,
        e: E<'_>,
        part: &str,
        path: &str,
        depth: usize,
    ) -> Node {
        let kind = if e.name() == "hdr" {
            "header"
        } else {
            "footer"
        };
        let mut node = Node::new(path, kind);
        node.text = Some(t_text(e).trim().to_string());
        let rel_id = self
            .pkg
            .rels(&self.main_part)
            .into_iter()
            .find(|r| !r.external && resolve_target(&self.main_part, &r.target) == part)
            .map(|r| r.id);
        for sect in self
            .body()
            .map(|b| b.children(W, "sectPr"))
            .unwrap_or_default()
        {
            let found = sect
                .children(W, &format!("{kind}Reference"))
                .into_iter()
                .find(|r| {
                    r.attr_ns("id", R) == rel_id.as_deref()
                        && r.w("type").is_some_and(|t| !t.is_empty())
                });
            if let Some(r) = found {
                node.str("type", r.w("type").unwrap_or_default());
                break;
            }
        }
        let first = e.descendants_named(W, "r").into_iter().next();
        if let Some(rp) = w_child(first, "rPr") {
            let rf = rp.child(W, "rFonts");
            if let Some(font) = rf.and_then(|f| f.w("ascii").or_else(|| f.w("hAnsi"))) {
                node.str("font", font);
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
            if let Some(cv) = color.and_then(|c| c.w("val")) {
                node.str("color", hex_color(cv));
            } else if let Some(theme) = color.and_then(|c| c.w("themeColor")) {
                node.str("color", theme);
            }
            if let Some(u) = w_val(rp.child(W, "u")) {
                node.str("underline", u);
            }
        }
        let first_p = e.children(W, "p").into_iter().next();
        if let Some(jc) = w_val(w_child(w_child(first_p, "pPr"), "jc")) {
            node.str("align", jc);
        }
        self.header_footer(e, node, path, depth)
    }

    /// Any element's node, as `ElementToNode` dispatches it.
    pub(super) fn element(&self, e: E<'_>, path: &str, depth: usize) -> Node {
        let node = Node::new(path, e.name());
        if e.ns() == W {
            match e.name() {
                "bookmarkStart" => return self.bookmark(e, node),
                "sectPr" => return self.section(e, path),
                "p" => return self.paragraph(e, node, path, depth),
                "r" => return self.run(e, node),
                "hyperlink" => return self.hyperlink(e, node),
                "tbl" => return self.table(e, node, path, depth),
                "tc" => return self.cell(e, node, path, depth),
                "tr" => return self.row(e, node, path, depth),
                "sdt" => return self.sdt(e, node),
                "hdr" | "ftr" => return self.header_footer(e, node, path, depth),
                "body" => return self.body_node(e, node, path, depth),
                _ => {}
            }
        }
        let mut node = node;
        if e.is(WPG, "wgp") {
            node.kind = "group".to_string();
            return node;
        }
        let mut attrs: Vec<_> = e.attrs().iter().collect();
        if e.is(W, "style") {
            attrs.sort_by_key(|a| rank(&a.name));
        }
        for a in attrs {
            node.str(&a.name, a.value.clone());
        }
        for c in e.elements() {
            if c.elements().next().is_some() {
                continue;
            }
            if let Some(val) = c
                .attrs()
                .iter()
                .find(|a| a.name.eq_ignore_ascii_case("val"))
            {
                node.str(c.name(), val.value.clone());
            }
        }
        let inner = e.text();
        if inner.is_empty() {
            node.preview = Some(clip(&outer_xml(e), 200));
        } else {
            node.text = Some(clip(&inner, 200));
        }
        node.child_count = e.elements().count();
        if depth > 0 {
            let mut counters: Vec<(String, usize)> = Vec::new();
            for c in e.elements() {
                let idx = match counters.iter_mut().find(|(n, _)| n == c.name()) {
                    Some(slot) => {
                        slot.1 += 1;
                        slot.1
                    }
                    None => {
                        counters.push((c.name().to_string(), 1));
                        1
                    }
                };
                node.children.push(self.element(
                    c,
                    &format!("{path}/{}[{idx}]", c.name()),
                    depth - 1,
                ));
            }
        }
        node
    }

    pub(super) fn style_node(&self, style: E<'_>, path: &str, id: &str) -> Node {
        let mut node = Node::new(path, "style");
        let name = w_val(style.child(W, "name"));
        node.text = Some(name.unwrap_or(id).to_string());
        node.str("id", style.w("styleId").unwrap_or_default());
        node.str("name", name.unwrap_or_default());
        let ty = style.w("type");
        if let Some(t) = ty {
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
        if let Some(next) = w_val(style.child(W, "next")) {
            node.str("next", next);
        }
        if let Some(link) = w_val(style.child(W, "link")) {
            node.str("linked", link);
        }
        if is_on(style.child(W, "autoRedefine")) {
            node.flag("autoRedefine");
        }
        if is_on(style.child(W, "hidden")) {
            node.flag("hidden");
        }
        node.set(
            "customStyle",
            Value::Bool(
                style
                    .w("customStyle")
                    .is_some_and(|c| on_off(Some(c)) == Some(true)),
            ),
        );
        if let Some(uip) = w_val(style.child(W, "uiPriority")).filter(|u| is_int(u)) {
            node.set("uiPriority", num_value(uip));
        }
        for el in ["semiHidden", "unhideWhenUsed", "qFormat", "locked"] {
            if is_on(style.child(W, el)) {
                node.flag(el);
            }
        }
        let rpr = style.child(W, "rPr");
        if let Some(rpr) = rpr {
            if let Some(rf) = rpr.child(W, "rFonts") {
                for (a, k) in [
                    ("ascii", "font.ascii"),
                    ("eastAsia", "font.ea"),
                    ("hAnsi", "font.hAnsi"),
                    ("cs", "font.cs"),
                    ("asciiTheme", "font.asciiTheme"),
                    ("hAnsiTheme", "font.hAnsiTheme"),
                    ("eastAsiaTheme", "font.eaTheme"),
                    ("cstheme", "font.csTheme"),
                ] {
                    if let Some(v) = rf.w(a) {
                        node.str(k, v);
                    }
                }
            }
            if let Some(sz) = half_points(w_val(rpr.child(W, "sz"))) {
                node.str("size", sz);
            }
            if let Some(sz) = half_points(w_val(rpr.child(W, "szCs"))) {
                node.str("size.cs", sz);
            }
            for (el, key) in [
                ("b", "bold"),
                ("bCs", "bold.cs"),
                ("i", "italic"),
                ("iCs", "italic.cs"),
            ] {
                if let Some(e) = rpr.child(W, el) {
                    node.set(key, Value::Bool(is_on(Some(e))));
                }
            }
            if let Some(c) = rpr.child(W, "color").and_then(color_with_theme_tail) {
                node.str("color", c);
            }
            let u = rpr.child(W, "u");
            if let Some(uv) = u.and_then(|u| u.w("val")) {
                node.str("underline", uv);
            }
            if let Some(uc) = u.and_then(|u| u.w("color")) {
                node.str("underline.color", hex_color(uc));
            }
            for (el, key) in [
                ("strike", "strike"),
                ("dstrike", "dstrike"),
                ("caps", "caps"),
                ("smallCaps", "smallCaps"),
                ("vanish", "vanish"),
            ] {
                if let Some(e) = rpr.child(W, el) {
                    node.set(key, Value::Bool(is_on(Some(e))));
                }
            }
            if let Some(rtl) = rpr.child(W, "rtl") {
                let on = on_off(rtl.w("val"));
                if ty == Some("character") {
                    node.str("direction", if on == Some(true) { "rtl" } else { "ltr" });
                } else if on == Some(true) {
                    node.str("direction", "rtl");
                }
                if let Some(on) = on {
                    node.set("rtl", Value::Bool(on));
                }
            }
            if let Some(hl) = w_val(rpr.child(W, "highlight")) {
                node.str("highlight", hl);
            }
            if let Some(fill) = rpr.child(W, "shd").and_then(|s| s.w("fill")) {
                node.str("shading", hex_color(fill));
            }
            if let Some(va) = w_val(rpr.child(W, "vertAlign")) {
                node.str("vertAlign", va);
            }
            if let Some(sp) = w_val(rpr.child(W, "spacing")).filter(|s| is_int(s)) {
                node.str("charSpacing", format!("{}pt", f2(jsn(sp) / 20.0)));
            }
            if let Some(lang) = rpr.child(W, "lang") {
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
        }
        let ppr = style.child(W, "pPr");
        if let Some(ppr) = ppr {
            if let Some(jc) = w_val(ppr.child(W, "jc")) {
                node.str("align", jc);
            }
            if let Some(bidi) = ppr.child(W, "bidi") {
                node.str(
                    "direction",
                    if on_off(bidi.w("val")) == Some(true) {
                        "rtl"
                    } else {
                        "ltr"
                    },
                );
            }
            if let Some(sp) = ppr.child(W, "spacing") {
                if let Some(b) = sp.w("before") {
                    node.str("spaceBefore", word_spacing(b, true));
                }
                if let Some(a) = sp.w("after") {
                    node.str("spaceAfter", word_spacing(a, true));
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
            }
            if let Some(ind) = ppr.child(W, "ind") {
                if let Some(fl) = ind.w("firstLine") {
                    node.str("firstLineIndent", word_spacing(fl, false));
                }
                if let Some(hg) = ind.w("hanging") {
                    node.str("hangingIndent", word_spacing(hg, false));
                }
                if let Some(left) = ind.w("left").or_else(|| ind.w("start")) {
                    node.str("leftIndent", word_spacing(left, false));
                }
                if let Some(right) = ind.w("right").or_else(|| ind.w("end")) {
                    node.str("rightIndent", word_spacing(right, false));
                }
            }
            if let Some(outline) = w_val(ppr.child(W, "outlineLvl")) {
                node.set("outlineLvl", num_value(outline));
            }
            for name in [
                "keepNext",
                "keepLines",
                "pageBreakBefore",
                "widowControl",
                "contextualSpacing",
            ] {
                if let Some(e) = ppr.child(W, name) {
                    node.set(name, Value::Bool(is_on(Some(e))));
                }
            }
            if let Some(shd) = ppr.child(W, "shd") {
                if let Some(v) = shd.w("val").filter(|v| !v.is_empty()) {
                    node.str("shading.val", v);
                }
                if let Some(f) = shd.w("fill").filter(|f| !f.is_empty()) {
                    node.str("shading.fill", hex_color(f));
                }
                if let Some(c) = shd.w("color").filter(|c| !c.is_empty()) {
                    node.str("shading.color", hex_color(c));
                }
            }
            if let Some(pbdr) = ppr.child(W, "pBdr") {
                for side in ["top", "bottom", "left", "right", "between", "bar"] {
                    read_border(pbdr.child(W, side), &format!("pbdr.{side}"), &mut node);
                }
            }
            let num_pr = ppr.child(W, "numPr");
            if let Some(nid) = w_val(w_child(num_pr, "numId")) {
                node.str("numId", num_text(nid));
            }
            if let Some(ilvl) = w_val(w_child(num_pr, "ilvl")) {
                node.str("ilvl", num_text(ilvl));
            }
        }
        fill_unknown(rpr, &mut node);
        fill_unknown(ppr, &mut node);
        node
    }
}
