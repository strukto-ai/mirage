// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! Changing a deck as OfficeCLI's PowerPoint handler does: slides added
//! from a layout with their title and text, text boxes and tables added
//! with shape ids from 100000, properties set, and slides and shapes
//! removed, moved and swapped.

use super::super::errors::{Fail, SetFail};
use super::super::media::{self, Media};
use super::super::package::{Pkg, relative, resolve_target};
use super::super::tree::{self, A, Id, Kid, P, R, Tree, insert_at, set_attr, set_attr_ns};
use super::super::types::{Added, Place};
use super::deck::Deck;

const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const SLIDE_TYPE: &str = "application/vnd.openxmlformats-officedocument.presentationml.slide+xml";
const HEAD: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";
const EMPTY_TREE: &str =
    "<p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>";
const TABLE_URI: &str = "http://schemas.openxmlformats.org/drawingml/2006/table";

fn fail(message: String) -> Fail {
    Fail::of(message)
}

/// A read handle on element `id` of `t`.
fn at(t: &Tree, id: Id) -> tree::E<'_> {
    tree::E { t, id }
}

fn get<'a>(props: &'a [(String, String)], keys: &[&str]) -> Option<&'a (String, String)> {
    props
        .iter()
        .rev()
        .find(|(k, _)| keys.iter().any(|x| k.eq_ignore_ascii_case(x)))
}

fn truthy(v: &str) -> bool {
    matches!(
        v.trim().to_ascii_lowercase().as_str(),
        "true" | "1" | "yes" | "on"
    )
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// A length in EMU, as OfficeCLI's `ParseEmu` reads one: `mm`, `cm`,
/// `in`, `pc`, `pt`, `px`, `Q`, or bare EMU.
pub(in super::super) fn emu(value: &str) -> Result<i64, Fail> {
    let v = value.trim();
    let units: [(&str, f64); 7] = [
        ("mm", 36_000.0),
        ("cm", 360_000.0),
        ("in", 914_400.0),
        ("pc", 152_400.0),
        ("pt", 12_700.0),
        ("px", 9_525.0),
        ("q", 9_000.0),
    ];
    let lower = v.to_ascii_lowercase();
    for (suffix, per) in units {
        if let Some(n) = lower.strip_suffix(suffix) {
            return n
                .trim()
                .parse::<f64>()
                .ok()
                .filter(|n| n.is_finite())
                .map(|n| (n * per).round() as i64)
                .ok_or_else(|| fail(format!("Invalid length value: '{value}'.")));
        }
    }
    v.parse::<f64>()
        .ok()
        .filter(|n| n.is_finite())
        .map(|n| n.round() as i64)
        .ok_or_else(|| {
            fail(format!(
                "Invalid length value: '{value}'. Expected e.g. 2cm, 1in, 72pt."
            ))
        })
}

/// A color as `a:srgbClr` stores it.
fn rgb(value: &str) -> Result<String, Fail> {
    let v = value.trim().trim_start_matches('#');
    let v = if v.len() == 3 {
        v.chars().flat_map(|c| [c, c]).collect()
    } else if v.len() == 8 && v.is_ascii() {
        v[2..].to_string()
    } else {
        v.to_string()
    };
    if v.len() == 6 && v.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(v.to_ascii_uppercase());
    }
    let named = match value.trim().to_ascii_lowercase().as_str() {
        "black" => "000000",
        "white" => "FFFFFF",
        "red" => "FF0000",
        "green" => "008000",
        "blue" => "0000FF",
        "yellow" => "FFFF00",
        "gray" | "grey" => "808080",
        "orange" => "FFA500",
        "purple" => "800080",
        _ => {
            return Err(fail(format!(
                "Invalid color value: '{value}'. Expected a hex color (e.g. FF0000) or a color name."
            )));
        }
    };
    Ok(named.to_string())
}

/// The paragraphs of `text`, one per line, each run carrying `rpr`.
fn paragraphs_xml(text: &str, rpr: &str) -> String {
    if text.is_empty() {
        return "<a:p/>".to_string();
    }
    text.split('\n')
        .map(|line| {
            if line.is_empty() {
                "<a:p><a:endParaRPr lang=\"en-US\"/></a:p>".to_string()
            } else {
                format!("<a:p><a:r>{rpr}<a:t>{}</a:t></a:r></a:p>", escape(line))
            }
        })
        .collect()
}

/// The order `a:rPr` keeps its children in.
const RPR_KIDS: &[&str] = &[
    "ln",
    "noFill",
    "solidFill",
    "gradFill",
    "blipFill",
    "pattFill",
    "grpFill",
    "effectLst",
    "effectDag",
    "highlight",
    "uLnTx",
    "uLn",
    "uFillTx",
    "uFill",
    "latin",
    "ea",
    "cs",
    "sym",
    "hlinkClick",
    "hlinkMouseOver",
    "rtl",
    "extLst",
];

const FILLS: &[&str] = &[
    "noFill",
    "solidFill",
    "gradFill",
    "blipFill",
    "pattFill",
    "grpFill",
];

/// The run properties `rpr` written onto the run's `a:rPr` `old`, keeping
/// every property `rpr` does not name.
fn merge_rpr(t: &mut Tree, old: Id, rpr: &str) -> Result<(), Fail> {
    let frag = parse(&rpr.replacen("<a:rPr", &format!("<a:rPr xmlns:a=\"{A}\""), 1))?;
    let root = frag.root();
    for a in root.attrs() {
        let kept = a.name == "lang" && at(t, old).attr("lang").is_some();
        if a.ns.is_empty() && !kept {
            set_attr(t, old, &a.name, &a.value);
        }
    }
    for kid in root.elements() {
        let name = kid.name();
        let clash: Vec<Id> = at(t, old)
            .elements()
            .filter(|e| e.name() == name || (FILLS.contains(&name) && FILLS.contains(&e.name())))
            .map(|e| e.id)
            .collect();
        for c in clash {
            t.detach(c);
        }
        let rank = |n: &str| {
            RPR_KIDS
                .iter()
                .position(|k| *k == n)
                .unwrap_or(RPR_KIDS.len())
        };
        let pos = t.nodes[old]
            .kids
            .iter()
            .position(|k| matches!(k, Kid::El(c) if rank(&t.nodes[*c].name) > rank(name)));
        let copy = t.adopt(kid);
        t.nodes[copy].decls.clear();
        insert_at(t, old, pos, copy);
    }
    Ok(())
}

/// The run properties `rpr` applied to every run under `body`, merged into
/// each run's own.
fn apply_rpr(t: &mut Tree, body: Id, rpr: &str) -> Result<(), Fail> {
    let runs: Vec<Id> = at(t, body)
        .descendants_named(A, "r")
        .iter()
        .map(|e| e.id)
        .collect();
    for r in runs {
        let old = match at(t, r).child(A, "rPr").map(|e| e.id) {
            Some(old) => old,
            None => {
                let fresh = t.create(A, "rPr", "a");
                insert_at(t, r, Some(0), fresh);
                fresh
            }
        };
        merge_rpr(t, old, rpr)?;
    }
    Ok(())
}

/// The paragraphs under `body` replaced by `text`'s lines, each keeping the
/// first paragraph's `a:pPr` and the first run's `a:rPr`.
fn replace_text(t: &mut Tree, body: Id, text: &str) -> Result<(), Fail> {
    let mut kept = Tree::fragment(A, "txBody", "a");
    let mut keep = |name: &str| {
        at(t, body)
            .descendants_named(A, name)
            .first()
            .map(|e| kept.adopt(*e))
    };
    let ppr = keep("pPr");
    let rpr = keep("rPr");
    let paras: Vec<Id> = at(t, body).children(A, "p").iter().map(|e| e.id).collect();
    for p in paras {
        t.detach(p);
    }
    let lines = paragraphs_xml(text, "<a:rPr lang=\"en-US\"/>");
    let frag = parse(&format!("<a:txBody xmlns:a=\"{A}\">{lines}</a:txBody>"))?;
    for p in frag.root().children(A, "p") {
        let copy = t.adopt(p);
        t.nodes[copy].decls.clear();
        t.append(body, copy);
        if let Some(ppr) = ppr.filter(|_| !t.nodes[copy].kids.is_empty()) {
            let own = t.adopt(at(&kept, ppr));
            insert_at(t, copy, Some(0), own);
        }
        let Some(rpr) = rpr else {
            continue;
        };
        for r in at(t, copy)
            .children(A, "r")
            .iter()
            .map(|e| e.id)
            .collect::<Vec<Id>>()
        {
            if let Some(old) = at(t, r).child(A, "rPr").map(|e| e.id) {
                t.detach(old);
            }
            let own = t.adopt(at(&kept, rpr));
            insert_at(t, r, Some(0), own);
        }
    }
    Ok(())
}

/// The run properties `size`, `bold`, `italic`, `color`, `font` and
/// `underline` describe, with the keys taken.
fn run_props(props: &[(String, String)]) -> Result<(String, Vec<String>), Fail> {
    let mut took = Vec::new();
    let mut attrs = String::from(" lang=\"en-US\"");
    if let Some((k, v)) = get(props, &["size", "fontsize", "font.size"]) {
        took.push(k.clone());
        let pt: f64 = v
            .trim()
            .trim_end_matches("pt")
            .trim()
            .parse()
            .map_err(|_| fail(format!("Invalid font size: '{v}'.")))?;
        attrs.push_str(&format!(" sz=\"{}\"", (pt * 100.0).round() as i64));
    }
    if let Some((k, v)) = get(props, &["bold"]) {
        took.push(k.clone());
        attrs.push_str(if truthy(v) { " b=\"1\"" } else { " b=\"0\"" });
    }
    if let Some((k, v)) = get(props, &["italic"]) {
        took.push(k.clone());
        attrs.push_str(if truthy(v) { " i=\"1\"" } else { " i=\"0\"" });
    }
    if let Some((k, v)) = get(props, &["underline"]) {
        took.push(k.clone());
        let u = if truthy(v) || v.eq_ignore_ascii_case("single") {
            "sng"
        } else if v.eq_ignore_ascii_case("double") {
            "dbl"
        } else {
            "none"
        };
        attrs.push_str(&format!(" u=\"{u}\""));
    }
    let mut kids = String::new();
    if let Some((k, v)) = get(props, &["color", "font.color"]) {
        took.push(k.clone());
        kids.push_str(&format!(
            "<a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill>",
            rgb(v)?
        ));
    }
    if let Some((k, v)) = get(props, &["font", "font.name", "font.latin"]) {
        took.push(k.clone());
        kids.push_str(&format!("<a:latin typeface=\"{}\"/>", escape(v)));
    }
    Ok((
        if kids.is_empty() {
            format!("<a:rPr{attrs}/>")
        } else {
            format!("<a:rPr{attrs}>{kids}</a:rPr>")
        },
        took,
    ))
}

