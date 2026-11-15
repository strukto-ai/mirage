// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! The nodes a slide's content becomes: shapes with their paragraphs and
//! runs, pictures, tables with their rows and cells, connectors, groups,
//! SmartArt and chart frames, each with the properties OfficeCLI shows.

use super::super::node::{Node, Value};
use super::super::tree::{A, E, P, R, outer_xml};
use super::super::units::{f2, fmt, format_emu, format_emu_lossy, format_line_width, hex_color};
use super::color::{
    HANDLED_EFFECTS, bevel_spec, glow_spec, gradient_string, gradient_tuned, plain_inner_shadow,
    plain_outer_shadow, plain_reflection, points_of, read_color, read_highlight, reflection_name,
    rotation, shadow_spec,
};
use super::deck::{Deck, Slide};
use super::motion::animations;
use super::tables::{cell_borders, rich_cell_body, table_borders, table_style_name};
use super::text::{
    align_name, break_props, bullets, cap_name, cell_text, custom_path, dynamic_field,
    indent_points, outline, run_text, shape_name, shape_text, spacing, strike_name, tabs,
    text_direction, underline_detail, underline_name, unknown_run_props,
};
use super::{
    A14, boolean, cnvpr_of, content_kids, creation_id, id_of, int, is_hidden, is_title_shape, long,
    nv_of, ph_of, ph_type, placeholder_type_name, segment, zorder,
};

fn bool_key(v: Option<&str>) -> &'static str {
    match boolean(v) {
        None => "(unset)",
        Some(true) => "1",
        Some(false) => "0",
    }
}

fn guides(geom: E<'_>) -> Option<String> {
    let av = geom.child(A, "avLst")?;
    let list: Vec<String> = av
        .children(A, "gd")
        .into_iter()
        .filter_map(|g| Some(format!("{}:{}", g.attr("name")?, g.attr("fmla")?)))
        .collect();
    (!list.is_empty()).then(|| list.join(","))
}

fn rect_list(e: E<'_>) -> Option<String> {
    let v: Vec<Option<i64>> = ["l", "t", "r", "b"]
        .iter()
        .map(|k| int(e.attr(k)))
        .collect();
    v.iter().any(Option::is_some).then(|| {
        v.iter()
            .map(|x| x.unwrap_or(0).to_string())
            .collect::<Vec<_>>()
            .join(",")
    })
}

impl<'p> Deck<'p> {
    /// A transform's offset and extent onto `node`.
    pub(super) fn frame(xfrm: Option<E<'_>>, node: &mut Node, lossy: bool) {
        let f = if lossy { format_emu_lossy } else { format_emu };
        let off = xfrm.and_then(|x| x.child(A, "off"));
        let ext = xfrm.and_then(|x| x.child(A, "ext"));
        if let Some(off) = off {
            if let Some(x) = long(off.attr("x")) {
                node.str("x", f(x));
            }
            if let Some(y) = long(off.attr("y")) {
                node.str("y", f(y));
            }
        }
        if let Some(ext) = ext {
            if let Some(cx) = long(ext.attr("cx")) {
                node.str("width", f(cx));
            }
            if let Some(cy) = long(ext.attr("cy")) {
                node.str("height", f(cy));
            }
        }
    }

