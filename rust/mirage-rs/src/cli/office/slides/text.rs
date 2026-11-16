// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! A slide's text as OfficeCLI reads it: a shape's text with its breaks
//! and fields, paragraph spacing and bullets, and the run properties it
//! names past the ones it reads itself.

use super::super::node::{Node, Value};
use super::super::tree::{A, E, M, P, canonical_xml, outer_xml, schema_ordered};
use super::super::units::{EMU_PER_PT, f2, fmt, format_emu, format_line_width, round_even};
use super::color::read_color;
use super::{A14, boolean, cnvpr_of, int, long};

pub(super) fn indent_points(emu: i64) -> String {
    format!("{}pt", fmt(emu as f64 / EMU_PER_PT, 4))
}

pub(super) fn line_spacing_percent(val: i64) -> String {
    format!("{}x", fmt(val as f64 / 100_000.0, 5))
}

pub(super) fn hundredths_points(val: i64) -> String {
    format!("{}pt", f2(val as f64 / 100.0))
}

/// A percentage value as thousandths: `90000`, or `90%` as 90000.
pub(super) fn percent_val(e: Option<E<'_>>) -> Option<i64> {
    let raw = e?.attr("val").filter(|v| !v.is_empty())?;
    match raw.strip_suffix('%') {
        Some(pct) => pct
            .trim()
            .parse::<f64>()
            .ok()
            .map(|p| round_even(p * 1000.0) as i64),
        None => int(Some(raw)),
    }
}

/// A paragraph alignment as a shape's readers name it.
pub(super) fn align_name(algn: Option<&str>) -> String {
    match algn {
        None | Some("l" | "") => "left",
        Some("ctr") => "center",
        Some("r") => "right",
        Some("just") => "justify",
        Some(other) => return other.to_string(),
    }
    .to_string()
}

/// A paragraph alignment as the direct paragraph and cell readers name it.
pub(super) fn normalize_alignment(algn: &str) -> String {
    match algn {
        "l" => "left",
        "r" => "right",
        "ctr" => "center",
        "just" => "justify",
        "dist" => "distributed",
        other => return other.to_string(),
    }
    .to_string()
}

pub(super) fn underline_name(u: &str) -> String {
    match u {
        "sng" => "single",
        "dbl" => "double",
        other => other,
    }
    .to_string()
}

pub(super) fn strike_name(s: &str) -> &'static str {
    match s {
        "dblStrike" => "double",
        "noStrike" => "none",
        _ => "single",
    }
}

pub(super) fn cap_name(cap: &str) -> String {
    match cap {
        "rnd" => "round",
        "sq" => "square",
        other => other,
    }
    .to_string()
}

const BULLET_CHILDREN: [&str; 11] = [
    "buClrTx",
    "buClr",
    "buSzTx",
    "buSzPct",
    "buSzPts",
    "buFontTx",
    "buFont",
    "buNone",
    "buAutoNum",
    "buChar",
    "buBlip",
];

fn bullet_raw(ppr: E<'_>) -> Option<String> {
    let out: String = ppr
        .elements()
        .filter(|c| BULLET_CHILDREN.contains(&c.name()))
        .map(canonical_xml)
        .collect();
    (!out.is_empty()).then_some(out)
}

fn list_style(ppr: E<'_>) -> Option<String> {
    if ppr.child(A, "buNone").is_some() {
        return Some("none".to_string());
    }
    if let Some(ch) = ppr.child(A, "buChar") {
        let c = ch.attr("char").unwrap_or("•");
        return Some(
            match c {
                "•" | "●" | "○" => "bullet",
                "–" | "—" | "-" => "dash",
                "►" | "▶" | "▸" | "➤" => "arrow",
                "✓" | "✔" => "check",
                "★" | "☆" | "⭐" => "star",
                other => other,
            }
            .to_string(),
        );
    }
    let auto = ppr.child(A, "buAutoNum").and_then(|a| a.attr("type"))?;
    for (prefix, name) in [
        ("arabic", "numbered"),
        ("romanLc", "romanLc"),
        ("romanUc", "romanUc"),
        ("alphaLc", "alphaLc"),
        ("alphaUc", "alphaUc"),
    ] {
        if let Some(rest) = auto.strip_prefix(prefix) {
            let ok = if prefix == "arabic" {
                matches!(rest, "Period" | "ParenR" | "Plain" | "ParenBoth")
            } else {
                matches!(rest, "Period" | "ParenR" | "ParenBoth")
            };
            if ok {
                return Some(name.to_string());
            }
        }
    }
    Some(auto.to_string())
}

