// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! A table's styles and borders as OfficeCLI reads them: a built-in style
//! GUID as its short name, each cell edge as `width dash color`, and the
//! table's outer edges where every cell on them agrees.

use super::super::node::Node;
use super::super::tree::{A, E, outer_xml};
use super::super::units::format_emu;
use super::color::read_color;
use super::long;

/// PowerPoint's built-in table styles: GUID, family, accent.
const TABLE_STYLES: [(&str, &str, &str); 74] = [
    (
        "{2D5ABB26-0587-4C30-8999-92F81FD0307C}",
        "Themed-Style-1",
        "",
    ),
    (
        "{3C2FFA5D-87B4-456A-9821-1D502468CF0F}",
        "Themed-Style-1",
        "Accent1",
    ),
    (
        "{284E427A-3D55-4303-BF80-6455036E1DE7}",
        "Themed-Style-1",
        "Accent2",
    ),
    (
        "{69C7853C-536D-4A76-A0AE-DD22124D55A5}",
        "Themed-Style-1",
        "Accent3",
    ),
    (
        "{775DCB02-9BB8-47FD-8907-85C794F793BA}",
        "Themed-Style-1",
        "Accent4",
    ),
    (
        "{35758FB7-9AC5-4552-8A53-C91805E547FA}",
        "Themed-Style-1",
        "Accent5",
    ),
    (
        "{08FB837D-C827-4EFA-A057-4D05807E0F7C}",
        "Themed-Style-1",
        "Accent6",
    ),
    (
        "{5940675A-B579-460E-94D1-54222C63F5DA}",
        "Themed-Style-2",
        "",
    ),
    (
        "{D113A9D2-9D6B-4929-AA2D-F23B5EE8CBE7}",
        "Themed-Style-2",
        "Accent1",
    ),
    (
        "{18603FDC-E32A-4AB5-989C-0864C3EAD2B8}",
        "Themed-Style-2",
        "Accent2",
    ),
    (
        "{306799F8-075E-4A3A-A7F6-7FBC6576F1A4}",
        "Themed-Style-2",
        "Accent3",
    ),
    (
        "{E269D01E-BC32-4049-B463-5C60D7B0CCD2}",
        "Themed-Style-2",
        "Accent4",
    ),
    (
        "{327F97BB-C833-4FB7-BDE5-3F7075034690}",
        "Themed-Style-2",
        "Accent5",
    ),
    (
        "{638B1855-1B75-4FBE-930C-398BA8C253C6}",
        "Themed-Style-2",
        "Accent6",
    ),
    (
        "{9D7B26C5-4107-4FEC-AEDC-1716B250A1EF}",
        "Light-Style-1",
        "",
    ),
    (
        "{3B4B98B0-60AC-42C2-AFA5-B58CD77FA1E5}",
        "Light-Style-1",
        "Accent1",
    ),
    (
        "{0E3FDE45-AF77-4B5C-9715-49D594BDF05E}",
        "Light-Style-1",
        "Accent2",
    ),
    (
        "{C083E6E3-FA7D-4D7B-A595-EF9225AFEA82}",
        "Light-Style-1",
        "Accent3",
    ),
    (
        "{D27102A9-8310-4765-A935-A1911B00CA55}",
        "Light-Style-1",
        "Accent4",
    ),
    (
        "{5FD0F851-EC5A-4D38-B0AD-8093EC10F338}",
        "Light-Style-1",
        "Accent5",
    ),
    (
        "{68D230F3-CF80-4859-8CE7-A43EE81993B5}",
        "Light-Style-1",
        "Accent6",
    ),
    (
        "{7E9639D4-E3E2-4D34-9284-5A2195B3D0D7}",
        "Light-Style-2",
        "",
    ),
    (
        "{69012ECD-51FC-41F1-AA8D-1B2483CD663E}",
        "Light-Style-2",
        "Accent1",
    ),
    (
        "{72833802-FEF1-4C79-8D5D-14CF1EAF98D9}",
        "Light-Style-2",
        "Accent2",
    ),
    (
        "{F2DE63D5-997A-4646-A377-4702673A728D}",
        "Light-Style-2",
        "Accent3",
    ),
    (
        "{17292A2E-F333-43FB-9621-5CBBE7FDCDCB}",
        "Light-Style-2",
        "Accent4",
    ),
    (
        "{5A111915-BE36-4E01-A7E5-04B1672EAD32}",
        "Light-Style-2",
        "Accent5",
    ),
    (
        "{912C8C85-51F0-491E-9774-3900AFEF0FD7}",
        "Light-Style-2",
        "Accent6",
    ),
    (
        "{616DA210-FB5B-4158-B5E0-FEB733F419BA}",
        "Light-Style-3",
        "",
    ),
    (
        "{BC89EF96-8CEA-46FF-86C4-4CE0E7609802}",
        "Light-Style-3",
        "Accent1",
    ),
    (
        "{5DA37D80-6434-44D0-A028-1B22A696006F}",
        "Light-Style-3",
        "Accent2",
    ),
    (
        "{8799B23B-EC83-4686-B30A-512413B5E67A}",
        "Light-Style-3",
        "Accent3",
    ),
    (
        "{ED083AE6-46FA-4A59-8FB0-9F97EB10719F}",
        "Light-Style-3",
        "Accent4",
    ),
    (
        "{BDBED569-4797-4DF1-A0F4-6AAB3CD982D8}",
        "Light-Style-3",
        "Accent5",
    ),
    (
        "{E8B1032C-EA38-4F05-BA0D-38AFFFC7BED3}",
        "Light-Style-3",
        "Accent6",
    ),
    (
        "{793D81CF-94F2-401A-BA57-92F5A7B2D0C5}",
        "Medium-Style-1",
        "",
    ),
    (
        "{B301B821-A1FF-4177-AEE7-76D212191A09}",
        "Medium-Style-1",
        "Accent1",
    ),
    (
        "{9DCAF9ED-07DC-4A11-8D7F-57B35C25682E}",
        "Medium-Style-1",
        "Accent2",
    ),
    (
        "{1FECB4D8-DB02-4DC6-A0A2-4F2EBAE1DC90}",
        "Medium-Style-1",
        "Accent3",
    ),
    (
        "{1E171933-4619-4E11-9A3F-F7608DF75F80}",
        "Medium-Style-1",
        "Accent4",
    ),
    (
        "{FABFCF23-3B69-468F-B69F-88F6DE6A72F2}",
        "Medium-Style-1",
        "Accent5",
    ),
    (
        "{10A1B5D5-9B99-4C35-A422-299274C87663}",
        "Medium-Style-1",
        "Accent6",
    ),
    (
        "{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}",
        "Medium-Style-2",
        "",
    ),
    (
        "{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}",
        "Medium-Style-2",
        "Accent1",
    ),
    (
        "{21E4AEA4-8DFA-4A89-87EB-49C32662AFE0}",
        "Medium-Style-2",
        "Accent2",
    ),
    (
        "{F5AB1C69-6EDB-4FF4-983F-18BD219EF322}",
        "Medium-Style-2",
        "Accent3",
    ),
    (
        "{00A15C55-8517-42AA-B614-E9B94910E393}",
        "Medium-Style-2",
        "Accent4",
    ),
    (
        "{7DF18680-E054-41AD-8BC1-D1AEF772440D}",
        "Medium-Style-2",
        "Accent5",
    ),
    (
        "{93296810-A885-4BE3-A3E7-6D5BEEA58F35}",
        "Medium-Style-2",
        "Accent6",
    ),
    (
        "{8EC20E35-A176-4012-BC5E-935CFFF8708E}",
        "Medium-Style-3",
        "",
    ),
    (
        "{6E25E649-3F16-4E02-A733-19D2CDBF48F0}",
        "Medium-Style-3",
        "Accent1",
    ),
    (
        "{85BE263C-DBD7-4A20-BB59-AAB30ACAA65A}",
        "Medium-Style-3",
        "Accent2",
    ),
    (
        "{EB344D84-9AFB-497E-A393-DC336BA19D2E}",
        "Medium-Style-3",
        "Accent3",
    ),
    (
        "{EB9631B5-78F2-41C9-869B-9F39066F8104}",
        "Medium-Style-3",
        "Accent4",
    ),
    (
        "{74C1A8A3-306A-4EB7-A6B1-4F7E0EB9C5D6}",
        "Medium-Style-3",
        "Accent5",
    ),
    (
        "{2A488322-F2BA-4B5B-9748-0D474271808F}",
        "Medium-Style-3",
        "Accent6",
    ),
    (
        "{D7AC3CCA-C797-4891-BE02-D94E43425B78}",
        "Medium-Style-4",
        "",
    ),
    (
        "{69CF1AB2-1976-4502-BF36-3FF5EA218861}",
        "Medium-Style-4",
        "Accent1",
    ),
    (
        "{8A107856-5554-42FB-B03E-39F5DBC370BA}",
        "Medium-Style-4",
        "Accent2",
    ),
    (
        "{0505E3EF-67EA-436B-97B2-0124C06EBD24}",
        "Medium-Style-4",
        "Accent3",
    ),
    (
        "{C4B1156A-380E-4F78-BDF5-A606A8083BF9}",
        "Medium-Style-4",
        "Accent4",
    ),
    (
        "{22838BEF-8BB2-4498-84A7-C5851F593DF1}",
        "Medium-Style-4",
        "Accent5",
    ),
    (
        "{16D9F66E-5EB9-4882-86FB-DCBF35E3C3E4}",
        "Medium-Style-4",
        "Accent6",
    ),
    ("{E8034E78-7F5D-4C2E-B375-FC64B27BC917}", "Dark-Style-1", ""),
    (
        "{125E5076-3810-47DD-B79F-674D7AD40C01}",
        "Dark-Style-1",
        "Accent1",
    ),
    (
        "{37CE84F3-28C3-443E-9E96-99CF82512B78}",
        "Dark-Style-1",
        "Accent2",
    ),
    (
        "{D03447BB-5D67-496B-8E87-E561075AD55C}",
        "Dark-Style-1",
        "Accent3",
    ),
    (
        "{E929F9F4-4A8F-4326-A1B4-22849713DDAB}",
        "Dark-Style-1",
        "Accent4",
    ),
    (
        "{8FD4443E-F989-4FC4-A0C8-D5A2AF1F390B}",
        "Dark-Style-1",
        "Accent5",
    ),
    (
        "{AF606853-7671-496A-8E4F-DF71F8EC918B}",
        "Dark-Style-1",
        "Accent6",
    ),
    ("{5202B0CA-FC54-4496-8BCA-5EF66A818D29}", "Dark-Style-2", ""),
    (
        "{0660B408-B3CF-4A94-85FC-2B1E0A45F4A2}",
        "Dark-Style-2",
        "Accent1",
    ),
    (
        "{91EBBBCC-DAD2-459C-BE2E-F6DE35CF9A28}",
        "Dark-Style-2",
        "Accent3",
    ),
    (
        "{46F890A9-2807-4EBB-B81D-B2AA78EC7F39}",
        "Dark-Style-2",
        "Accent5",
    ),
];

