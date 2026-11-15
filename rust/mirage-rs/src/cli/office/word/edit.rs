// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! Changing a Word document as OfficeCLI's Word handler does: every
//! paragraph given a `w14:paraId` and `w14:textId` when the document is
//! opened to change, paragraphs, runs and tables added, properties set in
//! schema order, and elements removed, moved and swapped.

use std::collections::HashSet;

use super::super::media::{self, Media};
use super::super::package::Pkg;
use super::super::slides::edit::emu;
use super::super::tree::{
    self, Id, Kid, MC, Tree, W, W14, WP, XML, insert_at, remove_attr, set_attr_ns,
};
use super::super::{Fail, SetFail};
use super::{Word, fail};

/// The order `w:rPr` holds its children in.
const RPR_ORDER: &[&str] = &[
    "rStyle",
    "rFonts",
    "b",
    "bCs",
    "i",
    "iCs",
    "caps",
    "smallCaps",
    "strike",
    "dstrike",
    "outline",
    "shadow",
    "emboss",
    "imprint",
    "noProof",
    "snapToGrid",
    "vanish",
    "webHidden",
    "color",
    "spacing",
    "w",
    "kern",
    "position",
    "sz",
    "szCs",
    "highlight",
    "u",
    "effect",
    "bdr",
    "shd",
    "fitText",
    "vertAlign",
    "rtl",
    "cs",
    "em",
    "lang",
    "eastAsianLayout",
    "specVanish",
    "oMath",
];

/// The order `w:pPr` holds its children in.
const PPR_ORDER: &[&str] = &[
    "pStyle",
    "keepNext",
    "keepLines",
    "pageBreakBefore",
    "framePr",
    "widowControl",
    "numPr",
    "suppressLineNumbers",
    "pBdr",
    "shd",
    "tabs",
    "suppressAutoHyphens",
    "kinsoku",
    "wordWrap",
    "overflowPunct",
    "topLinePunct",
    "autoSpaceDE",
    "autoSpaceDN",
    "bidi",
    "adjustRightInd",
    "snapToGrid",
    "spacing",
    "ind",
    "contextualSpacing",
    "mirrorIndents",
    "suppressOverlap",
    "jc",
    "textDirection",
    "textAlignment",
    "textboxTightWrap",
    "outlineLvl",
    "divId",
    "cnfStyle",
    "rPr",
    "sectPr",
    "pPrChange",
];

/// The order `w:tcPr` holds its children in.
const TCPR_ORDER: &[&str] = &[
    "cnfStyle",
    "tcW",
    "gridSpan",
    "hMerge",
    "vMerge",
    "tcBorders",
    "shd",
    "noWrap",
    "tcMar",
    "textDirection",
    "tcFitText",
    "vAlign",
    "hideMark",
    "headers",
    "cellIns",
    "cellDel",
    "cellMerge",
    "tcPrChange",
];

/// The id allocator OfficeCLI's handler seeds when it opens a document to
/// change: past every paraId, textId and revision id in use, and never
/// below 0x100000.
pub(in super::super) struct Ids {
    next: u32,
    used: HashSet<String>,
}

impl Ids {
    fn take(&mut self) -> String {
        loop {
            let id = format!("{:08X}", self.next);
            self.next += 1;
            if self.next > 0x7FFF_FFFF {
                self.next = 0x10_0000;
            }
            if self.used.insert(id.to_lowercase()) {
                return id;
            }
        }
    }
}

/// The parts that hold paragraphs: the body, headers, footers, notes and
/// comments.
fn paragraph_parts(pkg: &Pkg<'_>) -> Vec<String> {
    let main = pkg.main.clone();
    let mut parts = vec![main.clone()];
    for kind in ["header", "footer", "footnotes", "endnotes", "comments"] {
        parts.extend(pkg.related(&main, kind));
    }
    parts
}

/// Each paragraph of `t`, in document order, but the mirrored copies a
/// floating text box keeps under `mc:Fallback`.
fn paragraphs(t: &Tree) -> Vec<Id> {
    let mut out = Vec::new();
    let mut stack = vec![t.root];
    while let Some(id) = stack.pop() {
        let el = &t.nodes[id];
        if &*el.ns == MC && el.name == "Fallback" {
            continue;
        }
        if &*el.ns == W && el.name == "p" {
            out.push(id);
        }
        for kid in el.kids.iter().rev() {
            if let Kid::El(c) = kid {
                stack.push(*c);
            }
        }
    }
    out
}

fn attr(t: &Tree, id: Id, ns: &str, name: &str) -> Option<String> {
    t.nodes[id]
        .attrs
        .iter()
        .find(|a| &*a.ns == ns && a.name == name)
        .map(|a| a.value.clone())
}

const REVISIONS: &[&str] = &[
    "ins",
    "del",
    "moveFrom",
    "moveTo",
    "rPrChange",
    "pPrChange",
    "sectPrChange",
    "tblPrChange",
    "tcPrChange",
    "trPrChange",
];

/// Every paragraph given a paraId and textId it lacks, a duplicate paraId
/// given a new one, and `w14` made ignorable: what OfficeCLI does to a
/// document it opens to change. Returns the allocator, seeded past every
/// id in use.
pub(in super::super) fn prepare(pkg: &mut Pkg<'_>) -> Ids {
    let parts = paragraph_parts(pkg);
    let mut used = HashSet::new();
    let mut max = 0u32;
    let mut cleared: Vec<(String, Id)> = Vec::new();
    for part in &parts {
        let Some(t) = pkg.xml(part) else { continue };
        let mut seen = HashSet::new();
        for p in paragraphs(t) {
            if let Some(id) = attr(t, p, W14, "paraId").filter(|v| !v.is_empty()) {
                if seen.insert(id.to_lowercase()) && used.insert(id.to_lowercase()) {
                    max = max.max(u32::from_str_radix(&id, 16).unwrap_or(0));
                } else {
                    cleared.push((part.clone(), p));
                }
            }
            if let Some(id) = attr(t, p, W14, "textId").filter(|v| !v.is_empty()) {
                used.insert(id.to_lowercase());
                max = max.max(u32::from_str_radix(&id, 16).unwrap_or(0));
            }
        }
        for (id, el) in t.nodes.iter().enumerate() {
            let _ = id;
            if &*el.ns == W && REVISIONS.contains(&el.name.as_str()) {
                if let Some(rid) = el
                    .attrs
                    .iter()
                    .find(|a| a.name == "id")
                    .and_then(|a| a.value.parse::<u32>().ok())
                {
                    used.insert(format!("{rid:08x}"));
                    max = max.max(rid);
                }
            }
        }
    }
    let mut ids = Ids {
        next: (max.saturating_add(1)).max(0x10_0000),
        used,
    };
    if ids.next > 0x7FFF_FFFF {
        ids.next = 0x10_0000;
    }
    for part in &parts {
        let needs = pkg.xml(part).is_some_and(|t| {
            paragraphs(t).into_iter().any(|p| {
                attr(t, p, W14, "paraId").is_none_or(|v| v.is_empty())
                    || attr(t, p, W14, "textId").is_none_or(|v| v.is_empty())
            })
        }) || cleared.iter().any(|(c, _)| c == part);
        if !needs {
            continue;
        }
        let Some(t) = pkg.xml_mut(part) else { continue };
        for (c, p) in &cleared {
            if c == part {
                remove_attr(t, *p, W14, "paraId");
            }
        }
        for p in paragraphs(t) {
            if attr(t, p, W14, "paraId").is_none_or(|v| v.is_empty()) {
                let id = ids.take();
                set_attr_ns(t, p, W14, "paraId", &id);
            }
            if attr(t, p, W14, "textId").is_none_or(|v| v.is_empty()) {
                let id = ids.take();
                set_attr_ns(t, p, W14, "textId", &id);
            }
        }
    }
    let main = pkg.main.clone();
    if let Some(t) = pkg.xml_mut(&main) {
        let root = t.root;
        let ignorable = attr(t, root, MC, "Ignorable").unwrap_or_default();
        if !ignorable.split_whitespace().any(|p| p == "w14") {
            let value = if ignorable.is_empty() {
                "w14".to_string()
            } else {
                format!("{ignorable} w14")
            };
            set_attr_ns(t, root, MC, "Ignorable", &value);
        }
        for (prefix, ns) in [("mc", MC), ("w14", W14)] {
            if !t.nodes[root].decls.iter().any(|(p, _)| p == prefix) {
                t.nodes[root]
                    .decls
                    .push((prefix.to_string(), ns.to_string()));
            }
        }
    }
    ids
}

/// A new `w:` element, detached.
fn el(t: &mut Tree, name: &str) -> Id {
    t.create(W, name, "")
}

/// A `w:` attribute set.
fn wattr(t: &mut Tree, id: Id, name: &str, value: &str) {
    set_attr_ns(t, id, W, name, value);
}

/// The first `w:name` child of `parent`.
fn child(t: &Tree, parent: Id, name: &str) -> Option<Id> {
    t.nodes[parent].kids.iter().find_map(|k| match k {
        Kid::El(c) if &*t.nodes[*c].ns == W && t.nodes[*c].name == name => Some(*c),
        _ => None,
    })
}

/// Each `w:` child of `parent`.
fn children(t: &Tree, parent: Id) -> Vec<Id> {
    t.nodes[parent]
        .kids
        .iter()
        .filter_map(|k| match k {
            Kid::El(c) => Some(*c),
            _ => None,
        })
        .collect()
}

fn is(t: &Tree, id: Id, name: &str) -> bool {
    &*t.nodes[id].ns == W && t.nodes[id].name == name
}

/// `parent`'s `w:name` child, made where `order` puts it when absent.
fn ensure(t: &mut Tree, parent: Id, name: &str, order: &[&str]) -> Id {
    if let Some(c) = child(t, parent, name) {
        return c;
    }
    let c = el(t, name);
    place_ordered(t, parent, c, order);
    c
}

/// `c` put among `parent`'s children where `order` puts its name.
fn place_ordered(t: &mut Tree, parent: Id, c: Id, order: &[&str]) {
    let rank = |name: &str| order.iter().position(|n| *n == name).unwrap_or(order.len());
    let mine = rank(&t.nodes[c].name.clone());
    let at = t.nodes[parent].kids.iter().position(|k| match k {
        Kid::El(x) => rank(&t.nodes[*x].name) > mine,
        Kid::Text(_) => false,
    });
    insert_at(t, parent, at, c);
}

/// `parent`'s `w:name` child replaced by a fresh empty one in order.
fn replace(t: &mut Tree, parent: Id, name: &str, order: &[&str]) -> Id {
    if let Some(old) = child(t, parent, name) {
        t.detach(old);
    }
    ensure(t, parent, name, order)
}

fn drop_child(t: &mut Tree, parent: Id, name: &str) {
    while let Some(c) = child(t, parent, name) {
        t.detach(c);
    }
}

fn truthy(v: &str) -> bool {
    matches!(
        v.trim().to_ascii_lowercase().as_str(),
        "true" | "1" | "yes" | "on" | "y"
    )
}

fn explicit_false(v: &str) -> bool {
    matches!(
        v.trim().to_ascii_lowercase().as_str(),
        "false" | "0" | "off" | "no" | "n"
    )
}

/// A font size in points, as OfficeCLI reads one.
fn font_size(value: &str) -> Result<f64, Fail> {
    let mut v = value.trim();
    if v.len() >= 2 && v[v.len() - 2..].eq_ignore_ascii_case("pt") {
        v = v[..v.len() - 2].trim();
    }
    if v.contains(',') {
        return Err(fail(format!(
            "Invalid font size: '{value}'. Comma is not allowed — use '.' as decimal separator (e.g., '10.5')."
        )));
    }
    let n: f64 = v
        .parse()
        .ok()
        .filter(|n: &f64| n.is_finite())
        .ok_or_else(|| {
            fail(format!(
                "Invalid font size: '{value}'. Expected a finite number (e.g., '12', '10.5', '14pt')."
            ))
        })?;
    if n <= 0.0 {
        return Err(fail(format!(
            "Invalid font size: '{value}'. Font size must be greater than 0."
        )));
    }
    if n < 0.5 {
        return Err(fail(format!(
            "Invalid font size: '{value}'. Minimum font size is 0.5pt (one half-point)."
        )));
    }
    if n > 4000.0 {
        return Err(fail(format!(
            "Invalid font size: '{value}'. Maximum font size is 4000pt (Office cap)."
        )));
    }
    Ok(n)
}

fn half_points(value: &str) -> Result<String, Fail> {
    Ok(((font_size(value)? * 2.0).round() as i64).to_string())
}

fn justification(value: &str) -> Result<&'static str, Fail> {
    Ok(match value.to_ascii_lowercase().as_str() {
        "left" | "start" => "left",
        "center" => "center",
        "right" | "end" => "right",
        "justify" | "both" => "both",
        "distribute" => "distribute",
        "thaidistribute" => "thaiDistribute",
        "highkashida" => "highKashida",
        "mediumkashida" => "mediumKashida",
        "lowkashida" => "lowKashida",
        "numtab" => "numTab",
        _ => {
            return Err(fail(format!(
                "Invalid alignment value: '{value}'. Valid values: left, center, right, justify, distribute, thaiDistribute, start, end."
            )));
        }
    })
}

fn underline(value: &str) -> Result<String, Fail> {
    let v = value.trim();
    let mapped = match v.to_ascii_lowercase().as_str() {
        "true" | "single" | "1" => "single",
        "false" | "none" | "0" | "" => "none",
        "double" => "double",
        "thick" => "thick",
        "dotted" => "dotted",
        "dottedheavy" | "dotted-heavy" | "dotted_heavy" => "dottedHeavy",
        "dash" | "dashed" => "dash",
        "dashedheavy" | "dashheavy" => "dashedHeavy",
        "dashlong" | "longdash" => "dashLong",
        "dashlongheavy" | "longdashheavy" => "dashLongHeavy",
        "dotdash" | "dashdot" => "dotDash",
        "dotdashheavy" | "dashdotheavy" => "dashDotHeavy",
        "dotdotdash" | "dashdotdot" => "dotDotDash",
        "dotdotdashheavy" | "dashdotdotheavy" => "dashDotDotHeavy",
        "wave" | "wavy" => "wave",
        "waveheavy" | "wavyheavy" => "wavyHeavy",
        "wavedouble" | "wavydouble" | "doublewave" => "wavyDouble",
        "words" | "word" => "words",
        _ => v,
    };
    const VALID: &[&str] = &[
        "single",
        "double",
        "thick",
        "dotted",
        "dottedHeavy",
        "dash",
        "dashedHeavy",
        "dashLong",
        "dashLongHeavy",
        "dotDash",
        "dashDotHeavy",
        "dotDotDash",
        "dashDotDotHeavy",
        "wave",
        "wavyHeavy",
        "wavyDouble",
        "words",
        "none",
    ];
    if !VALID.contains(&mapped) {
        return Err(fail(format!(
            "Invalid underline value: '{value}'. Valid values: single, double, thick, dotted, dottedHeavy, dash, dashedHeavy, dashLong, dashLongHeavy, dotDash, dashDotHeavy, dotDotDash, dashDotDotHeavy, wave, wavyHeavy, wavyDouble, words, none."
        )));
    }
    Ok(mapped.to_string())
}