fn list_keyword(ppr: E<'_>) -> Option<String> {
    if ppr.child(A, "buChar").is_some() && ppr.child(A, "buFont").is_some() {
        return None;
    }
    list_style(ppr)
}

pub(super) fn tabs(ppr: E<'_>) -> Option<String> {
    let parts: Vec<String> = ppr
        .child(A, "tabLst")
        .map(|l| l.children(A, "tab"))
        .unwrap_or_default()
        .into_iter()
        .filter_map(|tab| {
            let pos = long(tab.attr("pos"))?;
            Some(format!(
                "{}:{}",
                indent_points(pos),
                tab.attr("algn").unwrap_or("l")
            ))
        })
        .collect();
    (!parts.is_empty()).then(|| parts.join(","))
}

/// A paragraph's bullet: its raw XML with its keyword, or the keyword alone.
pub(super) fn bullets(ppr: E<'_>, node: &mut Node) {
    match bullet_raw(ppr) {
        Some(raw) => {
            node.str("bulletRaw", raw);
            if let Some(canon) = list_keyword(ppr) {
                node.str("list", canon);
            }
        }
        None => {
            if let Some(list) = list_style(ppr) {
                node.str("list", list);
            }
        }
    }
}

pub(super) fn spacing(ppr: Option<E<'_>>, node: &mut Node) {
    let Some(ppr) = ppr else { return };
    let ln = ppr.child(A, "lnSpc");
    if let Some(pct) = percent_val(ln.and_then(|l| l.child(A, "spcPct"))) {
        node.str("lineSpacing", line_spacing_percent(pct));
    }
    if let Some(pts) = int(ln
        .and_then(|l| l.child(A, "spcPts"))
        .and_then(|p| p.attr("val")))
    {
        node.str("lineSpacing", hundredths_points(pts));
    }
    let pts = |name: &str| {
        int(ppr
            .child(A, name)
            .and_then(|s| s.child(A, "spcPts"))
            .and_then(|p| p.attr("val")))
    };
    if let Some(sb) = pts("spcBef") {
        node.str("spaceBefore", hundredths_points(sb));
    }
    if let Some(sa) = pts("spcAft") {
        node.str("spaceAfter", hundredths_points(sa));
    }
}

pub(super) fn break_props(ppr: Option<E<'_>>, node: &mut Node) {
    let Some(ppr) = ppr else { return };
    if let Some(ea) = boolean(ppr.attr("eaLnBrk")) {
        node.str("eaLnBrk", if ea { "1" } else { "0" });
    }
    if let Some(latin) = boolean(ppr.attr("latinLnBrk")) {
        node.str("latinLnBrk", if latin { "1" } else { "0" });
    }
    if let Some(fa) = ppr.attr("fontAlgn").filter(|v| !v.is_empty()) {
        node.str("fontAlgn", fa);
    }
    if let Some(tab) = long(ppr.attr("defTabSz")) {
        node.str("defTabSz", format_emu(tab));
    }
}

pub(super) fn run_text(run: E<'_>) -> String {
    run.child(A, "t").map(|t| t.text()).unwrap_or_default()
}

pub(super) fn dynamic_field(t: &str) -> bool {
    !t.is_empty() && (t == "slidenum" || t.to_lowercase().starts_with("datetime"))
}

