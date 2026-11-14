// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! The deck itself: its slides, layouts, masters and theme, what a shape
//! inherits from them, and the presentation, slide and theme nodes.

use super::super::Fail;
use super::super::node::{Node, Value};
use super::super::office::{Pkg, core_properties, extended_properties, theme_properties};
use super::super::tree::{A, C, E, P, R, Tree};
use super::super::units::{format_emu, format_emu_paired, hex_color, round_even};
use super::cascade::{Resolved, complete_frame, ph_layer, placeholder_matches};
use super::color::{degrees, focus_of, read_color};
use super::fail;
use super::motion::transition;
use super::text::{run_text, shape_text};
use super::{
    CHART_EX_URI, DGM, PICTURE_URI, TABLE_URI, boolean, content_kids, int, is_title_shape, long,
    ph_of, ph_type,
};

/// A slide a node's inherited values are read from: its part and number.
#[derive(Clone, Copy)]
pub(super) struct Slide<'a> {
    pub(super) part: &'a str,
    pub(super) num: usize,
}

/// What kind of frame a `p:graphicFrame` holds.
#[derive(PartialEq, Eq, Clone, Copy)]
pub(super) enum Graphic {
    Table,
    Chart,
    Picture,
    SmartArt,
}

pub(crate) struct Deck<'p> {
    pub(super) pkg: &'p Pkg<'p>,
}