const TABLE_STYLE_NAMES: [(&str, &str); 10] = [
    ("medium1", "{793D81CF-94F2-401A-BA57-92F5A7B2D0C5}"),
    ("medium2", "{073A0DAA-6AF3-43AB-8588-CEC1D06C72B9}"),
    ("medium3", "{8EC20E35-A176-4012-BC5E-935CFFF8708E}"),
    ("medium4", "{D7AC3CCA-C797-4891-BE02-D94E43425B78}"),
    ("light1", "{9D7B26C5-4107-4FEC-AEDC-1716B250A1EF}"),
    ("light2", "{7E9639D4-E3E2-4D34-9284-5A2195B3D0D7}"),
    ("light3", "{616DA210-FB5B-4158-B5E0-FEB733F419BA}"),
    ("dark1", "{E8034E78-7F5D-4C2E-B375-FC64B27BC917}"),
    ("dark2", "{5202B0CA-FC54-4496-8BCA-5EF66A818D29}"),
    ("none", "{2D5ABB26-0587-4C30-8999-92F81FD0307C}"),
];

/// A table style GUID as its short name (`medium2`, `dark1-accent3`), when it has one.
pub(super) fn table_style_name(guid: &str) -> Option<String> {
    let g = guid.to_uppercase();
    if let Some((name, _)) = TABLE_STYLE_NAMES.iter().find(|(_, id)| *id == g) {
        return Some((*name).to_string());
    }
    let (_, family, accent) = TABLE_STYLES.iter().find(|(id, _, _)| *id == g)?;
    if accent.is_empty() {
        return None;
    }
    for (name, id) in TABLE_STYLE_NAMES {
        if let Some((_, base_family, base_accent)) =
            TABLE_STYLES.iter().find(|(bid, _, _)| *bid == id)
        {
            if base_family == family && base_accent.is_empty() {
                return Some(format!("{name}-{}", accent.to_lowercase()));
            }
        }
    }
    None
}