fn highlight(value: &str) -> Result<String, Fail> {
    const VALID: &[&str] = &[
        "yellow",
        "green",
        "cyan",
        "magenta",
        "blue",
        "red",
        "darkBlue",
        "darkCyan",
        "darkGreen",
        "darkMagenta",
        "darkRed",
        "darkYellow",
        "darkGray",
        "lightGray",
        "black",
        "white",
        "none",
    ];
    VALID
        .iter()
        .find(|v| v.eq_ignore_ascii_case(value))
        .map(|v| (*v).to_string())
        .ok_or_else(|| fail(format!("Invalid 'highlight' value '{value}'. Valid values: yellow, green, cyan, magenta, blue, red, darkBlue, darkCyan, darkGreen, darkMagenta, darkRed, darkYellow, darkGray, lightGray, black, white, none.")))
}

/// A color as `w:color` stores it: six hex digits, upper case.
fn hex(value: &str) -> Result<String, Fail> {
    let v = value.trim().trim_start_matches('#');
    let v = if v.len() == 8 { &v[2..] } else { v };
    let v = if v.len() == 3 {
        v.chars().flat_map(|c| [c, c]).collect::<String>()
    } else {
        v.to_string()
    };
    if v.len() == 6 && v.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(v.to_ascii_uppercase());
    }
    named_color(value)
        .map(str::to_string)
        .ok_or_else(|| fail(format!("Invalid color value: '{value}'. Expected a hex color (e.g. FF0000, #FF0000) or a color name.")))
}

fn named_color(name: &str) -> Option<&'static str> {
    Some(match name.trim().to_ascii_lowercase().as_str() {
        "black" => "000000",
        "white" => "FFFFFF",
        "red" => "FF0000",
        "green" => "008000",
        "blue" => "0000FF",
        "yellow" => "FFFF00",
        "cyan" | "aqua" => "00FFFF",
        "magenta" | "fuchsia" => "FF00FF",
        "gray" | "grey" => "808080",
        "orange" => "FFA500",
        "purple" => "800080",
        "lime" => "00FF00",
        "navy" => "000080",
        "silver" => "C0C0C0",
        "maroon" => "800000",
        "olive" => "808000",
        "teal" => "008080",
        _ => return None,
    })
}

/// A length in twips, as OfficeCLI's Word spacing parsers read one: `pt`,
/// `cm`, `in` or `dxa`, or bare twips.
fn twips(value: &str) -> Result<i64, Fail> {
    let v = value.trim().to_ascii_lowercase();
    let (num, scale) = if let Some(n) = v.strip_suffix("pt") {
        (n, 20.0)
    } else if let Some(n) = v.strip_suffix("cm") {
        (n, 72.0 / 2.54 * 20.0)
    } else if let Some(n) = v.strip_suffix("in") {
        (n, 1440.0)
    } else if let Some(n) = v.strip_suffix("dxa") {
        (n, 1.0)
    } else {
        (v.as_str(), 1.0)
    };
    let n: f64 = num.trim().parse().ok().filter(|n: &f64| n.is_finite()).ok_or_else(|| {
        fail(format!(
            "Invalid 'spacing' value '{value}'. Expected a finite number with optional unit (e.g. '12pt', '1.5x', '150%')."
        ))
    })?;
    if n < 0.0 {
        return Err(fail(format!(
            "Invalid spacing value '{value}'. Spacing must be non-negative."
        )));
    }
    Ok((n * scale).round() as i64)
}

/// A line spacing as `w:spacing` writes it: the line value and whether it
/// is a multiple of a single line (`1.5x`, `150%`, a bare number) or an
/// exact length.
fn line_spacing(value: &str) -> Result<(i64, bool), Fail> {
    let v = value.trim().to_ascii_lowercase();
    let number = |s: &str| -> Result<f64, Fail> {
        s.trim()
            .parse::<f64>()
            .ok()
            .filter(|n| n.is_finite() && *n != 0.0)
            .ok_or_else(|| {
                fail(format!(
                    "Invalid 'lineSpacing' value '{value}'. Line spacing must not be zero."
                ))
            })
    };
    if let Some(n) = v.strip_suffix('x') {
        return Ok(((number(n)? * 240.0).round() as i64, true));
    }
    if let Some(n) = v.strip_suffix('%') {
        return Ok(((number(n)? / 100.0 * 240.0).round() as i64, true));
    }
    if v.ends_with("pt") || v.ends_with("cm") || v.ends_with("in") {
        return Ok((twips(&v)?, false));
    }
    Ok(((number(&v)? * 240.0).round() as i64, true))
}

/// The props `set` and `add` read off a run, written into `rpr`. Returns
/// the keys it took.
fn apply_run(
    t: &mut Tree,
    rpr: Id,
    props: &[(String, String)],
    adding: bool,
) -> Result<Vec<String>, Fail> {
    let mut took = Vec::new();
    let get = |keys: &[&str]| {
        props
            .iter()
            .rev()
            .find(|(k, _)| keys.iter().any(|x| k.eq_ignore_ascii_case(x)))
            .map(|(k, v)| (k.clone(), v.clone()))
    };
    let mut fonts: Vec<(&str, String)> = Vec::new();
    if let Some((k, v)) = get(&["font", "font.name"]) {
        took.push(k);
        fonts.extend([("ascii", v.clone()), ("hAnsi", v.clone()), ("eastAsia", v)]);
    }
    if let Some((k, v)) = get(&["font.latin"]) {
        took.push(k);
        fonts.extend([("ascii", v.clone()), ("hAnsi", v)]);
    }
    if let Some((k, v)) = get(&["font.ea", "font.eastasia", "font.eastasian"]) {
        took.push(k);
        fonts.push(("eastAsia", v));
    }
    if let Some((k, v)) = get(&["font.cs", "font.complexscript", "font.complex"]) {
        took.push(k);
        fonts.push(("cs", v));
    }
    if !fonts.is_empty() {
        let rf = ensure(t, rpr, "rFonts", RPR_ORDER);
        for (slot, v) in fonts {
            wattr(t, rf, slot, &v);
        }
    }
    if let Some((k, v)) = get(&["rStyle", "rstyle"]) {
        took.push(k);
        let s = replace(t, rpr, "rStyle", RPR_ORDER);
        wattr(t, s, "val", &v);
    }
    if let Some((k, v)) = get(&["size", "font.size", "fontsize"]) {
        took.push(k);
        let hp = half_points(&v)?;
        let sz = replace(t, rpr, "sz", RPR_ORDER);
        wattr(t, sz, "val", &hp);
        if !adding {
            let cs = replace(t, rpr, "szCs", RPR_ORDER);
            wattr(t, cs, "val", &hp);
        }
    }
    if let Some((k, v)) = get(&["size.cs", "font.size.cs"]) {
        took.push(k);
        let hp = half_points(&v)?;
        let cs = replace(t, rpr, "szCs", RPR_ORDER);
        wattr(t, cs, "val", &hp);
    }
    let toggles: &[(&[&str], &str)] = &[
        (&["bold", "font.bold"], "b"),
        (&["bold.cs", "font.bold.cs"], "bCs"),
        (&["italic", "font.italic"], "i"),
        (&["italic.cs", "font.italic.cs"], "iCs"),
        (
            &[
                "strike",
                "strikethrough",
                "font.strike",
                "font.strikethrough",
            ],
            "strike",
        ),
        (&["caps", "allcaps"], "caps"),
        (&["smallcaps"], "smallCaps"),
        (&["dstrike", "doublestrike"], "dstrike"),
        (&["vanish", "hidden"], "vanish"),
        (&["outline"], "outline"),
        (&["shadow"], "shadow"),
        (&["emboss"], "emboss"),
        (&["imprint"], "imprint"),
        (&["noproof"], "noProof"),
    ];
    for (keys, name) in toggles {
        if let Some((k, v)) = get(keys) {
            took.push(k);
            if truthy(&v) {
                replace(t, rpr, name, RPR_ORDER);
            } else if adding && explicit_false(&v) {
                let e = replace(t, rpr, name, RPR_ORDER);
                wattr(t, e, "val", "false");
            } else {
                drop_child(t, rpr, name);
            }
        }
    }
    if let Some((k, v)) = get(&["color", "font.color"]) {
        took.push(k);
        let value = if v.eq_ignore_ascii_case("auto") {
            "auto".to_string()
        } else {
            hex(&v)?
        };
        let c = replace(t, rpr, "color", RPR_ORDER);
        wattr(t, c, "val", &value);
    }
    if let Some((k, v)) = get(&["underline", "font.underline"]) {
        took.push(k);
        let u = underline(&v)?;
        let e = replace(t, rpr, "u", RPR_ORDER);
        wattr(t, e, "val", &u);
    }
    if let Some((k, v)) = get(&["highlight"]) {
        took.push(k);
        let h = highlight(&v)?;
        let e = replace(t, rpr, "highlight", RPR_ORDER);
        wattr(t, e, "val", &h);
    }
    for (key, value) in [("superscript", "superscript"), ("subscript", "subscript")] {
        if let Some((k, v)) = get(&[key]) {
            took.push(k);
            if truthy(&v) {
                let e = replace(t, rpr, "vertAlign", RPR_ORDER);
                wattr(t, e, "val", value);
            } else {
                drop_child(t, rpr, "vertAlign");
            }
        }
    }
    if let Some((k, v)) = get(&["vertAlign", "vertalign"]) {
        took.push(k);
        let e = replace(t, rpr, "vertAlign", RPR_ORDER);
        wattr(t, e, "val", &v);
    }
    if let Some((k, v)) = get(&["shading", "shd", "fill"]) {
        took.push(k);
        shading(t, rpr, &v, RPR_ORDER)?;
    }
    Ok(took)
}

/// The shading patterns `w:shd` takes.
const PATTERNS: &[&str] = &[
    "clear",
    "solid",
    "nil",
    "pct5",
    "pct10",
    "pct12",
    "pct15",
    "pct20",
    "pct25",
    "pct30",
    "pct35",
    "pct37",
    "pct40",
    "pct45",
    "pct50",
    "pct55",
    "pct60",
    "pct62",
    "pct65",
    "pct70",
    "pct75",
    "pct80",
    "pct85",
    "pct87",
    "pct90",
    "pct95",
    "diagStripe",
    "reverseDiagStripe",
    "thinDiagStripe",
    "thinReverseDiagStripe",
    "horzStripe",
    "vertStripe",
    "thinHorzStripe",
    "thinVertStripe",
    "diagCross",
    "thinDiagCross",
    "horzCross",
    "thinHorzCross",
];

/// A `w:shd` written into `parent` from `FILL` or `PATTERN;FILL[;COLOR]`,
/// as OfficeCLI's `ParseShadingValue` reads one.
fn shading(t: &mut Tree, parent: Id, value: &str, order: &[&str]) -> Result<(), Fail> {
    let parts: Vec<&str> = value.split(';').collect();
    let is_hex = |s: &str| {
        let h = s.trim_start_matches('#');
        h.len() >= 6 && h.chars().all(|c| c.is_ascii_hexdigit())
    };
    let (pattern, fill, color) = match parts.as_slice() {
        [fill] => ("clear".to_string(), hex(fill)?, None),
        [first, ..] if is_hex(first) => ("clear".to_string(), hex(first)?, None),
        [pattern, fill, rest @ ..] => {
            if !PATTERNS.contains(pattern) {
                return Err(fail(format!(
                    "Invalid 'shading' pattern value: '{pattern}'. Valid ST_Shd values: clear, solid, nil, pct5/10/12/15/20/25/30/35/37/40/45/50/55/60/62/65/70/75/80/85/87/90/95, diagStripe, reverseDiagStripe, thinDiagStripe, thinReverseDiagStripe, horzStripe, vertStripe, thinHorzStripe, thinVertStripe, diagCross, thinDiagCross, horzCross, thinHorzCross."
                )));
            }
            let color = match rest.first().filter(|c| !c.is_empty()) {
                Some(c) => Some(hex(c)?),
                None => None,
            };
            (pattern.to_string(), hex(fill)?, color)
        }
        [] => return Ok(()),
    };
    let e = replace(t, parent, "shd", order);
    wattr(t, e, "val", &pattern);
    if let Some(c) = color {
        wattr(t, e, "color", &c);
    }
    wattr(t, e, "fill", &fill);
    Ok(())
}

/// The paragraph props `add` and `set` read, written into `ppr`; the keys
/// taken and any advisory warnings.
fn apply_paragraph(
    t: &mut Tree,
    ppr: Id,
    props: &[(String, String)],
    styles: &dyn Fn(&str) -> bool,
) -> Result<(Vec<String>, Vec<String>), Fail> {
    let mut took = Vec::new();
    let warnings = Vec::new();
    let get = |keys: &[&str]| {
        props
            .iter()
            .rev()
            .find(|(k, _)| keys.iter().any(|x| k.eq_ignore_ascii_case(x)))
            .map(|(k, v)| (k.clone(), v.clone()))
    };
    if let Some((k, v)) = get(&["style", "styleId", "styleid"]) {
        took.push(k);
        let _ = styles(&v);
        let s = replace(t, ppr, "pStyle", PPR_ORDER);
        wattr(t, s, "val", &v);
    }
    if let Some((k, v)) = get(&["align", "alignment", "jc"]) {
        took.push(k);
        let j = justification(&v)?;
        let e = replace(t, ppr, "jc", PPR_ORDER);
        wattr(t, e, "val", j);
    }
    for (keys, name) in [
        (&["keepNext", "keepnext"][..], "keepNext"),
        (
            &["keepLines", "keeplines", "keepTogether", "keeptogether"][..],
            "keepLines",
        ),
        (
            &["pageBreakBefore", "pagebreakbefore"][..],
            "pageBreakBefore",
        ),
        (&["widowControl", "widowcontrol"][..], "widowControl"),
        (
            &["contextualSpacing", "contextualspacing"][..],
            "contextualSpacing",
        ),
    ] {
        if let Some((k, v)) = get(keys) {
            took.push(k);
            if truthy(&v) {
                replace(t, ppr, name, PPR_ORDER);
            } else {
                drop_child(t, ppr, name);
            }
        }
    }
    let spacing: [(&[&str], &str); 2] = [
        (&["spaceBefore", "spacebefore"], "before"),
        (&["spaceAfter", "spaceafter"], "after"),
    ];
    for (keys, slot) in spacing {
        if let Some((k, v)) = get(keys) {
            took.push(k);
            let n = twips(&v)?;
            let e = ensure(t, ppr, "spacing", PPR_ORDER);
            wattr(t, e, slot, &n.to_string());
        }
    }
    if let Some((k, v)) = get(&["lineSpacing", "linespacing"]) {
        took.push(k);
        let (line, multiple) = line_spacing(&v)?;
        let e = ensure(t, ppr, "spacing", PPR_ORDER);
        wattr(t, e, "line", &line.to_string());
        wattr(t, e, "lineRule", if multiple { "auto" } else { "exact" });
    }
    let indents: [(&[&str], &str); 4] = [
        (
            &["leftIndent", "leftindent", "indentleft", "indent"],
            "left",
        ),
        (&["rightIndent", "rightindent", "indentright"], "right"),
        (&["firstLineIndent", "firstlineindent"], "firstLine"),
        (&["hangingIndent", "hangingindent", "hanging"], "hanging"),
    ];
    for (keys, slot) in indents {
        if let Some((k, v)) = get(keys) {
            took.push(k);
            let n = twips(&v)?;
            let e = ensure(t, ppr, "ind", PPR_ORDER);
            wattr(t, e, slot, &n.to_string());
        }
    }
    if let Some((k, v)) = get(&["outlineLevel", "outlineLvl", "outlinelevel", "outlinelvl"]) {
        took.push(k);
        let e = replace(t, ppr, "outlineLvl", PPR_ORDER);
        wattr(t, e, "val", v.trim());
    }
    Ok((took, warnings))
}