fn has_math(e: E<'_>) -> bool {
    if e.name() == "m" && e.ns() == A14 {
        return true;
    }
    if e.name() == "AlternateContent" {
        if e.descendants()
            .iter()
            .any(|d| d.name() == "oMath" || d.name() == "oMathPara")
        {
            return true;
        }
        return outer_xml(e).contains("oMath");
    }
    false
}

fn math_text(e: E<'_>) -> String {
    e.descendants_named(M, "t")
        .iter()
        .map(|t| t.text())
        .collect()
}

/// A shape's text: its paragraphs a line each, a break as `\v`, a field's
/// cached text, an equation as its plain text.
pub(super) fn shape_text(shape: E<'_>) -> String {
    let Some(body) = shape.child(P, "txBody") else {
        return String::new();
    };
    let mut lines = Vec::new();
    for para in body.children(A, "p") {
        let mut line = String::new();
        for c in para.elements() {
            if c.is(A, "r") {
                line.push_str(&run_text(c));
            } else if c.is(A, "br") {
                line.push('\u{b}');
            } else if c.is(A, "fld") {
                let cached: String = c.children(A, "t").iter().map(|t| t.text()).collect();
                let t = c.attr("type").unwrap_or_default();
                if !cached.is_empty() {
                    line.push_str(&cached);
                } else if dynamic_field(t) {
                    line.push_str(&format!("#OCLI_NOTEVAL!{{{t}}}"));
                }
            } else if has_math(c) {
                line.push_str(&math_text(c));
            }
        }
        lines.push(line);
    }
    lines.join("\n")
}