fn border_line(line: Option<E<'_>>, prefix: &str, node: &mut Node) {
    let Some(line) = line else { return };
    if line.child(A, "noFill").is_some() {
        return;
    }
    let mut color = None;
    if let Some(solid) = line.child(A, "solidFill") {
        color = read_color(Some(solid));
        if let Some(c) = &color {
            node.str(&format!("{prefix}.color"), c.clone());
        }
    }
    let w = long(line.attr("w")).filter(|w| *w > 0);
    if let Some(w) = w {
        node.str(&format!("{prefix}.width"), format_emu(w));
    }
    let dash = line.child(A, "prstDash").and_then(|d| d.attr("val"));
    if let Some(d) = dash {
        node.str(&format!("{prefix}.dash"), d);
    }
    let cmpd = line.attr("cmpd").filter(|c| !c.is_empty());
    if let Some(c) = cmpd {
        node.str(&format!("{prefix}.compound"), c);
    }
    if color.is_none() && w.is_none() && dash.is_none() && cmpd.is_none() {
        return;
    }
    let mut parts = Vec::new();
    if let Some(w) = w {
        parts.push(format_emu(w));
    }
    parts.push(dash.unwrap_or("solid").to_string());
    if let Some(c) = color {
        parts.push(c);
    }
    node.str(prefix, parts.join(" "));
}