/// A run of `text`: a tab for each `\t`, a line break for each `\v`.
fn run_content(t: &mut Tree, run: Id, text: &str) {
    let mut chunk = String::new();
    let flush = |t: &mut Tree, chunk: &mut String| {
        if chunk.is_empty() {
            return;
        }
        let te = el(t, "t");
        set_attr_ns(t, te, XML, "space", "preserve");
        t.nodes[te].kids.push(Kid::Text(std::mem::take(chunk)));
        t.append(run, te);
    };
    for c in text.chars() {
        match c {
            '\t' => {
                flush(t, &mut chunk);
                let tab = el(t, "tab");
                t.append(run, tab);
            }
            '\u{0B}' => {
                flush(t, &mut chunk);
                let br = el(t, "br");
                t.append(run, br);
            }
            c => chunk.push(c),
        }
    }
    flush(t, &mut chunk);
}

/// Where `add` puts a new child of `parent`: before the `index`-th of the
/// children it counts, or last (before a body's closing `w:sectPr`).
fn insertion(
    t: &Tree,
    parent: Id,
    index: Option<usize>,
    counted: &dyn Fn(Id) -> bool,
) -> Option<usize> {
    let kids = &t.nodes[parent].kids;
    if let Some(n) = index {
        let mut seen = 0;
        for (i, k) in kids.iter().enumerate() {
            if let Kid::El(c) = k {
                if counted(*c) {
                    if seen == n {
                        return Some(i);
                    }
                    seen += 1;
                }
            }
        }
    }
    kids.iter()
        .position(|k| matches!(k, Kid::El(c) if is(t, *c, "sectPr")))
}

/// Body-level content an index counts: everything but the closing
/// `w:sectPr`.
fn block(t: &Tree, id: Id) -> bool {
    !is(t, id, "sectPr")
}

/// The path of paragraph `p` in the document as `get` spells it.
fn paragraph_path(pkg: &Pkg<'_>, part: &str, p: Id) -> String {
    let word = Word::new(pkg);
    let Some(t) = pkg.xml(part) else {
        return String::new();
    };
    let e = tree::E { t, id: p };
    let id = attr(t, p, W14, "paraId").unwrap_or_default();
    let mut prefix = String::new();
    if let Some(parent) = e.parent() {
        if !parent.is(W, "body") {
            prefix = container_path(&word, parent);
        } else {
            prefix = "/body".to_string();
        }
    }
    format!("{prefix}/p[@paraId={id}]")
}

/// The path of a table, row or cell element.
fn container_path(word: &Word<'_>, e: tree::E<'_>) -> String {
    let mut segs = Vec::new();
    let mut cur = Some(e);
    while let Some(c) = cur {
        if c.is(W, "body") {
            segs.push("/body".to_string());
            break;
        }
        let name = c.name();
        let siblings: Vec<tree::E<'_>> = c
            .parent()
            .map(|p| {
                if p.is(W, "body") && name == "tbl" {
                    p.descendants_named(W, "tbl")
                        .into_iter()
                        .filter(|x| {
                            x.parent()
                                .is_some_and(|y| y.is(W, "body") || y.is(W, "customXml"))
                        })
                        .collect()
                } else {
                    p.children(W, name)
                }
            })
            .unwrap_or_default();
        let n = siblings.iter().position(|x| *x == c).map_or(1, |i| i + 1);
        if name == "p" {
            if let Some(id) = c.attr_ns("paraId", W14) {
                segs.push(format!("/p[@paraId={id}]"));
                cur = c.parent();
                continue;
            }
        }
        segs.push(format!("/{name}[{n}]"));
        cur = c.parent();
    }
    let _ = word;
    segs.reverse();
    segs.concat()
}

/// Word's built-in paragraph styles a fresh document does not define:
/// display name, outline level, size in half-points, color, italic and
/// space before, as Word's Normal template has them.
type BuiltIn = (
    &'static str,
    &'static str,
    Option<u8>,
    u32,
    Option<&'static str>,
    bool,
    u32,
);

const BUILT_IN: &[BuiltIn] = &[
    (
        "Heading1",
        "heading 1",
        Some(0),
        32,
        Some("2F5496"),
        false,
        240,
    ),
    (
        "Heading2",
        "heading 2",
        Some(1),
        26,
        Some("2F5496"),
        false,
        40,
    ),
    (
        "Heading3",
        "heading 3",
        Some(2),
        24,
        Some("1F3763"),
        false,
        40,
    ),
    (
        "Heading4",
        "heading 4",
        Some(3),
        22,
        Some("2F5496"),
        true,
        40,
    ),
    (
        "Heading5",
        "heading 5",
        Some(4),
        22,
        Some("2F5496"),
        false,
        40,
    ),
    (
        "Heading6",
        "heading 6",
        Some(5),
        22,
        Some("1F3763"),
        false,
        40,
    ),
    (
        "Heading7",
        "heading 7",
        Some(6),
        22,
        Some("1F3763"),
        true,
        40,
    ),
    (
        "Heading8",
        "heading 8",
        Some(7),
        21,
        Some("272727"),
        false,
        40,
    ),
    (
        "Heading9",
        "heading 9",
        Some(8),
        21,
        Some("272727"),
        true,
        40,
    ),
    ("Title", "Title", None, 56, None, false, 0),
    ("Subtitle", "Subtitle", None, 22, Some("5A5A5A"), false, 0),
];

/// The style `props` name, defined when it is a built-in the styles part
/// lacks: the advisory warning OfficeCLI prints either way.
fn style_warning(pkg: &mut Pkg<'_>, props: &[(String, String)]) -> Option<String> {
    let (_, style) = props.iter().rev().find(|(k, _)| {
        ["style", "styleId", "styleid"]
            .iter()
            .any(|x| k.eq_ignore_ascii_case(x))
    })?;
    if style == "Normal" || style_ids(pkg).contains(style) {
        return None;
    }
    if let Some(def) = BUILT_IN.iter().find(|d| d.0 == style) {
        let part = Word::new(pkg).styles_part.clone()?;
        let t = pkg.xml_mut(&part)?;
        let root = t.root;
        let (id, name, outline, sz, color, italic, before) = *def;
        let s = el(t, "style");
        wattr(t, s, "type", "paragraph");
        wattr(t, s, "styleId", id);
        let kid = |t: &mut Tree, parent: Id, tag: &str, val: Option<&str>| -> Id {
            let e = el(t, tag);
            if let Some(v) = val {
                wattr(t, e, "val", v);
            }
            t.append(parent, e);
            e
        };
        kid(t, s, "name", Some(name));
        kid(t, s, "basedOn", Some("Normal"));
        kid(t, s, "next", Some("Normal"));
        kid(
            t,
            s,
            "uiPriority",
            Some(if outline.is_some() { "9" } else { "10" }),
        );
        if outline.is_some_and(|o| o > 0) {
            kid(t, s, "semiHidden", None);
            kid(t, s, "unhideWhenUsed", None);
        }
        kid(t, s, "qFormat", None);
        let ppr = kid(t, s, "pPr", None);
        match outline {
            Some(level) => {
                kid(t, ppr, "keepNext", None);
                kid(t, ppr, "keepLines", None);
                let sp = kid(t, ppr, "spacing", None);
                wattr(t, sp, "before", &before.to_string());
                wattr(t, sp, "after", "0");
                kid(t, ppr, "outlineLvl", Some(&level.to_string()));
            }
            None => {
                let sp = kid(t, ppr, "spacing", None);
                wattr(t, sp, "after", "0");
                wattr(t, sp, "line", "240");
                wattr(t, sp, "lineRule", "auto");
                kid(t, ppr, "contextualSpacing", None);
            }
        }
        let rpr = kid(t, s, "rPr", None);
        if outline.is_none_or(|o| o < 3) || id == "Title" {
            let rf = kid(t, rpr, "rFonts", None);
            wattr(t, rf, "asciiTheme", "majorHAnsi");
            wattr(t, rf, "hAnsiTheme", "majorHAnsi");
            wattr(t, rf, "eastAsiaTheme", "majorEastAsia");
            wattr(t, rf, "cstheme", "majorBidi");
        }
        if italic {
            kid(t, rpr, "i", None);
            kid(t, rpr, "iCs", None);
        }
        if let Some(c) = color {
            kid(t, rpr, "color", Some(c));
        }
        if id == "Title" {
            kid(t, rpr, "spacing", Some("-10"));
            kid(t, rpr, "kern", Some("28"));
        }
        kid(t, rpr, "sz", Some(&sz.to_string()));
        kid(t, rpr, "szCs", Some(&sz.to_string()));
        t.append(root, s);
        return Some(format!(
            "style '{style}' was not defined in the styles part; added Word's built-in definition ('{name}')"
        ));
    }
    let word = Word::new(pkg);
    let resolved = word.styles().and_then(|styles| {
        styles
            .children(W, "style")
            .into_iter()
            .find(|s| {
                s.child(W, "name")
                    .and_then(|n| n.w("val"))
                    .is_some_and(|n| n.eq_ignore_ascii_case(style))
            })
            .and_then(|s| s.w("styleId").map(str::to_string))
    });
    Some(match resolved {
        Some(id) => format!(
            "style '{style}' is a display name, not a styleId — will be referenced as-is. Use styleName='{style}' to resolve it (styleId '{id}')."
        ),
        None => format!("style '{style}' not found in styles part — will be referenced as-is"),
    })
}

const NUMBERING_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml";

/// A list a paragraph joins: its numId and level, and the keys it took.
struct ListPlan {
    num_id: Option<i64>,
    level: i64,
    took: Vec<String>,
}

/// The `w:val` of a `w:` child.
fn wval(t: &Tree, parent: Id, name: &str) -> Option<String> {
    child(t, parent, name).and_then(|c| attr(t, c, W, "val"))
}

/// The number format level 0 of list `num_id` uses.
fn list_format(pkg: &Pkg<'_>, num_id: i64) -> String {
    let word = Word::new(pkg);
    let Some(numbering) = word.numbering() else {
        return "decimal".to_string();
    };
    let abs = numbering
        .children(W, "num")
        .into_iter()
        .find(|n| n.w("numId") == Some(&num_id.to_string()))
        .and_then(|n| n.child(W, "abstractNumId"))
        .and_then(|a| a.w("val").map(str::to_string));
    abs.and_then(|a| {
        numbering
            .children(W, "abstractNum")
            .into_iter()
            .find(|x| x.w("abstractNumId") == Some(a.as_str()))
    })
    .and_then(|x| {
        x.children(W, "lvl")
            .into_iter()
            .find(|l| l.w("ilvl").unwrap_or("0") == "0")
    })
    .and_then(|l| l.child(W, "numFmt"))
    .and_then(|f| f.w("val").map(str::to_string))
    .unwrap_or_else(|| "decimal".to_string())
}

/// The list a new list paragraph continues: the nearest paragraph before
/// it in its container, skipping deeper levels, when that one is a list of
/// the same kind; none when a paragraph outside any list comes first.
fn continuation(
    pkg: &Pkg<'_>,
    part: &str,
    container: Id,
    target: Option<Id>,
    bullet: bool,
    level: i64,
) -> Option<i64> {
    let t = pkg.xml(part)?;
    let kids = children(t, container);
    let end = match target {
        Some(id) => kids.iter().position(|k| *k == id)?,
        None => kids.len(),
    };
    for &cur in kids[..end].iter().rev() {
        if !is(t, cur, "p") || Some(cur) == target {
            continue;
        }
        let num = child(t, cur, "pPr").and_then(|ppr| child(t, ppr, "numPr"));
        let num_id = num
            .and_then(|n| wval(t, n, "numId"))
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|n| *n != 0)?;
        let prev_level = num
            .and_then(|n| wval(t, n, "ilvl"))
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        if prev_level > level {
            continue;
        }
        let prev_bullet = list_format(pkg, num_id).eq_ignore_ascii_case("bullet");
        return (prev_bullet == bullet).then_some(num_id);
    }
    None
}

