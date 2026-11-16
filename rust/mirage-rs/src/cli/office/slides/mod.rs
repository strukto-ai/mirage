// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! A PowerPoint deck as OfficeCLI 1.0.161's PowerPoint handler reads it:
//! its paths (`/slide[N]/shape[@id=K]/paragraph[P]/run[R]`, tables,
//! pictures, groups, connectors, placeholders, masters and layouts), each
//! node's properties with the values a shape inherits from its layout,
//! master, theme and presentation, and the transitions and animations a
//! slide carries. Divergences: a chart shows its frame and name but not
//! its plot properties, and an equation's text is plain, not LaTeX.

mod cascade;
mod color;
mod deck;
pub(super) mod edit;
mod motion;
mod nodes;
mod paths;
mod query;
mod tables;
mod text;

use super::node::{Node, Value};
use super::package::Pkg;
use super::tree::{E, P};
use super::{Fail, SetFail};

pub(super) use self::deck::Deck;

pub(super) const A14: &str = "http://schemas.microsoft.com/office/drawing/2010/main";
pub(super) const DGM: &str = "http://schemas.openxmlformats.org/drawingml/2006/diagram";
pub(super) const TABLE_URI: &str = "http://schemas.openxmlformats.org/drawingml/2006/table";
pub(super) const PICTURE_URI: &str = "http://schemas.openxmlformats.org/drawingml/2006/picture";
pub(super) const CHART_EX_URI: &str = "http://schemas.microsoft.com/office/drawing/2014/chartex";
const CREATION_ID_URI: &str = "{FF2B5EF4-FFF2-40B4-BE49-F238E27FC236}";

const CONTENT: [&str; 5] = ["sp", "pic", "graphicFrame", "grpSp", "cxnSp"];

/// An Int32 attribute value, as the SDK parses one.
pub(super) fn int(v: Option<&str>) -> Option<i64> {
    let t = v?.trim();
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    if body.is_empty() || !body.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    t.parse::<i64>().ok().filter(|n| n.abs() <= 2_147_483_647)
}

/// An Int64 attribute value.
pub(super) fn long(v: Option<&str>) -> Option<i64> {
    let t = v?.trim();
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    if body.is_empty() || !body.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    t.parse::<i64>().ok()
}

/// An xsd:boolean attribute value.
pub(super) fn boolean(v: Option<&str>) -> Option<bool> {
    match v?.trim() {
        "1" | "true" => Some(true),
        "0" | "false" => Some(false),
        _ => None,
    }
}

pub(super) fn content_kids<'t>(container: E<'t>) -> Vec<E<'t>> {
    container
        .elements()
        .filter(|e| e.ns() == P && CONTENT.contains(&e.name()))
        .collect()
}

pub(super) fn nv_of<'t>(e: E<'t>) -> Option<E<'t>> {
    e.child_of(
        P,
        &[
            "nvSpPr",
            "nvPicPr",
            "nvGraphicFramePr",
            "nvCxnSpPr",
            "nvGrpSpPr",
        ],
    )
}

pub(super) fn cnvpr_of<'t>(e: E<'t>) -> Option<E<'t>> {
    nv_of(e).and_then(|nv| nv.child(P, "cNvPr"))
}

pub(super) fn ph_of<'t>(e: E<'t>) -> Option<E<'t>> {
    nv_of(e)
        .and_then(|nv| nv.child(P, "nvPr"))
        .and_then(|nv| nv.child(P, "ph"))
}

pub(super) fn id_of(e: E<'_>) -> Option<i64> {
    long(cnvpr_of(e).and_then(|c| c.attr("id")))
}

/// A path segment: `kind[@id=N]` when the element has an id, else positional.
pub(super) fn segment(kind: &str, e: E<'_>, index: usize) -> String {
    match id_of(e) {
        Some(id) => format!("{kind}[@id={id}]"),
        None => format!("{kind}[{index}]"),
    }
}

pub(super) fn creation_id(e: E<'_>) -> Option<String> {
    let cnvpr = cnvpr_of(e)?;
    for lst in cnvpr.elements().filter(|x| x.name() == "extLst") {
        for ext in lst.elements().filter(|x| x.name() == "ext") {
            if !ext
                .attr("uri")
                .is_some_and(|u| u.eq_ignore_ascii_case(CREATION_ID_URI))
            {
                continue;
            }
            for inner in ext.elements() {
                if inner.name() == "creationId" {
                    return inner.attr("val").map(str::to_string);
                }
            }
        }
    }
    None
}

pub(super) fn is_hidden(e: E<'_>) -> bool {
    boolean(cnvpr_of(e).and_then(|c| c.attr("hidden"))) == Some(true)
}

/// The element's place among its shape tree's content, when its parent is the tree.
pub(super) fn zorder(e: E<'_>, node: &mut Node) {
    let Some(parent) = e.parent() else { return };
    if !parent.is(P, "spTree") {
        return;
    }
    if let Some(at) = content_kids(parent).iter().position(|x| *x == e) {
        node.set("zorder", Value::Int(at as i64 + 1));
    }
}

pub(super) fn ph_type<'t>(ph: Option<E<'t>>) -> Option<&'t str> {
    ph.and_then(|p| p.attr("type"))
}

pub(super) fn is_title_shape(shape: E<'_>) -> bool {
    matches!(ph_type(ph_of(shape)), Some("title" | "ctrTitle"))
}

/// A placeholder type as OfficeCLI names it.
pub(super) fn placeholder_type_name(t: Option<&str>) -> String {
    match t {
        None | Some("body") => "body",
        Some("title") => "title",
        Some("ctrTitle") => "ctrTitle",
        Some("subTitle") => "subtitle",
        Some("dt") => "date",
        Some("ftr") => "footer",
        Some("sldNum") => "slidenum",
        Some("hdr") => "header",
        Some("obj") => "obj",
        Some("chart") => "chart",
        Some("tbl") => "table",
        Some("clipArt") => "clipart",
        Some("dgm") => "diagram",
        Some("media") => "media",
        Some("pic") => "picture",
        Some("sldImg") => "SlideImage",
        Some(other) => return other.to_string(),
    }
    .to_string()
}

/// A refusal with the code and hints OfficeCLI reads off its message.
pub(super) fn fail(message: String) -> Fail {
    super::package::enriched(message)
}

pub(super) fn get(pkg: &Pkg<'_>, path: &str, depth: usize) -> Result<Node, Fail> {
    Deck::new(pkg).get(path, depth)
}

pub(super) fn query(pkg: &Pkg<'_>, selector: &str) -> Result<Vec<Node>, Fail> {
    Deck::new(pkg).query(selector)
}

pub(super) fn set(
    pkg: &mut Pkg<'_>,
    path: &str,
    props: &[(String, String)],
) -> Result<(String, Vec<String>), SetFail> {
    edit::set(pkg, path, props)
}

pub(super) fn remove(pkg: &mut Pkg<'_>, path: &str) -> Result<(String, Vec<String>), Fail> {
    edit::remove(pkg, path)
}