pub(super) fn cell_text(cell: E<'_>) -> String {
    let Some(body) = cell.child(A, "txBody") else {
        return String::new();
    };
    let paras = body.children(A, "p");
    if paras.is_empty() {
        return body.text();
    }
    paras
        .iter()
        .map(|p| {
            let mut out = String::new();
            for c in p.elements() {
                if c.is(A, "r") {
                    out.push_str(&run_text(c));
                } else if c.is(A, "br") {
                    out.push('\u{b}');
                }
            }
            if out.is_empty() { p.text() } else { out }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub(super) fn shape_name(shape: E<'_>) -> String {
    cnvpr_of(shape)
        .and_then(|c| c.attr("name"))
        .unwrap_or("?")
        .to_string()
}

const RUN_CURATED_ATTRS: [&str; 8] = ["b", "i", "u", "strike", "sz", "spc", "baseline", "rtl"];
const RUN_BOOL_ATTRS: [&str; 8] = [
    "b",
    "i",
    "noProof",
    "normalizeH",
    "dirty",
    "err",
    "smtClean",
    "kumimoji",
];
const RUN_CURATED_CHILDREN: [&str; 8] = [
    "latin",
    "ea",
    "cs",
    "solidFill",
    "gradFill",
    "hlinkClick",
    "effectLst",
    "ln",
];
const RUN_ONLY_ATTRS: [&str; 6] = ["err", "dirty", "smtClean", "lang", "normalizeH", "kern"];

/// The run properties OfficeCLI names past those it reads itself.
pub(super) fn unknown_run_props(rpr: Option<E<'_>>, node: &mut Node, shape_level: bool) {
    let Some(rpr) = rpr else { return };
    for a in schema_ordered(rpr) {
        let name = a.name.as_str();
        if name.is_empty()
            || RUN_CURATED_ATTRS.contains(&name)
            || (shape_level && RUN_ONLY_ATTRS.contains(&name))
            || node.has(name)
        {
            continue;
        }
        if RUN_BOOL_ATTRS.contains(&name) {
            let on = matches!(a.value.as_str(), "1" | "true" | "True");
            node.str(name, if on { "true" } else { "false" });
        } else {
            node.str(name, a.value.clone());
        }
    }
    for c in rpr.elements() {
        let name = c.name();
        if RUN_CURATED_CHILDREN.contains(&name) || node.has(name) || c.elements().next().is_some() {
            continue;
        }
        let val = c
            .attrs()
            .iter()
            .rev()
            .find(|a| a.name.eq_ignore_ascii_case("val"))
            .map(|a| a.value.clone());
        match val {
            Some(v) => node.str(name, v),
            None if c.attrs().is_empty() => node.set(name, Value::Bool(true)),
            None => {}
        }
    }
}

/// A run's text outline: its width and color, and its raw XML when it holds more.
pub(super) fn outline(ln: E<'_>, node: &mut Node) {
    let width = long(ln.attr("w")).map(format_line_width);
    let color = read_color(ln.child(A, "solidFill"));
    if let Some(w) = &width {
        node.str("textOutline.width", w.clone());
    }
    if let Some(c) = &color {
        node.str("textOutline.color", c.clone());
    }
    let summary = match (&width, &color) {
        (Some(w), Some(c)) => format!("{w}:{c}"),
        (Some(w), None) => w.clone(),
        (None, Some(c)) => c.clone(),
        (None, None) => "true".to_string(),
    };
    node.str("textOutline", summary);
    if ln.elements().any(|c| !c.is(A, "solidFill")) || ln.attrs().iter().any(|a| a.name != "w") {
        node.str("textOutlineRaw", outer_xml(ln));
    }
}

pub(super) fn underline_detail(rpr: E<'_>, node: &mut Node) {
    if let Some(ufill) = rpr.child(A, "uFill") {
        if let Some(c) = read_color(ufill.child(A, "solidFill")) {
            node.str("underline.color", c);
        }
    }
    if let Some(uln) = rpr.child(A, "uLn") {
        if !node.has("underline.color") {
            if let Some(c) = read_color(uln.child(A, "solidFill")) {
                node.str("underline.color", c);
            }
        }
        if let Some(w) = long(uln.attr("w")) {
            node.str("underline.width", format_line_width(w));
        }
    }
}

/// A custom geometry's path as `M x,y L x,y C … Z`.
pub(super) fn custom_path(geom: E<'_>) -> String {
    let Some(list) = geom.child(A, "pathLst") else {
        return "custom".to_string();
    };
    let pt = |p: Option<E<'_>>| {
        format!(
            "{},{}",
            p.and_then(|p| p.attr("x")).unwrap_or("0"),
            p.and_then(|p| p.attr("y")).unwrap_or("0")
        )
    };
    let mut out = Vec::new();
    for path in list.children(A, "path") {
        for c in path.elements() {
            if c.is(A, "moveTo") {
                if let Some(p) = c.child(A, "pt") {
                    out.push(format!("M{}", pt(Some(p))));
                }
            } else if c.is(A, "lnTo") {
                if let Some(p) = c.child(A, "pt") {
                    out.push(format!("L{}", pt(Some(p))));
                }
            } else if c.is(A, "cubicBezTo") {
                let ps = c.children(A, "pt");
                if ps.len() >= 3 {
                    out.push(format!(
                        "C{} {} {}",
                        pt(Some(ps[0])),
                        pt(Some(ps[1])),
                        pt(Some(ps[2]))
                    ));
                }
            } else if c.is(A, "quadBezTo") {
                let ps = c.children(A, "pt");
                if ps.len() >= 2 {
                    out.push(format!("Q{} {}", pt(Some(ps[0])), pt(Some(ps[1]))));
                }
            } else if c.is(A, "arcTo") {
                out.push(format!(
                    "A{},{}",
                    c.attr("wR").unwrap_or("0"),
                    c.attr("hR").unwrap_or("0")
                ));
            } else if c.is(A, "close") {
                out.push("Z".to_string());
            }
        }
    }
    out.join(" ")
}

/// A cell's or body's text direction as OfficeCLI names it.
pub(super) fn text_direction(vert: &str) -> String {
    match vert {
        "horz" => "horizontal",
        "vert" => "vertical90",
        "vert270" => "vertical270",
        "wordArtVert" => "stacked",
        other => other,
    }
    .to_string()
}