/// A new nine-level list definition of bullets or numbers and the
/// instance that uses it; the instance's numId.
fn new_list(
    pkg: &mut Pkg<'_>,
    bullet: bool,
    start: Option<i64>,
    level: Option<i64>,
) -> Result<i64, Fail> {
    let main = pkg.main.clone();
    let part = match Word::new(pkg).numbering_part.clone() {
        Some(part) => part,
        None => {
            let name = "/word/numbering.xml".to_string();
            let mut t = Tree::fragment(W, "numbering", "w");
            t.declaration =
                "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n".to_string();
            let root = t.root;
            t.nodes[root].decls.push(("w".to_string(), W.to_string()));
            pkg.add_part(&name, t, NUMBERING_TYPE);
            pkg.add_rel(
                &main,
                "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering",
                "numbering.xml",
                false,
            );
            name
        }
    };
    let t = pkg
        .xml_mut(&part)
        .ok_or_else(|| fail("Corrupt file: numbering data missing".to_string()))?;
    let root = t.root;
    let abstract_id = children(t, root)
        .into_iter()
        .filter(|c| is(t, *c, "abstractNum"))
        .filter_map(|c| attr(t, c, W, "abstractNumId").and_then(|v| v.parse::<i64>().ok()))
        .max()
        .map_or(0, |m| m + 1);
    let num_id = children(t, root)
        .into_iter()
        .filter(|c| is(t, *c, "num"))
        .filter_map(|c| attr(t, c, W, "numId").and_then(|v| v.parse::<i64>().ok()))
        .max()
        .map_or(1, |m| m + 1);
    let abs = el(t, "abstractNum");
    wattr(t, abs, "abstractNumId", &abstract_id.to_string());
    let mlt = el(t, "multiLevelType");
    wattr(t, mlt, "val", "hybridMultilevel");
    t.append(abs, mlt);
    let bullets = ["\u{2022}", "\u{25E6}", "\u{25AA}"];
    for lvl in 0..9i64 {
        let l = el(t, "lvl");
        wattr(t, l, "ilvl", &lvl.to_string());
        let st = el(t, "start");
        let first = if lvl == level.unwrap_or(0) {
            start
        } else {
            None
        };
        wattr(t, st, "val", &first.unwrap_or(1).to_string());
        t.append(l, st);
        let fmt = el(t, "numFmt");
        let text = el(t, "lvlText");
        if bullet {
            wattr(t, fmt, "val", "bullet");
            wattr(t, text, "val", bullets[lvl as usize % 3]);
        } else {
            let f = ["decimal", "lowerLetter", "lowerRoman"][lvl as usize % 3];
            wattr(t, fmt, "val", f);
            wattr(t, text, "val", &format!("%{}.", lvl + 1));
        }
        t.append(l, fmt);
        t.append(l, text);
        let jc = el(t, "lvlJc");
        wattr(t, jc, "val", "left");
        t.append(l, jc);
        let ppr = el(t, "pPr");
        let ind = el(t, "ind");
        wattr(t, ind, "left", &((lvl + 1) * 720).to_string());
        wattr(t, ind, "hanging", "360");
        t.append(ppr, ind);
        t.append(l, ppr);
        t.append(abs, l);
    }
    let first_num = t.nodes[root]
        .kids
        .iter()
        .position(|k| matches!(k, Kid::El(c) if is(t, *c, "num")));
    insert_at(t, root, first_num, abs);
    let num = el(t, "num");
    wattr(t, num, "numId", &num_id.to_string());
    let a = el(t, "abstractNumId");
    wattr(t, a, "val", &abstract_id.to_string());
    t.append(num, a);
    let cleanup = t.nodes[root]
        .kids
        .iter()
        .position(|k| matches!(k, Kid::El(c) if is(t, *c, "numIdMacAtCleanup")));
    insert_at(t, root, cleanup, num);
    Ok(num_id)
}

/// The list `props` asks a paragraph to join, as OfficeCLI's
/// `ApplyListStyle` decides it; None when they name no list style.
fn plan_list(
    pkg: &mut Pkg<'_>,
    props: &[(String, String)],
    part: &str,
    container: Id,
    target: Option<Id>,
    current_level: Option<i64>,
) -> Result<Option<ListPlan>, Fail> {
    let get = |keys: &[&str]| {
        props
            .iter()
            .rev()
            .find(|(k, _)| keys.iter().any(|n| k.eq_ignore_ascii_case(n)))
            .map(|(k, v)| (k.clone(), v.clone()))
    };
    let Some((key, style)) = get(&["listStyle"]) else {
        return Ok(None);
    };
    let mut took = vec![key];
    let start = match get(&["start"]) {
        Some((k, v)) => {
            took.push(k);
            Some(v.trim().parse::<i64>().map_err(|_| {
                fail(format!(
                    "Invalid 'start' value: '{v}'. Expected an integer."
                ))
            })?)
        }
        None => None,
    };
    let level = match get(&["listLevel", "level", "numlevel"]) {
        Some((k, v)) => {
            took.push(k);
            let n: i64 = v
                .trim()
                .parse()
                .map_err(|_| fail(format!("Invalid 'listLevel' value: '{v}'.")))?;
            if !(0..=8).contains(&n) {
                return Err(fail(format!("listLevel must be in range 0..8 (got {n}).")));
            }
            Some(n)
        }
        None => None,
    };
    if matches!(
        style.to_ascii_lowercase().as_str(),
        "none" | "remove" | "clear"
    ) {
        return Ok(Some(ListPlan {
            num_id: None,
            level: 0,
            took,
        }));
    }
    let bullet = matches!(
        style.to_ascii_lowercase().as_str(),
        "bullet" | "unordered" | "ul"
    );
    let target_level = level.or(current_level).unwrap_or(0);
    let continued = continuation(pkg, part, container, target, bullet, target_level);
    let (num_id, ilvl) = match continued {
        Some(id) if start.is_none() => (id, target_level),
        _ => (new_list(pkg, bullet, start, level)?, level.unwrap_or(0)),
    };
    Ok(Some(ListPlan {
        num_id: Some(num_id),
        level: ilvl,
        took,
    }))
}

/// `ppr` set to join list `plan`, or leave any list it was in.
fn apply_plan(t: &mut Tree, ppr: Id, plan: &ListPlan) {
    drop_child(t, ppr, "numPr");
    let Some(num_id) = plan.num_id else { return };
    let num = el(t, "numPr");
    let ilvl = el(t, "ilvl");
    wattr(t, ilvl, "val", &plan.level.to_string());
    t.append(num, ilvl);
    let id = el(t, "numId");
    wattr(t, id, "val", &num_id.to_string());
    t.append(num, id);
    place_ordered(t, ppr, num, PPR_ORDER);
}

/// The hyperlink color the document's theme defines, or Office's.
fn theme_hyperlink(pkg: &Pkg<'_>) -> String {
    let main = pkg.main.clone();
    pkg.related(&main, "theme")
        .first()
        .and_then(|part| pkg.xml(part))
        .and_then(|t| {
            t.root()
                .descendants_named(super::super::tree::A, "hlink")
                .first()
                .and_then(|h| h.child(super::super::tree::A, "srgbClr"))
                .and_then(|c| c.attr("val").map(str::to_string))
        })
        .unwrap_or_else(|| "0563C1".to_string())
}