/// The keys of `props` not in `took`.
fn unread(props: &[(String, String)], took: &[String]) -> Vec<String> {
    props
        .iter()
        .map(|(k, _)| k.clone())
        .filter(|k| !took.iter().any(|t| t.eq_ignore_ascii_case(k)))
        .collect()
}

/// The next shape id: past every shape id on every slide, never below
/// 100000.
fn next_shape_id(pkg: &Pkg<'_>) -> u32 {
    let deck = Deck::new(pkg);
    let mut max = 99_999u32;
    for part in deck.slide_parts() {
        if let Some(t) = pkg.xml(&part) {
            for el in &t.nodes {
                if el.name == "cNvPr" && &*el.ns == P {
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

/// The slide size in EMU.
fn slide_size(pkg: &Pkg<'_>) -> (i64, i64) {
    let deck = Deck::new(pkg);
    let sz = deck.presentation().and_then(|p| p.child(P, "sldSz"));
    let n = |name: &str, d: i64| {
        sz.and_then(|s| s.attr(name))
            .and_then(|v| v.parse().ok())
            .unwrap_or(d)
    };
    (n("cx", 12_192_000), n("cy", 6_858_000))
}

/// The layout a slide takes: the first, or the one `hint` names by name,
/// type, alias, number or part of its name.
fn resolve_layout(pkg: &Pkg<'_>, hint: Option<&str>) -> Result<Option<String>, Fail> {
    let deck = Deck::new(pkg);
    let all = deck.all_layouts();
    if all.is_empty() {
        return Ok(None);
    }
    let Some(hint) = hint.filter(|h| !h.is_empty()) else {
        return Ok(all.first().cloned());
    };
    let root = |l: &str| deck.root_of(l);
    let name = |l: &str| {
        root(l)
            .and_then(|r| r.child(P, "cSld"))
            .and_then(|c| c.attr("name").map(str::to_string))
    };
    let kind = |l: &str| root(l).and_then(|r| r.attr("type").map(str::to_string));
    let matching = |l: &str| root(l).and_then(|r| r.attr("matchingName").map(str::to_string));
    if let Some(l) = all.iter().find(|l| {
        name(l).is_some_and(|n| n.eq_ignore_ascii_case(hint))
            || matching(l).is_some_and(|n| n.eq_ignore_ascii_case(hint))
    }) {
        return Ok(Some(l.clone()));
    }
    if let Some(l) = all
        .iter()
        .find(|l| kind(l).is_some_and(|k| k.eq_ignore_ascii_case(hint)))
    {
        return Ok(Some(l.clone()));
    }
    let alias = match hint.to_ascii_lowercase().as_str() {
        "title" => Some("title"),
        "titleonly" | "title_only" => Some("titleOnly"),
        "blank" => Some("blank"),
        "twocontent" | "two_content" | "twocol" => Some("twoColTx"),
        "titlecontent" | "title_content" => Some("obj"),
        "section" | "sectionheader" => Some("secHead"),
        "comparison" => Some("twoTxTwoObj"),
        "contentwithcaption" | "caption" => Some("objTx"),
        "picturewithcaption" | "pictxt" => Some("picTx"),
        "custom" => Some("cust"),
        _ => None,
    };
    if let Some(a) = alias {
        if let Some(l) = all.iter().find(|l| kind(l).as_deref() == Some(a)) {
            return Ok(Some(l.clone()));
        }
    }
    if let Ok(n) = hint.parse::<usize>() {
        if n >= 1 && n <= all.len() {
            return Ok(Some(all[n - 1].clone()));
        }
    }
    if let Some(l) = all
        .iter()
        .find(|l| name(l).is_some_and(|n| n.to_lowercase().contains(&hint.to_lowercase())))
    {
        return Ok(Some(l.clone()));
    }
    let listed: Vec<String> = all
        .iter()
        .enumerate()
        .map(|(i, l)| {
            format!(
                "[{}] {} ({})",
                i + 1,
                name(l).unwrap_or_else(|| "(unnamed)".to_string()),
                kind(l).unwrap_or_else(|| "?".to_string())
            )
        })
        .collect();
    Err(fail(format!(
        "Layout '{hint}' not found. Available layouts: {}",
        listed.join(", ")
    )))
}

/// A placeholder's type, index and frame.
type Found = (Option<String>, Option<String>, Option<[i64; 4]>);

/// The layout placeholder of the title family, or of the body family: its
/// type, index and frame.
fn layout_placeholder(pkg: &Pkg<'_>, layout: Option<&str>, title: bool) -> Option<Found> {
    let deck = Deck::new(pkg);
    let find = |part: &str| -> Option<Found> {
        let tree = deck.root_of(part)?.child(P, "cSld")?.child(P, "spTree")?;
        for sp in tree.children(P, "sp") {
            let Some(ph) = sp
                .child(P, "nvSpPr")
                .and_then(|n| n.child(P, "nvPr"))
                .and_then(|n| n.child(P, "ph"))
            else {
                continue;
            };
            let t = ph.attr("type").unwrap_or("obj");
            let hit = if title {
                matches!(t, "title" | "ctrTitle")
            } else {
                matches!(t, "body" | "subTitle" | "obj")
            };
            if !hit {
                continue;
            }
            let frame = sp
                .child(P, "spPr")
                .and_then(|s| s.child(A, "xfrm"))
                .and_then(|x| {
                    let off = x.child(A, "off")?;
                    let ext = x.child(A, "ext")?;
                    Some([
                        off.attr("x")?.parse().ok()?,
                        off.attr("y")?.parse().ok()?,
                        ext.attr("cx")?.parse().ok()?,
                        ext.attr("cy")?.parse().ok()?,
                    ])
                });
            return Some((
                ph.attr("type").map(str::to_string),
                ph.attr("idx").map(str::to_string),
                frame,
            ));
        }
        None
    };
    let layout = layout?;
    let (kind, idx, frame) = find(layout)?;
    let frame = frame.or_else(|| {
        deck.pkg
            .related(layout, "slideMaster")
            .first()
            .and_then(|m| find(m))
            .and_then(|(_, _, f)| f)
    });
    Some((kind, idx, frame))
}

/// A slide's title or content shape, fitted to the layout's placeholder.
fn text_shape(pkg: &Pkg<'_>, layout: Option<&str>, id: u32, title: bool, text: &str) -> String {
    let (name, mut ph_type, mut ph_idx, mut frame) = if title {
        (
            "Title",
            Some("title".to_string()),
            None,
            [838_200, 365_125, 10_515_600, 1_320_800],
        )
    } else {
        (
            "Content",
            Some("body".to_string()),
            Some("1".to_string()),
            [838_200, 1_825_625, 10_515_600, 4_349_750],
        )
    };
    let (sw, sh) = slide_size(pkg);
    if let Some((kind, idx, f)) = layout_placeholder(pkg, layout, title) {
        if let Some(k) = kind {
            ph_type = Some(k);
        }
        ph_idx = idx;
        if let Some(f) = f.filter(|f| f[0] + f[2] <= sw && f[1] + f[3] <= sh) {
            frame = f;
        }
    }
    let ph = format!(
        "<p:ph{}{}/>",
        ph_type.map_or(String::new(), |t| format!(" type=\"{t}\"")),
        ph_idx.map_or(String::new(), |i| format!(" idx=\"{i}\""))
    );
    let tx = if title {
        "<p:cNvSpPr/>"
    } else {
        "<p:cNvSpPr txBox=\"1\"/>"
    };
    let [x, y, cx, cy] = frame;
    format!(
        "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{name}\"/>{tx}<p:nvPr>{ph}</p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>{}</p:txBody></p:sp>",
        paragraphs_xml(text, "<a:rPr lang=\"en-US\"/>")
    )
}

fn parse(xml: &str) -> Result<Tree, Fail> {
    tree::parse(xml.as_bytes()).map_err(|_| fail("Malformed XML built for the deck".to_string()))
}

/// The slide part `n` names (1-based), or the not-found refusal.
fn slide_at(pkg: &Pkg<'_>, n: usize) -> Result<String, Fail> {
    let parts = Deck::new(pkg).slide_parts();
    parts
        .get(n.wrapping_sub(1))
        .cloned()
        .ok_or_else(|| fail(format!("Slide {n} not found (total: {})", parts.len())))
}

/// `/slide[N]` and what follows it.
fn slide_number(path: &str) -> Option<(usize, &str)> {
    let rest = path.strip_prefix("/slide[")?;
    let (n, tail) = rest.split_once(']')?;
    Some((n.parse().ok()?, tail))
}

/// The element of a slide's shape tree a path tail names: `shape[K]`,
/// `shape[@id=X]`, `picture[K]`, `table[K]`, `table[@id=X]` or
/// `placeholder[T]`.
fn shape_in(t: &Tree, tail: &str) -> Result<Id, Fail> {
    let root = t.root();
    let tree = root
        .child(P, "cSld")
        .and_then(|c| c.child(P, "spTree"))
        .ok_or_else(|| fail("Corrupt file: slide data missing".to_string()))?;
    let mut segs = tail.trim_start_matches('/').split('/');
    let seg = segs.next().unwrap_or_default();
    let rest: Vec<&str> = segs.collect();
    let (kind, pred) = seg
        .split_once('[')
        .map(|(k, p)| (k, p.trim_end_matches(']')))
        .unwrap_or((seg, ""));
    let shapes: Vec<tree::E<'_>> = match kind.to_ascii_lowercase().as_str() {
        "shape" => tree.children(P, "sp"),
        "picture" => tree.children(P, "pic"),
        "table" => tree
            .children(P, "graphicFrame")
            .into_iter()
            .filter(|g| !g.descendants_named(A, "tbl").is_empty())
            .collect(),
        "placeholder" => {
            let hit = tree.children(P, "sp").into_iter().find(|sp| {
                sp.child(P, "nvSpPr")
                    .and_then(|n| n.child(P, "nvPr"))
                    .and_then(|n| n.child(P, "ph"))
                    .is_some_and(|ph| {
                        ph.attr("type").unwrap_or("obj").eq_ignore_ascii_case(pred)
                            || ph.attr("idx") == Some(pred)
                    })
            });
            return hit.map(|e| e.id).ok_or_else(|| {
                fail(format!(
                    "Placeholder '{pred}' not found on slide or its layout"
                ))
            });
        }
        _ => return Err(fail(format!("Path not found: {tail}"))),
    };
    let found = if let Some(id) = pred.strip_prefix("@id=") {
        shapes.into_iter().find(|s| {
            s.descendants_named(P, "cNvPr")
                .first()
                .and_then(|c| c.attr("id"))
                == Some(id)
        })
    } else {
        pred.parse::<usize>()
            .ok()
            .and_then(|n| shapes.get(n.wrapping_sub(1)).copied())
    };
    let found = found.ok_or_else(|| fail(format!("Path not found: {tail}")))?;
    if rest.is_empty() {
        return Ok(found.id);
    }
    let index = |seg: &str, name: &str| -> Option<usize> {
        seg.strip_prefix(name)?
            .strip_prefix('[')?
            .strip_suffix(']')?
            .parse()
            .ok()
    };
    let Some(table) = found.descendants_named(A, "tbl").first().copied() else {
        return Err(fail(format!("Path not found: {tail}")));
    };
    let Some(r) = index(rest[0], "tr") else {
        return Err(fail(format!("Path not found: {tail}")));
    };
    let rows = table.children(A, "tr");
    let row = rows
        .get(r.wrapping_sub(1))
        .copied()
        .ok_or_else(|| fail(format!("Row {r} not found (table has {} rows)", rows.len())))?;
    let Some(cell) = rest.get(1) else {
        return Ok(row.id);
    };
    let Some(c) = index(cell, "tc") else {
        return Err(fail(format!("Path not found: {tail}")));
    };
    let cells = row.children(A, "tc");
    cells.get(c.wrapping_sub(1)).map(|e| e.id).ok_or_else(|| {
        fail(format!(
            "Cell {c} not found (row has {} cells)",
            cells.len()
        ))
    })
}

/// The element types `add` makes in a deck.
const TYPES: &[&str] = &[
    "slide",
    "shape",
    "textbox",
    "table",
    "picture",
    "chart",
    "connector",
    "group",
    "video",
    "audio",
    "equation",
    "ole",
    "notes",
    "comment",
    "zoom",
    "3dmodel",
    "diagram",
];

/// `add`: a new slide, text box, table, picture, row or notes.
pub(in super::super) fn add(
    pkg: &mut Pkg<'_>,
    parent: &str,
    kind: &str,
    place: &Place<'_>,
    props: &[(String, String)],
    media: &Media,
) -> Result<Added, Fail> {
    let lower = kind.to_ascii_lowercase();
    match lower.as_str() {
        "slide" => add_slide(pkg, parent, place, props),
        "picture" | "image" | "img" => add_picture(pkg, parent, place, props, media),
        "notes" | "note" => {
            let Some((n, _)) = slide_number(parent).filter(|(_, t)| t.is_empty()) else {
                return Err(fail(
                    "Notes must be added to a slide: /slide[N]".to_string(),
                ));
            };
            let slide = slide_at(pkg, n)?;
            let notes = ensure_notes(pkg, &slide)?;
            let mut took = Vec::new();
            if let Some((k, v)) = get(props, &["text"]) {
                took.push(k.clone());
                set_notes_text(pkg, &notes, v)?;
            }
            Ok((
                format!("/slide[{n}]/notes"),
                unread(props, &took),
                Vec::new(),
            ))
        }
        "row" | "tr" => {
            let (part, element) = locate(pkg, parent)?;
            let frame = element
                .filter(|e| {
                    pkg.xml(&part)
                        .is_some_and(|t| t.nodes[*e].name == "graphicFrame")
                })
                .ok_or_else(|| fail(format!("Rows can only be added to a table: {parent}")))?;
            add_table_row(pkg, &part, parent, frame, place, props)
        }
        "shape" | "textbox" | "table" => {
            let Some((n, tail)) = slide_number(parent).filter(|(_, t)| t.is_empty()) else {
                return Err(fail(format!(
                    "Generic add requires a path starting with /slide[N]: {parent}"
                )));
            };
            let part = slide_at(pkg, n)?;
            let _ = tail;
            if lower == "table" {
                add_table(pkg, &part, n, place, props)
            } else {
                add_text_box(pkg, &part, n, place, props)
            }
        }
        t if TYPES.contains(&t) => Err(fail(format!(
            "add --type {kind} on .pptx is not available yet"
        ))),
        _ => Err(fail(format!(
            "Generic add requires a path starting with /slide[N]: {parent}"
        ))),
    }
}

fn add_slide(
    pkg: &mut Pkg<'_>,
    parent: &str,
    place: &Place<'_>,
    props: &[(String, String)],
) -> Result<Added, Fail> {
    if !(parent.is_empty() || parent == "/") {
        return Err(fail(format!(
            "Invalid parent '{parent}' for --type slide: a slide can only be added at '/' (slides hang off the presentation root, not under another element)."
        )));
    }
    let anchor = |path: &str| -> Result<i64, Fail> {
        match slide_number(path).filter(|(_, t)| t.is_empty()) {
            Some((n, _)) => slide_at(pkg, n).map(|_| n as i64),
            None => Err(fail(format!("Anchor element not found: {path}"))),
        }
    };
    let index = match (place.after, place.before) {
        (Some(a), _) => Some(anchor(a)?),
        (_, Some(b)) => Some(anchor(b)? - 1),
        _ => place.index,
    };
    let mut took = Vec::new();
    let layout_hint = get(props, &["layout"]).map(|(k, v)| {
        took.push(k.clone());
        v.clone()
    });
    let layout = resolve_layout(pkg, layout_hint.as_deref())?;
    let mut shapes = String::new();
    let mut next = 2;
    if let Some((k, v)) = get(props, &["title"]) {
        took.push(k.clone());
        shapes.push_str(&text_shape(pkg, layout.as_deref(), next, true, v));
        next += 1;
    }
    if let Some((k, v)) = get(props, &["text"]) {
        took.push(k.clone());
        shapes.push_str(&text_shape(pkg, layout.as_deref(), next, false, v));
    }
    let show = match get(props, &["hidden"]) {
        Some((k, v)) => {
            took.push(k.clone());
            if truthy(v) { " show=\"0\"" } else { "" }
        }
        None => "",
    };
    let name = match get(props, &["name"]) {
        Some((k, v)) if !v.is_empty() => {
            took.push(k.clone());
            format!(" name=\"{}\"", escape(v))
        }
        Some((k, _)) => {
            took.push(k.clone());
            String::new()
        }
        None => String::new(),
    };
    let xml = format!(
        "{HEAD}<p:sld xmlns:a=\"{A}\" xmlns:r=\"{REL}\" xmlns:p=\"{P}\"{show}><p:cSld{name}><p:spTree>{EMPTY_TREE}{shapes}</p:spTree></p:cSld></p:sld>"
    );
    let part = (1..)
        .map(|n| format!("/ppt/slides/slide{n}.xml"))
        .find(|p| !pkg.has(p))
        .unwrap_or_default();
    pkg.add_part(&part, parse(&xml)?, SLIDE_TYPE);
    if let Some(layout) = &layout {
        let target = relative(&part, layout);
        pkg.add_rel(&part, &format!("{REL}/slideLayout"), &target, false);
    }
    let main = pkg.main.clone();
    let rid = pkg.add_rel(
        &main,
        &format!("{REL}/slide"),
        &relative(&main, &part),
        false,
    );
    let t = pkg
        .xml_mut(&main)
        .ok_or_else(|| fail("Presentation not found".to_string()))?;
    let root = t.root;
    let list = match at(t, root).child(P, "sldIdLst").map(|e| e.id) {
        Some(l) => l,
        None => {
            let l = t.create(P, "sldIdLst", "");
            let at = t.nodes[root].kids.iter().position(|k| {
                matches!(k, Kid::El(c) if !matches!(t.nodes[*c].name.as_str(), "sldMasterIdLst" | "notesMasterIdLst" | "handoutMasterIdLst"))
            });
            insert_at(t, root, at, l);
            l
        }
    };
    let ids: Vec<Id> = t.nodes[list]
        .kids
        .iter()
        .filter_map(|k| match k {
            Kid::El(c) => Some(*c),
            _ => None,
        })
        .collect();
    let max = ids
        .iter()
        .filter_map(|c| {
            t.nodes[*c]
                .attrs
                .iter()
                .find(|a| a.name == "id" && a.ns.is_empty())
                .and_then(|a| a.value.parse::<u32>().ok())
        })
        .max();
    let new_id = max.map_or(256, |m| m + 1);
    let sid = t.create(P, "sldId", "");
    set_attr(t, sid, "id", &new_id.to_string());
    set_attr_ns(t, sid, R, "id", &rid);
    let at = index
        .filter(|i| *i >= 0 && (*i as usize) < ids.len())
        .and_then(|i| {
            t.nodes[list]
                .kids
                .iter()
                .position(|k| matches!(k, Kid::El(c) if *c == ids[i as usize]))
        });
    insert_at(t, list, at, sid);
    let position = Deck::new(pkg)
        .slide_parts()
        .iter()
        .position(|p| *p == part)
        .map_or(1, |i| i + 1);
    Ok((
        format!("/slide[{position}]"),
        unread(props, &took),
        Vec::new(),
    ))
}

fn add_text_box(
    pkg: &mut Pkg<'_>,
    part: &str,
    n: usize,
    place: &Place<'_>,
    props: &[(String, String)],
) -> Result<Added, Fail> {
    let id = next_shape_id(pkg);
    let mut took = Vec::new();
    let length = |keys: &[&str], d: i64, took: &mut Vec<String>| -> Result<i64, Fail> {
        match get(props, keys) {
            Some((k, v)) => {
                took.push(k.clone());
                emu(v)
            }
            None => Ok(d),
        }
    };
    let x = length(&["x", "left"], 0, &mut took)?;
    let y = length(&["y", "top"], 0, &mut took)?;
    let cx = length(&["width", "w"], 3_600_000, &mut took)?;
    let cy = length(&["height", "h"], 1_800_000, &mut took)?;
    let count = pkg
        .xml(part)
        .and_then(|t| {
            t.root()
                .child(P, "cSld")
                .and_then(|c| c.child(P, "spTree"))
                .map(|s| s.children(P, "sp").len())
        })
        .unwrap_or(0);
    let name = match get(props, &["name"]) {
        Some((k, v)) => {
            took.push(k.clone());
            v.clone()
        }
        None => format!("TextBox {}", count + 1),
    };
    let fill = match get(props, &["fill"]) {
        Some((k, v)) => {
            took.push(k.clone());
            format!(
                "<a:solidFill><a:srgbClr val=\"{}\"/></a:solidFill>",
                rgb(v)?
            )
        }
        None => String::new(),
    };
    let (rpr, run_took) = run_props(props)?;
    took.extend(run_took);
    let text = get(props, &["text"]).map(|(k, v)| {
        took.push(k.clone());
        v.clone()
    });
    let body = paragraphs_xml(text.as_deref().unwrap_or(""), &rpr);
    let xml = format!(
        "<p:sp xmlns:a=\"{A}\" xmlns:p=\"{P}\"><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{}\"/><p:cNvSpPr txBox=\"1\"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom>{fill}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>{body}</p:txBody></p:sp>",
        escape(&name)
    );
    insert_shape(pkg, part, &xml, place)?;
    Ok((
        format!("/slide[{n}]/shape[@id={id}]"),
        unread(props, &took),
        Vec::new(),
    ))
}

/// The shape-tree element `--after` or `--before` names on slide `part`,
/// and whether the new shape goes after it.
fn shape_anchor(pkg: &Pkg<'_>, part: &str, place: &Place<'_>) -> Result<Option<(Id, bool)>, Fail> {
    let Some((path, after)) = place
        .after
        .map(|a| (a, true))
        .or(place.before.map(|b| (b, false)))
    else {
        return Ok(None);
    };
    match locate(pkg, path)? {
        (p, Some(el)) if p == part => Ok(Some((el, after))),
        _ => Err(fail(format!("Anchor element not found: {path}"))),
    }
}

/// Where in the shape tree a new shape goes: beside its anchor, before the
/// `index`th shape, or last.
fn shape_slot(
    t: &Tree,
    tree_id: Id,
    index: Option<i64>,
    anchored: Option<(Id, bool)>,
) -> Option<usize> {
    let kids = &t.nodes[tree_id].kids;
    if let Some((aid, after)) = anchored {
        let mut top = aid;
        while t.nodes[top].parent != Some(tree_id) {
            top = t.nodes[top].parent?;
        }
        return kids
            .iter()
            .position(|k| matches!(k, Kid::El(c) if *c == top))
            .map(|p| if after { p + 1 } else { p });
    }
    let content: Vec<usize> = kids
        .iter()
        .enumerate()
        .filter_map(|(i, k)| match k {
            Kid::El(c) if !matches!(t.nodes[*c].name.as_str(), "nvGrpSpPr" | "grpSpPr") => Some(i),
            _ => None,
        })
        .collect();
    match index {
        Some(i) if i >= 0 && (i as usize) < content.len() => Some(content[i as usize]),
        Some(_) => content.last().map(|l| l + 1),
        None => None,
    }
}

/// `xml`, one shape element, put in the slide's shape tree where `place`
/// says.
fn insert_shape(pkg: &mut Pkg<'_>, part: &str, xml: &str, place: &Place<'_>) -> Result<(), Fail> {
    let anchored = shape_anchor(pkg, part, place)?;
    let fragment = parse(xml)?;
    let t = pkg
        .xml_mut(part)
        .ok_or_else(|| fail("Corrupt file: slide data missing".to_string()))?;
    let tree_id = t
        .root()
        .child(P, "cSld")
        .and_then(|c| c.child(P, "spTree"))
        .map(|e| e.id)
        .ok_or_else(|| fail("Corrupt file: slide data missing".to_string()))?;
    let copy = t.adopt(fragment.root());
    t.nodes[copy].decls.clear();
    let pos = shape_slot(t, tree_id, place.index, anchored);
    insert_at(t, tree_id, pos, copy);
    Ok(())
}

/// A picture: the image `src` names embedded in the slide, framed at its
/// pixel aspect and centered unless placed, as OfficeCLI's AddPicture.
fn add_picture(
    pkg: &mut Pkg<'_>,
    parent: &str,
    place: &Place<'_>,
    props: &[(String, String)],
    media: &Media,
) -> Result<Added, Fail> {
    let mut took = Vec::new();
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
    let Some((n, _)) = slide_number(parent).filter(|(_, t)| t.is_empty()) else {
        return Err(fail(
            "Pictures must be added to a slide: /slide[N]".to_string(),
        ));
    };
    let part = slide_at(pkg, n)?;
    let image = media::take(media, src)?;
    let (rid, svg_rid) = media::embed(pkg, &part, image, props, media, &mut took)?;
    let width = get(props, &["width"]);
    let height = get(props, &["height"]);
    let mut cx = 5_486_400;
    let mut cy = 3_657_600;
    if let Some((k, v)) = width {
        took.push(k.clone());
        cx = emu(v)?;
    }
    if let Some((k, v)) = height {
        took.push(k.clone());
        cy = emu(v)?;
    }
    if cx < 0 {
        return Err(fail(format!(
            "Negative width is not allowed: '{}'.",
            width.map(|(_, v)| v.as_str()).unwrap_or_default()
        )));
    }
    if cy < 0 {
        return Err(fail(format!(
            "Negative height is not allowed: '{}'.",
            height.map(|(_, v)| v.as_str()).unwrap_or_default()
        )));
    }
    let (cx, cy) = media::fit(image, cx, cy, width.is_some(), height.is_some());
    let (sw, sh) = slide_size(pkg);
    let mut x = (sw - cx) / 2;
    let mut y = (sh - cy) / 2;
    if let Some((k, v)) = media::value(props, "x")
        .map(|v| ("x", v))
        .or_else(|| media::value(props, "left").map(|v| ("left", v)))
    {
        took.push(k.to_string());
        x = emu(v)?;
    }
    if let Some((k, v)) = media::value(props, "y")
        .map(|v| ("y", v))
        .or_else(|| media::value(props, "top").map(|v| ("top", v)))
    {
        took.push(k.to_string());
        y = emu(v)?;
    }
    let id = next_shape_id(pkg);
    let count = pkg
        .xml(&part)
        .and_then(|t| {
            t.root()
                .child(P, "cSld")
                .and_then(|c| c.child(P, "spTree"))
                .map(|s| s.children(P, "pic").len())
        })
        .unwrap_or(0);
    let name = match get(props, &["name"]) {
        Some((k, v)) => {
            took.push(k.clone());
            v.clone()
        }
        None => format!("Picture {}", count + 1),
    };
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
    let mut sides: [Option<i64>; 4] = [None; 4];
    if let Some((k, all)) = get(props, &["crop"]) {
        took.push(k.clone());
        let one = |s: &str| -> Result<i64, Fail> {
            let stripped = s.trim();
            let stripped = stripped.strip_suffix('%').unwrap_or(stripped).trim();
            let v = media::number(stripped, "crop")?;
            if !(-1000.0..=1000.0).contains(&v) {
                return Err(fail(format!(
                    "Invalid 'crop' value: '{}'. Crop percentage must be between -1000 and 1000.",
                    s.trim()
                )));
            }
            Ok((v * 1000.0) as i64)
        };
        let parts: Vec<&str> = all.split(',').collect();
        sides = match parts.as_slice() {
            [l, t, r, b] => [Some(one(l)?), Some(one(t)?), Some(one(r)?), Some(one(b)?)],
            [v, h] => {
                let (v, h) = (one(v)?, one(h)?);
                [Some(h), Some(v), Some(h), Some(v)]
            }
            [p] => [Some(one(p)?); 4],
            _ => {
                return Err(fail(format!(
                    "Invalid 'crop' value: '{all}'. Expected 1, 2, or 4 comma-separated percentages."
                )));
            }
        };
    }
    for (i, key) in ["cropleft", "croptop", "cropright", "cropbottom"]
        .iter()
        .enumerate()
    {
        if let Some((k, v)) = get(props, &[key]) {
            took.push(k.clone());
            let stripped = v.trim();
            let stripped = stripped.strip_suffix('%').unwrap_or(stripped).trim();
            let d = stripped
                .parse::<f64>()
                .ok()
                .filter(|d| !d.is_nan())
                .ok_or_else(|| {
                    fail(format!(
                        "Invalid '{key}' value: '{v}'. Expected a percentage (-1000 to 1000)."
                    ))
                })?;
            if !(-1000.0..=1000.0).contains(&d) {
                return Err(fail(format!(
                    "Invalid '{key}' value: '{v}'. Crop percentage must be between -1000 and 1000."
                )));
            }
            sides[i] = Some((d * 1000.0) as i64);
        }
    }
    let src_rect = if sides.iter().any(|s| s.is_some_and(|v| v != 0)) {
        format!("<a:srcRect{}/>", media::src_rect(sides))
    } else {
        String::new()
    };
    let fill = media::value(props, "fillMode")
        .map(|v| ("fillMode", v))
        .or_else(|| media::value(props, "fill").map(|v| ("fill", v)));
    if let Some((k, v)) = fill {
        if v.eq_ignore_ascii_case("stretch") {
            took.push(k.to_string());
        }
    }
    let mut xfrm = String::new();
    if let Some((k, v)) = get(props, &["rotation", "rotate"]) {
        took.push(k.clone());
        let deg = media::number(v, "rotation")?;
        xfrm.push_str(&format!(" rot=\"{}\"", (deg * 60_000.0) as i32));
    }
    for (keys, attr) in [(["flipH", "fliph"], "flipH"), (["flipV", "flipv"], "flipV")] {
        if let Some((k, v)) = get(props, &keys) {
            took.push(k.clone());
            xfrm.push_str(&format!(" {attr}=\"{}\"", u8::from(truthy(v))));
        }
    }
    let mut blip = svg_rid.map(|r| media::svg_blip(&r)).unwrap_or_default();
    if let Some((k, v)) = get(props, &["opacity"]) {
        took.push(k.clone());
        let mut o = v
            .trim()
            .parse::<f64>()
            .ok()
            .filter(|o| o.is_finite())
            .ok_or_else(|| {
                fail(format!(
                    "Invalid 'opacity' value: '{v}'. Expected a finite decimal 0.0-1.0."
                ))
            })?;
        if o > 1.0 && o < 2.0 {
            return Err(fail(format!(
                "Invalid 'opacity' value: '{v}'. Expected 0.0-1.0 as decimal or 2-100 as percent (values in (1, 2) are ambiguous)."
            )));
        }
        if o > 1.0 {
            o /= 100.0;
        }
        if !(0.0..=1.0).contains(&o) {
            return Err(fail(format!(
                "Invalid 'opacity' value: '{v}'. Expected 0.0-1.0 (or 0-100 as percent)."
            )));
        }
        blip.push_str(&format!(
            "<a:alphaModFix amt=\"{}\"/>",
            (o * 100_000.0) as i32
        ));
    }
    let descr = alt
        .map(|a| format!(" descr=\"{}\"", escape(&a)))
        .unwrap_or_default();
    let blip = if blip.is_empty() {
        format!("<a:blip r:embed=\"{rid}\"/>")
    } else {
        format!("<a:blip r:embed=\"{rid}\">{blip}</a:blip>")
    };
    let xml = format!(
        "<p:pic xmlns:a=\"{A}\" xmlns:p=\"{P}\" xmlns:r=\"{R}\"><p:nvPicPr><p:cNvPr id=\"{id}\" name=\"{}\"{descr}/><p:cNvPicPr><a:picLocks noChangeAspect=\"1\"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill>{blip}{src_rect}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm{xfrm}><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></p:spPr></p:pic>",
        escape(&name)
    );
    insert_shape(pkg, &part, &xml, place)?;
    Ok((
        format!("/slide[{n}]/picture[@id={id}]"),
        unread(props, &took),
        Vec::new(),
    ))
}

fn add_table(
    pkg: &mut Pkg<'_>,
    part: &str,
    n: usize,
    place: &Place<'_>,
    props: &[(String, String)],
) -> Result<Added, Fail> {
    let id = next_shape_id(pkg);
    let mut took = Vec::new();
    let data: Option<Vec<Vec<String>>> = get(props, &["data"]).map(|(k, v)| {
        took.push(k.clone());
        v.split(';')
            .map(|r| r.split(',').map(|c| c.trim().to_string()).collect())
            .collect()
    });
    let count = |key: &str, took: &mut Vec<String>| -> Result<usize, Fail> {
        match get(props, &[key]) {
            Some((k, v)) => {
                took.push(k.clone());
                v.trim()
                    .parse::<usize>()
                    .ok()
                    .filter(|n| *n >= 1)
                    .ok_or_else(|| {
                        fail(format!(
                            "Invalid '{key}' value: '{v}'. Expected a positive integer."
                        ))
                    })
            }
            None => Ok(1),
        }
    };
    let (rows, cols) = match &data {
        Some(d) => (d.len(), d.iter().map(Vec::len).max().unwrap_or(1)),
        None => (count("rows", &mut took)?, count("cols", &mut took)?),
    };
    let (x, y, cx, row_h) = (457_200i64, 1_600_200i64, 8_229_600i64, 370_840i64);
    let cy = row_h * rows as i64;
    let tables = pkg
        .xml(part)
        .and_then(|t| {
            t.root()
                .child(P, "cSld")
                .and_then(|c| c.child(P, "spTree"))
                .map(|s| {
                    s.children(P, "graphicFrame")
                        .into_iter()
                        .filter(|g| !g.descendants_named(A, "tbl").is_empty())
                        .count()
                })
        })
        .unwrap_or(0);
    let name = match get(props, &["name"]) {
        Some((k, v)) => {
            took.push(k.clone());
            v.clone()
        }
        None => format!("Table {}", tables + 1),
    };
    let col_w = cx / cols as i64;
    let grid: String = (0..cols)
        .map(|_| format!("<a:gridCol w=\"{col_w}\"/>"))
        .collect();
    let mut body = String::new();
    for r in 0..rows {
        body.push_str(&format!("<a:tr h=\"{row_h}\">"));
        for c in 0..cols {
            let text = data
                .as_ref()
                .and_then(|d| d.get(r))
                .and_then(|row| row.get(c))
                .filter(|t| !t.is_empty());
            let para = match text {
                Some(t) => format!(
                    "<a:p><a:r><a:rPr lang=\"en-US\"/><a:t>{}</a:t></a:r></a:p>",
                    escape(t)
                ),
                None => "<a:p><a:endParaRPr lang=\"en-US\"/></a:p>".to_string(),
            };
            body.push_str(&format!(
                "<a:tc><a:txBody><a:bodyPr/><a:lstStyle/>{para}</a:txBody><a:tcPr/></a:tc>"
            ));
        }
        body.push_str("</a:tr>");
    }
    let xml = format!(
        "<p:graphicFrame xmlns:a=\"{A}\" xmlns:p=\"{P}\"><p:nvGraphicFramePr><p:cNvPr id=\"{id}\" name=\"{}\"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x=\"{x}\" y=\"{y}\"/><a:ext cx=\"{cx}\" cy=\"{cy}\"/></p:xfrm><a:graphic><a:graphicData uri=\"{TABLE_URI}\"><a:tbl><a:tblPr firstRow=\"1\" bandRow=\"1\"/><a:tblGrid>{grid}</a:tblGrid>{body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>",
        escape(&name)
    );
    insert_shape(pkg, part, &xml, place)?;
    Ok((
        format!("/slide[{n}]/table[@id={id}]"),
        unread(props, &took),
        Vec::new(),
    ))
}

/// The part and element `path` names: a slide, or a shape on one.
fn locate(pkg: &Pkg<'_>, path: &str) -> Result<(String, Option<Id>), Fail> {
    let Some((n, tail)) = slide_number(path) else {
        return Err(fail(format!("Path not found: {path}")));
    };
    let part = slide_at(pkg, n)?;
    if tail.is_empty() {
        return Ok((part, None));
    }
    let t = pkg
        .xml(&part)
        .ok_or_else(|| fail("Corrupt file: slide data missing".to_string()))?;
    let id = shape_in(t, tail)?;
    Ok((part, Some(id)))
}

/// A shape's `a:xfrm` offset and extent set from the props given.
fn place_shape(
    t: &mut Tree,
    sp: Id,
    props: &[(String, String)],
    took: &mut Vec<String>,
) -> Result<(), Fail> {
    let keys: [(&[&str], &str, &str); 4] = [
        (&["x", "left"], "off", "x"),
        (&["y", "top"], "off", "y"),
        (&["width", "w"], "ext", "cx"),
        (&["height", "h"], "ext", "cy"),
    ];
    for (names, child, attr) in keys {
        let Some((k, v)) = get(props, names) else {
            continue;
        };
        took.push(k.clone());
        let value = emu(v)?;
        if let Some(frame) = at(t, sp).child(P, "xfrm").map(|e| e.id) {
            if let Some(c) = at(t, frame).child(A, child).map(|e| e.id) {
                set_attr(t, c, attr, &value.to_string());
            }
            continue;
        }
        let sppr = at(t, sp)
            .child(P, "spPr")
            .map(|e| e.id)
            .ok_or_else(|| fail("Shape has no properties".to_string()))?;
        let xfrm = match at(t, sppr).child(A, "xfrm").map(|e| e.id) {
            Some(x) => x,
            None => {
                let x = t.create(A, "xfrm", "a");
                insert_at(t, sppr, Some(0), x);
                let off = t.create(A, "off", "a");
                set_attr(t, off, "x", "0");
                set_attr(t, off, "y", "0");
                t.append(x, off);
                let ext = t.create(A, "ext", "a");
                set_attr(t, ext, "cx", "0");
                set_attr(t, ext, "cy", "0");
                t.append(x, ext);
                x
            }
        };
        if let Some(c) = at(t, xfrm).child(A, child).map(|e| e.id) {
            set_attr(t, c, attr, &value.to_string());
        }
    }
    Ok(())
}

/// `set`: the props written onto a shape or slide.
pub(in super::super) fn set(
    pkg: &mut Pkg<'_>,
    path: &str,
    props: &[(String, String)],
) -> Result<(String, Vec<String>), SetFail> {
    if let Some((n, "/notes")) = slide_number(path) {
        let slide = slide_at(pkg, n)?;
        let mut took = Vec::new();
        if let Some((k, v)) = get(props, &["text"]) {
            took.push(k.clone());
            let notes = ensure_notes(pkg, &slide)?;
            set_notes_text(pkg, &notes, v)?;
        }
        return finish(path, props, &took, "notes");
    }
    let (part, element) = locate(pkg, path)?;
    let mut took = Vec::new();
    let Some(sp) = element else {
        if let Some((k, v)) = get(props, &["notes"]) {
            took.push(k.clone());
            let notes = ensure_notes(pkg, &part)?;
            set_notes_text(pkg, &notes, v)?;
        }
        if let Some((k, v)) = get(props, &["hidden"]) {
            took.push(k.clone());
            let t = pkg
                .xml_mut(&part)
                .ok_or_else(|| fail("Corrupt file: slide data missing".to_string()))?;
            let root = t.root;
            if truthy(v) {
                set_attr(t, root, "show", "0");
            } else {
                tree::remove_attr(t, root, "", "show");
            }
        }
        return finish(path, props, &took, "slide");
    };
    let element = pkg
        .xml(&part)
        .map(|t| t.nodes[sp].name.clone())
        .unwrap_or_default();
    if element == "tc" {
        return set_cell(pkg, &part, sp, path, props);
    }
    let fill = match get(props, &["fill"]) {
        Some((k, v)) => {
            took.push(k.clone());
            Some(rgb(v)?)
        }
        None => None,
    };
    let (rpr, run_took) = run_props(props)?;
    let has_run_props = !run_took.is_empty();
    took.extend(run_took);
    let text = get(props, &["text"]).map(|(k, v)| {
        took.push(k.clone());
        v.clone()
    });
    let t = pkg
        .xml_mut(&part)
        .ok_or_else(|| fail("Corrupt file: slide data missing".to_string()))?;
    place_shape(t, sp, props, &mut took)?;
    if let Some(color) = fill {
        if let Some(sppr) = at(t, sp).child(P, "spPr").map(|e| e.id) {
            let old: Vec<Id> = at(t, sppr)
                .elements()
                .filter(|e| {
                    matches!(
                        e.name(),
                        "solidFill" | "noFill" | "gradFill" | "blipFill" | "pattFill"
                    )
                })
                .map(|e| e.id)
                .collect();
            for o in old {
                t.detach(o);
            }
            let frag = parse(&format!(
                "<a:solidFill xmlns:a=\"{A}\"><a:srgbClr val=\"{color}\"/></a:solidFill>"
            ))?;
            let copy = t.adopt(frag.root());
            t.nodes[copy].decls.clear();
            let at = t.nodes[sppr].kids.iter().position(|k| {
                matches!(k, Kid::El(c) if !matches!(t.nodes[*c].name.as_str(), "xfrm" | "custGeom" | "prstGeom"))
            });
            insert_at(t, sppr, at, copy);
        }
    }
    let body = at(t, sp).child(P, "txBody").map(|e| e.id);
    if let Some(body) = body {
        if let Some(text) = &text {
            replace_text(t, body, text)?;
        }
        if has_run_props {
            apply_rpr(t, body, &rpr)?;
        }
    }
    finish(path, props, &took, "shape")
}

const NOTES_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml";
const NOTES_MASTER_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml";
const THEME_TYPE: &str = "application/vnd.openxmlformats-officedocument.theme+xml";

/// A notes page rectangle in the standard 6858000 x 9144000 page, scaled
/// to the deck's notes size.
fn notes_rect(page: (i64, i64), x: i64, y: i64, cx: i64, cy: i64) -> [i64; 4] {
    let scale = |v: i64, actual: i64, standard: i64| {
        if actual == standard {
            v
        } else {
            (v as f64 * actual as f64 / standard as f64).round() as i64
        }
    };
    [
        scale(x, page.0, 6_858_000),
        scale(y, page.1, 9_144_000),
        scale(cx, page.0, 6_858_000),
        scale(cy, page.1, 9_144_000),
    ]
}

/// The notes master OfficeCLI writes for a deck with this notes page and
/// slide size.
fn notes_master_xml(page: (i64, i64), slide: (i64, i64)) -> String {
    let hdr = notes_rect(page, 0, 0, 2_971_800, 458_788);
    let dt = notes_rect(page, 3_884_613, 0, 2_971_800, 458_788);
    let ftr = notes_rect(page, 0, 8_685_213, 2_971_800, 458_787);
    let num = notes_rect(page, 3_884_613, 8_685_213, 2_971_800, 458_787);
    let img_box = notes_rect(page, 1_143_000, 685_800, 4_572_000, 0);
    let img_cy = if slide.0 > 0 {
        (img_box[2] as f64 * slide.1 as f64 / slide.0 as f64).round() as i64
    } else {
        img_box[3]
    };
    let img = [img_box[0], img_box[1], img_box[2], img_cy];
    let quarter = 228_600i64;
    let body_box = notes_rect(page, 685_800, 0, 5_486_400, 4_114_800);
    let body_y =
        ((img_box[1] + img_cy) / quarter * quarter + quarter).min(img_box[1].max(ftr[1] - quarter));
    let body_cy = quarter.max(body_box[3].min(ftr[1] - body_y));
    let body = [body_box[0], body_y, body_box[2], body_cy];
    let xfrm = |r: [i64; 4]| {
        format!(
            "<a:xfrm><a:off x=\"{}\" y=\"{}\"/><a:ext cx=\"{}\" cy=\"{}\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom>",
            r[0], r[1], r[2], r[3]
        )
    };
    let banner = |algn: &str, field: &str| {
        format!(
            "<p:txBody><a:bodyPr vert=\"horz\" lIns=\"91440\" tIns=\"45720\" rIns=\"91440\" bIns=\"45720\"/><a:lstStyle><a:lvl1pPr algn=\"{algn}\"><a:defRPr sz=\"1200\"/></a:lvl1pPr></a:lstStyle><a:p>{field}<a:endParaRPr lang=\"en-US\"/></a:p></p:txBody>"
        )
    };
    let date = "<a:fld id=\"{B1E4B0A2-5C8E-4E5F-9C1D-2F3A4B5C6D71}\" type=\"datetimeFigureOut\"><a:rPr lang=\"en-US\"/></a:fld>";
    let slide_num = "<a:fld id=\"{B1E4B0A2-5C8E-4E5F-9C1D-2F3A4B5C6D72}\" type=\"slidenum\"><a:rPr lang=\"en-US\"/></a:fld>";
    let style: String = (1..=9)
        .map(|lvl| {
            format!(
                "<a:lvl{lvl}pPr marL=\"{}\" algn=\"l\" defTabSz=\"914400\" rtl=\"0\" eaLnBrk=\"1\" latinLnBrk=\"0\" hangingPunct=\"1\"><a:defRPr sz=\"1200\" kern=\"1200\"><a:solidFill><a:schemeClr val=\"tx1\"/></a:solidFill><a:latin typeface=\"+mn-lt\"/><a:ea typeface=\"+mn-ea\"/><a:cs typeface=\"+mn-cs\"/></a:defRPr></a:lvl{lvl}pPr>",
                (lvl - 1) * 457_200
            )
        })
        .collect();
    let sp = |id: u32, name: &str, locks: &str, ph: &str, sppr: String, body: String| {
        format!(
            "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{name}\"/><p:cNvSpPr><a:spLocks {locks}/></p:cNvSpPr><p:nvPr><p:ph {ph}/></p:nvPr></p:nvSpPr><p:spPr>{sppr}</p:spPr>{body}</p:sp>"
        )
    };
    let shapes = [
        sp(2, "Header Placeholder 1", "noGrp=\"1\"", "type=\"hdr\" sz=\"quarter\"", xfrm(hdr), banner("l", "")),
        sp(3, "Date Placeholder 2", "noGrp=\"1\"", "type=\"dt\" idx=\"1\"", xfrm(dt), banner("r", date)),
        sp(
            4,
            "Slide Image Placeholder 3",
            "noGrp=\"1\" noRot=\"1\" noChangeAspect=\"1\"",
            "type=\"sldImg\" idx=\"2\"",
            format!("{}<a:noFill/><a:ln w=\"12700\"><a:solidFill><a:prstClr val=\"black\"/></a:solidFill></a:ln>", xfrm(img)),
            "<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang=\"en-US\"/></a:p></p:txBody>".to_string(),
        ),
        sp(
            5,
            "Notes Placeholder 4",
            "noGrp=\"1\"",
            "type=\"body\" sz=\"quarter\" idx=\"3\"",
            xfrm(body),
            "<p:txBody><a:bodyPr vert=\"horz\" lIns=\"91440\" tIns=\"45720\" rIns=\"91440\" bIns=\"45720\"/><a:lstStyle/><a:p><a:endParaRPr lang=\"en-US\"/></a:p></p:txBody>".to_string(),
        ),
        sp(6, "Footer Placeholder 5", "noGrp=\"1\"", "type=\"ftr\" sz=\"quarter\" idx=\"4\"", xfrm(ftr), banner("l", "")),
        sp(7, "Slide Number Placeholder 6", "noGrp=\"1\"", "type=\"sldNum\" sz=\"quarter\" idx=\"5\"", xfrm(num), banner("r", slide_num)),
    ]
    .concat();
    format!(
        "{HEAD}<p:notesMaster xmlns:a=\"{A}\" xmlns:r=\"{REL}\" xmlns:p=\"{P}\"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"0\" cy=\"0\"/><a:chOff x=\"0\" y=\"0\"/><a:chExt cx=\"0\" cy=\"0\"/></a:xfrm></p:grpSpPr>{shapes}</p:spTree></p:cSld><p:clrMap bg1=\"lt1\" tx1=\"dk1\" bg2=\"lt2\" tx2=\"dk2\" accent1=\"accent1\" accent2=\"accent2\" accent3=\"accent3\" accent4=\"accent4\" accent5=\"accent5\" accent6=\"accent6\" hlink=\"hlink\" folHlink=\"folHlink\"/><p:notesStyle>{style}</p:notesStyle></p:notesMaster>"
    )
}

/// The deck's notes master, made with a copy of the deck's theme when it
/// has none.
fn ensure_notes_master(pkg: &mut Pkg<'_>) -> Result<String, Fail> {
    let main = pkg.main.clone();
    if let Some(found) = pkg.related(&main, "notesMaster").first() {
        return Ok(found.clone());
    }
    let (page, slide) = {
        let deck = Deck::new(pkg);
        let pres = deck.presentation();
        let size = |name: &str, d: (i64, i64)| {
            pres.and_then(|p| p.child(P, name))
                .map(|s| {
                    (
                        s.attr("cx").and_then(|v| v.parse().ok()).unwrap_or(d.0),
                        s.attr("cy").and_then(|v| v.parse().ok()).unwrap_or(d.1),
                    )
                })
                .unwrap_or(d)
        };
        (
            size("notesSz", (6_858_000, 9_144_000)),
            size("sldSz", (12_192_000, 6_858_000)),
        )
    };
    let part = (1..)
        .map(|n| format!("/ppt/notesMasters/notesMaster{n}.xml"))
        .find(|p| !pkg.has(p))
        .unwrap_or_default();
    pkg.add_part(
        &part,
        parse(&notes_master_xml(page, slide))?,
        NOTES_MASTER_TYPE,
    );
    let source = pkg.related(&main, "theme").first().cloned().or_else(|| {
        let deck = Deck::new(pkg);
        deck.masters()
            .first()
            .and_then(|m| deck.pkg.related(m, "theme").first().cloned())
    });
    let theme = source
        .and_then(|s| pkg.xml(&s).cloned())
        .unwrap_or_else(|| Tree::fragment(A, "theme", "a"));
    let theme_part = (2..)
        .map(|n| format!("/ppt/notesMasters/theme/theme{n}.xml"))
        .find(|p| !pkg.has(p))
        .unwrap_or_default();
    pkg.add_part(&theme_part, theme, THEME_TYPE);
    pkg.add_rel(
        &part,
        &format!("{REL}/theme"),
        &relative(&part, &theme_part),
        false,
    );
    let rid = pkg.add_rel(
        &main,
        &format!("{REL}/notesMaster"),
        &relative(&main, &part),
        false,
    );
    let t = pkg
        .xml_mut(&main)
        .ok_or_else(|| fail("Presentation not found".to_string()))?;
    let root = t.root;
    let list = match at(t, root).child(P, "notesMasterIdLst").map(|e| e.id) {
        Some(l) => l,
        None => {
            let l = t.create(P, "notesMasterIdLst", "");
            let after = t.nodes[root]
                .kids
                .iter()
                .position(|k| matches!(k, Kid::El(c) if t.nodes[*c].name == "sldMasterIdLst"))
                .map(|i| i + 1)
                .or(Some(0));
            insert_at(t, root, after, l);
            l
        }
    };
    let old: Vec<Id> = at(t, list).elements().map(|e| e.id).collect();
    for o in old {
        t.detach(o);
    }
    let id = t.create(P, "notesMasterId", "");
    set_attr_ns(t, id, R, "id", &rid);
    t.append(list, id);
    Ok(part)
}

/// The notes slide of `slide`, made with its two placeholders when the
/// slide has none.
fn ensure_notes(pkg: &mut Pkg<'_>, slide: &str) -> Result<String, Fail> {
    if let Some(found) = pkg.related(slide, "notesSlide").first() {
        return Ok(found.clone());
    }
    let master = ensure_notes_master(pkg)?;
    let part = (1..)
        .map(|n| format!("/ppt/notesSlides/notesSlide{n}.xml"))
        .find(|p| !pkg.has(p))
        .unwrap_or_default();
    let placeholder = |id: u32, name: &str, kind: &str, idx: u32| {
        format!(
            "<p:sp><p:nvSpPr><p:cNvPr id=\"{id}\" name=\"{name}\"/><p:cNvSpPr/><p:nvPr><p:ph type=\"{kind}\" idx=\"{idx}\"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>"
        )
    };
    let xml = format!(
        "{HEAD}<p:notes xmlns:a=\"{A}\" xmlns:r=\"{REL}\" xmlns:p=\"{P}\"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id=\"1\" name=\"\"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm/></p:grpSpPr>{}{}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>",
        placeholder(2, "Slide Image Placeholder 1", "sldImg", 0),
        placeholder(3, "Notes Placeholder 2", "body", 1)
    );
    pkg.add_part(&part, parse(&xml)?, NOTES_TYPE);
    pkg.add_rel(
        &part,
        &format!("{REL}/notesMaster"),
        &relative(&part, &master),
        false,
    );
    pkg.add_rel(
        &part,
        &format!("{REL}/slide"),
        &relative(&part, slide),
        false,
    );
    pkg.add_rel(
        slide,
        &format!("{REL}/notesSlide"),
        &relative(slide, &part),
        false,
    );
    Ok(part)
}

/// The notes slide's text set, one paragraph a line, in its first body
/// placeholder.
fn set_notes_text(pkg: &mut Pkg<'_>, notes: &str, text: &str) -> Result<(), Fail> {
    let t = pkg
        .xml_mut(notes)
        .ok_or_else(|| fail("Notes slide has no shape tree".to_string()))?;
    let tree_id = t
        .root()
        .child(P, "cSld")
        .and_then(|c| c.child(P, "spTree"))
        .map(|e| e.id)
        .ok_or_else(|| fail("Notes slide has no shape tree".to_string()))?;
    let bodies: Vec<Id> = at(t, tree_id)
        .children(P, "sp")
        .into_iter()
        .filter(|sp| {
            sp.child(P, "nvSpPr")
                .and_then(|n| n.child(P, "nvPr"))
                .and_then(|n| n.child(P, "ph"))
                .is_some_and(|ph| ph.attr("type") == Some("body"))
        })
        .map(|e| e.id)
        .collect();
    for extra in bodies.iter().skip(1) {
        t.detach(*extra);
    }
    let shape = match bodies.first() {
        Some(s) => *s,
        None => {
            let next = t
                .nodes
                .iter()
                .filter(|e| e.name == "cNvPr")
                .filter_map(|e| {
                    e.attrs
                        .iter()
                        .find(|a| a.name == "id")
                        .and_then(|a| a.value.parse::<u32>().ok())
                })
                .max()
                .unwrap_or(0)
                + 1;
            let frag = parse(&format!(
                "<p:sp xmlns:a=\"{A}\" xmlns:p=\"{P}\"><p:nvSpPr><p:cNvPr id=\"{next}\" name=\"Notes Placeholder 2\"/><p:cNvSpPr/><p:nvPr><p:ph type=\"body\" idx=\"1\"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>"
            ))?;
            let copy = t.adopt(frag.root());
            t.nodes[copy].decls.clear();
            t.append(tree_id, copy);
            copy
        }
    };
    let body = match at(t, shape).child(P, "txBody").map(|e| e.id) {
        Some(b) => b,
        None => {
            let frag = parse(&format!(
                "<p:txBody xmlns:a=\"{A}\" xmlns:p=\"{P}\"><a:bodyPr/><a:lstStyle/></p:txBody>"
            ))?;
            let copy = t.adopt(frag.root());
            t.nodes[copy].decls.clear();
            t.append(shape, copy);
            copy
        }
    };
    let paras: Vec<Id> = at(t, body).children(A, "p").iter().map(|e| e.id).collect();
    for p in paras {
        t.detach(p);
    }
    let lines: String = text
        .split('\n')
        .map(|l| {
            format!(
                "<a:p><a:r><a:rPr lang=\"en-US\"/><a:t>{}</a:t></a:r></a:p>",
                escape(l)
            )
        })
        .collect();
    let frag = parse(&format!(
        "<p:txBody xmlns:a=\"{A}\" xmlns:p=\"{P}\">{lines}</p:txBody>"
    ))?;
    for p in frag.root().children(A, "p") {
        let copy = t.adopt(p);
        t.nodes[copy].decls.clear();
        t.append(body, copy);
    }
    Ok(())
}

/// A paragraph alignment as `a:pPr algn` writes it.
fn align(value: &str) -> Result<&'static str, Fail> {
    Ok(match value.to_ascii_lowercase().as_str() {
        "left" | "l" => "l",
        "center" | "centre" | "ctr" => "ctr",
        "right" | "r" => "r",
        "justify" | "just" => "just",
        "distribute" | "dist" => "dist",
        _ => {
            return Err(fail(format!(
                "Invalid alignment value: '{value}'. Valid values: left, center, right, justify, distribute."
            )));
        }
    })
}

/// `set` on a table cell: its text, run props, fill and alignment.
fn set_cell(
    pkg: &mut Pkg<'_>,
    part: &str,
    tc: Id,
    path: &str,
    props: &[(String, String)],
) -> Result<(String, Vec<String>), SetFail> {
    let mut took = Vec::new();
    let fill = match get(props, &["fill"]) {
        Some((k, v)) => {
            took.push(k.clone());
            Some(rgb(v)?)
        }
        None => None,
    };
    let alignment = match get(props, &["alignment", "align"]) {
        Some((k, v)) => {
            took.push(k.clone());
            Some(align(v)?)
        }
        None => None,
    };
    let (rpr, run_took) = run_props(props)?;
    let has_run_props = !run_took.is_empty();
    took.extend(run_took);
    let text = get(props, &["text"]).map(|(k, v)| {
        took.push(k.clone());
        v.clone()
    });
    let t = pkg
        .xml_mut(part)
        .ok_or_else(|| fail("Corrupt file: slide data missing".to_string()))?;
    let body = match at(t, tc).child(A, "txBody").map(|e| e.id) {
        Some(b) => b,
        None => {
            let frag = parse(&format!(
                "<a:txBody xmlns:a=\"{A}\"><a:bodyPr/><a:lstStyle/><a:p/></a:txBody>"
            ))?;
            let copy = t.adopt(frag.root());
            t.nodes[copy].decls.clear();
            insert_at(t, tc, Some(0), copy);
            copy
        }
    };
    if let Some(text) = &text {
        replace_text(t, body, text)?;
    }
    if has_run_props {
        apply_rpr(t, body, &rpr)?;
    }
    if let Some(algn) = alignment {
        let paras: Vec<Id> = at(t, body).children(A, "p").iter().map(|e| e.id).collect();
        for p in paras {
            let ppr = match at(t, p).child(A, "pPr").map(|e| e.id) {
                Some(x) => x,
                None => {
                    let x = t.create(A, "pPr", "a");
                    insert_at(t, p, Some(0), x);
                    x
                }
            };
            set_attr(t, ppr, "algn", algn);
        }
    }
    if let Some(color) = fill {
        let tcpr = match at(t, tc).child(A, "tcPr").map(|e| e.id) {
            Some(x) => x,
            None => {
                let x = t.create(A, "tcPr", "a");
                t.append(tc, x);
                x
            }
        };
        let old: Vec<Id> = at(t, tcpr)
            .elements()
            .filter(|e| {
                matches!(
                    e.name(),
                    "solidFill" | "noFill" | "gradFill" | "blipFill" | "pattFill"
                )
            })
            .map(|e| e.id)
            .collect();
        for o in old {
            t.detach(o);
        }
        let frag = parse(&format!(
            "<a:solidFill xmlns:a=\"{A}\"><a:srgbClr val=\"{color}\"/></a:solidFill>"
        ))?;
        let copy = t.adopt(frag.root());
        t.nodes[copy].decls.clear();
        let pos = t.nodes[tcpr].kids.iter().position(|k| {
            matches!(k, Kid::El(c) if !matches!(t.nodes[*c].name.as_str(), "lnL" | "lnR" | "lnT" | "lnB" | "lnTlToBr" | "lnBlToTr" | "cell3D"))
        });
        insert_at(t, tcpr, pos, copy);
    }
    finish(path, props, &took, "cell")
}

/// `add --type row` on a slide table: a row of empty cells as high as the
/// table's first row, the frame grown to hold it.
fn add_table_row(
    pkg: &mut Pkg<'_>,
    part: &str,
    parent: &str,
    frame: Id,
    place: &Place<'_>,
    props: &[(String, String)],
) -> Result<Added, Fail> {
    let t = pkg
        .xml_mut(part)
        .ok_or_else(|| fail("Corrupt file: slide data missing".to_string()))?;
    let Some(table) = at(t, frame)
        .descendants_named(A, "tbl")
        .first()
        .map(|e| e.id)
    else {
        return Err(fail(format!("Path not found: {parent}")));
    };
    let cols = at(t, table)
        .child(A, "tblGrid")
        .map(|g| g.children(A, "gridCol").len())
        .unwrap_or(1)
        .max(1);
    let rows: Vec<Id> = at(t, table)
        .children(A, "tr")
        .iter()
        .map(|e| e.id)
        .collect();
    let height: i64 = rows
        .first()
        .and_then(|r| {
            t.nodes[*r]
                .attrs
                .iter()
                .find(|a| a.name == "h")
                .and_then(|a| a.value.parse().ok())
        })
        .unwrap_or(370_840);
    let cells: String = (0..cols)
        .map(|_| "<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang=\"en-US\"/></a:p></a:txBody><a:tcPr/></a:tc>")
        .collect();
    let frag = parse(&format!(
        "<a:tr xmlns:a=\"{A}\" h=\"{height}\">{cells}</a:tr>"
    ))?;
    let copy = t.adopt(frag.root());
    t.nodes[copy].decls.clear();
    let pos = place
        .index
        .and_then(|i| rows.get(i.max(0) as usize))
        .and_then(|r| {
            t.nodes[table]
                .kids
                .iter()
                .position(|k| matches!(k, Kid::El(c) if c == r))
        });
    insert_at(t, table, pos, copy);
    if let Some(ext) = at(t, frame)
        .child(P, "xfrm")
        .and_then(|x| x.child(A, "ext"))
        .map(|e| e.id)
    {
        let cy: i64 = t.nodes[ext]
            .attrs
            .iter()
            .find(|a| a.name == "cy")
            .and_then(|a| a.value.parse().ok())
            .unwrap_or(0);
        set_attr(t, ext, "cy", &(cy + height).to_string());
    }
    let n = at(t, table)
        .children(A, "tr")
        .iter()
        .position(|e| e.id == copy)
        .map_or(1, |i| i + 1);
    Ok((format!("{parent}/tr[{n}]"), unread(props, &[]), Vec::new()))
}

fn finish(
    path: &str,
    props: &[(String, String)],
    took: &[String],
    element: &'static str,
) -> Result<(String, Vec<String>), SetFail> {
    super::super::errors::partial(
        path,
        props,
        took,
        Vec::new(),
        element,
        &[
            "text", "fill", "x", "y", "width", "height", "size", "bold", "italic", "color", "font",
        ],
    )
}

/// The `sldIdLst` entries of the presentation, in order.
fn slide_ids(t: &Tree) -> (Option<Id>, Vec<Id>) {
    let list = t.root().child(P, "sldIdLst").map(|e| e.id);
    let ids = list
        .map(|l| {
            t.nodes[l]
                .kids
                .iter()
                .filter_map(|k| match k {
                    Kid::El(c) => Some(*c),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    (list, ids)
}

/// `remove`: a slide, or a shape on one, taken out.
pub(in super::super) fn remove(
    pkg: &mut Pkg<'_>,
    path: &str,
) -> Result<(String, Vec<String>), Fail> {
    if let Some((n, "/notes")) = slide_number(path) {
        let slide = slide_at(pkg, n)?;
        if let Some(notes) = pkg.related(&slide, "notesSlide").first().cloned() {
            let rid = pkg
                .rels(&slide)
                .into_iter()
                .find(|r| r.kind.ends_with("/notesSlide"))
                .map(|r| r.id);
            if let Some(rid) = rid {
                pkg.drop_rel(&slide, &rid);
            }
            pkg.drop_part(&notes);
        }
        return Ok((format!("Removed {path}"), Vec::new()));
    }
    let (part, element) = locate(pkg, path)?;
    if let Some(sp) = element {
        let t = pkg
            .xml_mut(&part)
            .ok_or_else(|| fail("Corrupt file: slide data missing".to_string()))?;
        t.detach(sp);
        return Ok((format!("Removed {path}"), Vec::new()));
    }
    let main = pkg.main.clone();
    let rid = pkg
        .rels(&main)
        .into_iter()
        .find(|r| resolve_target(&main, &r.target) == part)
        .map(|r| r.id)
        .unwrap_or_default();
    let t = pkg
        .xml_mut(&main)
        .ok_or_else(|| fail("Presentation not found".to_string()))?;
    let (_, ids) = slide_ids(t);
    for id in ids {
        let hit = t.nodes[id]
            .attrs
            .iter()
            .any(|a| a.name == "id" && &*a.ns == R && a.value == rid);
        if hit {
            t.detach(id);
        }
    }
    pkg.drop_rel(&main, &rid);
    pkg.drop_owned(&part);
    Ok((format!("Removed {path}"), Vec::new()))
}

/// The 1-based place of slide entry `id` in the list.
fn slide_position(t: &Tree, id: Id) -> usize {
    slide_ids(t)
        .1
        .iter()
        .position(|x| *x == id)
        .map_or(1, |i| i + 1)
}

/// The slide-list entry of `part`.
fn entry_of(pkg: &Pkg<'_>, part: &str) -> Option<Id> {
    let main = pkg.main.clone();
    let rid = pkg
        .rels(&main)
        .into_iter()
        .find(|r| resolve_target(&main, &r.target) == part)?
        .id;
    let t = pkg.xml(&main)?;
    slide_ids(t).1.into_iter().find(|id| {
        t.nodes[*id]
            .attrs
            .iter()
            .any(|a| a.name == "id" && &*a.ns == R && a.value == rid)
    })
}

/// `move`: a slide put elsewhere in the deck, or a shape elsewhere in its
/// slide's stacking order.
pub(in super::super) fn move_to(
    pkg: &mut Pkg<'_>,
    path: &str,
    _to: Option<&str>,
    place: &Place<'_>,
) -> Result<String, Fail> {
    let (part, element) = locate(pkg, path)?;
    if let Some(sp) = element {
        let t = pkg
            .xml_mut(&part)
            .ok_or_else(|| fail("Corrupt file: slide data missing".to_string()))?;
        let parent = t.nodes[sp].parent.unwrap_or(t.root);
        t.detach(sp);
        let content: Vec<usize> = t.nodes[parent]
            .kids
            .iter()
            .enumerate()
            .filter_map(|(i, k)| match k {
                Kid::El(c) if !matches!(t.nodes[*c].name.as_str(), "nvGrpSpPr" | "grpSpPr") => {
                    Some(i)
                }
                _ => None,
            })
            .collect();
        let at = place
            .index
            .and_then(|i| content.get(i.max(0) as usize).copied());
        insert_at(t, parent, at, sp);
        return Ok(format!("Moved to {path}"));
    }
    let entry = entry_of(pkg, &part).ok_or_else(|| fail(format!("Path not found: {path}")))?;
    let main = pkg.main.clone();
    let anchor = match (place.after, place.before) {
        (Some(a), _) => Some((locate(pkg, a)?.0, true)),
        (_, Some(b)) => Some((locate(pkg, b)?.0, false)),
        _ => None,
    };
    let anchor_entry = match &anchor {
        Some((p, after)) => Some((
            entry_of(pkg, p).ok_or_else(|| fail(format!("Path not found: {p}")))?,
            *after,
        )),
        None => None,
    };
    let t = pkg
        .xml_mut(&main)
        .ok_or_else(|| fail("Presentation not found".to_string()))?;
    let (Some(list), _) = slide_ids(t) else {
        return Err(fail(format!("Path not found: {path}")));
    };
    t.detach(entry);
    let (_, rest) = slide_ids(t);
    let at = match anchor_entry {
        Some((a, after)) => t.nodes[list]
            .kids
            .iter()
            .position(|k| matches!(k, Kid::El(c) if *c == a))
            .map(|p| if after { p + 1 } else { p }),
        None => place.index.and_then(|i| {
            rest.get(i.max(0) as usize).and_then(|c| {
                t.nodes[list]
                    .kids
                    .iter()
                    .position(|k| matches!(k, Kid::El(x) if x == c))
            })
        }),
    };
    insert_at(t, list, at, entry);
    Ok(format!("Moved to /slide[{}]", slide_position(t, entry)))
}

/// `swap`: two slides, or two shapes of one slide, trade places.
pub(in super::super) fn swap(pkg: &mut Pkg<'_>, first: &str, second: &str) -> Result<String, Fail> {
    let (pa, ea) = locate(pkg, first)?;
    let (pb, eb) = locate(pkg, second)?;
    let (part, a, b) = match (ea, eb) {
        (Some(a), Some(b)) if pa == pb => (pa, a, b),
        (None, None) => {
            let a = entry_of(pkg, &pa).ok_or_else(|| fail(format!("Path not found: {first}")))?;
            let b = entry_of(pkg, &pb).ok_or_else(|| fail(format!("Path not found: {second}")))?;
            (pkg.main.clone(), a, b)
        }
        _ => {
            return Err(fail(format!(
                "Cannot swap {first} and {second}: both must be slides, or shapes on one slide"
            )));
        }
    };
    let slides = ea.is_none();
    let t = pkg
        .xml_mut(&part)
        .ok_or_else(|| fail(format!("Path not found: {first}")))?;
    let (Some(xa), Some(xb)) = (t.nodes[a].parent, t.nodes[b].parent) else {
        return Err(fail(format!("Cannot swap {first} and {second}")));
    };
    let ia = t.nodes[xa]
        .kids
        .iter()
        .position(|k| matches!(k, Kid::El(c) if *c == a))
        .unwrap_or(0);
    let ib = t.nodes[xb]
        .kids
        .iter()
        .position(|k| matches!(k, Kid::El(c) if *c == b))
        .unwrap_or(0);
    t.nodes[xa].kids[ia] = Kid::El(b);
    t.nodes[xb].kids[ib] = Kid::El(a);
    t.nodes[a].parent = Some(xb);
    t.nodes[b].parent = Some(xa);
    if slides {
        Ok(format!(
            "Swapped /slide[{}] <-> /slide[{}]",
            slide_position(t, a),
            slide_position(t, b)
        ))
    } else {
        Ok(format!("Swapped {second} <-> {first}"))
    }
}