    pub(super) fn shape_node(
        &self,
        shape: E<'_>,
        slide_num: usize,
        index: usize,
        depth: usize,
        slide: Option<Slide<'_>>,
        prefix: Option<&str>,
    ) -> Node {
        let text = shape_text(shape);
        let name = shape_name(shape);
        let title = is_title_shape(shape);
        let body = shape.child(P, "txBody");
        let equation = !title
            && body.is_some_and(|b| {
                b.descendants().iter().any(|d| {
                    d.name() == "oMath"
                        || d.name() == "oMathPara"
                        || (d.name() == "m" && d.ns() == A14)
                })
            });
        let ph = ph_of(shape);
        let base = prefix.map_or_else(|| format!("/slide[{slide_num}]"), str::to_string);
        let path = format!("{base}/{}", segment("shape", shape, index));
        let text_box = boolean(
            nv_of(shape)
                .and_then(|n| n.child(P, "cNvSpPr"))
                .and_then(|c| c.attr("txBox")),
        ) == Some(true);
        let kind = if title {
            "title"
        } else if equation {
            "equation"
        } else if ph.is_some() {
            "placeholder"
        } else if text_box {
            "textbox"
        } else {
            "shape"
        };
        let mut node = Node::new(path.clone(), kind);
        node.preview = Some(if text.is_empty() {
            name.clone()
        } else if text.encode_utf16().count() > 50 {
            let cut: Vec<u16> = text.encode_utf16().take(50).collect();
            format!("{}...", String::from_utf16_lossy(&cut))
        } else {
            text.clone()
        });
        node.text = Some(text);
        if is_hidden(shape) {
            node.set("hidden", Value::Bool(true));
        }
        node.str("name", name);
        if let Some(ph) = ph {
            node.str("phType", placeholder_type_name(ph_type(Some(ph))));
        }
        let ph_idx = long(ph.and_then(|p| p.attr("idx")));
        if let Some(i) = ph_idx {
            node.set("phIndex", Value::Int(i));
        }
        if ph.is_some() && ph_type(ph).is_none() && ph_idx.is_none() {
            node.str("phBare", "true");
        }
        let locks = nv_of(shape)
            .and_then(|n| n.child(P, "cNvSpPr"))
            .and_then(|c| c.child(A, "spLocks"));
        if boolean(locks.and_then(|l| l.attr("noGrp"))) == Some(true) {
            node.set("noGrp", Value::Bool(true));
        }
        if let Some(body) = body {
            let mut dynamic = false;
            let mut unevaluated = false;
            for fld in body.descendants_named(A, "fld") {
                if !dynamic_field(fld.attr("type").unwrap_or_default()) {
                    continue;
                }
                dynamic = true;
                if fld.children(A, "t").iter().all(|t| t.text().is_empty()) {
                    unevaluated = true;
                    break;
                }
            }
            if dynamic {
                node.set("evaluated", Value::Bool(!unevaluated));
            }
        }
        if let Some(alt) = cnvpr_of(shape)
            .and_then(|c| c.attr("descr"))
            .filter(|a| !a.is_empty())
        {
            node.str("alt", alt);
        }
        if let Some(id) = id_of(shape) {
            node.set("id", Value::Int(id));
        }
        if let Some(cid) = creation_id(shape) {
            node.str("extLst.creationId", cid);
        }
        node.set("isTitle", Value::Bool(title));
        let sppr = shape.child(P, "spPr");
        let xfrm = sppr.and_then(|s| s.child(A, "xfrm"));
        Self::frame(xfrm, &mut node, false);
        if let (Some(ph), Some(slide)) = (ph, slide) {
            if !Self::complete(xfrm) {
                self.inherited_frame(ph, slide, &mut node);
            }
        }
        let solid = sppr.and_then(|s| s.child(A, "solidFill"));
        if let Some(fill) = read_color(solid) {
            node.str("fill", fill);
        }
        if sppr.and_then(|s| s.child(A, "noFill")).is_some() {
            node.str("fill", "none");
        }
        let fill_color =
            solid.and_then(|s| s.child(A, "srgbClr").or_else(|| s.child(A, "schemeClr")));
        if let Some(alpha) = int(fill_color
            .and_then(|c| c.child(A, "alpha"))
            .and_then(|a| a.attr("val")))
        {
            node.str("opacity", f2(alpha as f64 / 100_000.0));
        }
        let preset = sppr.and_then(|s| s.child(A, "prstGeom"));
        if let Some(prst) = preset.and_then(|p| p.attr("prst")) {
            node.str("geometry", prst);
            if let Some(adj) = preset.and_then(guides) {
                node.str("adj", adj);
            }
        } else if let Some(cust) = sppr.and_then(|s| s.child(A, "custGeom")) {
            node.str("geometry", "custom");
            node.str("customPath", custom_path(cust));
            node.str("customGeometryXml", outer_xml(cust));
        }
        if let Some(grad) = sppr.and_then(|s| s.child(A, "gradFill")) {
            node.str("gradient", gradient_string(grad));
            if !node.has("fill") {
                node.str("fill", "gradient");
            }
            if gradient_tuned(grad) {
                node.str("gradientRaw", outer_xml(grad));
            }
        }
        if let Some(blip) = sppr.and_then(|s| s.child(A, "blipFill")) {
            node.str("image", "true");
            let embed = blip
                .child(A, "blip")
                .and_then(|b| b.attr_ns("embed", R))
                .filter(|e| !e.is_empty());
            if let (Some(embed), Some(slide)) = (embed, slide) {
                if let Some(file) = self.file_name(slide.part, embed).filter(|f| !f.is_empty()) {
                    node.str("image.src", file);
                }
            }
            if let Some(v) = blip.child(A, "srcRect").and_then(rect_list) {
                node.str("srcRect", v);
            }
            if let Some(v) = blip
                .child(A, "stretch")
                .and_then(|s| s.child(A, "fillRect"))
                .and_then(rect_list)
            {
                node.str("fillRect", v);
            }
        }
        if let Some(pattern) = sppr.and_then(|s| s.child(A, "pattFill")) {
            let p = pattern.attr("prst").unwrap_or_default();
            let side = |e: Option<E<'_>>| -> String {
                if let Some(hex) = e
                    .and_then(|e| e.child(A, "srgbClr"))
                    .and_then(|c| c.attr("val"))
                {
                    return hex_color(hex);
                }
                e.and_then(|e| e.child(A, "schemeClr"))
                    .and_then(|c| c.attr("val"))
                    .unwrap_or_default()
                    .to_string()
            };
            let fg = side(pattern.child(A, "fgClr"));
            let bg = side(pattern.child(A, "bgClr"));
            node.str(
                "pattern",
                if bg.is_empty() {
                    format!("{p}:{fg}")
                } else {
                    format!("{p}:{fg}:{bg}")
                },
            );
            if !node.has("fill") {
                node.str("fill", "pattern");
            }
        }
        let paras = body.map(|b| b.children(A, "p")).unwrap_or_default();
        let first_ppr = paras.first().and_then(|p| p.child(A, "pPr"));
        if let Some(ppr) = first_ppr {
            bullets(ppr, &mut node);
        }
        let runs = body
            .map(|b| b.descendants_named(A, "r"))
            .unwrap_or_default();
        let (mut mixed_size, mut mixed_color, mut mixed_bold, mut mixed_italic) =
            (false, false, false, false);
        if runs.len() > 1 {
            let size = |r: E<'_>| {
                int(r.child(A, "rPr").and_then(|p| p.attr("sz")))
                    .map_or("(unset)".to_string(), |s| s.to_string())
            };
            let color = |r: E<'_>| {
                read_color(r.child(A, "rPr").and_then(|p| p.child(A, "solidFill")))
                    .unwrap_or_else(|| "(unset)".to_string())
            };
            let b = |r: E<'_>| bool_key(r.child(A, "rPr").and_then(|p| p.attr("b")));
            let i = |r: E<'_>| bool_key(r.child(A, "rPr").and_then(|p| p.attr("i")));
            let first = runs[0];
            for r in &runs[1..] {
                mixed_size |= size(*r) != size(first);
                mixed_color |= color(*r) != color(first);
                mixed_bold |= b(*r) != b(first);
                mixed_italic |= i(*r) != i(first);
            }
        }
        if let Some(rpr) = runs.first().and_then(|r| r.child(A, "rPr")) {
            let face = |c: &str| rpr.child(A, c).and_then(|x| x.attr("typeface"));
            if let Some(latin) = face("latin") {
                node.str("font", latin);
                node.str("font.latin", latin);
            }
            if let Some(ea) = face("ea") {
                node.str("font.ea", ea);
            }
            if let Some(cs) = face("cs") {
                node.str("font.cs", cs);
            }
            if let Some(sz) = int(rpr.attr("sz")).filter(|_| !mixed_size) {
                node.str("size", format!("{}pt", f2(sz as f64 / 100.0)));
            }
            if let Some(b) = boolean(rpr.attr("b")).filter(|_| !mixed_bold) {
                node.set("bold", Value::Bool(b));
            }
            if let Some(i) = boolean(rpr.attr("i")).filter(|_| !mixed_italic) {
                node.set("italic", Value::Bool(i));
            }
            if let Some(cap) = rpr.attr("cap").filter(|c| *c != "none") {
                node.str("cap", cap);
            }
            if let Some(u) = rpr.attr("u").filter(|u| *u != "none") {
                node.str("underline", underline_name(u));
            }
            underline_detail(rpr, &mut node);
            if let Some(ln) = rpr.child(A, "ln") {
                outline(ln, &mut node);
            }
            if let Some(s) = rpr.attr("strike") {
                node.str("strike", strike_name(s));
            }
            if let Some(h) = read_highlight(rpr.child(A, "highlight")) {
                node.str("highlight", h);
            }
            if let Some(spc) = int(rpr.attr("spc")) {
                node.str("spacing", f2(spc as f64 / 100.0));
            }
            if let Some(c) = read_color(rpr.child(A, "solidFill")).filter(|_| !mixed_color) {
                node.str("color", c);
            }
            if let Some(g) = rpr.child(A, "gradFill") {
                node.str("textFill", gradient_string(g));
            }
            if let Some(slide) = slide {
                let h = rpr.child(A, "hlinkClick");
                if let Some(link) = self.hyperlink(h, slide.part) {
                    node.str("link", link);
                }
                if let Some(tip) = h.and_then(|h| h.attr("tooltip")).filter(|t| !t.is_empty()) {
                    node.str("tooltip", tip);
                }
            }
            unknown_run_props(Some(rpr), &mut node, true);
        } else if let Some(end) = paras.first().and_then(|p| p.child(A, "endParaRPr")) {
            let face = |c: &str| end.child(A, c).and_then(|x| x.attr("typeface"));
            if let Some(latin) = face("latin") {
                node.str("font", latin);
                node.str("font.latin", latin);
            }
            if let Some(ea) = face("ea") {
                node.str("font.ea", ea);
            }
            if let Some(cs) = face("cs") {
                node.str("font.cs", cs);
            }
            if let Some(sz) = int(end.attr("sz")) {
                node.str("size", format!("{}pt", f2(sz as f64 / 100.0)));
            }
            if let Some(b) = boolean(end.attr("b")) {
                node.set("bold", Value::Bool(b));
            }
            if let Some(i) = boolean(end.attr("i")) {
                node.set("italic", Value::Bool(i));
            }
            if let Some(u) = end.attr("u").filter(|u| *u != "none") {
                node.str("underline", underline_name(u));
            }
            if let Some(s) = end.attr("strike") {
                node.str("strike", strike_name(s));
            }
            if let Some(cap) = end.attr("cap").filter(|c| *c != "none") {
                node.str("cap", cap);
            }
            if let Some(c) = read_color(end.child(A, "solidFill")) {
                node.str("color", c);
            }
        }
        if let Some(slide) = slide {
            if !node.has("link") {
                let h = cnvpr_of(shape).and_then(|c| c.child(A, "hlinkClick"));
                if let Some(link) = self.hyperlink(h, slide.part) {
                    node.str("link", link);
                }
                if let Some(tip) = h.and_then(|h| h.attr("tooltip")).filter(|t| !t.is_empty()) {
                    if !node.has("tooltip") {
                        node.str("tooltip", tip);
                    }
                }
            }
        }
        if let Some(ln) = sppr.and_then(|s| s.child(A, "ln")) {
            Self::line_props(ln, &mut node);
        }
        Self::effects(sppr, &mut node);
        if let Some(scene) = sppr.and_then(|s| s.child(A, "scene3d")) {
            let cam = scene.child(A, "camera");
            if let Some(rot) = cam.and_then(|c| c.child(A, "rot")) {
                let v = |k: &str| int(rot.attr(k)).unwrap_or(0);
                let (rx, ry, rz) = (v("lat"), v("lon"), v("rev"));
                if rx != 0 || ry != 0 || rz != 0 {
                    node.str(
                        "rot3d",
                        format!(
                            "{},{},{}",
                            f2(rx as f64 / 60_000.0),
                            f2(ry as f64 / 60_000.0),
                            f2(rz as f64 / 60_000.0)
                        ),
                    );
                }
            }
            if let Some(p) = cam.and_then(|c| c.attr("prst")) {
                node.str("camera", p);
            }
            let rig = scene.child(A, "lightRig");
            if let Some(r) = rig.and_then(|r| r.attr("rig")) {
                node.str("lighting", r);
            }
            if let Some(d) = rig.and_then(|r| r.attr("dir")) {
                node.str("lightingDir", d);
            }
            if let Some(lrot) = rig.and_then(|r| r.child(A, "rot")) {
                let v = |k: &str| int(lrot.attr(k)).unwrap_or(0);
                node.str(
                    "lightingRot",
                    format!("{}:{}:{}", v("lat"), v("lon"), v("rev")),
                );
            }
        }
        if let Some(sp3d) = sppr.and_then(|s| s.child(A, "sp3d")) {
            if let Some(h) = long(sp3d.attr("extrusionH")).filter(|h| *h != 0) {
                node.str("depth", points_of(h));
            }
            if let Some(m) = sp3d.attr("prstMaterial") {
                node.str("material", m);
            }
            if let Some(b) = sp3d.child(A, "bevelT") {
                node.str("bevel", bevel_spec(b));
            }
            if let Some(b) = sp3d.child(A, "bevelB") {
                node.str("bevelBottom", bevel_spec(b));
            }
            if let Some(c) = read_color(sp3d.child(A, "extrusionClr")).filter(|c| !c.is_empty()) {
                node.str("extrusionColor", c);
            }
            if let Some(c) = read_color(sp3d.child(A, "contourClr")).filter(|c| !c.is_empty()) {
                node.str("contourColor", c);
            }
        }
        if boolean(xfrm.and_then(|x| x.attr("flipH"))) == Some(true) {
            node.set("flipH", Value::Bool(true));
        }
        if boolean(xfrm.and_then(|x| x.attr("flipV"))) == Some(true) {
            node.set("flipV", Value::Bool(true));
        }
        zorder(shape, &mut node);
        if let Some(rot) = int(xfrm.and_then(|x| x.attr("rot"))).filter(|r| *r != 0) {
            node.str("rotation", rotation(rot, 6));
        }
        if let Some(body_pr) = body.and_then(|b| b.child(A, "bodyPr")) {
            Self::body_props(body_pr, &mut node);
        }
        if let Some(lst) = body.and_then(|b| b.child(A, "lstStyle")) {
            if lst.elements().next().is_some() {
                node.str("lstStyleRaw", outer_xml(lst));
            }
        }
        if let Some(algn) = first_ppr.and_then(|p| p.attr("algn")) {
            node.str("align", align_name(Some(algn)));
        }
        if let Some(ppr) = first_ppr {
            spacing(Some(ppr), &mut node);
            if let Some(v) = long(ppr.attr("indent")) {
                node.str("indent", indent_points(v));
            }
            if let Some(v) = long(ppr.attr("marL")) {
                node.str("marginLeft", indent_points(v));
            }
            if let Some(v) = long(ppr.attr("marR")) {
                node.str("marginRight", indent_points(v));
            }
            if let Some(rtl) = boolean(ppr.attr("rtl")) {
                node.str("direction", if rtl { "rtl" } else { "ltr" });
            }
            break_props(Some(ppr), &mut node);
        }
        if let Some(slide) = slide {
            if !node.has("direction") {
                if let Some(rtl) =
                    self.inherited_direction(slide.part, ph.and_then(|p| ph_type(Some(p))), title)
                {
                    node.str("effective.direction", if rtl { "rtl" } else { "ltr" });
                }
            }
        }
        if body.is_some() {
            node.child_count = paras.len();
            if depth > 0 {
                for (i, para) in paras.iter().enumerate() {
                    let child = self.paragraph_node(
                        shape,
                        *para,
                        &format!("{path}/paragraph[{}]", i + 1),
                        depth,
                        slide,
                    );
                    node.children.push(child);
                }
            }
        }
        if let Some(slide) = slide {
            if let Some(root) = self.root_of(slide.part) {
                animations(root, shape, &mut node, false);
            }
            let level = int(first_ppr.and_then(|p| p.attr("lvl"))).unwrap_or(0) as usize;
            let r = self.resolve(shape, slide, level, None, first_ppr);
            r.emit_run(&mut node);
            r.emit_paragraph(&mut node);
        }
        node
    }

    pub(super) fn paragraph_node(
        &self,
        shape: E<'_>,
        para: E<'_>,
        path: &str,
        depth: usize,
        slide: Option<Slide<'_>>,
    ) -> Node {
        let runs = para.children(A, "r");
        let mut node = Node::new(path, "paragraph");
        node.text = Some(runs.iter().map(|r| run_text(*r)).collect());
        node.child_count = runs.len();
        let ppr = para.child(A, "pPr");
        if let Some(algn) = ppr.and_then(|p| p.attr("algn")) {
            node.str("align", align_name(Some(algn)));
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
                node.str(key, indent_points(v));
            }
        }
        if let Some(ppr) = ppr {
            bullets(ppr, &mut node);
            if let Some(t) = tabs(ppr) {
                node.str("tabs", t);
            }
            if let Some(def) = ppr.child(A, "defRPr") {
                node.str("defRPrRaw", outer_xml(def));
            }
        }
        if let Some(rtl) = boolean(ppr.and_then(|p| p.attr("rtl"))) {
            node.str("direction", if rtl { "rtl" } else { "ltr" });
        }
        break_props(ppr, &mut node);
        spacing(ppr, &mut node);
        if runs.is_empty() {
            if let Some(sz) = int(para.child(A, "endParaRPr").and_then(|e| e.attr("sz"))) {
                node.str("size", format!("{}pt", f2(sz as f64 / 100.0)));
            }
        }
        if depth > 1 {
            let (mut run, mut br) = (0, 0);
            for c in para.elements() {
                if c.is(A, "r") {
                    run += 1;
                    node.children.push(self.run_node(
                        c,
                        &format!("{path}/run[{run}]"),
                        slide,
                        slide.map(|s| s.part),
                    ));
                } else if c.is(A, "br") {
                    br += 1;
                    let mut b = Node::new(format!("{path}/linebreak[{br}]"), "linebreak");
                    b.text = Some(String::new());
                    if let Some(rpr) = c.child(A, "rPr") {
                        b.str("rPrRaw", outer_xml(rpr));
                    }
                    node.children.push(b);
                }
            }
        }
        if let Some(slide) = slide {
            let level = int(ppr.and_then(|p| p.attr("lvl"))).unwrap_or(0) as usize;
            self.resolve(shape, slide, level, None, ppr)
                .emit_paragraph(&mut node);
        }
        node
    }

    pub(super) fn run_node(
        &self,
        run: E<'_>,
        path: &str,
        slide: Option<Slide<'_>>,
        link_part: Option<&str>,
    ) -> Node {
        let mut node = Node::new(path, "run");
        node.text = Some(run_text(run));
        let rpr = run.child(A, "rPr");
        if let Some(rpr) = rpr {
            let face = |c: &str| rpr.child(A, c).and_then(|x| x.attr("typeface"));
            if let Some(v) = face("latin") {
                node.str("font.latin", v);
            }
            if let Some(v) = face("ea") {
                node.str("font.ea", v);
            }
            if let Some(v) = face("cs") {
                node.str("font.cs", v);
            }
            if let Some(sz) = int(rpr.attr("sz")) {
                node.str("size", format!("{}pt", f2(sz as f64 / 100.0)));
            }
            if let Some(b) = boolean(rpr.attr("b")) {
                node.set("bold", Value::Bool(b));
            }
            if let Some(i) = boolean(rpr.attr("i")) {
                node.set("italic", Value::Bool(i));
            }
            if let Some(rtl) = rpr
                .attrs()
                .iter()
                .find(|a| a.name == "rtl" && !a.value.is_empty())
            {
                node.str(
                    "rtl",
                    if rtl.value == "1" || rtl.value == "true" {
                        "true"
                    } else {
                        "false"
                    },
                );
            }
            if let Some(u) = rpr.attr("u").filter(|u| *u != "none") {
                node.str("underline", underline_name(u));
            }
            underline_detail(rpr, &mut node);
            if let Some(s) = rpr.attr("strike") {
                node.str("strike", strike_name(s));
            }
            if let Some(spc) = int(rpr.attr("spc")) {
                node.str("spacing", f2(spc as f64 / 100.0));
            }
            if let Some(b) = int(rpr.attr("baseline")).filter(|b| *b != 0) {
                node.str("baseline", format!("{}%", f2(b as f64 / 1000.0)));
            }
            if let Some(c) = read_color(rpr.child(A, "solidFill")) {
                node.str("color", c);
            }
            if let Some(g) = rpr.child(A, "gradFill") {
                node.str("textFill", gradient_string(g));
            }
            if let Some(h) = read_highlight(rpr.child(A, "highlight")) {
                node.str("highlight", h);
            }
            if let Some(part) = link_part {
                let h = rpr.child(A, "hlinkClick");
                if let Some(link) = self.hyperlink(h, part) {
                    node.str("link", link);
                }
                if let Some(tip) = h.and_then(|h| h.attr("tooltip")).filter(|t| !t.is_empty()) {
                    node.str("tooltip", tip);
                }
            }
            if let Some(effects) = rpr.child(A, "effectLst") {
                if let Some(s) = effects.child(A, "outerShdw") {
                    node.str("shadow", shadow_spec(s, "100"));
                }
                if let Some(g) = effects.child(A, "glow") {
                    node.str("glow", glow_spec(g, "100"));
                }
                if let Some(r) = effects.child(A, "reflection") {
                    node.str("reflection", reflection_name(r));
                }
                if let Some(rad) = long(effects.child(A, "softEdge").and_then(|s| s.attr("rad"))) {
                    node.str("softEdge", format!("{}pt", points_of(rad)));
                }
                if let Some(o) = effects.child(A, "fillOverlay") {
                    node.str("fillOverlayRaw", outer_xml(o));
                }
            }
            if let Some(ln) = rpr.child(A, "ln") {
                outline(ln, &mut node);
            }
            if let Some(blip) = rpr.child(A, "blipFill") {
                node.str("textFillRaw", outer_xml(blip));
            }
            unknown_run_props(Some(rpr), &mut node, false);
        }
        if let Some(slide) = slide {
            if let Some(shape) = run.ancestor(P, "sp") {
                let ppr = run.ancestor(A, "p").and_then(|p| p.child(A, "pPr"));
                let level = int(ppr.and_then(|p| p.attr("lvl"))).unwrap_or(0) as usize;
                self.resolve(shape, slide, level, rpr, ppr)
                    .emit_run(&mut node);
            }
        }
        node
    }

    fn line_props(ln: E<'_>, node: &mut Node) {
        let solid = ln.child(A, "solidFill");
        if let Some(c) = read_color(solid) {
            node.str("line", c);
        }
        let none = ln.child(A, "noFill").is_some();
        if none {
            node.str("line", "none");
        }
        if let Some(g) = ln.child(A, "gradFill") {
            node.str("line.gradient", gradient_string(g));
        }
        if let Some(w) = long(ln.attr("w")).filter(|_| !none) {
            node.str("lineWidth", format_line_width(w));
        }
        Self::line_style(ln, node, true);
        let el = solid.and_then(|s| s.child(A, "srgbClr").or_else(|| s.child(A, "schemeClr")));
        if let Some(alpha) = int(el
            .and_then(|e| e.child(A, "alpha"))
            .and_then(|a| a.attr("val")))
        {
            node.str("lineOpacity", f2(alpha as f64 / 100_000.0));
        }
    }

    /// A line's dash, cap, compound, alignment, join and ends.
    fn line_style(ln: E<'_>, node: &mut Node, shape: bool) {
        if let Some(d) = ln.child(A, "prstDash").and_then(|d| d.attr("val")) {
            node.str("lineDash", d);
        }
        if let Some(c) = ln.child(A, "custDash") {
            node.str("lineDashRaw", outer_xml(c));
        }
        if let Some(cap) = ln.attr("cap") {
            node.str("lineCap", cap_name(cap));
        }
        if let Some(c) = ln.attr("cmpd") {
            node.str("cmpd", c);
        }
        if shape {
            if let Some(a) = ln.attr("algn") {
                node.str("lineAlign", a);
            }
        }
        if ln.child(A, "round").is_some() {
            node.str("lineJoin", "round");
        } else if ln.child(A, "bevel").is_some() {
            node.str("lineJoin", "bevel");
        } else if let Some(miter) = ln.child(A, "miter") {
            node.str("lineJoin", "miter");
            if let Some(lim) = int(miter.attr("lim")) {
                node.set("miterLimit", Value::Int(lim));
            }
        }
        if shape {
            if let Some(h) = ln.child(A, "headEnd").and_then(|h| h.attr("type")) {
                node.str("headEnd", h);
            }
            if let Some(t) = ln.child(A, "tailEnd").and_then(|t| t.attr("type")) {
                node.str("tailEnd", t);
            }
        }
    }

    fn effects(sppr: Option<E<'_>>, node: &mut Node) {
        if let Some(list) = sppr
            .and_then(|s| s.child(A, "effectLst"))
            .filter(|l| l.elements().next().is_some())
        {
            if let Some(s) = list.child(A, "outerShdw") {
                node.str("shadow", shadow_spec(s, "100"));
                if !plain_outer_shadow(s) {
                    node.str("shadowRaw", outer_xml(s));
                }
            }
            if let Some(s) = list.child(A, "innerShdw") {
                node.str("innerShadow", shadow_spec(s, "100"));
                if !plain_inner_shadow(s) {
                    node.str("innerShadowRaw", outer_xml(s));
                }
            }
            if let Some(g) = list.child(A, "glow") {
                node.str("glow", glow_spec(g, "100"));
            }
            if let Some(o) = list.child(A, "fillOverlay") {
                node.str("fillOverlayRaw", outer_xml(o));
            }
            if let Some(r) = list.child(A, "reflection") {
                node.str("reflection", reflection_name(r));
                if !plain_reflection(r) {
                    node.str("reflectionRaw", outer_xml(r));
                }
            }
            if let Some(rad) = long(list.child(A, "softEdge").and_then(|s| s.attr("rad"))) {
                node.str("softEdge", format!("{}pt", points_of(rad)));
            }
            if let Some(blur) = list.child(A, "blur") {
                let rad = long(blur.attr("rad"))
                    .map_or_else(|| "0pt".to_string(), |r| format!("{}pt", points_of(r)));
                let grow = boolean(blur.attr("grow")).unwrap_or(true);
                node.str("blur", format!("{rad}:{grow}"));
            }
            if list
                .elements()
                .any(|c| !HANDLED_EFFECTS.contains(&c.name()))
            {
                node.str("effectsRaw", outer_xml(list));
            }
        }
        if let Some(dag) = sppr.and_then(|s| s.child(A, "effectDag")) {
            node.str("effectDagRaw", outer_xml(dag));
        }
    }

    fn body_props(body_pr: E<'_>, node: &mut Node) {
        if let Some(rtl) = body_pr.attr("rtlCol").filter(|v| !v.is_empty()) {
            if !node.has("direction") {
                let on = rtl == "1" || rtl.eq_ignore_ascii_case("true");
                node.str("direction", if on { "rtl" } else { "ltr" });
            }
        }
        let ins: Vec<Option<i64>> = ["lIns", "tIns", "rIns", "bIns"]
            .iter()
            .map(|k| long(body_pr.attr(k)))
            .collect();
        if ins.iter().any(Option::is_some) {
            if ins[0].is_some() && ins.iter().all(|v| *v == ins[0]) {
                node.str("margin", format_emu(ins[0].unwrap_or(0)));
            } else {
                node.str(
                    "margin",
                    ins.iter()
                        .map(|v| v.map_or_else(|| "-".to_string(), format_emu))
                        .collect::<Vec<_>>()
                        .join(","),
                );
            }
        }
        if let Some(anchor) = body_pr.attr("anchor") {
            node.str(
                "valign",
                match anchor {
                    "t" => "top",
                    "ctr" => "middle",
                    "b" => "bottom",
                    other => other,
                },
            );
        }
        if let Some(vert) = body_pr.attr("vert") {
            node.str("textdirection", text_direction(vert));
        }
        if let Some(cols) = int(body_pr.attr("numCol")).filter(|c| *c > 1) {
            node.str("columns", cols.to_string());
            if let Some(gap) = long(body_pr.attr("spcCol")) {
                node.str("columnSpacing", format!("{}pt", points_of(gap)));
            }
        }
        if let Some(warp) = body_pr.child(A, "prstTxWarp") {
            if let Some(prst) = warp.attr("prst") {
                node.str("textWarp", prst);
                if warp
                    .child(A, "avLst")
                    .is_some_and(|a| a.elements().next().is_some())
                {
                    node.str("textWarpRaw", outer_xml(warp));
                }
            }
        }
        if let Some(s) = body_pr.child(A, "scene3d") {
            node.str("textScene3dRaw", outer_xml(s));
        }
        if let Some(s) = body_pr.child(A, "sp3d") {
            node.str("textSp3dRaw", outer_xml(s));
        }
        if let Some(wrap) = body_pr.attr("wrap") {
            node.set("wrap", Value::Bool(wrap != "none"));
        }
        if let Some(v) = boolean(body_pr.attr("anchorCtr")) {
            node.set("anchorCtr", Value::Bool(v));
        }
        if let Some(v) = boolean(body_pr.attr("upright")) {
            node.set("upright", Value::Bool(v));
        }
        if let Some(v) = body_pr.attr("vertOverflow") {
            node.str("vertOverflow", v);
        }
        if let Some(v) = body_pr.attr("horzOverflow") {
            node.str("horzOverflow", v);
        }
        if let Some(norm) = body_pr.child(A, "normAutofit") {
            node.str("autoFit", "normal");
            if let Some(scale) = int(norm.attr("fontScale")).filter(|s| *s != 100_000) {
                node.set("fontScale", Value::Int(scale));
            }
            if let Some(red) = int(norm.attr("lnSpcReduction")).filter(|r| *r != 0) {
                node.set("lnSpcReduction", Value::Int(red));
            }
        } else if body_pr.child(A, "spAutoFit").is_some() {
            node.str("autoFit", "shape");
        } else if body_pr.child(A, "noAutofit").is_some() {
            node.str("autoFit", "none");
        }
    }

    pub(super) fn picture_node(
        &self,
        pic: E<'_>,
        slide_num: usize,
        index: usize,
        slide: Option<Slide<'_>>,
        prefix: Option<&str>,
    ) -> Node {
        let cnvpr = cnvpr_of(pic);
        let name = cnvpr
            .and_then(|c| c.attr("name"))
            .unwrap_or("Picture")
            .to_string();
        let alt = cnvpr.and_then(|c| c.attr("descr"));
        let nvpr = nv_of(pic).and_then(|n| n.child(P, "nvPr"));
        let video = nvpr.and_then(|n| n.child(A, "videoFile"));
        let audio = nvpr.and_then(|n| n.child(A, "audioFile"));
        let base = prefix.map_or_else(|| format!("/slide[{slide_num}]"), str::to_string);
        let kind = if video.is_some() {
            "video"
        } else if audio.is_some() {
            "audio"
        } else {
            "picture"
        };
        let mut node = Node::new(format!("{base}/{}", segment("picture", pic, index)), kind);
        node.preview = Some(name.clone());
        if is_hidden(pic) {
            node.set("hidden", Value::Bool(true));
        }
        node.str("name", name);
        if let Some(id) = id_of(pic) {
            node.set("id", Value::Int(id));
        }
        if let Some(cid) = creation_id(pic) {
            node.str("extLst.creationId", cid);
        }
        node.str("alt", alt.filter(|a| !a.is_empty()).unwrap_or("(missing)"));
        let blip_fill = pic.child(P, "blipFill");
        let blip = blip_fill.and_then(|b| b.child(A, "blip"));
        let embed = blip.and_then(|b| b.attr_ns("embed", R));
        let media = video.or(audio).and_then(|m| m.attr_ns("link", R));
        if let Some(source) = media.or(embed).filter(|s| !s.is_empty()) {
            node.str("relId", source);
            if let Some(slide) = slide {
                if let Some(target) = self.pkg.rel_part(slide.part, source) {
                    if let Some(size) = self.pkg.size(&target) {
                        node.str(
                            "contentType",
                            self.pkg.content_type(&target).unwrap_or_default(),
                        );
                        node.set("fileSize", Value::Int(size as i64));
                    }
                }
            }
        }
        let sppr = pic.child(P, "spPr");
        let xfrm = sppr.and_then(|s| s.child(A, "xfrm"));
        Self::frame(xfrm, &mut node, false);
        if let Some(rot) = int(xfrm.and_then(|x| x.attr("rot"))).filter(|r| *r != 0) {
            node.str("rotation", rotation(rot, 6));
        }
        if boolean(xfrm.and_then(|x| x.attr("flipH"))) == Some(true) {
            node.set("flipH", Value::Bool(true));
        }
        if boolean(xfrm.and_then(|x| x.attr("flipV"))) == Some(true) {
            node.set("flipV", Value::Bool(true));
        }
        if let Some(ph) = ph_of(pic) {
            node.str("phType", placeholder_type_name(ph_type(Some(ph))));
            let idx = long(ph.attr("idx"));
            if let Some(i) = idx {
                node.set("phIndex", Value::Int(i));
            }
            if ph_type(Some(ph)).is_none() && idx.is_none() {
                node.str("phBare", "true");
            }
            if let Some(slide) = slide {
                if !Self::complete(xfrm) {
                    self.inherited_frame(ph, slide, &mut node);
                }
            }
        }
        let preset = sppr.and_then(|s| s.child(A, "prstGeom"));
        if let Some(prst) = preset
            .and_then(|p| p.attr("prst"))
            .filter(|p| !p.is_empty() && *p != "rect")
        {
            node.str("geometry", prst);
            if let Some(adj) = preset.and_then(guides) {
                node.str("adj", adj);
            }
        }
        if let Some(c) = sppr.and_then(|s| s.child(A, "custGeom")) {
            node.str("customGeometryXml", outer_xml(c));
        }
        if let Some(f) = read_color(sppr.and_then(|s| s.child(A, "solidFill"))) {
            node.str("frameFill", f);
        }
        if let Some(s) = sppr.and_then(|s| s.child(A, "scene3d")) {
            node.str("scene3dRaw", outer_xml(s));
        }
        if let Some(s) = sppr.and_then(|s| s.child(A, "sp3d")) {
            node.str("sp3dRaw", outer_xml(s));
        }
        zorder(pic, &mut node);
        if let Some(amt) = int(blip
            .and_then(|b| b.child(A, "alphaModFix"))
            .and_then(|a| a.attr("amt")))
        {
            node.str("opacity", f2(amt as f64 / 100_000.0));
        }
        if let Some(c) = blip
            .and_then(|b| b.attr("cstate"))
            .filter(|c| !c.is_empty() && *c != "none")
        {
            node.str("compressionState", c);
        }
        if let Some(t) = int(blip
            .and_then(|b| b.child(A, "biLevel"))
            .and_then(|b| b.attr("thresh")))
        {
            node.str("biLevel", f2(t as f64 / 1000.0));
        }
        if let Some(duo) = blip.and_then(|b| b.child(A, "duotone")) {
            let stops: Vec<String> = duo
                .elements()
                .filter_map(|c| {
                    let v = c.attr("val")?;
                    if c.is(A, "srgbClr") {
                        Some(hex_color(v))
                    } else if c.is(A, "schemeClr") && !v.is_empty() {
                        Some(v.to_string())
                    } else {
                        None
                    }
                })
                .collect();
            if stops.len() == 2 {
                node.str("duotone", stops.join(","));
            }
        }
        if blip.and_then(|b| b.child(A, "grayscl")).is_some() {
            node.str("recolor", "grayscale");
        }
        if let Some(slide) = slide {
            let h = cnvpr.and_then(|c| c.child(A, "hlinkClick"));
            if let Some(link) = self.hyperlink(h, slide.part) {
                node.str("link", link);
            }
            if let Some(tip) = h.and_then(|h| h.attr("tooltip")).filter(|t| !t.is_empty()) {
                node.str("tooltip", tip);
            }
        }
        if let Some(blip) = blip {
            let (mut bright, mut contrast) = (None, None);
            for k in blip.elements().filter(|k| k.ns() == A) {
                match k.name() {
                    "lum" => {
                        if let Some(b) = int(k.attr("bright")) {
                            bright = Some(b);
                        }
                        if let Some(c) = int(k.attr("contrast")) {
                            contrast = Some(c);
                        }
                    }
                    "lumOff" => {
                        if let Some(v) = int(k.attr("val")) {
                            bright.get_or_insert(v);
                        }
                    }
                    "lumMod" => {
                        if let Some(v) = int(k.attr("val")) {
                            contrast.get_or_insert(v - 100_000);
                        }
                    }
                    _ => {}
                }
            }
            if let Some(b) = bright.filter(|b| *b != 0) {
                node.str("brightness", f2(b as f64 / 1000.0));
            }
            if let Some(c) = contrast.filter(|c| *c != 0) {
                node.str("contrast", f2(c as f64 / 1000.0));
            }
        }
        if let Some(effects) = sppr.and_then(|s| s.child(A, "effectLst")) {
            if let Some(s) = effects.child(A, "outerShdw") {
                node.str("shadow", shadow_spec(s, "40"));
            }
            if let Some(g) = effects.child(A, "glow") {
                node.str("glow", glow_spec(g, "75"));
            }
            node.str("effectsRaw", outer_xml(effects));
        }
        if let Some(ln) = sppr.and_then(|s| s.child(A, "ln")) {
            node.str("lineRaw", outer_xml(ln));
        }
        if let Some(src) = blip_fill.and_then(|b| b.child(A, "srcRect")) {
            let v: Vec<i64> = ["l", "t", "r", "b"]
                .iter()
                .map(|k| int(src.attr(k)).unwrap_or(0))
                .collect();
            if v.iter().any(|x| *x != 0) {
                node.str(
                    "crop",
                    v.iter()
                        .map(|x| fmt(*x as f64 / 1000.0, 3))
                        .collect::<Vec<_>>()
                        .join(","),
                );
            }
        }
        if let Some(tile) = blip_fill.and_then(|b| b.child(A, "tile")) {
            node.str("fillMode", "tile");
            for (attr, key) in [
                ("sx", "tileSx"),
                ("sy", "tileSy"),
                ("tx", "tileTx"),
                ("ty", "tileTy"),
            ] {
                if let Some(v) = long(tile.attr(attr)) {
                    node.set(key, Value::Int(v));
                }
            }
            if let Some(a) = tile.attr("algn") {
                node.str("tileAlgn", a);
            }
            if let Some(f) = tile.attr("flip") {
                node.str("tileFlip", f);
            }
        } else if let Some(stretch) = blip_fill.and_then(|b| b.child(A, "stretch")) {
            match stretch.child(A, "fillRect") {
                Some(fr) => {
                    if let Some(v) = rect_list(fr) {
                        node.str("fillRect", v);
                    }
                }
                None => node.str("stretchBare", "true"),
            }
        }
        node
    }

    pub(super) fn table_node(
        &self,
        gf: E<'_>,
        slide_num: usize,
        index: usize,
        depth: usize,
        prefix: Option<&str>,
    ) -> Node {
        let table = gf.first_named(A, "tbl");
        let rows = table.map(|t| t.children(A, "tr")).unwrap_or_default();
        let cols = rows.first().map_or(0, |r| r.children(A, "tc").len());
        let name = cnvpr_of(gf)
            .and_then(|c| c.attr("name"))
            .unwrap_or("Table")
            .to_string();
        let base = prefix.map_or_else(|| format!("/slide[{slide_num}]"), str::to_string);
        let path = format!("{base}/{}", segment("table", gf, index));
        let mut node = Node::new(path.clone(), "table");
        node.preview = Some(format!("{name} ({}x{cols})", rows.len()));
        node.child_count = rows.len();
        node.str("name", name);
        if let Some(id) = id_of(gf) {
            node.set("id", Value::Int(id));
        }
        if let Some(cid) = creation_id(gf) {
            node.str("extLst.creationId", cid);
        }
        node.set("rows", Value::Int(rows.len() as i64));
        node.set("cols", Value::Int(cols as i64));
        let grid = table
            .and_then(|t| t.child(A, "tblGrid"))
            .map(|g| g.children(A, "gridCol"))
            .unwrap_or_default();
        if !grid.is_empty() {
            node.str(
                "colWidths",
                grid.iter()
                    .map(|gc| long(gc.attr("w")).map_or_else(|| "0".to_string(), format_emu_lossy))
                    .collect::<Vec<_>>()
                    .join(","),
            );
        }
        let tblpr = table.and_then(|t| t.child(A, "tblPr"));
        if let Some(style) = tblpr
            .and_then(|t| t.child(A, "tableStyleId"))
            .map(|s| s.text())
            .filter(|s| !s.is_empty())
        {
            node.str("style", table_style_name(&style).unwrap_or(style));
        }
        if let Some(tblpr) = tblpr {
            let flag = |a: &str| boolean(tblpr.attr(a)).unwrap_or(false);
            node.set("firstRow", Value::Bool(flag("firstRow")));
            for (attr, key) in [
                ("lastRow", "lastRow"),
                ("firstCol", "firstCol"),
                ("lastCol", "lastCol"),
            ] {
                if tblpr.attr(attr).is_some() {
                    node.set(key, Value::Bool(flag(attr)));
                }
            }
            node.set("bandedRows", Value::Bool(flag("bandRow")));
            if tblpr.attr("bandCol").is_some() {
                node.set("bandedCols", Value::Bool(flag("bandCol")));
            }
        }
        if table.is_some() {
            table_borders(&rows, &mut node);
        }
        Self::frame(gf.child(P, "xfrm"), &mut node, true);
        zorder(gf, &mut node);
        if depth > 0 {
            for (ri, row) in rows.iter().enumerate() {
                let cells = row.children(A, "tc");
                let mut row_node = Node::new(format!("{path}/tr[{}]", ri + 1), "tr");
                row_node.child_count = cells.len();
                if let Some(h) = long(row.attr("h")) {
                    row_node.str("height", format_emu_lossy(h));
                }
                if depth > 1 {
                    for (ci, cell) in cells.iter().enumerate() {
                        row_node.children.push(Self::cell_node(
                            *cell,
                            &format!("{path}/tr[{}]/tc[{}]", ri + 1, ci + 1),
                        ));
                    }
                }
                node.children.push(row_node);
            }
        }
        node
    }

    fn cell_node(cell: E<'_>, path: &str) -> Node {
        let mut node = Node::new(path, "tc");
        let text = cell_text(cell);
        let body = cell.child(A, "txBody");
        if text.is_empty() && body.is_some_and(|b| b.first_named(A, "r").is_some()) {
            node.set("hasEmptyRun", Value::Bool(true));
        }
        node.text = Some(text);
        if let Some(b) = body.filter(|b| rich_cell_body(*b)) {
            node.str("txBodyRaw", outer_xml(b));
        }
        let tcpr = cell.child(A, "tcPr");
        Self::cell_fill(tcpr, &mut node, true);
        if let Some(tcpr) = tcpr {
            cell_borders(tcpr, &mut node);
        }
        Self::padding(tcpr, &mut node);
        Self::spans(cell, &mut node);
        if let Some(vert) = tcpr.and_then(|t| t.attr("vert")) {
            node.str("textdirection", text_direction(vert));
        }
        if let Some(wrap) = body
            .and_then(|b| b.child(A, "bodyPr"))
            .and_then(|b| b.attr("wrap"))
        {
            node.set("wrap", Value::Bool(wrap != "none"));
        }
        if let Some(anchor) = tcpr.and_then(|t| t.attr("anchor")) {
            node.str("valign", cell_anchor(anchor));
        }
        if let Some(ho) = tcpr.and_then(|t| t.attr("horzOverflow")) {
            node.str("horzOverflow", ho);
        }
        if let Some(lock) = tcpr.and_then(|t| t.attrs().iter().find(|a| a.name == "lockText")) {
            node.set(
                "lockText",
                Value::Bool(lock.value == "1" || lock.value.eq_ignore_ascii_case("true")),
            );
        }
        if let Some(rpr) = cell.first_named(A, "r").and_then(|r| r.child(A, "rPr")) {
            let face = |c: &str| rpr.child(A, c).and_then(|x| x.attr("typeface"));
            if let Some(latin) = face("latin") {
                node.str("font", latin);
                node.str("font.latin", latin);
            }
            if let Some(ea) = face("ea") {
                node.str("font.ea", ea);
            }
            if let Some(cs) = face("cs") {
                node.str("font.cs", cs);
            }
            if let Some(sz) = int(rpr.attr("sz")) {
                node.str("size", format!("{}pt", f2(sz as f64 / 100.0)));
            }
            if let Some(b) = boolean(rpr.attr("b")) {
                node.set("bold", Value::Bool(b));
            }
            if let Some(i) = boolean(rpr.attr("i")) {
                node.set("italic", Value::Bool(i));
            }
            if let Some(u) = rpr.attr("u").filter(|u| *u != "none") {
                node.str("underline", underline_name(u));
            }
            if let Some(s) = rpr.attr("strike") {
                node.str("strike", strike_name(s));
            }
            if let Some(c) = read_color(rpr.child(A, "solidFill")) {
                node.str("color", c);
            }
            if let Some(spc) = int(rpr.attr("spc")) {
                node.str("spacing", f2(spc as f64 / 100.0));
            }
            if let Some(b) = int(rpr.attr("baseline")).filter(|b| *b != 0) {
                node.str("baseline", format!("{}%", f2(b as f64 / 1000.0)));
            }
        }
        let ppr = body
            .and_then(|b| b.children(A, "p").into_iter().next())
            .and_then(|p| p.child(A, "pPr"));
        if let Some(algn) = ppr.and_then(|p| p.attr("algn")) {
            node.str(
                "align",
                match algn {
                    "l" => "left",
                    "ctr" => "center",
                    "r" => "right",
                    "just" => "justify",
                    other => other,
                },
            );
        }
        if let Some(rtl) = boolean(ppr.and_then(|p| p.attr("rtl"))) {
            node.str("direction", if rtl { "rtl" } else { "ltr" });
        }
        spacing(ppr, &mut node);
        node
    }

    /// A cell's fill: an image, a gradient, a color, or none.
    pub(super) fn cell_fill(tcpr: Option<E<'_>>, node: &mut Node, gradient_first: bool) {
        if let Some(blip) = tcpr.and_then(|t| t.child(A, "blipFill")) {
            node.str("fill", "image");
            if let Some(embed) = blip.child(A, "blip").and_then(|b| b.attr_ns("embed", R)) {
                node.str("image.relId", embed);
            }
        } else if let Some(grad) = tcpr.and_then(|t| t.child(A, "gradFill")) {
            if gradient_first {
                node.str("gradient", gradient_string(grad));
                node.str("fill", "gradient");
            } else {
                node.str("fill", "gradient");
                node.str("gradient", gradient_string(grad));
            }
        } else if let Some(c) = read_color(tcpr.and_then(|t| t.child(A, "solidFill"))) {
            node.str("fill", c);
        } else if gradient_first && tcpr.and_then(|t| t.child(A, "noFill")).is_some() {
            node.str("fill", "none");
        }
    }

    pub(super) fn padding(tcpr: Option<E<'_>>, node: &mut Node) {
        for (attr, key) in [
            ("marL", "padding.left"),
            ("marR", "padding.right"),
            ("marT", "padding.top"),
            ("marB", "padding.bottom"),
        ] {
            if let Some(v) = long(tcpr.and_then(|t| t.attr(attr))) {
                node.str(key, format_emu(v));
            }
        }
    }

    pub(super) fn spans(cell: E<'_>, node: &mut Node) {
        if let Some(s) = int(cell.attr("gridSpan")).filter(|s| *s > 1) {
            node.set("colspan", Value::Int(s));
        }
        if let Some(s) = int(cell.attr("rowSpan")).filter(|s| *s > 1) {
            node.set("rowspan", Value::Int(s));
        }
        if boolean(cell.attr("hMerge")) == Some(true) {
            node.set("hmerge", Value::Bool(true));
        }
        if boolean(cell.attr("vMerge")) == Some(true) {
            node.set("vmerge", Value::Bool(true));
        }
    }

    pub(super) fn connector_node(
        &self,
        cxn: E<'_>,
        slide_num: usize,
        index: usize,
        prefix: Option<&str>,
        depth: usize,
        slide: Option<Slide<'_>>,
    ) -> Node {
        let name = cnvpr_of(cxn)
            .and_then(|c| c.attr("name"))
            .unwrap_or("Connector")
            .to_string();
        let base = prefix.map_or_else(|| format!("/slide[{slide_num}]"), str::to_string);
        let mut node = Node::new(
            format!("{base}/{}", segment("connector", cxn, index)),
            "connector",
        );
        node.preview = Some(name.clone());
        if is_hidden(cxn) {
            node.set("hidden", Value::Bool(true));
        }
        node.str("name", name);
        if let Some(id) = id_of(cxn) {
            node.set("id", Value::Int(id));
        }
        if let Some(cid) = creation_id(cxn) {
            node.str("extLst.creationId", cid);
        }
        let sppr = cxn.child(P, "spPr");
        let xfrm = sppr.and_then(|s| s.child(A, "xfrm"));
        if xfrm.is_some() {
            Self::frame(xfrm, &mut node, false);
        }
        if let Some(f) = read_color(sppr.and_then(|s| s.child(A, "solidFill"))) {
            node.str("fill", f);
        }
        if sppr.and_then(|s| s.child(A, "noFill")).is_some() {
            node.str("fill", "none");
        }
        if let Some(prst) = sppr
            .and_then(|s| s.child(A, "prstGeom"))
            .and_then(|g| g.attr("prst"))
        {
            node.str("shape", prst);
        }
        let ln = sppr.and_then(|s| s.child(A, "ln"));
        let none = ln.is_some_and(|l| l.child(A, "noFill").is_some());
        if let Some(w) = long(ln.and_then(|l| l.attr("w"))).filter(|_| !none) {
            node.str("lineWidth", format_line_width(w));
        }
        if let Some(ln) = ln {
            Self::line_style(ln, &mut node, false);
            if let Some(g) = ln.child(A, "gradFill") {
                node.str("line.gradient", gradient_string(g));
            }
        }
        let solid = ln.and_then(|l| l.child(A, "solidFill"));
        if let Some(c) = read_color(solid) {
            node.str("color", c);
        }
        let el = solid.and_then(|s| s.child(A, "srgbClr").or_else(|| s.child(A, "schemeClr")));
        if let Some(alpha) = int(el
            .and_then(|e| e.child(A, "alpha"))
            .and_then(|a| a.attr("val")))
        {
            node.str("lineOpacity", f2(alpha as f64 / 100_000.0));
        }
        if let Some(h) = ln
            .and_then(|l| l.child(A, "headEnd"))
            .and_then(|h| h.attr("type"))
        {
            node.str("headEnd", h);
        }
        if let Some(t) = ln
            .and_then(|l| l.child(A, "tailEnd"))
            .and_then(|t| t.attr("type"))
        {
            node.str("tailEnd", t);
        }
        if let Some(rot) = int(xfrm.and_then(|x| x.attr("rot"))).filter(|r| *r != 0) {
            node.str("rotation", rotation(rot, 6));
        }
        if boolean(xfrm.and_then(|x| x.attr("flipH"))) == Some(true) {
            node.set("flipH", Value::Bool(true));
        }
        if boolean(xfrm.and_then(|x| x.attr("flipV"))) == Some(true) {
            node.set("flipV", Value::Bool(true));
        }
        zorder(cxn, &mut node);
        let draw = nv_of(cxn).and_then(|n| n.child(P, "cNvCxnSpPr"));
        for (child, shape_key, idx_key) in [
            ("stCxn", "startShape", "startIdx"),
            ("endCxn", "endShape", "endIdx"),
        ] {
            let c = draw.and_then(|d| d.child(A, child));
            if let Some(id) = long(c.and_then(|c| c.attr("id"))) {
                node.set(shape_key, Value::Int(id));
                if let Some(idx) = long(c.and_then(|c| c.attr("idx"))) {
                    node.set(idx_key, Value::Int(idx));
                }
            }
        }
        if boolean(
            draw.and_then(|d| d.child(A, "cxnSpLocks"))
                .and_then(|l| l.attr("noChangeShapeType")),
        ) == Some(true)
        {
            node.str("lockShapeType", "true");
        }
        if let Some(body) = cxn.child(P, "txBody") {
            let paras = body.children(A, "p");
            let agg = paras
                .iter()
                .map(|p| {
                    p.children(A, "r")
                        .iter()
                        .map(|r| run_text(*r))
                        .collect::<String>()
                })
                .collect::<Vec<_>>()
                .join("\n");
            if !agg.is_empty() {
                node.text = Some(agg);
            }
            node.child_count = paras.len();
            if depth > 0 {
                let base = node.path.clone();
                for (pi, para) in paras.iter().enumerate() {
                    let runs = para.children(A, "r");
                    let mut pn = Node::new(format!("{base}/paragraph[{}]", pi + 1), "paragraph");
                    pn.text = Some(runs.iter().map(|r| run_text(*r)).collect());
                    pn.child_count = runs.len();
                    let ppr = para.child(A, "pPr");
                    if let Some(algn) = ppr.and_then(|p| p.attr("algn")) {
                        pn.str("align", align_name(Some(algn)));
                    }
                    break_props(ppr, &mut pn);
                    if depth > 1 {
                        for (ri, run) in runs.iter().enumerate() {
                            pn.children.push(self.run_node(
                                *run,
                                &format!("{base}/paragraph[{}]/run[{}]", pi + 1, ri + 1),
                                slide,
                                slide.map(|s| s.part),
                            ));
                        }
                    }
                    node.children.push(pn);
                }
            }
        }
        node
    }

    pub(super) fn group_node(
        &self,
        grp: E<'_>,
        slide: Slide<'_>,
        depth: usize,
        prefix: &str,
        index: usize,
        siblings: &[E<'_>],
    ) -> Node {
        let name = cnvpr_of(grp)
            .and_then(|c| c.attr("name"))
            .unwrap_or("Group")
            .to_string();
        let path = format!("{prefix}/{}", segment("group", grp, index));
        let mut node = Node::new(path.clone(), "group");
        node.preview = Some(name.clone());
        node.child_count = content_kids(grp).len();
        node.str("name", name);
        if let Some(id) = id_of(grp) {
            node.set("id", Value::Int(id));
        }
        if let Some(cid) = creation_id(grp) {
            node.str("extLst.creationId", cid);
        }
        let xfrm = grp.child(P, "grpSpPr").and_then(|g| g.child(A, "xfrm"));
        Self::frame(xfrm, &mut node, false);
        if let Some(rot) = int(xfrm.and_then(|x| x.attr("rot"))).filter(|r| *r != 0) {
            node.str("rotation", rotation(rot, 6));
        }
        Self::child_frame(xfrm, &mut node);
        if let Some(at) = siblings.iter().position(|s| *s == grp) {
            node.set("zorder", Value::Int(at as i64 + 1));
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

    pub(super) fn child_frame(xfrm: Option<E<'_>>, node: &mut Node) {
        let Some(xfrm) = xfrm else { return };
        let v = |e: Option<E<'_>>, k: &str| long(e.and_then(|e| e.attr(k))).unwrap_or(0);
        let off = xfrm.child(A, "off");
        let ext = xfrm.child(A, "ext");
        let choff = xfrm.child(A, "chOff");
        let chext = xfrm.child(A, "chExt");
        if choff.is_some() && (v(choff, "x") != v(off, "x") || v(choff, "y") != v(off, "y")) {
            node.str(
                "childOffset",
                format!("{},{}", v(choff, "x"), v(choff, "y")),
            );
        }
        if chext.is_some() && (v(chext, "cx") != v(ext, "cx") || v(chext, "cy") != v(ext, "cy")) {
            node.str(
                "childExtent",
                format!("{},{}", v(chext, "cx"), v(chext, "cy")),
            );
        }
    }

    pub(super) fn smart_art_node(
        &self,
        gf: E<'_>,
        slide_num: usize,
        index: usize,
        prefix: Option<&str>,
    ) -> Node {
        let name = cnvpr_of(gf)
            .and_then(|c| c.attr("name"))
            .unwrap_or("SmartArt")
            .to_string();
        let base = prefix.map_or_else(|| format!("/slide[{slide_num}]"), str::to_string);
        let mut node = Node::new(
            format!("{base}/{}", segment("shape", gf, index)),
            "smartart",
        );
        node.preview = Some(name.clone());
        node.str("name", name);
        if let Some(id) = id_of(gf) {
            node.set("id", Value::Int(id));
        }
        if let Some(cid) = creation_id(gf) {
            node.str("extLst.creationId", cid);
        }
        Self::frame(gf.child(P, "xfrm"), &mut node, true);
        zorder(gf, &mut node);
        node
    }

    pub(super) fn chart_node(
        &self,
        gf: E<'_>,
        slide: Slide<'_>,
        index: usize,
        prefix: Option<&str>,
    ) -> Node {
        let name = cnvpr_of(gf)
            .and_then(|c| c.attr("name"))
            .unwrap_or("Chart")
            .to_string();
        let base = prefix.map_or_else(|| format!("/slide[{}]", slide.num), str::to_string);
        let mut node = Node::new(format!("{base}/{}", segment("chart", gf, index)), "chart");
        node.preview = Some(name.clone());
        node.str("name", name);
        if let Some(id) = id_of(gf) {
            node.set("id", Value::Int(id));
        }
        Self::frame(gf.child(P, "xfrm"), &mut node, false);
        zorder(gf, &mut node);
        if let Some(root) = self.root_of(slide.part) {
            animations(root, gf, &mut node, true);
        }
        node
    }
}

/// A table cell's anchor as OfficeCLI names it.
pub(super) fn cell_anchor(anchor: &str) -> String {
    match anchor {
        "t" => "top",
        "ctr" => "center",
        "b" => "bottom",
        other => other,
    }
    .to_string()
}