/// The style ids the styles part defines.
fn style_ids(pkg: &Pkg<'_>) -> HashSet<String> {
    let word = Word::new(pkg);
    word.styles()
        .map(|s| {
            s.children(W, "style")
                .into_iter()
                .filter_map(|x| x.w("styleId").map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// A position `add` and `move` take: an index or an anchor path.
pub(in super::super) struct Place<'a> {
    pub(in super::super) index: Option<i64>,
    pub(in super::super) after: Option<&'a str>,
    pub(in super::super) before: Option<&'a str>,
}

/// What `add` answers: the new element's path, the props it did not read
/// and its advisory warnings.
pub(in super::super) type Added = (String, Vec<String>, Vec<String>);

/// The element types `add` makes in a document, as OfficeCLI lists them.
const TYPES: &str = "paragraph (p), run (r), table (tbl), row, cell, picture, chart, ole (object, embed), equation, comment, section, footnote, endnote, toc, style, watermark, bookmark, hyperlink, field, break, sdt, header, footer";

/// Where a picture goes: the part and element it goes under, the path as
/// typed, and the `--index` or anchor that places it.
struct Target<'a> {
    part: &'a str,
    parent: Id,
    typed: &'a str,
    index: Option<usize>,
    anchored: Option<(Id, bool)>,
}

/// The props a picture reads for itself, which its run's formatting pass
/// leaves alone.
const PICTURE_OWN: [&str; 25] = [
    "width",
    "height",
    "alt",
    "name",
    "src",
    "wrap",
    "anchor",
    "hposition",
    "vposition",
    "hrelative",
    "vrelative",
    "halign",
    "valign",
    "behindtext",
    "tooltip",
    "tgtframe",
    "history",
    "url",
    "relid",
    "id",
    "contenttype",
    "filesize",
    "src.svg",
    "blipeffects",
    "speffects",
];

/// Props a picture takes that its run's formatting pass does not apply,
/// though it gives the run an empty `w:rPr`.
const PICTURE_UNFORMATTED: [&str; 11] = [
    "path",
    "w",
    "h",
    "hidden",
    "decorative",
    "fallback",
    "effectextent",
    "link",
    "alttext",
    "description",
    "spprxml",
];

/// One crop key applied to the sides kept so far, as OfficeCLI's shared
/// crop writer does; an all-zero rectangle is no crop.
fn crop_side(sides: &mut [Option<i64>; 4], key: &str, value: &str) -> Result<(), Fail> {
    let strip = |s: &str| {
        let t = s.trim();
        t.strip_suffix('%').unwrap_or(t).trim().to_string()
    };
    let lk = key.to_ascii_lowercase();
    if lk == "crop" {
        let parts: Vec<&str> = value.split(',').collect();
        match parts.as_slice() {
            [_, _, _, _] => {
                for (i, part) in parts.iter().enumerate() {
                    let v = media::number(&strip(part), "crop")?;
                    if !(-1000.0..=1000.0).contains(&v) {
                        return Err(fail(format!(
                            "Invalid 'crop' value: '{}'. Crop percentage must be between -1000 and 1000.",
                            part.trim()
                        )));
                    }
                    sides[i] = Some((v * 1000.0) as i64);
                }
            }
            [_] => {
                let v = strip(value)
                    .parse::<f64>()
                    .ok()
                    .filter(|v| (-1000.0..=1000.0).contains(v))
                    .ok_or_else(|| {
                        fail(format!(
                            "Invalid 'crop' value: '{value}'. Expected percentage -1000..1000."
                        ))
                    })?;
                *sides = [Some((v * 1000.0) as i64); 4];
            }
            _ => {
                return Err(fail(format!(
                    "Invalid 'crop' value: '{value}'. Expected 1 or 4 comma-separated percentages."
                )));
            }
        }
    } else {
        let v = strip(value)
            .parse::<f64>()
            .ok()
            .filter(|v| (0.0..=100.0).contains(v))
            .ok_or_else(|| {
                fail(format!(
                    "Invalid '{key}' value: '{value}'. Expected percentage 0-100."
                ))
            })?;
        let i = ["cropleft", "croptop", "cropright", "cropbottom"]
            .iter()
            .position(|k| *k == lk)
            .unwrap_or(0);
        sides[i] = Some((v * 1000.0) as i64);
    }
    if sides.iter().all(|s| s.unwrap_or(0) == 0) {
        *sides = [None; 4];
    }
    Ok(())
}

/// The next drawing id: past every `wp:docPr` id in the document's parts.
fn next_drawing_id(pkg: &Pkg<'_>) -> u32 {
    let mut max = 0u32;
    for part in paragraph_parts(pkg) {
        if let Some(t) = pkg.xml(&part) {
            for el in &t.nodes {
                if el.name == "docPr" && &*el.ns == WP {
                    if let Some(id) = el
                        .attrs
                        .iter()
                        .find(|a| a.name == "id" && a.ns.is_empty())
                        .and_then(|a| a.value.parse::<u32>().ok())
                    {
                        max = max.max(id);
                    }
                }
            }
        }
    }
    max + 1
}

fn xml_escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// A boolean prop's value as OfficeCLI's IsValidBooleanString reads it,
/// None when it is not one.
fn boolean(v: &str) -> Option<bool> {
    match v.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Some(true),
        "false" | "0" | "no" | "off" => Some(false),
        _ => None,
    }
}

/// A floating picture's `wp:anchor` start, through its positions, and its
/// wrap element, as OfficeCLI's CreateAnchorImageRun writes them.
fn anchor_frame(
    props: &[(String, String)],
    took: &mut Vec<String>,
    wrap: Option<&String>,
) -> Result<(String, String), Fail> {
    let mut read = |key: &str| {
        let v = media::value(props, key);
        if v.is_some() {
            took.push(key.to_string());
        }
        v
    };
    let wrap = wrap.map_or("none".to_string(), |w| w.to_ascii_lowercase());
    let hpos = read("hposition").map(|v| emu(v)).transpose()?.unwrap_or(0);
    let vpos = read("vposition").map(|v| emu(v)).transpose()?.unwrap_or(0);
    let hrel = match read("hrelative") {
        Some(v) => match v.to_ascii_lowercase().as_str() {
            "page" => "page",
            "column" => "column",
            "character" => "character",
            "margin" => "margin",
            "leftmargin" => "leftMargin",
            "rightmargin" => "rightMargin",
            "insidemargin" => "insideMargin",
            "outsidemargin" => "outsideMargin",
            _ => {
                return Err(fail(format!(
                    "Invalid horizontal relative position: '{v}'. Valid values: margin, page, column, character, leftMargin, rightMargin, insideMargin, outsideMargin."
                )));
            }
        },
        None => "margin",
    };
    let vrel = match read("vrelative") {
        Some(v) => match v.to_ascii_lowercase().as_str() {
            "page" => "page",
            "paragraph" => "paragraph",
            "line" => "line",
            "margin" => "margin",
            "topmargin" => "topMargin",
            "bottommargin" => "bottomMargin",
            "insidemargin" => "insideMargin",
            "outsidemargin" => "outsideMargin",
            _ => {
                return Err(fail(format!(
                    "Invalid vertical relative position: '{v}'. Valid values: margin, page, paragraph, line, topMargin, bottomMargin, insideMargin, outsideMargin."
                )));
            }
        },
        None => "margin",
    };
    let behind = read("behindtext").is_some_and(|v| truthy(v));
    let halign = read("halign").filter(|v| !v.is_empty()).cloned();
    let valign = read("valign").filter(|v| !v.is_empty()).cloned();
    let height = read("relativeHeight")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(1);
    let mut dist = [0u32, 0, 114_300, 114_300];
    if let Some(v) = read("wrapDist") {
        let parts: Vec<Option<u32>> = v.split(',').map(|p| p.trim().parse().ok()).collect();
        if let [Some(t), Some(b), Some(l), Some(r)] = parts.as_slice() {
            dist = [*t, *b, *l, *r];
        }
    }
    let side = read("wrap.side")
        .or_else(|| read("wrapSide"))
        .map(String::as_str);
    let side = match side {
        Some("left") => "left",
        Some("right") => "right",
        Some("largest") => "largest",
        _ => "bothSides",
    };
    let polygon = "<wp:wrapPolygon edited=\"0\"><wp:start x=\"0\" y=\"0\"/><wp:lineTo x=\"21600\" y=\"0\"/><wp:lineTo x=\"21600\" y=\"21600\"/><wp:lineTo x=\"0\" y=\"21600\"/><wp:lineTo x=\"0\" y=\"0\"/></wp:wrapPolygon>";
    let wrap_el = match wrap.as_str() {
        "square" => format!("<wp:wrapSquare wrapText=\"{side}\"/>"),
        "tight" => format!("<wp:wrapTight wrapText=\"bothSides\">{polygon}</wp:wrapTight>"),
        "through" => {
            format!("<wp:wrapThrough wrapText=\"bothSides\">{polygon}</wp:wrapThrough>")
        }
        "topandbottom" | "topbottom" => "<wp:wrapTopAndBottom/>".to_string(),
        "none" => "<wp:wrapNone/>".to_string(),
        _ => {
            return Err(fail(format!(
                "Invalid wrap value: '{}'. Valid values: none, square, tight, through, topandbottom.",
                media::value(props, "wrap").map_or("none", String::as_str)
            )));
        }
    };
    let position = |align: &Option<String>, offset: i64| match align {
        Some(a) => format!("<wp:align>{}</wp:align>", xml_escape(a)),
        None => format!("<wp:posOffset>{offset}</wp:posOffset>"),
    };
    let [t, b, l, r] = dist;
    let open = format!(
        "<wp:anchor distT=\"{t}\" distB=\"{b}\" distL=\"{l}\" distR=\"{r}\" simplePos=\"0\" relativeHeight=\"{height}\" behindDoc=\"{}\" locked=\"0\" layoutInCell=\"1\" allowOverlap=\"1\"><wp:simplePos x=\"0\" y=\"0\"/><wp:positionH relativeFrom=\"{hrel}\">{}</wp:positionH><wp:positionV relativeFrom=\"{vrel}\">{}</wp:positionV>",
        u8::from(behind),
        position(&halign, hpos),
        position(&valign, vpos)
    );
    Ok((open, wrap_el))
}

/// A picture: the image `src` names in an inline drawing, framed at its
/// pixel aspect, as OfficeCLI's AddPicture writes one into a paragraph, a
/// cell's first empty paragraph, or a paragraph of its own.
fn add_picture(
    pkg: &mut Pkg<'_>,
    ids: &mut Ids,
    target: &Target<'_>,
    props: &[(String, String)],
    media: &Media,
) -> Result<Added, Fail> {
    let mut took: Vec<String> = Vec::new();
    let Some(src) = media::source(props) else {
        return Err(fail(
            "'src' property is required for picture type".to_string(),
        ));
    };
    took.push(
        if media::value(props, "path").is_some() {
            "path"
        } else {
            "src"
        }
        .to_string(),
    );
    if target.typed.to_ascii_lowercase().starts_with("/chart[") {
        return Err(fail(format!(
            "Cannot add a picture to a chart path ('{}'). Charts don't host picture children — use /body or a table cell as parent.",
            target.typed
        )));
    }
    let image = media::take(media, src)?;
    let (rid, svg_rid) = media::embed(pkg, target.part, image, props, media, &mut took)?;
    let side = |keys: [&str; 2]| {
        keys.iter()
            .find_map(|k| media::value(props, k).map(|v| (k.to_string(), v.clone())))
    };
    let width = side(["width", "w"]);
    let height = side(["height", "h"]);
    let mut cx = 5_486_400;
    let mut cy = 3_657_600;
    for (given, size, label) in [(&width, &mut cx, "width"), (&height, &mut cy, "height")] {
        if let Some((k, v)) = given {
            took.push(k.clone());
            *size = emu(v)?;
            if *size <= 0 {
                return Err(fail(format!(
                    "Invalid '{label}' value: '{v}'. Picture {label} must be > 0 (OOXML ST_PositiveCoordinate)."
                )));
            }
        }
    }
    let (cx, cy) = media::fit(image, cx, cy, width.is_some(), height.is_some());
    let mut alt = None;
    for key in ["alt", "alttext", "description"] {
        if let Some(v) = media::value(props, key) {
            took.push(key.to_string());
            if !v.is_empty() {
                alt = Some(v.clone());
                break;
            }
        }
    }
    let default_name = || {
        if src.to_ascii_lowercase().starts_with("data:")
            || (src.len() > 256 && !src.contains('/') && !src.contains('\\'))
        {
            "image".to_string()
        } else {
            src.rsplit('/').next().unwrap_or_default().to_string()
        }
    };
    let name = match media::value(props, "name") {
        Some(v) => {
            took.push("name".to_string());
            if v.is_empty() {
                alt.clone().unwrap_or_else(default_name)
            } else {
                v.clone()
            }
        }
        None => alt.clone().unwrap_or_else(default_name),
    };
    let doc_pr = next_drawing_id(pkg);
    let mut extent = [0i64; 4];
    if let Some(v) = media::value(props, "effectExtent") {
        took.push("effectExtent".to_string());
        let parts: Vec<Option<i64>> = v.split(',').map(|p| p.trim().parse().ok()).collect();
        if let [Some(l), Some(t), Some(r), Some(b)] = parts.as_slice() {
            extent = [*l, *t, *r, *b];
        }
    }
    let wrap = media::value(props, "wrap");
    if wrap.is_some() {
        took.push("wrap".to_string());
    }
    let floating_wrap = wrap.is_some_and(|w| {
        !w.is_empty() && !w.eq_ignore_ascii_case("none") && !w.eq_ignore_ascii_case("inline")
    });
    let anchor = media::value(props, "anchor");
    let anchor_flag = anchor.filter(|a| !a.is_empty()).map(|a| boolean(a));
    if anchor.is_some() && !matches!(anchor_flag, Some(None)) {
        took.push("anchor".to_string());
    }
    let floating = matches!(anchor_flag, Some(Some(true))) || floating_wrap;
    let frame = if floating {
        Some(anchor_frame(props, &mut took, wrap)?)
    } else {
        None
    };
    let mut hidden = String::new();
    if let Some(v) = media::value(props, "hidden") {
        took.push("hidden".to_string());
        if truthy(v) {
            hidden = " hidden=\"1\"".to_string();
        }
    }
    for key in ["decorative", "link", "blipEffects", "spPrXml", "spEffects"] {
        if media::value(props, key)
            .is_some_and(|v| v.trim().is_empty() || (key == "decorative" && !truthy(v)))
        {
            took.push(key.to_string());
        }
    }
    let mut seen: Vec<String> = Vec::new();
    let mut fields: Vec<(String, String)> = Vec::new();
    for (k, _) in props {
        let lk = k.to_ascii_lowercase();
        if !seen.contains(&lk) {
            seen.push(lk);
            fields.push((
                k.clone(),
                media::value(props, k).cloned().unwrap_or_default(),
            ));
        }
    }
    let mut sides: [Option<i64>; 4] = [None; 4];
    let mut formats: Vec<(String, String)> = Vec::new();
    let mut needs_rpr = false;
    for (k, v) in &fields {
        let lk = k.to_ascii_lowercase();
        if PICTURE_OWN.contains(&lk.as_str()) {
            continue;
        }
        if matches!(
            lk.as_str(),
            "crop" | "cropleft" | "cropright" | "croptop" | "cropbottom"
        ) {
            took.push(k.clone());
            crop_side(&mut sides, k, v)?;
            continue;
        }
        needs_rpr = true;
        if !PICTURE_UNFORMATTED.contains(&lk.as_str()) {
            formats.push((k.clone(), v.clone()));
        }
    }
    let src_rect = if sides.iter().any(Option::is_some) {
        format!("<a:srcRect{}/>", media::src_rect(sides))
    } else {
        String::new()
    };
    let blip_ext = svg_rid.map(|r| media::svg_blip(&r)).unwrap_or_default();
    let blip = if blip_ext.is_empty() {
        format!("<a:blip r:embed=\"{rid}\" cstate=\"print\"/>")
    } else {
        format!("<a:blip r:embed=\"{rid}\" cstate=\"print\">{blip_ext}</a:blip>")
    };
    let name = xml_escape(&name);
    let descr = xml_escape(alt.as_deref().unwrap_or_default());
    let [left, top, right, bottom] = extent;
    let (open, wrap_el, close) = match &frame {
        Some((open, wrap_el)) => (open.as_str(), wrap_el.as_str(), "</wp:anchor>"),
        None => (
            "<wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\">",
            "",
            "</wp:inline>",
        ),
    };
    let xml = format!(
        "<w:r xmlns:w=\"{W}\" xmlns:wp=\"{WP}\" xmlns:a=\"{}\" xmlns:pic=\"{}\" xmlns:r=\"{}\"><w:drawing>{open}<wp:extent cx=\"{cx}\" cy=\"{cy}\"/><wp:effectExtent l=\"{left}\" t=\"{top}\" r=\"{right}\" b=\"{bottom}\"/>{wrap_el}<wp:docPr id=\"{doc_pr}\" name=\"{name}\" descr=\"{descr}\"{hidden}/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:pic><pic:nvPicPr><pic:cNvPr id=\"{doc_pr}\" name=\"{name}\"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill>{blip}{src_rect}<a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>{close}</w:drawing></w:r>",
        tree::A,
        tree::PIC,
        tree::R
    );
    let fragment = tree::parse(xml.as_bytes())
        .map_err(|_| fail("Malformed XML built for the picture".to_string()))?;
    let part = target.part;
    let parent = target.parent;
    let t = pkg
        .xml_mut(part)
        .ok_or_else(|| fail(format!("Path not found: {}", target.typed)))?;
    let run = t.adopt(fragment.root());
    t.nodes[run].decls.clear();
    if needs_rpr {
        let rpr = el(t, "rPr");
        apply_run(t, rpr, &formats, true)?;
        insert_at(t, run, Some(0), rpr);
    }
    let anchored_at = |t: &Tree| {
        target.anchored.and_then(|(aid, after)| {
            t.nodes[parent]
                .kids
                .iter()
                .position(|k| matches!(k, Kid::El(c) if *c == aid))
                .map(|p| if after { p + 1 } else { p })
        })
    };
    let spaced = |t: &mut Tree, ids: &mut Ids| -> (Id, String) {
        let p = el(t, "p");
        let pid = ids.take();
        set_attr_ns(t, p, W14, "paraId", &pid);
        let tid = ids.take();
        set_attr_ns(t, p, W14, "textId", &tid);
        let ppr = el(t, "pPr");
        let spacing = el(t, "spacing");
        wattr(t, spacing, "line", "240");
        wattr(t, spacing, "lineRule", "auto");
        t.append(ppr, spacing);
        t.append(p, ppr);
        t.append(p, run);
        (p, pid)
    };
    if is(t, parent, "p") {
        let kids: Vec<(usize, Id)> = t.nodes[parent]
            .kids
            .iter()
            .enumerate()
            .filter_map(|(i, k)| match k {
                Kid::El(c) => Some((i, *c)),
                _ => None,
            })
            .collect();
        let pos = match (anchored_at(t), target.index) {
            (Some(p), _) => Some(p),
            (None, Some(i)) if i < kids.len() => {
                if is(t, kids[i].1, "pPr") {
                    kids.get(i + 1).map(|(k, _)| *k)
                } else {
                    Some(kids[i].0)
                }
            }
            _ => None,
        };
        insert_at(t, parent, pos, run);
        let n = tree::E { t, id: parent }
            .descendants_named(W, "r")
            .into_iter()
            .filter(|r| r.child(W, "commentReference").is_none())
            .position(|r| r.id == run)
            .map_or(1, |i| i + 1);
        let path = paragraph_path(pkg, part, parent);
        return Ok((
            format!("{path}/r[{n}]"),
            unread_keys(props, &took),
            Vec::new(),
        ));
    }
    if is(t, parent, "tc") {
        let first = children(t, parent).into_iter().find(|c| is(t, *c, "p"));
        let host = match first.filter(|p| !children(t, *p).iter().any(|c| is(t, *c, "r"))) {
            Some(p) => {
                t.append(p, run);
                p
            }
            None => {
                let (p, _) = spaced(t, ids);
                t.append(parent, p);
                p
            }
        };
        let id = attr(t, host, W14, "paraId").unwrap_or_default();
        return Ok((
            format!("{}/p[@paraId={id}]", target.typed),
            unread_keys(props, &took),
            Vec::new(),
        ));
    }
    let (p, pid) = spaced(t, ids);
    let pos = anchored_at(t).or_else(|| insertion(t, parent, target.index, &|_| true));
    insert_at(t, parent, pos, p);
    Ok((
        format!("{}/p[@paraId={pid}]", target.typed),
        unread_keys(props, &took),
        Vec::new(),
    ))
}

/// `add`: a new element of `kind` under `parent`.
pub(in super::super) fn add(
    pkg: &mut Pkg<'_>,
    parent: &str,
    kind: &str,
    place: &Place<'_>,
    props: &[(String, String)],
    media: &Media,
) -> Result<Added, Fail> {
    if place.index.is_some_and(|i| i < 0) {
        return Err(fail("--index must be non-negative.".to_string()));
    }
    let mut ids = prepare(pkg);
    let lower = kind.to_ascii_lowercase();
    let (part, parent_id, parent_path) = {
        let word = Word::new(pkg);
        word.locate(parent)?
    };
    let anchor = match (place.after, place.before) {
        (Some(a), _) => Some((a, true)),
        (_, Some(b)) => Some((b, false)),
        _ => None,
    };
    let anchored = match anchor {
        Some((path, after)) => {
            let word = Word::new(pkg);
            let (apart, aid, _) = word.locate(path)?;
            if apart != part {
                return Err(fail(format!("Anchor {path} is not under {parent}")));
            }
            Some((aid, after))
        }
        None => None,
    };
    let index = place.index.map(|i| i as usize);
    let style_note = if matches!(lower.as_str(), "paragraph" | "p") {
        style_warning(pkg, props)
    } else {
        None
    };
    let list = if matches!(lower.as_str(), "paragraph" | "p") {
        plan_list(pkg, props, &part, parent_id, None, None)?
    } else {
        None
    };
    let known = style_ids(pkg);
    let hyperlink_color = theme_hyperlink(pkg);
    let typed = if parent == "/" || parent.is_empty() {
        "/body"
    } else {
        parent
    };
    if let Some(fault) = pkg
        .xml(&part)
        .and_then(|t| parent_fault(t, parent_id, typed, kind))
    {
        return Err(fail(fault));
    }
    if media::PICTURE.contains(&lower.as_str()) {
        let target = Target {
            part: &part,
            parent: parent_id,
            typed,
            index,
            anchored,
        };
        return add_picture(pkg, &mut ids, &target, props, media);
    }
    let t = pkg
        .xml_mut(&part)
        .ok_or_else(|| fail(format!("Path not found: {parent}")))?;
    let at = |t: &Tree, counted: &dyn Fn(Id) -> bool| -> Option<usize> {
        if let Some((aid, after)) = anchored {
            let pos = t.nodes[parent_id]
                .kids
                .iter()
                .position(|k| matches!(k, Kid::El(c) if *c == aid))?;
            return Some(if after { pos + 1 } else { pos });
        }
        insertion(t, parent_id, index, counted)
    };
    match lower.as_str() {
        "paragraph" | "p" => {
            let text = props
                .iter()
                .rev()
                .find(|(k, _)| k.eq_ignore_ascii_case("text"))
                .map(|(_, v)| v.replace("\r\n", "\n").replace('\r', "\n"));
            let lines: Vec<Option<String>> = match &text {
                Some(t) => t.split('\n').map(|l| Some(l.to_string())).collect(),
                None => vec![None],
            };
            let mut first = None;
            let mut unread = Vec::new();
            let mut warnings = Vec::new();
            for (li, line) in lines.iter().enumerate() {
                let p = el(t, "p");
                let pid = ids.take();
                set_attr_ns(t, p, W14, "paraId", &pid);
                let tid = ids.take();
                set_attr_ns(t, p, W14, "textId", &tid);
                let ppr = el(t, "pPr");
                t.append(p, ppr);
                let (mut took, warned) = apply_paragraph(t, ppr, props, &|s| known.contains(s))?;
                if li == 0 {
                    warnings.extend(warned);
                }
                if let Some(plan) = &list {
                    apply_plan(t, ppr, plan);
                    took.extend(plan.took.iter().cloned());
                }
                took.push("text".to_string());
                if let Some(line) = line {
                    let r = el(t, "r");
                    let rpr = el(t, "rPr");
                    t.append(r, rpr);
                    took.extend(apply_run(t, rpr, props, true)?);
                    run_content(t, r, line);
                    t.append(p, r);
                } else {
                    let scratch = el(t, "rPr");
                    took.extend(apply_run(t, scratch, props, true)?);
                    if !t.nodes[scratch].kids.is_empty() {
                        place_ordered(t, ppr, scratch, PPR_ORDER);
                    }
                }
                let pos = match (index, anchored) {
                    (Some(i), None) => insertion(t, parent_id, Some(i + li), &|c| block(t, c)),
                    _ => at(t, &|c| block(t, c)).map(|p| p + li),
                };
                insert_at(t, parent_id, pos, p);
                if li == 0 {
                    first = Some(p);
                    unread = props
                        .iter()
                        .map(|(k, _)| k.clone())
                        .filter(|k| !took.iter().any(|x| x.eq_ignore_ascii_case(k)))
                        .collect();
                }
            }
            let first = first.unwrap_or_default();
            warnings.extend(style_note.map(|w| format!("  WARNING: {w}")));
            Ok((paragraph_path(pkg, &part, first), unread, warnings))
        }
        "run" | "r" => {
            if !is(t, parent_id, "p") {
                return Err(fail(format!(
                    "Cannot add run under {parent_path}: a run goes in a paragraph."
                )));
            }
            let r = el(t, "r");
            let rpr = el(t, "rPr");
            t.append(r, rpr);
            let mut took = apply_run(t, rpr, props, true)?;
            if let Some((k, v)) = props
                .iter()
                .rev()
                .find(|(k, _)| k.eq_ignore_ascii_case("text"))
            {
                took.push(k.clone());
                run_content(t, r, v);
            }
            let pos = at(t, &|c| is(t, c, "r"));
            let pos = match (index, anchored) {
                (None, None) => None,
                _ => pos,
            };
            insert_at(t, parent_id, pos, r);
            let tid = ids.take();
            set_attr_ns(t, parent_id, W14, "textId", &tid);
            let n = children(t, parent_id)
                .into_iter()
                .filter(|c| is(t, *c, "r"))
                .position(|c| c == r)
                .map_or(1, |i| i + 1);
            let unread = props
                .iter()
                .map(|(k, _)| k.clone())
                .filter(|k| !took.iter().any(|x| x.eq_ignore_ascii_case(k)))
                .collect();
            let path = paragraph_path(pkg, &part, parent_id);
            Ok((format!("{path}/r[{n}]"), unread, Vec::new()))
        }
        "table" | "tbl" => {
            let (width, took_keys, tbl) = build_table(t, &mut ids, props, &part)?;
            let _ = width;
            let pos = at(t, &|c| block(t, c));
            insert_at(t, parent_id, pos, tbl);
            let unread = props
                .iter()
                .map(|(k, _)| k.clone())
                .filter(|k| !took_keys.iter().any(|x| x.eq_ignore_ascii_case(k)))
                .collect();
            let n = t.nodes[parent_id]
                .kids
                .iter()
                .filter_map(|k| match k {
                    Kid::El(c) if is(t, *c, "tbl") => Some(*c),
                    _ => None,
                })
                .position(|c| c == tbl)
                .map_or(1, |i| i + 1);
            Ok((format!("{parent_path}/tbl[{n}]"), unread, Vec::new()))
        }
        "row" | "tr" => {
            if !is(t, parent_id, "tbl") {
                return Err(fail(
                    "Rows can only be added to a table: /body/tbl[N]".to_string(),
                ));
            }
            let mut took: Vec<String> = Vec::new();
            let grid = match child(t, parent_id, "tblGrid") {
                Some(g) => g,
                None => {
                    let g = el(t, "tblGrid");
                    insert_at(t, parent_id, Some(0), g);
                    g
                }
            };
            let widths: Vec<i64> = children(t, grid)
                .into_iter()
                .filter(|c| is(t, *c, "gridCol"))
                .map(|c| {
                    attr(t, c, W, "w")
                        .and_then(|w| w.parse().ok())
                        .unwrap_or(2400)
                })
                .collect();
            let existing = widths.len().max(1);
            let mut cols = existing;
            if let Some((k, v)) = props
                .iter()
                .rev()
                .find(|(k, _)| k.eq_ignore_ascii_case("cols"))
            {
                took.push(k.clone());
                cols = v
                    .trim()
                    .parse::<usize>()
                    .ok()
                    .filter(|n| *n > 0)
                    .ok_or_else(|| {
                        fail(format!(
                            "Invalid 'cols' value: '{v}'. Must be a positive integer (> 0); a row with 0 cells is invalid OOXML."
                        ))
                    })?;
            }
            if !widths.is_empty() && cols > widths.len() {
                let avg = widths.iter().sum::<i64>() / widths.len() as i64;
                for _ in widths.len()..cols {
                    let g = el(t, "gridCol");
                    wattr(t, g, "w", &avg.to_string());
                    t.append(grid, g);
                }
                let rows: Vec<Id> = children(t, parent_id)
                    .into_iter()
                    .filter(|c| is(t, *c, "tr"))
                    .collect();
                for row in rows {
                    for _ in widths.len()..cols {
                        let tc = el(t, "tc");
                        let p = el(t, "p");
                        let pid = ids.take();
                        set_attr_ns(t, p, W14, "paraId", &pid);
                        let tid = ids.take();
                        set_attr_ns(t, p, W14, "textId", &tid);
                        t.append(tc, p);
                        t.append(row, tc);
                    }
                }
            }
            let tr = el(t, "tr");
            let mut trpr: Option<Id> = None;
            let row_prop = |t: &mut Tree, trpr: &mut Option<Id>| -> Id {
                match *trpr {
                    Some(x) => x,
                    None => {
                        let x = el(t, "trPr");
                        t.append(tr, x);
                        *trpr = Some(x);
                        x
                    }
                }
            };
            for (key, rule) in [
                ("height", None),
                ("height.atleast", Some("atLeast")),
                ("height.exact", Some("exact")),
            ] {
                if let Some((k, v)) = props
                    .iter()
                    .rev()
                    .find(|(k, _)| k.eq_ignore_ascii_case(key))
                {
                    took.push(k.clone());
                    let x = row_prop(t, &mut trpr);
                    drop_child(t, x, "trHeight");
                    let h = el(t, "trHeight");
                    wattr(t, h, "val", &twips(v)?.to_string());
                    if let Some(r) = rule {
                        wattr(t, h, "hRule", r);
                    }
                    t.append(x, h);
                }
            }
            for (key, tag) in [
                ("header", "tblHeader"),
                ("cantSplit", "cantSplit"),
                ("hidden", "hidden"),
            ] {
                if let Some((k, v)) = props
                    .iter()
                    .rev()
                    .find(|(k, _)| k.eq_ignore_ascii_case(key))
                {
                    took.push(k.clone());
                    if truthy(v) {
                        let x = row_prop(t, &mut trpr);
                        if child(t, x, tag).is_none() {
                            let e = el(t, tag);
                            t.append(x, e);
                        }
                    }
                }
            }
            for c in 0..cols {
                let key = format!("c{}", c + 1);
                let text = props
                    .iter()
                    .rev()
                    .find(|(k, _)| k.eq_ignore_ascii_case(&key))
                    .map(|(k, v)| {
                        took.push(k.clone());
                        v.clone()
                    })
                    .unwrap_or_default();
                let tc = el(t, "tc");
                let p = el(t, "p");
                let pid = ids.take();
                set_attr_ns(t, p, W14, "paraId", &pid);
                let tid = ids.take();
                set_attr_ns(t, p, W14, "textId", &tid);
                if !text.is_empty() {
                    let r = el(t, "r");
                    run_content(t, r, &text);
                    t.append(p, r);
                }
                t.append(tc, p);
                t.append(tr, tc);
            }
            let rows: Vec<Id> = children(t, parent_id)
                .into_iter()
                .filter(|c| is(t, *c, "tr"))
                .collect();
            let pos = match index {
                Some(i) if i < rows.len() => t.nodes[parent_id]
                    .kids
                    .iter()
                    .position(|k| matches!(k, Kid::El(c) if *c == rows[i])),
                _ => None,
            };
            insert_at(t, parent_id, pos, tr);
            let n = children(t, parent_id)
                .into_iter()
                .filter(|c| is(t, *c, "tr"))
                .position(|c| c == tr)
                .map_or(1, |i| i + 1);
            Ok((
                format!("{parent_path}/tr[{n}]"),
                unread_keys(props, &took),
                Vec::new(),
            ))
        }
        "hyperlink" | "link" => {
            let get = |keys: &[&str]| {
                props
                    .iter()
                    .rev()
                    .find(|(k, _)| keys.iter().any(|n| k.eq_ignore_ascii_case(n)))
                    .map(|(k, v)| (k.clone(), v.clone()))
            };
            let mut took: Vec<String> = Vec::new();
            let url = get(&["url", "href", "link"]).filter(|(_, v)| !v.trim().is_empty());
            let mut anchor = get(&["anchor", "bookmark"]);
            let tooltip = get(&["tooltip"]);
            let frame = get(&["tgtFrame"]);
            let history = get(&["history"]);
            if url.is_none()
                && anchor.is_none()
                && tooltip.is_none()
                && frame.is_none()
                && history.is_none()
            {
                return Err(fail(
                    "'url' or 'anchor' property is required for hyperlink type".to_string(),
                ));
            }
            if !is(t, parent_id, "p") {
                return Err(fail(
                    "Hyperlinks can only be added to paragraphs: /body/p[N]".to_string(),
                ));
            }
            let mut target = None;
            if let Some((k, v)) = &url {
                took.push(k.clone());
                if let Some(frag) = v.strip_prefix('#') {
                    if anchor.is_none() {
                        anchor = Some(("anchor".to_string(), frag.to_string()));
                    }
                } else {
                    target = Some(v.replace(' ', "%20"));
                }
            }
            let rpr = el(t, "rPr");
            match get(&["color", "font.color"]) {
                Some((k, v)) if v.eq_ignore_ascii_case("inherit") => took.push(k),
                Some(_) => {}
                None => {
                    let c = el(t, "color");
                    wattr(t, c, "val", &hyperlink_color);
                    wattr(t, c, "themeColor", "hyperlink");
                    place_ordered(t, rpr, c, RPR_ORDER);
                }
            }
            match get(&["underline", "font.underline"]) {
                Some((k, v)) if v.eq_ignore_ascii_case("inherit") => took.push(k),
                Some(_) => {}
                None => {
                    let u = el(t, "u");
                    wattr(t, u, "val", "single");
                    place_ordered(t, rpr, u, RPR_ORDER);
                }
            }
            let run_keys: Vec<(String, String)> = props
                .iter()
                .filter(|(k, v)| {
                    !(["bold", "italic"].iter().any(|n| k.eq_ignore_ascii_case(n)) && !truthy(v))
                        && !v.eq_ignore_ascii_case("inherit")
                })
                .cloned()
                .collect();
            took.extend(apply_run(t, rpr, &run_keys, true)?);
            for key in ["bold", "italic"] {
                if let Some((k, _)) = get(&[key]) {
                    took.push(k);
                }
            }
            let run = el(t, "r");
            t.append(run, rpr);
            let text = match get(&["text"]) {
                Some((k, v)) => {
                    took.push(k);
                    v
                }
                None => url
                    .as_ref()
                    .map(|(_, v)| v.clone())
                    .or_else(|| anchor.as_ref().map(|(_, v)| v.clone()))
                    .unwrap_or_else(|| "link".to_string()),
            };
            run_content(t, run, &text);
            let link = el(t, "hyperlink");
            t.append(link, run);
            if let Some((k, v)) = &anchor {
                took.push(k.clone());
                wattr(t, link, "anchor", v);
            }
            if let Some((k, v)) = get(&["docLocation"]) {
                took.push(k);
                wattr(t, link, "docLocation", &v);
            }
            if let Some((k, v)) = &tooltip {
                took.push(k.clone());
                wattr(t, link, "tooltip", v);
            }
            if let Some((k, v)) = &frame {
                took.push(k.clone());
                wattr(t, link, "tgtFrame", v);
            }
            if let Some((k, v)) = &history {
                took.push(k.clone());
                wattr(t, link, "history", if truthy(v) { "true" } else { "false" });
            }
            let content: Vec<Id> = children(t, parent_id)
                .into_iter()
                .filter(|c| !is(t, *c, "pPr"))
                .collect();
            let pos = match index {
                Some(i) if i < content.len() => t.nodes[parent_id]
                    .kids
                    .iter()
                    .position(|k| matches!(k, Kid::El(c) if *c == content[i])),
                _ => None,
            };
            insert_at(t, parent_id, pos, link);
            let n = children(t, parent_id)
                .into_iter()
                .filter(|c| is(t, *c, "hyperlink"))
                .position(|c| c == link)
                .map_or(1, |i| i + 1);
            if let Some(target) = target {
                let rid = pkg.add_rel(
                    &part,
                    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
                    &target,
                    true,
                );
                if let Some(t) = pkg.xml_mut(&part) {
                    set_attr_ns(t, link, super::super::tree::R, "id", &rid);
                }
            }
            Ok((
                format!("{parent}/hyperlink[{n}]"),
                unread_keys(props, &took),
                Vec::new(),
            ))
        }
        "pagebreak" | "columnbreak" | "break" => {
            let mut took: Vec<String> = Vec::new();
            let get = |keys: &[&str]| {
                props
                    .iter()
                    .rev()
                    .find(|(k, _)| keys.iter().any(|n| k.eq_ignore_ascii_case(n)))
            };
            let mut kind_value = if lower == "columnbreak" {
                "column"
            } else {
                "page"
            };
            if let Some((k, v)) = get(&["type", "breakType"]) {
                took.push(k.clone());
                kind_value = match v.to_ascii_lowercase().as_str() {
                    "page" => "page",
                    "column" => "column",
                    "textwrapping" | "line" => "textWrapping",
                    _ => {
                        return Err(fail(format!(
                            "Invalid break type: '{v}'. Valid values: page, column, line, textwrapping."
                        )));
                    }
                };
            }
            let br = el(t, "br");
            wattr(t, br, "type", kind_value);
            if let Some((k, v)) = get(&["breakClear", "clear"]) {
                took.push(k.clone());
                let clear = match v.to_ascii_lowercase().as_str() {
                    c @ ("all" | "left" | "right" | "none") => c.to_string(),
                    _ => {
                        return Err(fail(format!(
                            "Invalid break clear: '{v}'. Valid values: all, left, right, none."
                        )));
                    }
                };
                wattr(t, br, "clear", &clear);
            }
            let run = el(t, "r");
            t.append(run, br);
            if is(t, parent_id, "p") {
                let tid = ids.take();
                set_attr_ns(t, parent_id, W14, "textId", &tid);
                let runs: Vec<Id> = children(t, parent_id)
                    .into_iter()
                    .filter(|c| is(t, *c, "r"))
                    .collect();
                let pos = match index {
                    Some(i) if i < runs.len() => t.nodes[parent_id]
                        .kids
                        .iter()
                        .position(|k| matches!(k, Kid::El(c) if *c == runs[i])),
                    _ => None,
                };
                insert_at(t, parent_id, pos, run);
                let n = children(t, parent_id)
                    .into_iter()
                    .filter(|c| is(t, *c, "r"))
                    .position(|c| c == run)
                    .map_or(1, |i| i + 1);
                let path = paragraph_path(pkg, &part, parent_id);
                return Ok((
                    format!("{path}/r[{n}]"),
                    unread_keys(props, &took),
                    Vec::new(),
                ));
            }
            let para = el(t, "p");
            let pid = ids.take();
            set_attr_ns(t, para, W14, "paraId", &pid);
            let tid = ids.take();
            set_attr_ns(t, para, W14, "textId", &tid);
            t.append(para, run);
            let pos = at(t, &|c| block(t, c));
            insert_at(t, parent_id, pos, para);
            Ok((
                paragraph_path(pkg, &part, para),
                unread_keys(props, &took),
                Vec::new(),
            ))
        }
        "cell" | "tc" => {
            if !is(t, parent_id, "tr") {
                return Err(fail(
                    "Cells can only be added to a table row: /body/tbl[N]/tr[M]".to_string(),
                ));
            }
            let mut took: Vec<String> = Vec::new();
            let get = |key: &str| {
                props
                    .iter()
                    .rev()
                    .find(|(k, _)| k.eq_ignore_ascii_case(key))
            };
            let p = el(t, "p");
            let pid = ids.take();
            set_attr_ns(t, p, W14, "paraId", &pid);
            let tid = ids.take();
            set_attr_ns(t, p, W14, "textId", &tid);
            if let Some((k, v)) = get("text") {
                took.push(k.clone());
                let r = el(t, "r");
                run_content(t, r, v);
                t.append(p, r);
            }
            let tc = el(t, "tc");
            t.append(tc, p);
            let mut tcpr: Option<Id> = None;
            let cell_props = |t: &mut Tree, tcpr: &mut Option<Id>| -> Id {
                match *tcpr {
                    Some(x) => x,
                    None => {
                        let x = el(t, "tcPr");
                        insert_at(t, tc, Some(0), x);
                        *tcpr = Some(x);
                        x
                    }
                }
            };
            if let Some((k, v)) = get("width") {
                took.push(k.clone());
                let x = cell_props(t, &mut tcpr);
                let w = el(t, "tcW");
                let v = v.trim();
                if let Some(pct) = v.strip_suffix('%').and_then(|n| n.parse::<f64>().ok()) {
                    wattr(t, w, "w", &((pct * 50.0).round() as i64).to_string());
                    wattr(t, w, "type", "pct");
                } else if v.eq_ignore_ascii_case("nil") || v.eq_ignore_ascii_case("auto") {
                    wattr(t, w, "w", "0");
                    wattr(t, w, "type", &v.to_ascii_lowercase());
                } else {
                    let dxa = if v.len() > 3 && v[v.len() - 3..].eq_ignore_ascii_case("dxa") {
                        &v[..v.len() - 3]
                    } else {
                        v
                    };
                    wattr(t, w, "w", dxa);
                    wattr(t, w, "type", "dxa");
                }
                place_ordered(t, x, w, TCPR_ORDER);
            }
            for (key, value) in props {
                if ["fill", "shd", "shading", "cellshading"]
                    .iter()
                    .any(|n| key.eq_ignore_ascii_case(n))
                {
                    took.push(key.clone());
                    let x = cell_props(t, &mut tcpr);
                    shading(t, x, value, TCPR_ORDER)?;
                }
            }
            let run_keys: Vec<(String, String)> = props
                .iter()
                .filter(|(k, _)| {
                    [
                        "font",
                        "size",
                        "fontsize",
                        "bold",
                        "italic",
                        "color",
                        "highlight",
                        "underline",
                        "strike",
                    ]
                    .iter()
                    .any(|n| k.eq_ignore_ascii_case(n))
                })
                .cloned()
                .collect();
            if !run_keys.is_empty() {
                let runs: Vec<Id> = children(t, p)
                    .into_iter()
                    .filter(|c| is(t, *c, "r"))
                    .collect();
                for r in &runs {
                    let rpr = el(t, "rPr");
                    insert_at(t, *r, Some(0), rpr);
                    took.extend(apply_run(t, rpr, &run_keys, false)?);
                }
                let ppr = el(t, "pPr");
                insert_at(t, p, Some(0), ppr);
                let mark = el(t, "rPr");
                took.extend(apply_run(t, mark, &run_keys, false)?);
                if runs.is_empty() && t.nodes[mark].kids.is_empty() {
                    t.detach(ppr);
                } else {
                    place_ordered(t, ppr, mark, PPR_ORDER);
                }
            }
            for (key, tag) in [
                ("noWrap", "noWrap"),
                ("tcFitText", "tcFitText"),
                ("hideMark", "hideMark"),
            ] {
                if let Some((k, v)) = get(key) {
                    took.push(k.clone());
                    if truthy(v) {
                        let x = cell_props(t, &mut tcpr);
                        ensure(t, x, tag, TCPR_ORDER);
                    }
                }
            }
            for (key, tag) in [("vMerge", "vMerge"), ("hMerge", "hMerge")] {
                if let Some((k, v)) = get(key) {
                    took.push(k.clone());
                    if !v.is_empty() {
                        let x = cell_props(t, &mut tcpr);
                        let e = replace(t, x, tag, TCPR_ORDER);
                        if v.eq_ignore_ascii_case("restart") {
                            wattr(t, e, "val", "restart");
                        }
                    }
                }
            }
            if let Some((k, v)) = props.iter().rev().find(|(k, _)| {
                ["gridSpan", "colspan"]
                    .iter()
                    .any(|n| k.eq_ignore_ascii_case(n))
            }) {
                took.push(k.clone());
                let span: i64 = v
                    .trim()
                    .parse()
                    .map_err(|_| fail(format!("Invalid 'gridSpan' value: '{v}'.")))?;
                if span > 0 {
                    let x = cell_props(t, &mut tcpr);
                    let e = replace(t, x, "gridSpan", TCPR_ORDER);
                    wattr(t, e, "val", &span.to_string());
                }
            }
            let cells: Vec<Id> = children(t, parent_id)
                .into_iter()
                .filter(|c| is(t, *c, "tc"))
                .collect();
            let pos = match index {
                Some(i) if i < cells.len() => t.nodes[parent_id]
                    .kids
                    .iter()
                    .position(|k| matches!(k, Kid::El(c) if *c == cells[i])),
                _ => None,
            };
            insert_at(t, parent_id, pos, tc);
            if let Some(table) = t.nodes[parent_id].parent.filter(|tb| is(t, *tb, "tbl")) {
                if let Some(grid) = child(t, table, "tblGrid") {
                    let widths: Vec<i64> = children(t, grid)
                        .into_iter()
                        .filter(|c| is(t, *c, "gridCol"))
                        .map(|c| {
                            attr(t, c, W, "w")
                                .and_then(|w| w.parse().ok())
                                .unwrap_or(2400)
                        })
                        .collect();
                    let span: usize = children(t, parent_id)
                        .into_iter()
                        .filter(|c| is(t, *c, "tc"))
                        .map(|c| {
                            child(t, c, "tcPr")
                                .and_then(|x| child(t, x, "gridSpan"))
                                .and_then(|g| attr(t, g, W, "val"))
                                .and_then(|v| v.parse().ok())
                                .unwrap_or(1)
                        })
                        .sum();
                    if span > widths.len() {
                        let avg = if widths.is_empty() {
                            2400
                        } else {
                            widths.iter().sum::<i64>() / widths.len() as i64
                        };
                        for _ in widths.len()..span {
                            let g = el(t, "gridCol");
                            wattr(t, g, "w", &avg.to_string());
                            t.append(grid, g);
                        }
                        let rows: Vec<Id> = children(t, table)
                            .into_iter()
                            .filter(|c| is(t, *c, "tr") && *c != parent_id)
                            .collect();
                        for row in rows {
                            for _ in widths.len()..span {
                                let pad = el(t, "tc");
                                let pp = el(t, "p");
                                let a = ids.take();
                                set_attr_ns(t, pp, W14, "paraId", &a);
                                let b = ids.take();
                                set_attr_ns(t, pp, W14, "textId", &b);
                                t.append(pad, pp);
                                t.append(row, pad);
                            }
                        }
                    }
                }
            }
            let n = children(t, parent_id)
                .into_iter()
                .filter(|c| is(t, *c, "tc"))
                .position(|c| c == tc)
                .map_or(1, |i| i + 1);
            Ok((
                format!("{parent_path}/tc[{n}]"),
                unread_keys(props, &took),
                Vec::new(),
            ))
        }
        _ => {
            let known = TYPES.split(", ").any(|v| {
                let name = v.split(' ').next().unwrap_or(v);
                name == lower
                    || v.contains(&format!("({lower})"))
                    || v.contains(&format!("({lower},"))
                    || v.contains(&format!(" {lower})"))
            });
            if known {
                Err(fail(format!(
                    "add --type {kind} on .docx is not available yet"
                )))
            } else {
                Err(fail(format!(
                    "Unknown element type '{kind}' for {parent_path}. Valid types: {TYPES}. Use 'office docx add' for details."
                )))
            }
        }
    }
}

/// The keys of `props` not in `took`.
fn unread_keys(props: &[(String, String)], took: &[String]) -> Vec<String> {
    props
        .iter()
        .map(|(k, _)| k.clone())
        .filter(|k| !took.iter().any(|x| x.eq_ignore_ascii_case(k)))
        .collect()
}

/// Why `kind` cannot go under the element `parent` is, in OfficeCLI's
/// words, or None when it can.
fn parent_fault(t: &Tree, parent: Id, at: &str, kind: &str) -> Option<String> {
    let k = kind.to_ascii_lowercase();
    let name = t.nodes[parent].name.as_str();
    let w = &*t.nodes[parent].ns == W;
    if w && name == "sectPr" && k != "header" && k != "footer" {
        return Some(format!(
            "Cannot add '{kind}' under {at}. SectionProperties only holds layout metadata; use 'office set' to modify pgSz, pgMar, cols, etc."
        ));
    }
    if w && name == "p" {
        match k.as_str() {
            "paragraph" | "p" | "table" | "tbl" | "section" | "sectionbreak" | "toc"
            | "tableofcontents" => {
                return Some(format!(
                    "Cannot add '{kind}' under {at}: a paragraph cannot contain another paragraph, table, section break, or TOC. Add at /body instead, or use --after/--before find:<text> to split this paragraph at the anchor."
                ));
            }
            "sectpr" => {
                return Some(format!(
                    "Cannot add '{kind}' under {at}: raw <w:sectPr> cannot be a direct child of a paragraph (it must live inside <w:pPr>). Use `--type section` to create a proper paragraph-level section break."
                ));
            }
            _ => {}
        }
    }
    if w && name == "body" {
        let fault = match k.as_str() {
            "row" | "tr" => Some("rows must be added under a table (/body/tbl[N]).".to_string()),
            "cell" | "tc" => Some("cells must be added under a row (/body/tbl[N]/tr[M]).".to_string()),
            "run" | "r" | "hyperlink" | "link" => Some("inline-level elements must live inside a paragraph (/body/p[N]).".to_string()),
            "sectpr" => Some("body-level <w:sectPr> is a singleton. Use 'office set /body/sectPr' to modify it, or add a section break via `--type section` (which creates a paragraph-level break).".to_string()),
            "style" => return Some(format!("Cannot add 'style' under {at}: styles belong under /styles, not /body.")),
            _ => None,
        };
        if let Some(f) = fault {
            return Some(format!("Cannot add '{kind}' under {at}: {f}"));
        }
    }
    if w && name == "tc" {
        match k.as_str() {
            "paragraph" | "p" | "table" | "tbl" | "sdt" | "contentcontrol" | "picture"
            | "image" | "img" | "ole" | "oleobject" | "object" | "embed" | "inlinedparts"
            | "activex" | "diagram" | "smartart" | "vmlshape" | "drawingshape" | "bookmark"
            | "bookmarkend" => {}
            "cell" | "tc" => {
                return Some(format!(
                    "Cannot add '{kind}' under {at}: cells cannot be nested inside cells. Add cells under a row (/body/tbl[N]/tr[M])."
                ));
            }
            _ => {
                return Some(format!(
                    "Cannot add '{kind}' under {at}: table cells only accept paragraphs, tables, or SDTs (block-level content). Add the element inside a paragraph first."
                ));
            }
        }
    }
    if k == "style" && !(w && name == "styles") {
        return Some(format!(
            "Cannot add 'style' under {at}: styles belong under /styles."
        ));
    }
    if w && name == "tbl" && !matches!(k.as_str(), "row" | "tr" | "col" | "column") {
        return Some(format!(
            "Cannot add '{kind}' under {at}: tables only accept rows (/body/tbl[N]/tr). Use --type row."
        ));
    }
    if w && name == "tr" && !matches!(k.as_str(), "cell" | "tc") {
        return Some(format!(
            "Cannot add '{kind}' under {at}: table rows only accept cells (/body/tbl[N]/tr[M]/tc). Use --type cell."
        ));
    }
    if w && name == "sdt" {
        return Some(format!(
            "Cannot add '{kind}' directly under {at}. SDT (content control) elements only contain <w:sdtPr> and <w:sdtContent>. Add under {at}/sdtContent instead."
        ));
    }
    if w && name == "styles" && k != "style" {
        return Some(format!(
            "Cannot add '{kind}' under /styles. /styles only holds style definitions — use --type style with --prop id=... --prop name=... (and basedOn/font/size/etc.) to add one."
        ));
    }
    None
}

/// The text width of the document's last section in twips: page width
/// less the side margins.
fn text_width(t: &Tree) -> i64 {
    let body = children(t, t.root).into_iter().find(|c| is(t, *c, "body"));
    let sect = body.and_then(|b| child(t, b, "sectPr"));
    let num = |id: Option<Id>, name: &str, default: i64| {
        id.and_then(|i| attr(t, i, W, name))
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(default)
    };
    let pg = sect.and_then(|s| child(t, s, "pgSz"));
    let mar = sect.and_then(|s| child(t, s, "pgMar"));
    num(pg, "w", 11906) - num(mar, "left", 1800) - num(mar, "right", 1800)
}

/// A table of `rows` by `cols`, or the `data` it is given (`;` between
/// rows, `,` between cells), its columns sharing the text width.
fn build_table(
    t: &mut Tree,
    ids: &mut Ids,
    props: &[(String, String)],
    _part: &str,
) -> Result<(i64, Vec<String>, Id), Fail> {
    let get = |key: &str| {
        props
            .iter()
            .rev()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(k, v)| (k.clone(), v.clone()))
    };
    let mut took = Vec::new();
    let data: Option<Vec<Vec<String>>> = get("data").map(|(k, v)| {
        took.push(k);
        v.split(';')
            .map(|row| row.split(',').map(|c| c.trim().to_string()).collect())
            .collect()
    });
    let count = |key: &str, default: usize| -> Result<usize, Fail> {
        match get(key) {
            Some((_, v)) => v
                .trim()
                .parse::<usize>()
                .ok()
                .filter(|n| *n >= 1)
                .ok_or_else(|| {
                    fail(format!(
                        "Invalid '{key}' value: '{v}'. Expected a positive integer."
                    ))
                }),
            None => Ok(default),
        }
    };
    let (rows, cols) = match &data {
        Some(d) => (d.len(), d.iter().map(Vec::len).max().unwrap_or(1)),
        None => (count("rows", 1)?, count("cols", 1)?),
    };
    for k in ["rows", "cols"] {
        if let Some((key, _)) = get(k) {
            took.push(key);
        }
    }
    let available = text_width(t);
    let col = available / cols as i64;
    let tbl = el(t, "tbl");
    let tpr = el(t, "tblPr");
    t.append(tbl, tpr);
    let tw = el(t, "tblW");
    wattr(t, tw, "w", &(col * cols as i64).to_string());
    wattr(t, tw, "type", "dxa");
    t.append(tpr, tw);
    let borders = el(t, "tblBorders");
    for side in ["top", "left", "bottom", "right", "insideH", "insideV"] {
        let b = el(t, side);
        wattr(t, b, "val", "single");
        wattr(t, b, "sz", "4");
        t.append(borders, b);
    }
    t.append(tpr, borders);
    let grid = el(t, "tblGrid");
    for _ in 0..cols {
        let g = el(t, "gridCol");
        wattr(t, g, "w", &col.to_string());
        t.append(grid, g);
    }
    t.append(tbl, grid);
    for r in 0..rows {
        let tr = el(t, "tr");
        for c in 0..cols {
            let tc = el(t, "tc");
            let p = el(t, "p");
            let pid = ids.take();
            set_attr_ns(t, p, W14, "paraId", &pid);
            let tid = ids.take();
            set_attr_ns(t, p, W14, "textId", &tid);
            if let Some(text) = data
                .as_ref()
                .and_then(|d| d.get(r))
                .and_then(|row| row.get(c))
            {
                let run = el(t, "r");
                run_content(t, run, text);
                t.append(p, run);
            }
            t.append(tc, p);
            t.append(tr, tc);
        }
        t.append(tbl, tr);
    }
    Ok((col, took, tbl))
}

