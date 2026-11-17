// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! A table, its rows and cells, with their properties.

use super::super::node::{Node, Value};
use super::super::tree::{E, W, is_on, on_off};
use super::super::units::{half_points, hex_color};
use super::doc::Word;
use super::{
    is_digits, is_int, jsn, num_text, num_value, para_segment, pct_width, read_border, row_cells,
    safe_width, sdt_segment, shading_canonical, shading_theme, t_text, table_rows, w_child, w_val,
};

const LOOK_BITS: [(&str, u32); 6] = [
    ("firstRow", 0x20),
    ("lastRow", 0x40),
    ("firstColumn", 0x80),
    ("lastColumn", 0x100),
    ("noHBand", 0x200),
    ("noVBand", 0x400),
];

fn span_of(cell: Option<E<'_>>) -> f64 {
    jsn(w_val(w_child(w_child(cell, "tcPr"), "gridSpan")).unwrap_or("1"))
}

impl<'p> Word<'p> {
    pub(super) fn table(&self, table: E<'_>, mut node: Node, path: &str, depth: usize) -> Node {
        node.kind = "table".to_string();
        let rows = table_rows(table);
        node.child_count = rows.len();
        let grid_cols = table.child(W, "tblGrid").map(|g| g.children(W, "gridCol"));
        let cols = match &grid_cols {
            Some(g) => g.len(),
            None => rows.first().map_or(0, |r| row_cells(*r).len()),
        };
        node.str("cols", cols.to_string());
        node.str("rows", node.child_count.to_string());
        if let Some(tp) = table.child(W, "tblPr") {
            Self::table_props(tp, &mut node);
        }
        if let Some(g) = grid_cols.filter(|g| !g.is_empty()) {
            node.str(
                "colWidths",
                g.iter()
                    .map(|c| format!("{}dxa", c.w("w").unwrap_or("0")))
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
        if depth > 0 {
            for (ri, row) in rows.iter().enumerate() {
                let row_path = format!("{path}/tr[{}]", ri + 1);
                let mut row_node = Node::new(row_path.clone(), "row");
                let cells = row_cells(*row);
                row_node.child_count = cells.len();
                Self::row_props(*row, &mut row_node);
                if depth > 1 {
                    for (ci, cell) in cells.into_iter().enumerate() {
                        let cell_path = format!("{row_path}/tc[{}]", ci + 1);
                        row_node.children.push(self.cell(
                            cell,
                            Node::new(cell_path.clone(), ""),
                            &cell_path,
                            depth - 2,
                        ));
                    }
                }
                node.children.push(row_node);
            }
        }
        node
    }

    fn table_props(tp: E<'_>, node: &mut Node) {
        if let Some(style) = w_val(tp.child(W, "tblStyle")).filter(|s| !s.is_empty()) {
            node.str("style", style);
        }
        for c in tp.elements() {
            let key = match c.name() {
                "tblStyleRowBandSize" => "rowBandSize",
                "tblStyleColBandSize" => "colBandSize",
                _ => continue,
            };
            if let Some(v) = c.w("val").filter(|v| is_int(v)) {
                node.set(key, num_value(v));
            }
        }
        if let Some(borders) = tp.child(W, "tblBorders") {
            read_border(borders.child(W, "top"), "border.top", node);
            read_border(borders.child(W, "bottom"), "border.bottom", node);
            read_border(borders.child(W, "insideH"), "border.insideH", node);
            read_border(borders.child(W, "insideV"), "border.insideV", node);
            for b in borders.elements() {
                match b.name().to_lowercase().as_str() {
                    "left" | "start" => read_border(Some(b), "border.left", node),
                    "right" | "end" => read_border(Some(b), "border.right", node),
                    _ => {}
                }
            }
        }
        let tbl_w = tp.child(W, "tblW");
        let w_type = tbl_w.and_then(|t| t.w("type"));
        match safe_width(tbl_w.and_then(|t| t.w("w"))) {
            Some(width) => node.str(
                "width",
                match w_type {
                    Some("pct") => pct_width(width),
                    Some("auto") => "auto".to_string(),
                    _ => width.to_string(),
                },
            ),
            None if w_type == Some("auto") => node.str("width", "auto"),
            None => {}
        }
        if let Some(jc) = w_val(tp.child(W, "jc")).filter(|j| !j.is_empty()) {
            node.str("align", jc);
        }
        let ind = tp.child(W, "tblInd");
        if let Some(w) = safe_width(ind.and_then(|i| i.w("w"))) {
            if ind.and_then(|i| i.w("type")) == Some("pct") {
                node.str("indent", pct_width(w));
            } else {
                node.set("indent", Value::Int(w));
            }
        }
        if let Some(cs) = safe_width(tp.child(W, "tblCellSpacing").and_then(|c| c.w("w"))) {
            node.set("cellSpacing", Value::Int(cs));
        }
        if let Some(layout) = tp.child(W, "tblLayout").and_then(|l| l.w("type")) {
            node.str(
                "layout",
                if layout == "fixed" {
                    "fixed"
                } else {
                    "autofit"
                },
            );
        }
        let look = tp.child(W, "tblLook");
        if let Some(look) = look {
            match look.w("val").filter(|v| !v.is_empty()) {
                Some(lv) => {
                    let digits = lv.trim_start();
                    let end = digits.bytes().take_while(u8::is_ascii_hexdigit).count();
                    match u64::from_str_radix(&digits[..end], 16) {
                        Ok(bits) if end > 0 => node.str("tblLook", format!("{bits:04X}")),
                        _ => node.str("tblLook", lv),
                    }
                }
                None => {
                    let mut bits = 0u32;
                    for a in look.attrs() {
                        if a.value != "1" && a.value != "true" {
                            continue;
                        }
                        bits |= LOOK_BITS
                            .iter()
                            .find(|(n, _)| *n == a.name)
                            .map_or(0, |(_, b)| *b);
                    }
                    node.str("tblLook", format!("{bits:04X}"));
                }
            }
        }
        if let Some(bidi) = tp.child(W, "bidiVisual") {
            if !matches!(bidi.w("val"), Some("0" | "false" | "off")) {
                node.str("direction", "rtl");
            }
        }
        let dcm = tp.child(W, "tblCellMar");
        for (side, key) in [
            ("top", "padding.top"),
            ("bottom", "padding.bottom"),
            ("left", "padding.left"),
            ("right", "padding.right"),
        ] {
            if let Some(v) = safe_width(w_child(dcm, side).and_then(|s| s.w("w"))) {
                node.set(key, Value::Int(v));
            }
        }
        if let Some(tblp) = tp.child(W, "tblpPr") {
            for (a, k) in [
                ("horzAnchor", "tblp.horzAnchor"),
                ("vertAnchor", "tblp.vertAnchor"),
                ("tblpX", "tblp.tblpX"),
                ("tblpY", "tblp.tblpY"),
                ("tblpXSpec", "tblp.tblpXSpec"),
                ("tblpYSpec", "tblp.tblpYSpec"),
                ("leftFromText", "tblp.leftFromText"),
                ("rightFromText", "tblp.rightFromText"),
                ("topFromText", "tblp.topFromText"),
                ("bottomFromText", "tblp.bottomFromText"),
            ] {
                let Some(v) = tblp.w(a) else { continue };
                if is_int(v) && !a.ends_with("Anchor") && !a.ends_with("Spec") {
                    node.set(k, num_value(v));
                } else {
                    node.str(k, v);
                }
            }
        }
        if let Some(overlap) = w_val(tp.child(W, "tblOverlap")) {
            node.str("tblOverlap.val", overlap);
        }
        if let Some(shd) = tp.child(W, "shd") {
            if let Some(v) = shd.w("val").filter(|v| !v.is_empty()) {
                node.str("shading.val", v);
            }
            if let Some(f) = shd.w("fill").filter(|f| !f.is_empty()) {
                node.str("shading.fill", hex_color(f));
            }
            if let Some(c) = shd.w("color").filter(|c| !c.is_empty()) {
                node.str("shading.color", hex_color(c));
            }
            shading_theme(shd, node);
        }
        if let Some(look) = look {
            let on = |a: &str| look.w(a).map(|v| on_off(Some(v)) == Some(true));
            if on("firstRow") == Some(true) {
                node.flag("firstRow");
            }
            if on("lastRow") == Some(true) {
                node.flag("lastRow");
            }
            if on("firstColumn") == Some(true) {
                node.flag("firstCol");
            }
            if on("lastColumn") == Some(true) {
                node.flag("lastCol");
            }
            if on("noHBand") == Some(false) {
                node.flag("bandedRows");
            }
            if on("noVBand") == Some(false) {
                node.flag("bandedCols");
            }
        }
        if let Some(c) = w_val(tp.child(W, "tblCaption")).filter(|c| !c.is_empty()) {
            node.str("caption", c);
        }
        if let Some(d) = w_val(tp.child(W, "tblDescription")).filter(|d| !d.is_empty()) {
            node.str("description", d);
        }
    }

    pub(super) fn row_props(row: E<'_>, node: &mut Node) {
        let Some(trpr) = row.child(W, "trPr") else {
            return;
        };
        let rh = trpr.child(W, "trHeight");
        if let Some(raw) = rh.and_then(|r| r.w("val")).filter(|r| !r.is_empty()) {
            let n = if is_int(raw) {
                jsn(raw)
            } else {
                js_round(jsn(raw))
            };
            if !n.is_nan() {
                node.str(
                    "height",
                    format!("{}dxa", super::super::node::number_text(n)),
                );
                match rh.and_then(|r| r.w("hRule")) {
                    Some("exact") => node.str("height.rule", "exact"),
                    Some("atLeast") => node.str("height.rule", "atLeast"),
                    _ => {}
                }
            }
        }
        for (el, key) in [
            ("tblHeader", "header"),
            ("cantSplit", "cantSplit"),
            ("hidden", "hidden"),
        ] {
            if is_on(trpr.child(W, el)) {
                node.flag(key);
            }
        }
        if let Some(jc) =
            w_val(trpr.child(W, "jc")).filter(|j| matches!(*j, "center" | "right" | "left"))
        {
            node.str("rowAlign", jc);
        }
        if let Some(cnf) = w_val(trpr.child(W, "cnfStyle")).filter(|c| !c.is_empty()) {
            node.str("cnfStyle", cnf);
        }
        if let Some(gb) = w_val(trpr.child(W, "gridBefore")) {
            node.str("gridBefore", num_text(gb));
        }
        if let Some(ga) = w_val(trpr.child(W, "gridAfter")) {
            node.str("gridAfter", num_text(ga));
        }
    }

    pub(super) fn cell(&self, cell: E<'_>, mut node: Node, path: &str, depth: usize) -> Node {
        node.kind = "cell".to_string();
        node.text = Some(t_text(cell));
        node.child_count = cell
            .elements()
            .filter(|e| e.is(W, "p") || e.is(W, "tbl") || e.is(W, "sdt"))
            .count();
        Self::cell_props(cell, &mut node);
        if depth > 0 {
            let (mut p, mut t, mut s) = (0, 0, 0);
            for c in cell.elements() {
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

    fn cell_props(cell: E<'_>, node: &mut Node) {
        let tcpr = cell.child(W, "tcPr");
        if let Some(tcpr) = tcpr {
            if let Some(cb) = tcpr.child(W, "tcBorders") {
                read_border(cb.child(W, "top"), "border.top", node);
                read_border(cb.child(W, "bottom"), "border.bottom", node);
                read_border(
                    cb.child(W, "left").or_else(|| cb.child(W, "start")),
                    "border.left",
                    node,
                );
                read_border(
                    cb.child(W, "right").or_else(|| cb.child(W, "end")),
                    "border.right",
                    node,
                );
                read_border(cb.child(W, "tl2br"), "border.tl2br", node);
                read_border(cb.child(W, "tr2bl"), "border.tr2bl", node);
            }
            if let Some(shd) = tcpr.child(W, "shd") {
                shading_canonical(shd, node);
            }
            let tcw = tcpr.child(W, "tcW");
            if let Some(cw) = safe_width(tcw.and_then(|t| t.w("w"))) {
                node.str(
                    "width",
                    match tcw.and_then(|t| t.w("type")) {
                        Some("nil") => "nil".to_string(),
                        Some("pct") => pct_width(cw),
                        Some("auto") => "auto".to_string(),
                        _ => format!("{cw}dxa"),
                    },
                );
            }
            if let Some(va) = w_val(tcpr.child(W, "vAlign")) {
                node.str("valign", va);
            }
            if let Some(vm) = tcpr.child(W, "vMerge") {
                node.str(
                    "vmerge",
                    if vm.w("val") == Some("restart") {
                        "restart"
                    } else {
                        "continue"
                    },
                );
            }
            if let Some(hm) = tcpr.child(W, "hMerge") {
                node.str(
                    "hmerge",
                    if hm.w("val") == Some("restart") {
                        "restart"
                    } else {
                        "continue"
                    },
                );
            }
            let span = span_of(Some(cell));
            if span > 1.0 {
                node.set("colspan", super::float_value(span));
            }
            if let Some(mar) = tcpr.child(W, "tcMar") {
                for (sides, key) in [
                    (&["top"][..], "padding.top"),
                    (&["bottom"][..], "padding.bottom"),
                    (&["left", "start"][..], "padding.left"),
                    (&["right", "end"][..], "padding.right"),
                ] {
                    for s in sides {
                        let side = mar.child(W, s);
                        if let Some(v) = safe_width(side.and_then(|x| x.w("w"))) {
                            node.set(key, Value::Int(v));
                            break;
                        }
                        if side.is_some() {
                            break;
                        }
                    }
                }
            }
            if let Some(td) = w_val(tcpr.child(W, "textDirection")) {
                node.str("textDirection", td);
            }
            if is_on(tcpr.child(W, "noWrap")) {
                node.flag("nowrap");
            }
            if let Some(cnf) = w_val(tcpr.child(W, "cnfStyle")).filter(|c| !c.is_empty()) {
                node.str("cnfStyle", cnf);
            }
            if is_on(tcpr.child(W, "hideMark")) {
                node.flag("hideMark");
            }
        }
        if !node.has("width") {
            let table = cell.ancestor(W, "tbl");
            if let (Some(table), Some(row)) = (table, cell.parent().filter(|r| r.is(W, "tr"))) {
                let cells = row_cells(row);
                if let Some(at) = cells.iter().position(|c| *c == cell) {
                    let col: f64 = cells[..at].iter().map(|c| span_of(Some(*c))).sum();
                    let grid = table
                        .child(W, "tblGrid")
                        .map(|g| g.children(W, "gridCol"))
                        .unwrap_or_default();
                    if col < grid.len() as f64 {
                        let span = span_of(Some(cell));
                        let end = (col + span).min(grid.len() as f64);
                        let mut total = 0f64;
                        let mut g = col;
                        while g < end {
                            if let Some(w) = grid
                                .get(g as usize)
                                .and_then(|x| x.w("w"))
                                .filter(|w| is_digits(w))
                            {
                                total += jsn(w);
                            }
                            g += 1.0;
                        }
                        if total > 0.0 {
                            node.str(
                                "width",
                                format!("{}dxa", super::super::node::number_text(total)),
                            );
                            node.flag("_widthDerived");
                        }
                    }
                }
            }
        }
        let first_para = cell.children(W, "p").into_iter().next();
        let ppr = w_child(first_para, "pPr");
        if let Some(just) = w_val(w_child(ppr, "jc")) {
            node.str("align", just);
        }
        if w_child(ppr, "bidi").is_some()
            || w_child(w_child(cell.ancestor(W, "tbl"), "tblPr"), "bidiVisual").is_some()
        {
            node.str("direction", "rtl");
        }
        let first_run = cell.descendants_named(W, "r").into_iter().next();
        let Some(rpr) = w_child(first_run, "rPr") else {
            return;
        };
        if let Some(ascii) = rpr.child(W, "rFonts").and_then(|f| f.w("ascii")) {
            node.str("font", ascii);
        }
        if let Some(sz) = half_points(w_val(rpr.child(W, "sz"))) {
            node.str("size", sz);
        }
        if let Some(b) = rpr.child(W, "b") {
            node.set("bold", Value::Bool(is_on(Some(b))));
        }
        if let Some(i) = rpr.child(W, "i") {
            node.set("italic", Value::Bool(is_on(Some(i))));
        }
        let color = rpr.child(W, "color");
        if let Some(cv) = color.and_then(|c| c.w("val")) {
            node.str("color", hex_color(cv));
        } else if let Some(theme) = color.and_then(|c| c.w("themeColor")) {
            node.str("color", theme);
        }
        let u = rpr.child(W, "u");
        if let Some(uv) = u.and_then(|u| u.w("val")) {
            node.str("underline", uv);
        }
        if let Some(uc) = u.and_then(|u| u.w("color")) {
            node.str("underline.color", hex_color(uc));
        }
        if let Some(s) = rpr.child(W, "strike") {
            node.set("strike", Value::Bool(is_on(Some(s))));
        }
        if let Some(hl) = w_val(rpr.child(W, "highlight")) {
            node.str("highlight", hl);
        }
    }

    pub(super) fn row(&self, row: E<'_>, mut node: Node, path: &str, depth: usize) -> Node {
        node.kind = "row".to_string();
        let cells = row_cells(row);
        node.child_count = cells.len();
        Self::row_props(row, &mut node);
        if depth > 0 {
            for (ci, cell) in cells.into_iter().enumerate() {
                let cell_path = format!("{path}/tc[{}]", ci + 1);
                node.children.push(self.cell(
                    cell,
                    Node::new(cell_path.clone(), ""),
                    &cell_path,
                    depth - 1,
                ));
            }
        }
        node
    }
}

/// `Math.round`: half up toward positive infinity.
fn js_round(n: f64) -> f64 {
    (n + 0.5).floor()
}