const CELL_EDGES: [(&str, &str); 6] = [
    ("lnL", "border.left"),
    ("lnR", "border.right"),
    ("lnT", "border.top"),
    ("lnB", "border.bottom"),
    ("lnTlToBr", "border.tl2br"),
    ("lnBlToTr", "border.tr2bl"),
];

pub(super) fn cell_borders(tcpr: E<'_>, node: &mut Node) {
    for (name, key) in CELL_EDGES {
        border_line(tcpr.child(A, name), key, node);
    }
    for (name, key) in CELL_EDGES {
        if let Some(line) = tcpr.child(A, name) {
            node.str(&format!("{key}.raw"), outer_xml(line));
        }
    }
    let get = |k: &str| node.get(k).map(|v| v.text());
    if let Some(top) = get("border.top") {
        if get("border.bottom").as_ref() == Some(&top)
            && get("border.left").as_ref() == Some(&top)
            && get("border.right").as_ref() == Some(&top)
        {
            node.str("border.all", top);
        }
    }
}

/// Whether a cell's text carries formatting its curated keys cannot hold.
pub(super) fn rich_cell_body(body: E<'_>) -> bool {
    if body
        .child(A, "lstStyle")
        .is_some_and(|l| l.elements().next().is_some())
    {
        return true;
    }
    let full = |e: Option<E<'_>>| e.is_some_and(|e| e.elements().next().is_some());
    for para in body.children(A, "p") {
        if full(para.child(A, "pPr")) || full(para.child(A, "endParaRPr")) {
            return true;
        }
        if para
            .children(A, "r")
            .iter()
            .any(|r| full(r.child(A, "rPr")))
        {
            return true;
        }
    }
    false
}

/// The table's outer edges, each where every cell along it agrees.
pub(super) fn table_borders(rows: &[E<'_>], node: &mut Node) {
    if rows.is_empty() {
        return;
    }
    let format = |line: Option<E<'_>>| -> Option<String> {
        let line = line?;
        if line.child(A, "noFill").is_some() {
            return Some("none".to_string());
        }
        let solid = line.child(A, "solidFill")?;
        let color = read_color(Some(solid));
        let mut parts = Vec::new();
        if let Some(w) = long(line.attr("w")).filter(|w| *w > 0) {
            parts.push(format_emu(w));
        }
        parts.push(
            line.child(A, "prstDash")
                .and_then(|d| d.attr("val"))
                .unwrap_or("solid")
                .to_string(),
        );
        if let Some(c) = color {
            parts.push(c);
        }
        Some(parts.join(" "))
    };
    let edge = |cells: &[E<'_>], name: &str| -> Option<String> {
        let mut agreed: Option<Option<String>> = None;
        for cell in cells {
            let v = cell.child(A, "tcPr").and_then(|t| format(t.child(A, name)));
            match &agreed {
                None => agreed = Some(v),
                Some(a) if *a != v => return None,
                Some(_) => {}
            }
        }
        agreed.flatten()
    };
    let first = rows[0].children(A, "tc");
    let last = rows[rows.len() - 1].children(A, "tc");
    let left: Vec<E<'_>> = rows
        .iter()
        .filter_map(|r| r.children(A, "tc").first().copied())
        .collect();
    let right: Vec<E<'_>> = rows
        .iter()
        .filter_map(|r| r.children(A, "tc").last().copied())
        .collect();
    let top = edge(&first, "lnT");
    let bottom = edge(&last, "lnB");
    let l = edge(&left, "lnL");
    let r = edge(&right, "lnR");
    for (key, v) in [
        ("border.top", &top),
        ("border.bottom", &bottom),
        ("border.left", &l),
        ("border.right", &r),
    ] {
        if let Some(v) = v {
            node.str(key, v.clone());
        }
    }
    if let Some(t) = &top {
        if Some(t) == bottom.as_ref() && Some(t) == l.as_ref() && Some(t) == r.as_ref() {
            node.str("border.all", t.clone());
        }
    }
}