/// The keys `set` reads on each element it changes.
const PARAGRAPH_KEYS: &[&str] = &["text"];

/// `set`: the props written onto the element at `path`.
pub(in super::super) fn set(
    pkg: &mut Pkg<'_>,
    path: &str,
    props: &[(String, String)],
) -> Result<(String, Vec<String>), SetFail> {
    let mut ids = prepare(pkg);
    let (part, id, _) = {
        let word = Word::new(pkg);
        word.locate(path)?
    };
    let style_note = style_warning(pkg, props);
    let list = match pkg.xml(&part) {
        Some(t) if is(t, id, "p") => {
            let container = t.nodes[id].parent.unwrap_or(t.root);
            let current = child(t, id, "pPr")
                .and_then(|ppr| child(t, ppr, "numPr"))
                .and_then(|n| wval(t, n, "ilvl"))
                .and_then(|v| v.parse::<i64>().ok());
            plan_list(pkg, props, &part, container, Some(id), current)?
        }
        _ => None,
    };
    let known = style_ids(pkg);
    let t = pkg
        .xml_mut(&part)
        .ok_or_else(|| fail(format!("Path not found: {path}")))?;
    let text = props
        .iter()
        .rev()
        .find(|(k, _)| k.eq_ignore_ascii_case("text"))
        .map(|(_, v)| v.clone());
    let mut took: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = style_note
        .map(|w| format!("  WARNING: {w}"))
        .into_iter()
        .collect();
    let name = t.nodes[id].name.clone();
    match name.as_str() {
        "p" => {
            let ppr = match child(t, id, "pPr") {
                Some(p) => p,
                None => {
                    let p = el(t, "pPr");
                    insert_at(t, id, Some(0), p);
                    p
                }
            };
            let (k, w) = apply_paragraph(t, ppr, props, &|s| known.contains(s))?;
            took.extend(k);
            warnings.extend(w);
            if let Some(plan) = &list {
                apply_plan(t, ppr, plan);
                took.extend(plan.took.iter().cloned());
            }
            let runs: Vec<Id> = children(t, id)
                .into_iter()
                .filter(|c| is(t, *c, "r"))
                .collect();
            if let Some(text) = &text {
                took.push("text".to_string());
                let keep = runs.first().and_then(|r| child(t, *r, "rPr"));
                for r in &runs {
                    t.detach(*r);
                }
                let links: Vec<Id> = children(t, id)
                    .into_iter()
                    .filter(|c| is(t, *c, "hyperlink"))
                    .collect();
                for h in links {
                    t.detach(h);
                }
                let r = el(t, "r");
                if let Some(rpr) = keep {
                    t.append(r, rpr);
                }
                run_content(t, r, text);
                t.append(id, r);
            }
            let runs: Vec<Id> = children(t, id)
                .into_iter()
                .filter(|c| is(t, *c, "r"))
                .collect();
            let run_keys: Vec<(String, String)> = props
                .iter()
                .filter(|(k, _)| !took.iter().any(|x| x.eq_ignore_ascii_case(k)))
                .cloned()
                .collect();
            if !run_keys.is_empty() {
                let mut run_took = Vec::new();
                for r in runs {
                    let rpr = match child(t, r, "rPr") {
                        Some(x) => x,
                        None => {
                            let x = el(t, "rPr");
                            insert_at(t, r, Some(0), x);
                            x
                        }
                    };
                    run_took = apply_run(t, rpr, &run_keys, false)?;
                }
                took.extend(run_took);
            }
            let tid = ids.take();
            set_attr_ns(t, id, W14, "textId", &tid);
        }
        "r" => {
            let rpr = match child(t, id, "rPr") {
                Some(x) => x,
                None => {
                    let x = el(t, "rPr");
                    insert_at(t, id, Some(0), x);
                    x
                }
            };
            took.extend(apply_run(t, rpr, props, false)?);
            if let Some(text) = &text {
                took.push("text".to_string());
                for c in children(t, id) {
                    if !is(t, c, "rPr") {
                        t.detach(c);
                    }
                }
                run_content(t, id, text);
            }
            let mut up = t.nodes[id].parent;
            while let Some(p) = up {
                if is(t, p, "p") {
                    let tid = ids.take();
                    set_attr_ns(t, p, W14, "textId", &tid);
                    break;
                }
                up = t.nodes[p].parent;
            }
        }
        "tc" => {
            let tcpr = match child(t, id, "tcPr") {
                Some(x) => x,
                None => {
                    let x = el(t, "tcPr");
                    insert_at(t, id, Some(0), x);
                    x
                }
            };
            if let Some((k, v)) = props.iter().rev().find(|(k, _)| {
                ["shading", "shd", "fill"]
                    .iter()
                    .any(|x| k.eq_ignore_ascii_case(x))
            }) {
                took.push(k.clone());
                shading(t, tcpr, v, TCPR_ORDER)?;
            }
            if let Some(text) = &text {
                took.push("text".to_string());
                let paras: Vec<Id> = children(t, id)
                    .into_iter()
                    .filter(|c| is(t, *c, "p"))
                    .collect();
                for p in paras.iter().skip(1) {
                    t.detach(*p);
                }
                let p = match paras.first() {
                    Some(p) => *p,
                    None => {
                        let p = el(t, "p");
                        let pid = ids.take();
                        set_attr_ns(t, p, W14, "paraId", &pid);
                        t.append(id, p);
                        p
                    }
                };
                for c in children(t, p) {
                    if !is(t, c, "pPr") {
                        t.detach(c);
                    }
                }
                let r = el(t, "r");
                run_content(t, r, text);
                t.append(p, r);
            }
        }
        _ => {}
    }
    let unread: Vec<String> = props
        .iter()
        .map(|(k, _)| k.clone())
        .filter(|k| !took.iter().any(|x| x.eq_ignore_ascii_case(k)))
        .collect();
    let _ = PARAGRAPH_KEYS;
    if !unread.is_empty() && took.is_empty() {
        return Err(SetFail::Unsupported {
            keys: unread,
            element: match name.as_str() {
                "p" => "paragraph",
                "r" => "run",
                "tc" => "cell",
                "tbl" => "table",
                _ => "element",
            },
            valid: &[
                "text",
                "style",
                "alignment",
                "bold",
                "italic",
                "size",
                "font",
                "color",
            ],
        });
    }
    let shown: Vec<String> = props.iter().map(|(k, v)| format!("{k}={v}")).collect();
    Ok((format!("Updated {path}: {}", shown.join(", ")), warnings))
}