impl<'p> Deck<'p> {
    pub(super) fn new(pkg: &'p Pkg<'p>) -> Deck<'p> {
        Deck { pkg }
    }

    pub(super) fn tree(&self, part: &str) -> Option<&'p Tree> {
        self.pkg.xml(part)
    }

    pub(super) fn root_of(&self, part: &str) -> Option<E<'p>> {
        self.tree(part).map(Tree::root)
    }

    pub(super) fn presentation(&self) -> Option<E<'p>> {
        self.root_of(&self.pkg.main)
    }

    /// Slide parts in `sldIdLst` order.
    pub(super) fn slide_parts(&self) -> Vec<String> {
        let mut out = Vec::new();
        let ids = self
            .presentation()
            .and_then(|p| p.child(P, "sldIdLst"))
            .map(|l| l.children(P, "sldId"))
            .unwrap_or_default();
        for id in ids {
            let Some(rid) = id.attr_ns("id", R) else {
                continue;
            };
            if let Some(part) = self.pkg.rel_part(&self.pkg.main, rid) {
                out.push(part);
            }
        }
        out
    }

    pub(super) fn slide(&self, part: &str) -> Result<E<'p>, Fail> {
        self.root_of(part)
            .ok_or_else(|| fail("Corrupt file: slide data missing".to_string()))
    }

    pub(super) fn sp_tree(root: Option<E<'p>>) -> Option<E<'p>> {
        root?.child(P, "cSld")?.child(P, "spTree")
    }

    pub(super) fn layout_of(&self, slide_part: &str) -> Option<String> {
        self.pkg
            .related(slide_part, "slideLayout")
            .into_iter()
            .next()
    }

    pub(super) fn master_of(&self, slide_part: &str) -> Option<String> {
        let layout = self.layout_of(slide_part)?;
        self.pkg.related(&layout, "slideMaster").into_iter().next()
    }

    pub(super) fn theme_of_master(&self, master: Option<&str>) -> Option<E<'p>> {
        let theme = self.pkg.related(master?, "theme").into_iter().next()?;
        self.root_of(&theme)
    }

    /// Masters in `sldMasterIdLst` order, then any others by name.
    pub(super) fn masters(&self) -> Vec<String> {
        let all = self.pkg.related(&self.pkg.main, "slideMaster");
        let mut out: Vec<String> = Vec::new();
        let ids = self
            .presentation()
            .and_then(|p| p.child(P, "sldMasterIdLst"))
            .map(|l| l.children(P, "sldMasterId"))
            .unwrap_or_default();
        for id in ids {
            let part = id
                .attr_ns("id", R)
                .and_then(|rid| self.pkg.rel_part(&self.pkg.main, rid));
            if let Some(part) = part {
                if all.contains(&part) && !out.contains(&part) {
                    out.push(part);
                }
            }
        }
        let mut rest = all.clone();
        rest.sort();
        for m in rest {
            if !out.contains(&m) {
                out.push(m);
            }
        }
        out
    }

    pub(super) fn layouts_of(&self, master: &str) -> Vec<String> {
        let all = self.pkg.related(master, "slideLayout");
        let mut out: Vec<String> = Vec::new();
        let ids = self
            .root_of(master)
            .and_then(|m| m.child(P, "sldLayoutIdLst"))
            .map(|l| l.children(P, "sldLayoutId"))
            .unwrap_or_default();
        for id in ids {
            let part = id
                .attr_ns("id", R)
                .and_then(|rid| self.pkg.rel_part(master, rid));
            if let Some(part) = part {
                if all.contains(&part) && !out.contains(&part) {
                    out.push(part);
                }
            }
        }
        let mut rest = all.clone();
        rest.sort();
        for l in rest {
            if !out.contains(&l) {
                out.push(l);
            }
        }
        out
    }

    pub(super) fn all_layouts(&self) -> Vec<String> {
        self.masters()
            .iter()
            .flat_map(|m| self.layouts_of(m))
            .collect()
    }

    fn master_index(&self, slide_part: &str) -> usize {
        let master = self.master_of(slide_part);
        let all = self.pkg.related(&self.pkg.main, "slideMaster");
        master
            .and_then(|m| all.iter().position(|x| *x == m))
            .map_or(1, |i| i + 1)
    }

    fn slide_index(&self, slide_part: &str) -> usize {
        self.pkg
            .related(&self.pkg.main, "slide")
            .iter()
            .position(|x| x == slide_part)
            .map_or(1, |i| i + 1)
    }

    /// A click hyperlink's URL, slide reference or action, as OfficeCLI shows it.
    pub(super) fn hyperlink(&self, h: Option<E<'_>>, part: &str) -> Option<String> {
        let h = h?;
        let id = h.attr_ns("id", R);
        let action = h.attr("action");
        if id.is_none_or(str::is_empty) {
            if let Some(action) = action.filter(|a| !a.is_empty()) {
                let prefix = "ppaction://hlinkshowjump?jump=";
                if action.to_lowercase().starts_with(prefix) {
                    let jump = action[prefix.len()..].to_lowercase();
                    return Some(
                        if matches!(
                            jump.as_str(),
                            "firstslide" | "lastslide" | "nextslide" | "previousslide" | "endshow"
                        ) {
                            jump
                        } else {
                            action.to_string()
                        },
                    );
                }
                return Some(action.to_string());
            }
        }
        let id = id?;
        let rel = self.pkg.rel(part, id)?;
        if rel.kind.ends_with("/hyperlink") {
            return Some(rel.target);
        }
        if rel.kind.ends_with("/slide") && !rel.external {
            let target = self.pkg.rel_part(part, id)?;
            let at = self
                .pkg
                .related(&self.pkg.main, "slide")
                .iter()
                .position(|x| *x == target)?;
            return Some(format!("slide[{}]", at + 1));
        }
        None
    }

    /// What a paragraph or run of `shape` inherits, layer by layer.
    pub(super) fn resolve(
        &self,
        shape: E<'_>,
        slide: Slide<'_>,
        level: usize,
        rpr: Option<E<'_>>,
        ppr: Option<E<'_>>,
    ) -> Resolved<'p> {
        let mut r = Resolved::default();
        let ph = ph_of(shape);
        let t = ph_type(ph).unwrap_or("body");
        let title = t == "title" || t == "ctrTitle";
        let sub = t == "subTitle";
        let master = self.master_of(slide.part);
        let font_scheme = self
            .theme_of_master(master.as_deref())
            .and_then(|th| th.child(A, "themeElements"))
            .and_then(|e| e.child(A, "fontScheme"));
        r.font_scheme = font_scheme;
        if let Some(scheme) = font_scheme {
            let source = if title {
                "/theme/majorFont"
            } else {
                "/theme/minorFont"
            };
            if let Some(font) = scheme.child(A, if title { "majorFont" } else { "minorFont" }) {
                let face = |c: &str| font.child(A, c).and_then(|x| x.attr("typeface"));
                if let Some(latin) = face("latin").filter(|f| !f.starts_with('+')) {
                    r.font_latin = Some(latin.to_string());
                    r.sources.insert("font.latin", source.to_string());
                }
                if let Some(ea) = face("ea").filter(|f| !f.is_empty() && !f.starts_with('+')) {
                    r.font_ea = Some(ea.to_string());
                    r.sources.insert("font.ea", source.to_string());
                }
                if let Some(cs) = face("cs").filter(|f| !f.is_empty() && !f.starts_with('+')) {
                    r.font_cs = Some(cs.to_string());
                    r.sources.insert("font.cs", source.to_string());
                }
            }
        }
        if let Some(m) = &master {
            let defaults = self
                .pkg
                .related(m, "officeDocument")
                .into_iter()
                .next()
                .and_then(|pres| self.root_of(&pres))
                .and_then(|p| p.child(P, "defaultTextStyle"));
            r.apply_level(defaults, level, "/presentation/defaultTextStyle");
        }
        let master_idx = self.master_index(slide.part);
        let master_root = master.as_deref().and_then(|m| self.root_of(m));
        if let Some(styles) = master_root.and_then(|m| m.child(P, "txStyles")) {
            let name = if title {
                "titleStyle"
            } else if sub || t == "body" || t == "obj" {
                "bodyStyle"
            } else {
                "otherStyle"
            };
            r.apply_level(
                styles.child(P, name),
                level,
                &format!("/master[{master_idx}]/{name}/lvl{}pPr", level + 1),
            );
        }
        if let Some(ph) = ph {
            if let Some((list, path)) = ph_layer(
                Self::sp_tree(master_root),
                ph,
                level,
                &format!("/master[{master_idx}]"),
            ) {
                r.apply_level(list, level, &path);
            }
            let layout_root = self.layout_of(slide.part).and_then(|l| self.root_of(&l));
            let root = format!("/slide[{}]/layout", self.slide_index(slide.part));
            if let Some((list, path)) = ph_layer(Self::sp_tree(layout_root), ph, level, &root) {
                r.apply_level(list, level, &path);
            }
        }
        r.apply_level(
            shape
                .child(P, "txBody")
                .and_then(|b| b.child(A, "lstStyle")),
            level,
            "/shape/lstStyle",
        );
        if let Some(ppr) = ppr {
            r.apply_paragraph(ppr, "/direct");
            if let Some(def) = ppr.child(A, "defRPr") {
                r.apply_run(def, "/direct");
            }
        }
        if let Some(rpr) = rpr {
            r.apply_run(rpr, "/direct");
        }
        if r.size.is_none() && ph.is_some() {
            r.size = Some(if title {
                4400
            } else if sub {
                3200
            } else {
                2400
            });
            r.sources.insert("size", "/spec-default".to_string());
        }
        r
    }

    /// The reading direction a shape inherits from its layout, master or text styles.
    pub(super) fn inherited_direction(
        &self,
        slide_part: &str,
        t: Option<&str>,
        title: bool,
    ) -> Option<bool> {
        let probe = |root: Option<E<'_>>| -> Option<bool> {
            for sp in root?.descendants_named(P, "sp") {
                for para in sp
                    .child(P, "txBody")
                    .map(|b| b.children(A, "p"))
                    .unwrap_or_default()
                {
                    if let Some(rtl) = boolean(para.child(A, "pPr").and_then(|p| p.attr("rtl"))) {
                        return Some(rtl);
                    }
                }
            }
            None
        };
        let layout_root = self.layout_of(slide_part).and_then(|l| self.root_of(&l));
        if let Some(hit) = probe(Self::sp_tree(layout_root)) {
            return Some(hit);
        }
        let master_root = self.master_of(slide_part).and_then(|m| self.root_of(&m));
        if let Some(hit) = probe(Self::sp_tree(master_root)) {
            return Some(hit);
        }
        let styles = master_root?.child(P, "txStyles")?;
        let name = if title || matches!(t, Some("title" | "ctrTitle")) {
            "titleStyle"
        } else if matches!(t, Some("body" | "subTitle" | "obj")) {
            "bodyStyle"
        } else {
            "otherStyle"
        };
        boolean(
            styles
                .child(P, name)
                .and_then(|s| s.child(A, "lvl1pPr"))
                .and_then(|l| l.attr("rtl")),
        )
    }

    /// The frame a placeholder without its own takes from its layout or master.
    pub(super) fn inherited_frame(&self, ph: E<'_>, slide: Slide<'_>, node: &mut Node) {
        let layout = self.layout_of(slide.part);
        let master = self.master_of(slide.part);
        let mut from_master = false;
        for part in [layout, master] {
            if let Some(tree) = Self::sp_tree(part.as_deref().and_then(|p| self.root_of(p))) {
                for candidate in tree.children(P, "sp") {
                    let Some(cph) = ph_of(candidate) else {
                        continue;
                    };
                    if !placeholder_matches(ph, cph) {
                        continue;
                    }
                    let xfrm = candidate.child(P, "spPr").and_then(|s| s.child(A, "xfrm"));
                    let (Some(off), Some(ext)) = (
                        xfrm.and_then(|x| x.child(A, "off")),
                        xfrm.and_then(|x| x.child(A, "ext")),
                    ) else {
                        continue;
                    };
                    let mut predicate = String::new();
                    if let Some(t) = cph.attr("type").filter(|t| !t.is_empty()) {
                        predicate.push_str(&format!("[@type={t}]"));
                    }
                    if let Some(i) = long(cph.attr("idx")) {
                        predicate.push_str(&format!("[@idx={i}]"));
                    }
                    let src = format!(
                        "/slide[{}]/{}/ph{predicate}",
                        slide.num,
                        if from_master { "master" } else { "layout" }
                    );
                    let v = |e: E<'_>, k: &str| long(e.attr(k)).unwrap_or(0);
                    node.str("effective.x", format_emu(v(off, "x")));
                    node.str("effective.y", format_emu(v(off, "y")));
                    node.str("effective.width", format_emu(v(ext, "cx")));
                    node.str("effective.height", format_emu(v(ext, "cy")));
                    for k in ["x", "y", "width", "height"] {
                        node.str(&format!("effective.{k}.src"), src.clone());
                    }
                    return;
                }
            }
            from_master = true;
        }
    }

    pub(super) fn complete(xfrm: Option<E<'_>>) -> bool {
        complete_frame(xfrm)
    }

    /// The file name of the part a relationship points at.
    pub(super) fn file_name(&self, part: &str, rid: &str) -> Option<String> {
        let target = self.pkg.rel_part(part, rid)?;
        if !self.pkg.has(&target) {
            return None;
        }
        Some(target.rsplit('/').next().unwrap_or_default().to_string())
    }

    pub(super) fn graphic_kind(gf: E<'_>) -> Option<Graphic> {
        let uri = gf
            .child(A, "graphic")
            .and_then(|g| g.child(A, "graphicData"))
            .and_then(|d| d.attr("uri"));
        if gf.first_named(A, "tbl").is_some()
            || uri.is_some_and(|u| u.eq_ignore_ascii_case(TABLE_URI))
        {
            return Some(Graphic::Table);
        }
        let datas = gf.descendants_named(A, "graphicData");
        if gf.first_named(C, "chart").is_some()
            || datas.iter().any(|d| d.attr("uri") == Some(CHART_EX_URI))
        {
            return Some(Graphic::Chart);
        }
        if let Some(pic) = datas.iter().find(|d| d.attr("uri") == Some(PICTURE_URI)) {
            if pic.first_named(P, "pic").is_some() {
                return Some(Graphic::Picture);
            }
        }
        if uri.is_some_and(|u| u.eq_ignore_ascii_case(DGM))
            || gf
                .descendants()
                .iter()
                .any(|d| d.name() == "relIds" && d.ns() == DGM)
        {
            return Some(Graphic::SmartArt);
        }
        None
    }

    /// A container's shapes, pictures, tables, charts, groups and connectors as nodes.
    pub(super) fn children(
        &self,
        out: &mut Vec<Node>,
        container: E<'_>,
        slide: Slide<'_>,
        depth: usize,
        prefix: &str,
    ) {
        let siblings = content_kids(container);
        let (mut shape, mut pic, mut tbl, mut chart, mut grp, mut cxn) = (0, 0, 0, 0, 0, 0);
        for e in container.elements() {
            if e.ns() != P {
                continue;
            }
            match e.name() {
                "sp" => {
                    shape += 1;
                    out.push(self.shape_node(
                        e,
                        slide.num,
                        shape,
                        depth,
                        Some(slide),
                        Some(prefix),
                    ));
                }
                "graphicFrame" => match Self::graphic_kind(e) {
                    Some(Graphic::Table) => {
                        tbl += 1;
                        out.push(self.table_node(e, slide.num, tbl, depth, Some(prefix)));
                    }
                    Some(Graphic::Chart) => {
                        chart += 1;
                        out.push(self.chart_node(e, slide, chart, Some(prefix)));
                    }
                    Some(Graphic::Picture) => {
                        let wrapped = e
                            .descendants_named(A, "graphicData")
                            .into_iter()
                            .find(|d| d.attr("uri") == Some(PICTURE_URI))
                            .and_then(|d| d.first_named(P, "pic"));
                        if let Some(w) = wrapped {
                            pic += 1;
                            out.push(self.picture_node(
                                w,
                                slide.num,
                                pic,
                                Some(slide),
                                Some(prefix),
                            ));
                        }
                    }
                    Some(Graphic::SmartArt) => {
                        shape += 1;
                        out.push(self.smart_art_node(e, slide.num, shape, Some(prefix)));
                    }
                    None => {}
                },
                "pic" => {
                    pic += 1;
                    out.push(self.picture_node(e, slide.num, pic, Some(slide), Some(prefix)));
                }
                "grpSp" => {
                    grp += 1;
                    out.push(self.group_node(e, slide, depth, prefix, grp, &siblings));
                }
                "cxnSp" => {
                    cxn += 1;
                    out.push(self.connector_node(
                        e,
                        slide.num,
                        cxn,
                        Some(prefix),
                        depth,
                        Some(slide),
                    ));
                }
                _ => {}
            }
        }
    }

    pub(super) fn slide_children(
        &self,
        part: &str,
        num: usize,
        depth: usize,
    ) -> Result<Vec<Node>, Fail> {
        let mut out = Vec::new();
        if let Some(tree) = Self::sp_tree(Some(self.slide(part)?)) {
            self.children(
                &mut out,
                tree,
                Slide { part, num },
                depth,
                &format!("/slide[{num}]"),
            );
        }
        Ok(out)
    }

    pub(super) fn slide_preview(&self, part: &str) -> Result<String, Fail> {
        let tree = Self::sp_tree(Some(self.slide(part)?));
        let title = tree.and_then(|t| t.children(P, "sp").into_iter().find(|s| is_title_shape(*s)));
        Ok(title.map_or_else(|| "(untitled)".to_string(), shape_text))
    }

    pub(super) fn layout_name(&self, part: &str) -> Option<String> {
        let root = self.layout_of(part).and_then(|l| self.root_of(&l))?;
        root.child(P, "cSld")
            .and_then(|c| c.attr("name"))
            .or_else(|| root.attr("matchingName"))
            .or_else(|| root.attr("type"))
            .map(str::to_string)
    }

    pub(super) fn background(&self, csld: Option<E<'_>>, node: &mut Node, part: Option<&str>) {
        let Some(bg) = csld.and_then(|c| c.child(P, "bg")) else {
            return;
        };
        let Some(bgpr) = bg.child(P, "bgPr") else {
            if let Some(r) = bg.child(P, "bgRef") {
                let color = read_color(Some(r));
                node.str(
                    "background",
                    match &color {
                        Some(c) => format!("ref:{c}"),
                        None => "ref".to_string(),
                    },
                );
                if let Some(idx) = long(r.attr("idx")) {
                    node.set("background.ref", Value::Int(idx));
                }
                if let Some(c) = color {
                    node.str("background.refColor", c);
                }
            }
            return;
        };
        if let Some(solid) = bgpr.child(A, "solidFill") {
            if let Some(c) = read_color(Some(solid)) {
                node.str("background", c);
            }
            let el = solid
                .child(A, "srgbClr")
                .or_else(|| solid.child(A, "schemeClr"));
            if let Some(alpha) = int(el
                .and_then(|e| e.child(A, "alpha"))
                .and_then(|a| a.attr("val")))
            {
                node.set(
                    "background.alpha",
                    Value::Int(round_even(alpha as f64 / 1000.0) as i64),
                );
            }
        } else if let Some(grad) = bgpr.child(A, "gradFill") {
            let stops = grad
                .child(A, "gsLst")
                .map(|l| l.children(A, "gs"))
                .unwrap_or_default();
            let n = stops.len() as i64;
            let parts: Vec<String> = stops
                .iter()
                .enumerate()
                .map(|(i, gs)| {
                    let color = read_color(Some(*gs)).unwrap_or_else(|| "?".to_string());
                    if let Some(pos) = int(gs.attr("pos")) {
                        let expected = if n <= 1 {
                            0
                        } else {
                            i as i64 * 100_000 / (n - 1)
                        };
                        if pos != expected {
                            return format!("{color}@{}", round_even(pos as f64 / 1000.0) as i64);
                        }
                    }
                    color
                })
                .collect();
            if !parts.is_empty() {
                if let Some(path) = grad.child(A, "path") {
                    let prefix = if path.attr("path") == Some("shape") {
                        "path"
                    } else {
                        "radial"
                    };
                    node.str(
                        "background",
                        format!("{prefix}:{}-{}", parts.join("-"), focus_of(path)),
                    );
                } else {
                    let mut s = parts.join("-");
                    if let Some(angle) = int(grad.child(A, "lin").and_then(|l| l.attr("ang"))) {
                        s.push_str(&format!("-{}", degrees(angle)));
                    }
                    node.str("background", s);
                }
            }
        } else if let Some(blip_fill) = bgpr.child(A, "blipFill") {
            let blip = blip_fill.child(A, "blip");
            node.str("background", "image");
            if let (Some(embed), Some(part)) = (
                blip.and_then(|b| b.attr_ns("embed", R))
                    .filter(|e| !e.is_empty()),
                part,
            ) {
                if let Some(file) = self.file_name(part, embed).filter(|f| !f.is_empty()) {
                    node.str("background.src", format!("image:{file}"));
                }
            }
            if let Some(amt) = int(blip
                .and_then(|b| b.child(A, "alphaModFix"))
                .and_then(|a| a.attr("amt")))
            {
                node.set(
                    "background.alpha",
                    Value::Int(round_even(amt as f64 / 1000.0) as i64),
                );
            }
            if let Some(tile) = blip_fill.child(A, "tile") {
                let sx = int(tile.attr("sx")).unwrap_or(100_000);
                if tile.attr("algn") == Some("ctr") && sx == 100_000 {
                    node.str("background.mode", "center");
                } else {
                    node.str("background.mode", "tile");
                    if sx != 100_000 {
                        node.set(
                            "background.scale",
                            Value::Int(round_even(sx as f64 / 1000.0) as i64),
                        );
                    }
                }
            }
            if let Some(src) = blip_fill.child(A, "srcRect") {
                let v: Vec<i64> = ["l", "t", "r", "b"]
                    .iter()
                    .map(|k| int(src.attr(k)).unwrap_or(0))
                    .collect();
                if v.iter().any(|x| *x != 0) {
                    node.str(
                        "background.crop",
                        v.iter().map(i64::to_string).collect::<Vec<_>>().join(","),
                    );
                }
            }
        }
    }

    pub(super) fn header_footer(&self, part: &str, node: &mut Node) -> Result<(), Fail> {
        let slide = self.slide(part)?;
        if let Some(hf) = slide.child(P, "hf") {
            for a in hf.attrs() {
                if a.value.is_empty() {
                    continue;
                }
                let b = if a.value == "1" || a.value == "true" {
                    "true"
                } else {
                    "false"
                };
                match a.name.as_str() {
                    "ftr" => node.str("showFooter", b),
                    "sldNum" => node.str("showSlideNumber", b),
                    "dt" => node.str("showDate", b),
                    "hdr" => node.str("showHeader", b),
                    _ => {}
                }
            }
        }
        let Some(root) = self.master_of(part).and_then(|m| self.root_of(&m)) else {
            return Ok(());
        };
        let types: Vec<&str> = Self::sp_tree(Some(root))
            .map(|t| t.descendants_named(P, "ph"))
            .unwrap_or_default()
            .into_iter()
            .filter_map(|ph| ph.attr("type"))
            .collect();
        for (key, t) in [
            ("showFooter", "ftr"),
            ("showSlideNumber", "sldNum"),
            ("showDate", "dt"),
        ] {
            if !node.has(key) && types.contains(&t) {
                node.str(key, "true");
            }
        }
        Ok(())
    }

    pub(super) fn notes_bodies(&self, notes: &str) -> Vec<E<'p>> {
        Self::sp_tree(self.root_of(notes))
            .map(|t| t.children(P, "sp"))
            .unwrap_or_default()
            .into_iter()
            .filter(|sp| ph_type(ph_of(*sp)) == Some("body"))
            .collect()
    }

    pub(super) fn notes_text(&self, slide_part: &str) -> Option<String> {
        let notes = self
            .pkg
            .related(slide_part, "notesSlide")
            .into_iter()
            .next()?;
        let mut lines = Vec::new();
        for sp in self.notes_bodies(&notes) {
            for p in sp
                .child(P, "txBody")
                .map(|b| b.children(A, "p"))
                .unwrap_or_default()
            {
                lines.push(
                    p.children(A, "r")
                        .iter()
                        .map(|r| run_text(*r))
                        .collect::<String>(),
                );
            }
        }
        Some(lines.join("\n"))
    }

    pub(super) fn root(&self, depth: usize) -> Result<Node, Fail> {
        let mut node = Node::new("/", "presentation");
        let pres = self.presentation();
        if let Some(size) = pres.and_then(|p| p.child(P, "sldSz")) {
            let cx = long(size.attr("cx"));
            let cy = long(size.attr("cy"));
            match (cx, cy) {
                (Some(w), Some(h)) => {
                    let (a, b) = format_emu_paired(w, h);
                    node.str("slideWidth", a);
                    node.str("slideHeight", b);
                }
                _ => {
                    if let Some(w) = cx {
                        node.str("slideWidth", format_emu(w));
                    }
                    if let Some(h) = cy {
                        node.str("slideHeight", format_emu(h));
                    }
                }
            }
            if let Some(t) = size.attr("type") {
                let lower = t.to_lowercase();
                let name = match lower.as_str() {
                    "screen16x9" => "widescreen".to_string(),
                    "screen4x3" => "standard".to_string(),
                    "screen16x10" => "16:10".to_string(),
                    "b4iso" => "b4".to_string(),
                    "b5iso" => "b5".to_string(),
                    _ => lower,
                };
                node.str("slideSize", name);
            } else if let (Some(w), Some(h)) = (cx, cy) {
                let ratio = w as f64 / h as f64;
                let name = if (ratio - 16.0 / 9.0).abs() < 0.02 {
                    "widescreen"
                } else if (ratio - 4.0 / 3.0).abs() < 0.02 {
                    "standard"
                } else if (ratio - 1.6).abs() < 0.02 {
                    "16:10"
                } else {
                    "custom"
                };
                node.str("slideSize", name);
            }
        }
        let first_master = self
            .pkg
            .related(&self.pkg.main, "slideMaster")
            .into_iter()
            .next();
        let theme = self.theme_of_master(first_master.as_deref());
        if let Some(minor) = theme
            .and_then(|t| t.child(A, "themeElements"))
            .and_then(|e| e.child(A, "fontScheme"))
            .and_then(|f| f.child(A, "minorFont"))
            .and_then(|m| m.child(A, "latin"))
            .and_then(|l| l.attr("typeface"))
        {
            node.str("defaultFont", minor);
        }
        let core = self.pkg.related("/", "core-properties").into_iter().next();
        core_properties(core.as_deref().and_then(|c| self.root_of(c)), &mut node);
        for (i, part) in self.slide_parts().iter().enumerate() {
            let num = i + 1;
            let mut slide_node = Node::new(format!("/slide[{num}]"), "slide");
            let root = self.slide(part)?;
            slide_node.preview = Some(self.slide_preview(part)?);
            if let Some(layout) = self.layout_name(part) {
                slide_node.str("layout", layout);
            }
            if let Some(name) = root
                .child(P, "cSld")
                .and_then(|c| c.attr("name"))
                .filter(|n| !n.is_empty())
            {
                slide_node.str("name", name);
            }
            if boolean(root.attr("show")) == Some(false) {
                slide_node.set("hidden", Value::Bool(true));
            }
            self.background(root.child(P, "cSld"), &mut slide_node, Some(part));
            transition(root, &mut slide_node);
            self.header_footer(part, &mut slide_node)?;
            if depth > 0 {
                slide_node.children = self.slide_children(part, num, depth - 1)?;
                slide_node.child_count = slide_node.children.len();
            } else {
                slide_node.child_count =
                    Self::sp_tree(Some(root)).map_or(0, |t| content_kids(t).len());
            }
            node.children.push(slide_node);
        }
        if let Some(pres) = pres {
            if let Some(first) = int(pres.attr("firstSlideNum")).filter(|f| *f != 1) {
                node.set("firstSlideNum", Value::Int(first));
            }
            if boolean(pres.attr("rtl")) == Some(true) {
                node.str("direction", "rtl");
            }
            if boolean(pres.attr("compatMode")) == Some(true) {
                node.set("compatMode", Value::Bool(true));
            }
            if boolean(pres.attr("removePersonalInfoOnSave")) == Some(true) {
                node.set("removePersonalInfo", Value::Bool(true));
            }
            let props = self
                .pkg
                .related(&self.pkg.main, "presProps")
                .into_iter()
                .next()
                .and_then(|p| self.root_of(&p));
            if let Some(props) = props {
                if let Some(print) = props.child(P, "prnPr") {
                    if let Some(w) = print.attr("prnWhat") {
                        node.str("print.what", w);
                    }
                    if let Some(m) = print.attr("clrMode") {
                        node.str("print.colorMode", m);
                    }
                    for (attr, key) in [
                        ("hiddenSlides", "print.hiddenSlides"),
                        ("scaleToFitPaper", "print.scaleToFitPaper"),
                        ("frameSlides", "print.frameSlides"),
                    ] {
                        if boolean(print.attr(attr)) == Some(true) {
                            node.set(key, Value::Bool(true));
                        }
                    }
                }
                if let Some(show) = props.child(P, "showPr") {
                    if boolean(show.attr("loop")) == Some(true) {
                        node.set("show.loop", Value::Bool(true));
                    }
                    for (attr, key) in [
                        ("showNarration", "show.narration"),
                        ("showAnimation", "show.animation"),
                        ("useTimings", "show.useTimings"),
                    ] {
                        if let Some(v) = boolean(show.attr(attr)) {
                            node.set(key, Value::Bool(v));
                        }
                    }
                }
            }
        }
        theme_properties(theme, &mut node);
        let app = self
            .pkg
            .related("/", "extended-properties")
            .into_iter()
            .next();
        extended_properties(app.as_deref().and_then(|a| self.root_of(a)), &mut node);
        node.child_count = node.children.len();
        Ok(node)
    }

    pub(super) fn theme(&self) -> Node {
        let mut node = Node::new("/theme", "theme");
        let first_master = self
            .pkg
            .related(&self.pkg.main, "slideMaster")
            .into_iter()
            .next();
        let theme = self.theme_of_master(first_master.as_deref());
        let elements = theme.and_then(|t| t.child(A, "themeElements"));
        let Some(scheme) = elements.and_then(|e| e.child(A, "clrScheme")) else {
            return node;
        };
        for (slot, key) in [
            ("dk1", "dk1"),
            ("lt1", "lt1"),
            ("dk2", "dk2"),
            ("lt2", "lt2"),
            ("accent1", "accent1"),
            ("accent2", "accent2"),
            ("accent3", "accent3"),
            ("accent4", "accent4"),
            ("accent5", "accent5"),
            ("accent6", "accent6"),
            ("hlink", "hyperlink"),
            ("folHlink", "followedhyperlink"),
        ] {
            let Some(e) = scheme.child(A, slot) else {
                continue;
            };
            let v = if let Some(rgb) = e.child(A, "srgbClr").and_then(|c| c.attr("val")) {
                Some(hex_color(rgb))
            } else {
                e.child(A, "sysClr")
                    .and_then(|s| s.attr("lastClr").or_else(|| s.attr("val")))
                    .map(hex_color)
            };
            if let Some(v) = v {
                node.str(key, v);
            }
        }
        let fonts = elements.and_then(|e| e.child(A, "fontScheme"));
        let face = |group: &str, kind: &str| {
            fonts
                .and_then(|f| f.child(A, group))
                .and_then(|g| g.child(A, kind))
                .and_then(|c| c.attr("typeface"))
                .filter(|v| !v.is_empty())
        };
        for (key, group, kind) in [
            ("headingFont", "majorFont", "latin"),
            ("bodyFont", "minorFont", "latin"),
            ("headingFont.ea", "majorFont", "ea"),
            ("bodyFont.ea", "minorFont", "ea"),
            ("headingFont.cs", "majorFont", "cs"),
            ("bodyFont.cs", "minorFont", "cs"),
        ] {
            if let Some(v) = face(group, kind) {
                node.str(key, v);
            }
        }
        if let Some(name) = scheme.attr("name") {
            node.str("name", name);
        }
        node
    }

    pub(super) fn slide_node(
        &self,
        path: &str,
        part: &str,
        num: usize,
        depth: usize,
    ) -> Result<Node, Fail> {
        let root = self.slide(part)?;
        let mut node = Node::new(path, "slide");
        node.preview = Some(self.slide_preview(part)?);
        if let Some(layout) = self.layout_name(part) {
            node.str("layout", layout);
        }
        let layout_type = self
            .layout_of(part)
            .and_then(|l| self.root_of(&l))
            .and_then(|l| l.attr("type"));
        if let Some(t) = layout_type {
            node.str("layoutType", t);
        }
        if let Some(name) = root
            .child(P, "cSld")
            .and_then(|c| c.attr("name"))
            .filter(|n| !n.is_empty())
        {
            node.str("name", name);
        }
        if boolean(root.attr("show")) == Some(false) {
            node.set("hidden", Value::Bool(true));
        }
        if boolean(root.attr("showMasterSp")) == Some(false) {
            node.set("showMasterShapes", Value::Bool(false));
        }
        self.background(root.child(P, "cSld"), &mut node, Some(part));
        transition(root, &mut node);
        self.header_footer(part, &mut node)?;
        if let Some(notes) = self.notes_text(part).filter(|n| !n.is_empty()) {
            node.str("notes", notes);
        }
        node.children = self.slide_children(part, num, depth)?;
        node.child_count = node.children.len();
        Ok(node)
    }
}