/// `remove`: the element at `path` taken out.
pub(in super::super) fn remove(
    pkg: &mut Pkg<'_>,
    path: &str,
) -> Result<(String, Vec<String>), Fail> {
    prepare(pkg);
    let (part, id, _) = {
        let word = Word::new(pkg);
        word.locate(path)?
    };
    let t = pkg
        .xml_mut(&part)
        .ok_or_else(|| fail(format!("Path not found: {path}")))?;
    let name = t.nodes[id].name.clone();
    if matches!(name.as_str(), "body" | "document" | "sectPr")
        && t.nodes[id]
            .parent
            .is_none_or(|p| is(t, p, "body") || is(t, p, "document"))
        && name != "sectPr"
    {
        return Err(fail(format!(
            "Cannot remove container element '{path}': it is a required structural element of the document."
        )));
    }
    if name == "tc" {
        if let Some(row) = t.nodes[id].parent {
            if children(t, row)
                .into_iter()
                .filter(|c| is(t, *c, "tc"))
                .count()
                == 1
            {
                t.detach(id);
                let p = el(t, "p");
                let tc = el(t, "tc");
                t.append(tc, p);
                t.append(row, tc);
                return Ok((format!("Removed {path}"), Vec::new()));
            }
        }
    }
    t.detach(id);
    Ok((format!("Removed {path}"), Vec::new()))
}

/// The path `get` gives element `id` of `part` after a move or swap: by
/// its place among its parent's same-named children.
fn indexed_path(pkg: &Pkg<'_>, part: &str, id: Id) -> String {
    let Some(t) = pkg.xml(part) else {
        return String::new();
    };
    let mut segs = Vec::new();
    let mut cur = Some(id);
    while let Some(c) = cur {
        if is(t, c, "body") {
            segs.push("/body".to_string());
            break;
        }
        let name = t.nodes[c].name.clone();
        let parent = t.nodes[c].parent;
        let n = parent
            .map(|p| {
                children(t, p)
                    .into_iter()
                    .filter(|x| t.nodes[*x].name == name && &*t.nodes[*x].ns == W)
                    .position(|x| x == c)
                    .map_or(1, |i| i + 1)
            })
            .unwrap_or(1);
        segs.push(format!("/{name}[{n}]"));
        cur = parent;
    }
    segs.reverse();
    segs.concat()
}

/// `move`: the element at `path` put elsewhere under its parent, or under
/// `to`.
pub(in super::super) fn move_to(
    pkg: &mut Pkg<'_>,
    path: &str,
    to: Option<&str>,
    place: &Place<'_>,
) -> Result<String, Fail> {
    prepare(pkg);
    let (part, id, _) = {
        let word = Word::new(pkg);
        word.locate(path)?
    };
    let target = match to {
        Some(to) => {
            let word = Word::new(pkg);
            let (tp, tid, _) = word.locate(to)?;
            if tp != part {
                return Err(fail(format!(
                    "Cannot move {path} into {to}: a different part"
                )));
            }
            Some(tid)
        }
        None => None,
    };
    let anchor = match (place.after, place.before) {
        (Some(a), _) => Some((a, true)),
        (_, Some(b)) => Some((b, false)),
        _ => None,
    };
    let anchored = match anchor {
        Some((p, after)) => {
            let word = Word::new(pkg);
            let (_, aid, _) = word.locate(p)?;
            Some((aid, after))
        }
        None => None,
    };
    let t = pkg
        .xml_mut(&part)
        .ok_or_else(|| fail(format!("Path not found: {path}")))?;
    let parent = match (target, anchored) {
        (Some(tid), _) => tid,
        (None, Some((aid, _))) => t.nodes[aid].parent.unwrap_or(t.root),
        (None, None) => t.nodes[id].parent.unwrap_or(t.root),
    };
    t.detach(id);
    let name = t.nodes[id].name.clone();
    let pos = if let Some((aid, after)) = anchored {
        t.nodes[parent]
            .kids
            .iter()
            .position(|k| matches!(k, Kid::El(c) if *c == aid))
            .map(|p| if after { p + 1 } else { p })
    } else {
        let counted = |c: Id| is(t, c, &name);
        insertion(t, parent, place.index.map(|i| i.max(0) as usize), &counted)
    };
    insert_at(t, parent, pos, id);
    Ok(format!("Moved to {}", indexed_path(pkg, &part, id)))
}

/// `swap`: two elements trade places.
pub(in super::super) fn swap(pkg: &mut Pkg<'_>, first: &str, second: &str) -> Result<String, Fail> {
    prepare(pkg);
    let (part, a, b) = {
        let word = Word::new(pkg);
        let (pa, a, _) = word.locate(first)?;
        let (pb, b, _) = word.locate(second)?;
        if pa != pb {
            return Err(fail(format!(
                "Cannot swap {first} and {second}: they are in different parts"
            )));
        }
        (pa, a, b)
    };
    let t = pkg
        .xml_mut(&part)
        .ok_or_else(|| fail(format!("Path not found: {first}")))?;
    let (Some(pa), Some(pb)) = (t.nodes[a].parent, t.nodes[b].parent) else {
        return Err(fail(format!("Cannot swap {first} and {second}")));
    };
    let ia = t.nodes[pa]
        .kids
        .iter()
        .position(|k| matches!(k, Kid::El(c) if *c == a))
        .unwrap_or(0);
    let ib = t.nodes[pb]
        .kids
        .iter()
        .position(|k| matches!(k, Kid::El(c) if *c == b))
        .unwrap_or(0);
    t.nodes[pa].kids[ia] = Kid::El(b);
    t.nodes[pb].kids[ib] = Kid::El(a);
    t.nodes[a].parent = Some(pb);
    t.nodes[b].parent = Some(pa);
    Ok(format!(
        "Swapped {} <-> {}",
        indexed_path(pkg, &part, a),
        indexed_path(pkg, &part, b)
    ))
}
