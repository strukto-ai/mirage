// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! A workbook's sheet list: adding a sheet, renaming one with every
//! formula, name and link that points at it, and removing one with the
//! parts only it used, as OfficeCLI's Excel handler does.

use super::book::{Book, relationships, rels_of, resolve};
use super::read::{Doc, Entry};
use super::xml::{Kind, element_end, escape, retag, tags, unescape};
use super::{Fail, HEAD, MAIN, REL, before_end, strip};

const WORKSHEET_TYPE: &str =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";

/// The props `add --type sheet` reads.
const ADD_PROPS: &[&str] = &["name", "position", "hidden", "ifexists", "tabcolor"];

/// Why Excel would refuse `name` for a sheet, in OfficeCLI's words.
pub(super) fn name_fault(name: &str) -> Option<String> {
    if name.trim().is_empty() {
        return Some("Invalid sheet name: name cannot be empty or whitespace.".to_string());
    }
    let length = name.encode_utf16().count();
    if length > 31 {
        return Some(format!(
            "Invalid sheet name '{name}': length {length} exceeds Excel's 31-char limit."
        ));
    }
    if let Some(c) = name.chars().find(|c| "\\/?*:[]".contains(*c)) {
        return Some(format!(
            "Invalid sheet name '{name}': contains forbidden character '{c}'. Excel rejects any of: \\ / ? * : [ ]"
        ));
    }
    if name.starts_with('\'') || name.ends_with('\'') {
        return Some(format!(
            "Invalid sheet name '{name}': cannot start or end with an apostrophe (')."
        ));
    }
    if name.eq_ignore_ascii_case("History") {
        return Some(
            "Invalid sheet name 'History': reserved by Excel for the change-history sheet."
                .to_string(),
        );
    }
    None
}

/// A tab color as `<tabColor>` writes it: an ARGB `rgb`, or the theme
/// index a scheme color name stands for.
fn tab_color(value: &str) -> Result<Option<(&'static str, String)>, Fail> {
    let v = value.trim();
    if v.eq_ignore_ascii_case("none") {
        return Ok(None);
    }
    const THEME: &[&str] = &[
        "lt1", "dk1", "lt2", "dk2", "accent1", "accent2", "accent3", "accent4", "accent5",
        "accent6", "hlink", "folhlink",
    ];
    if let Some(i) = THEME.iter().position(|t| t.eq_ignore_ascii_case(v)) {
        return Ok(Some(("theme", i.to_string())));
    }
    let named = match v.to_ascii_lowercase().as_str() {
        "black" => Some("000000"),
        "white" => Some("FFFFFF"),
        "red" => Some("FF0000"),
        "green" => Some("008000"),
        "blue" => Some("0000FF"),
        "yellow" => Some("FFFF00"),
        "orange" => Some("FFA500"),
        "purple" => Some("800080"),
        "gray" | "grey" => Some("808080"),
        _ => None,
    };
    let hex = named.map_or_else(
        || v.trim_start_matches('#').to_ascii_uppercase(),
        str::to_string,
    );
    let hex = if hex.len() == 3 {
        hex.chars().flat_map(|c| [c, c]).collect()
    } else {
        hex
    };
    if !hex.chars().all(|c| c.is_ascii_hexdigit()) || !matches!(hex.len(), 6 | 8) {
        return Err(Fail::of(format!(
            "Invalid color value: '{value}'. Expected hex (FF0000), #RGB, a color name or a scheme color (accent1)."
        )));
    }
    Ok(Some((
        "rgb",
        if hex.len() == 6 {
            format!("FF{hex}")
        } else {
            hex
        },
    )))
}

fn duplicate(name: &str) -> Fail {
    Fail::coded(
        format!("A sheet named '{name}' already exists. Sheet names must be unique."),
        "duplicate_name",
    )
}

fn truthy(v: &str) -> bool {
    matches!(
        v.trim().to_ascii_lowercase().as_str(),
        "true" | "1" | "yes" | "on"
    )
}

/// The prefix `xml`'s root binds to the relationships namespace, with its
/// colon.
fn rel_prefix(xml: &[u8]) -> String {
    let Some(root) = tags(xml).find(|t| t.kind != Kind::End) else {
        return "r:".to_string();
    };
    root.attrs()
        .into_iter()
        .find_map(|(name, value)| {
            let name = std::str::from_utf8(name).ok()?;
            let prefix = name.strip_prefix("xmlns:")?;
            (value == REL.as_bytes()).then(|| format!("{prefix}:"))
        })
        .unwrap_or_else(|| "r:".to_string())
}

/// A part name under `dir` not yet in the package: `{dir}{stem}{n}.xml`.
fn free_part(book: &Book<'_>, dir: &str, stem: &str) -> String {
    (1..)
        .map(|n| format!("{dir}{stem}{n}.xml"))
        .find(|name| book.size(name).is_none())
        .unwrap_or_default()
}

/// A relationship id `rels` does not use yet.
fn free_id(rels: &[u8], base: &str) -> String {
    let ids: Vec<String> = relationships(rels, base)
        .into_iter()
        .map(|(id, _, _)| id)
        .collect();
    (1..)
        .map(|n| format!("rId{n}"))
        .find(|id| !ids.contains(id))
        .unwrap_or_default()
}

/// `add --type sheet`: the new sheet's path and the props it did not read.
pub(super) async fn add(
    book: &mut Book<'_>,
    doc: &Doc,
    parent: &str,
    props: &[(String, String)],
) -> Result<(String, Vec<String>), Fail> {
    let trimmed = parent.trim_start_matches('/');
    if let Some((head, tail)) = trimmed.split_once('/') {
        if !tail.is_empty() {
            let mut fail = Fail::coded(
                format!(
                    "add --type sheet takes a sheet path (/{head}); the '{tail}' suffix in '{parent}' is not used."
                ),
                "invalid_path",
            );
            fail.suggestion = Some(
                "Use / or an existing sheet path (/Sheet1) as the parent; position with --index."
                    .to_string(),
            );
            return Err(fail);
        }
    }
    let get = |key: &str| {
        props
            .iter()
            .rev()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.clone())
    };
    let unread: Vec<String> = props
        .iter()
        .map(|(k, _)| k.clone())
        .filter(|k| !ADD_PROPS.contains(&k.to_ascii_lowercase().as_str()))
        .collect();
    let name = match get("name") {
        Some(name) => {
            if let Some(fault) = name_fault(&name) {
                return Err(Fail::of(fault));
            }
            name
        }
        None => format!("Sheet{}", doc.sheets.len() + 1),
    };
    if let Some(found) = doc
        .sheets
        .iter()
        .find(|s| s.name.to_lowercase() == name.to_lowercase())
    {
        if get("ifExists").is_some_and(|v| v.eq_ignore_ascii_case("use")) {
            return Ok((format!("/{}", found.name), unread));
        }
        return Err(duplicate(&found.name));
    }
    let Some(workbook) = book.part(&doc.wb_part).await else {
        return Err(Fail::of("Workbook not found".to_string()));
    };
    let rels_part = rels_of(&doc.wb_part);
    let rels = book.part(&rels_part).await.unwrap_or_default();
    let Some(types) = book.part("[Content_Types].xml").await else {
        return Err(Fail::of("Workbook not found".to_string()));
    };
    let dir = match doc.wb_part.rfind('/') {
        Some(at) => format!("{}/worksheets/", &doc.wb_part[..at]),
        None => "worksheets/".to_string(),
    };
    let part = free_part(book, &dir, "sheet");
    let target = part
        .strip_prefix(&match doc.wb_part.rfind('/') {
            Some(at) => format!("{}/", &doc.wb_part[..at]),
            None => String::new(),
        })
        .unwrap_or(&part)
        .to_string();
    let id = free_id(&rels, &doc.wb_part);
    let sheet_id = tags(&workbook)
        .filter(|t| t.kind != Kind::End && t.is("sheet"))
        .filter_map(|t| t.attr("sheetId")?.parse::<u64>().ok())
        .max()
        .unwrap_or(0)
        + 1;
    let r = rel_prefix(&workbook);
    let hidden = get("hidden").is_some_and(|v| truthy(&v));
    let state = if hidden { " state=\"hidden\"" } else { "" };
    let attrs = format!(
        "name=\"{}\" sheetId=\"{sheet_id}\"{state} {r}id=\"{id}\"",
        escape(&name)
    );
    let position = get("position")
        .and_then(|p| p.trim().parse::<usize>().ok())
        .filter(|p| *p < doc.sheets.len());
    let workbook = match position {
        Some(pos) => insert_sheet_at(&workbook, pos, &attrs)?,
        None => {
            if tags(&workbook).any(|t| t.kind != Kind::End && t.is("sheets")) {
                before_end(&workbook, "sheets", "sheet", &attrs).ok_or_else(missing_sheets)?
            } else {
                return Err(missing_sheets());
            }
        }
    };
    let workbook = match position {
        Some(pos) => shift_local_ids(&workbook, pos, 1),
        None => workbook,
    };
    let rels = before_end(
        &rels,
        "Relationships",
        "Relationship",
        &format!(
            "Id=\"{id}\" Type=\"{REL}/worksheet\" Target=\"{}\"",
            escape(&target)
        ),
    )
    .ok_or_else(|| Fail::of("Workbook not found".to_string()))?;
    let types = before_end(
        &types,
        "Types",
        "Override",
        &format!("PartName=\"/{part}\" ContentType=\"{WORKSHEET_TYPE}\""),
    )
    .ok_or_else(|| Fail::of("Workbook not found".to_string()))?;
    let tab = match get("tabColor") {
        Some(v) => tab_color(&v)?,
        None => None,
    };
    let sheet_pr = tab.map_or(String::new(), |(attr, value)| {
        format!("<sheetPr><tabColor {attr}=\"{value}\"/></sheetPr>")
    });
    book.put(
        &part,
        format!("{HEAD}<worksheet xmlns=\"{MAIN}\">{sheet_pr}<sheetData/></worksheet>")
            .into_bytes(),
    );
    book.put(&doc.wb_part, workbook);
    book.put(&rels_part, rels);
    book.put("[Content_Types].xml", types);
    Ok((format!("/{name}"), unread))
}

fn missing_sheets() -> Fail {
    Fail::of("Workbook has no sheet list".to_string())
}

/// `workbook` with a `<sheet>` holding `attrs` put before its `pos`-th sheet.
fn insert_sheet_at(workbook: &[u8], pos: usize, attrs: &str) -> Result<Vec<u8>, Fail> {
    let anchor = tags(workbook)
        .filter(|t| t.kind != Kind::End && t.is("sheet"))
        .nth(pos)
        .ok_or_else(missing_sheets)?;
    let prefix = String::from_utf8_lossy(anchor.prefix()).into_owned();
    let entry = format!("<{prefix}sheet {attrs}/>");
    Ok([
        &workbook[..anchor.start],
        entry.as_bytes(),
        &workbook[anchor.start..],
    ]
    .concat())
}

/// `workbook` with every `localSheetId` at or past `from` moved by `by`,
/// as a sheet put in or taken out shifts the positions after it.
fn shift_local_ids(workbook: &[u8], from: usize, by: i64) -> Vec<u8> {
    let mut out = Vec::with_capacity(workbook.len());
    let mut last = 0;
    for tag in tags(workbook) {
        if tag.kind == Kind::End || !tag.is("definedName") {
            continue;
        }
        let Some(id) = tag.attr("localSheetId").and_then(|v| v.parse::<i64>().ok()) else {
            continue;
        };
        if id < from as i64 {
            continue;
        }
        let moved = (id + by).to_string();
        out.extend_from_slice(&workbook[last..tag.start]);
        out.extend(retag(&tag, &[("localSheetId", Some(&moved))], tag.kind));
        last = tag.end;
    }
    out.extend_from_slice(&workbook[last..]);
    out
}

/// A sheet name as a formula writes it before `!`, quoted when it holds a
/// character a bare name cannot.
fn formula_ref(name: &str) -> String {
    let quoted = name
        .chars()
        .any(|c| c.is_whitespace() || "'[]:*?/\\".contains(c));
    if quoted {
        format!("'{}'!", name.replace('\'', "''"))
    } else {
        format!("{name}!")
    }
}

/// Whether a sheet reference may start right after `before`: not inside a
/// longer name, a quoted name or an external workbook's `[n]` prefix.
fn ref_boundary(before: Option<char>) -> bool {
    before.is_none_or(|c| !(c.is_alphanumeric() || matches!(c, '_' | '.' | '\'' | ']')))
}

/// Whether `chars` from `at` spell `name`, case aside, then `!`.
fn bare_ref_at(chars: &[(usize, char)], at: usize, name: &str) -> Option<usize> {
    let mut i = at;
    for want in name.chars() {
        let (_, got) = *chars.get(i)?;
        if !got.to_lowercase().eq(want.to_lowercase()) {
            return None;
        }
        i += 1;
    }
    (chars.get(i).map(|c| c.1) == Some('!')).then_some(i + 1)
}

/// Byte spans of each `name!` or `'name'!` prefix in `formula` that names
/// the sheet `name`, outside its string literals and bracketed parts.
fn sheet_refs(formula: &str, name: &str) -> Vec<std::ops::Range<usize>> {
    let chars: Vec<(usize, char)> = formula.char_indices().collect();
    let byte = |i: usize| chars.get(i).map_or(formula.len(), |c| c.0);
    let lower = name.to_lowercase();
    let mut out = Vec::new();
    let mut before = None;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i].1;
        match c {
            '"' => {
                i += 1;
                while i < chars.len() {
                    if chars[i].1 == '"' {
                        if chars.get(i + 1).map(|c| c.1) == Some('"') {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i += 1;
                before = Some('"');
            }
            '[' => {
                let mut depth = 0;
                while i < chars.len() {
                    match chars[i].1 {
                        '[' => depth += 1,
                        ']' => {
                            depth -= 1;
                            if depth == 0 {
                                break;
                            }
                        }
                        _ => {}
                    }
                    i += 1;
                }
                i += 1;
                before = Some(']');
            }
            '\'' if ref_boundary(before) => {
                let mut quoted = String::new();
                let mut j = i + 1;
                while j < chars.len() {
                    if chars[j].1 == '\'' {
                        if chars.get(j + 1).map(|c| c.1) == Some('\'') {
                            quoted.push('\'');
                            j += 2;
                            continue;
                        }
                        break;
                    }
                    quoted.push(chars[j].1);
                    j += 1;
                }
                if chars.get(j + 1).map(|c| c.1) == Some('!') && quoted.to_lowercase() == lower {
                    out.push(byte(i)..byte(j + 2));
                }
                i = j + 1;
                before = Some('\'');
            }
            _ => match ref_boundary(before)
                .then(|| bare_ref_at(&chars, i, name))
                .flatten()
            {
                Some(end) => {
                    out.push(byte(i)..byte(end));
                    i = end;
                    before = Some('!');
                }
                None => {
                    before = Some(c);
                    i += 1;
                }
            },
        }
    }
    out
}

/// A formula with each reference to sheet `from` pointed at sheet `to`,
/// leaving string literals, bracketed parts and longer names alone; None
/// when nothing changed.
pub(super) fn rename_in_formula(formula: &str, from: &str, to: &str) -> Option<String> {
    let spans = sheet_refs(formula, from);
    if spans.is_empty() {
        return None;
    }
    let to = formula_ref(to);
    let mut out = String::with_capacity(formula.len());
    let mut last = 0;
    for span in spans {
        out.push_str(&formula[last..span.start]);
        out.push_str(&to);
        last = span.end;
    }
    out.push_str(&formula[last..]);
    Some(out)
}

/// `xml` with the text of each `names` element passed through `edit`;
/// None when nothing changed.
fn edit_texts(
    xml: &[u8],
    names: &[&str],
    edit: impl Fn(&str) -> Option<String>,
) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(xml.len());
    let mut last = 0;
    let mut changed = false;
    for tag in tags(xml) {
        if tag.kind != Kind::Start || !names.iter().any(|n| tag.is(n)) {
            continue;
        }
        let rest = &xml[tag.end..];
        let end = tag.end + memchr::memchr(b'<', rest).unwrap_or(rest.len());
        let text = unescape(&xml[tag.end..end]);
        if let Some(done) = edit(&text) {
            out.extend_from_slice(&xml[last..tag.end]);
            out.extend_from_slice(escape(&done).as_bytes());
            last = end;
            changed = true;
        }
    }
    changed.then(|| {
        out.extend_from_slice(&xml[last..]);
        out
    })
}

/// `xml` with attribute `attr` of each `name` element passed through
/// `edit`; None when nothing changed.
fn edit_attrs(
    xml: &[u8],
    name: &str,
    attr: &str,
    edit: impl Fn(&str) -> Option<String>,
) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(xml.len());
    let mut last = 0;
    let mut changed = false;
    for tag in tags(xml) {
        if tag.kind == Kind::End || !tag.is(name) {
            continue;
        }
        let Some(value) = tag.attr(attr) else {
            continue;
        };
        if let Some(done) = edit(&value) {
            out.extend_from_slice(&xml[last..tag.start]);
            out.extend(retag(&tag, &[(attr, Some(&done))], tag.kind));
            last = tag.end;
            changed = true;
        }
    }
    changed.then(|| {
        out.extend_from_slice(&xml[last..]);
        out
    })
}

/// Every part the workbook reaches through `kind` relationships of its
/// sheets, each sheet's part first.
async fn sheet_parts(book: &mut Book<'_>, doc: &Doc, kind: &str) -> Vec<String> {
    let mut out = Vec::new();
    for entry in &doc.sheets {
        if let Some(rels) = book.part(&rels_of(&entry.part)).await {
            for (_, k, target) in relationships(&rels, &entry.part) {
                if k.ends_with(kind) {
                    out.push(target);
                }
            }
        }
    }
    out
}

/// The sheet `entry` renamed to `name`, every reference to it renamed too.
pub(super) async fn rename(
    book: &mut Book<'_>,
    doc: &Doc,
    entry: &Entry,
    name: &str,
) -> Result<(), Fail> {
    if let Some(fault) = name_fault(name) {
        return Err(Fail::of(fault));
    }
    let old = entry.name.clone();
    if old.to_lowercase() != name.to_lowercase()
        && doc
            .sheets
            .iter()
            .any(|s| s.name != old && s.name.to_lowercase() == name.to_lowercase())
    {
        return Err(duplicate(name));
    }
    let Some(workbook) = book.part(&doc.wb_part).await else {
        return Err(Fail::of("Workbook not found".to_string()));
    };
    let workbook = edit_attrs(&workbook, "sheet", "name", |v| {
        (v == old).then(|| name.to_string())
    })
    .unwrap_or(workbook);
    let rename = |t: &str| rename_in_formula(t, &old, name);
    let workbook = edit_texts(&workbook, &["definedName"], rename).unwrap_or(workbook);
    book.put(&doc.wb_part, workbook);
    for sheet in &doc.sheets {
        let Some(mut xml) = book.part(&sheet.part).await else {
            continue;
        };
        let mut changed = false;
        if let Some(done) = edit_texts(
            &xml,
            &["f", "formula", "formula1", "formula2", "sqref"],
            rename,
        ) {
            (xml, changed) = (done, true);
        }
        if let Some(done) = edit_attrs(&xml, "hyperlink", "location", rename) {
            (xml, changed) = (done, true);
        }
        if changed {
            book.put(&sheet.part, xml);
        }
    }
    for drawing in sheet_parts(book, doc, "/drawing").await {
        let Some(rels) = book.part(&rels_of(&drawing)).await else {
            continue;
        };
        for (_, kind, chart) in relationships(&rels, &drawing) {
            if !(kind.ends_with("/chart") || kind.ends_with("/chartEx")) {
                continue;
            }
            if let Some(xml) = book.part(&chart).await {
                if let Some(done) = edit_texts(&xml, &["f"], rename) {
                    book.put(&chart, done);
                }
            }
        }
    }
    let wb_rels = book.part(&rels_of(&doc.wb_part)).await.unwrap_or_default();
    for (_, kind, cache) in relationships(&wb_rels, &doc.wb_part) {
        if !kind.ends_with("/pivotCacheDefinition") {
            continue;
        }
        if let Some(xml) = book.part(&cache).await {
            if let Some(done) = edit_attrs(&xml, "worksheetSource", "sheet", |v| {
                v.eq_ignore_ascii_case(&old).then(|| name.to_string())
            }) {
                book.put(&cache, done);
            }
        }
    }
    Ok(())
}

/// Whether `text` names the sheet `name` as a reference does.
fn names_sheet(text: &str, name: &str) -> bool {
    !sheet_refs(text, name).is_empty()
}

/// Text of each `names` element in `xml`.
fn texts_of(xml: &[u8], names: &[&str]) -> Vec<String> {
    tags(xml)
        .filter(|t| t.kind == Kind::Start && names.iter().any(|n| t.is(n)))
        .map(|t| {
            let rest = &xml[t.end..];
            let end = memchr::memchr(b'<', rest).unwrap_or(rest.len());
            unescape(&rest[..end])
        })
        .collect()
}

/// The sheet `entry` removed with the parts only it used, refused while
/// another part still points into it.
pub(super) async fn remove(book: &mut Book<'_>, doc: &Doc, entry: &Entry) -> Result<(), Fail> {
    if doc.sheets.len() <= 1 {
        return Err(Fail::of(
            "Cannot remove the last sheet. A workbook must contain at least one sheet.".to_string(),
        ));
    }
    let name = entry.name.clone();
    if !entry.hidden()
        && !doc
            .sheets
            .iter()
            .any(|s| s.part != entry.part && !s.hidden())
    {
        return Err(Fail::of(format!(
            "Cannot remove sheet '{name}': a workbook must keep at least one visible sheet, or Excel refuses to open the file. Unhide another sheet first."
        )));
    }
    let refused = |what: &str, fix: &str| {
        Fail::of(format!(
            "Cannot remove sheet '{name}': it is referenced by {what}. Remove or repoint {fix} first."
        ))
    };
    for other in doc.sheets.iter().filter(|s| s.part != entry.part) {
        if let Some(rels) = book.part(&rels_of(&other.part)).await {
            for (_, kind, drawing) in relationships(&rels, &other.part) {
                if !kind.ends_with("/drawing") {
                    continue;
                }
                let Some(drels) = book.part(&rels_of(&drawing)).await else {
                    continue;
                };
                for (_, k, chart) in relationships(&drels, &drawing) {
                    if !k.ends_with("/chart") {
                        continue;
                    }
                    if let Some(xml) = book.part(&chart).await {
                        if names_sheet(&String::from_utf8_lossy(&xml), &name) {
                            return Err(refused("a chart in this workbook", "the chart"));
                        }
                    }
                }
            }
        }
        let Some(xml) = book.part(&other.part).await else {
            continue;
        };
        let checks: [(&[&str], &str, &str); 3] = [
            (&["f"], "a sparkline in this workbook", "the sparkline"),
            (
                &["formula1", "formula2"],
                "a data validation formula",
                "the validation",
            ),
            (&["formula"], "a conditional formatting rule", "the rule"),
        ];
        for (names, what, fix) in checks {
            let found = if names == ["f"] {
                sparkline_formulas(&xml)
                    .iter()
                    .any(|t| names_sheet(t, &name))
            } else {
                texts_of(&xml, names).iter().any(|t| names_sheet(t, &name))
            };
            if found {
                return Err(refused(what, fix));
            }
        }
        let linked = tags(&xml)
            .filter(|t| t.kind != Kind::End && t.is("hyperlink"))
            .filter_map(|t| t.attr("location"))
            .any(|l| names_sheet(&l, &name));
        if linked {
            return Err(refused("a hyperlink in this workbook", "the hyperlink"));
        }
    }
    let wb_rels_part = rels_of(&doc.wb_part);
    let wb_rels = book.part(&wb_rels_part).await.unwrap_or_default();
    for (_, kind, cache) in relationships(&wb_rels, &doc.wb_part) {
        if !kind.ends_with("/pivotCacheDefinition") {
            continue;
        }
        if let Some(xml) = book.part(&cache).await {
            let source = tags(&xml)
                .find(|t| t.kind != Kind::End && t.is("worksheetSource"))
                .and_then(|t| t.attr("sheet"));
            if source.is_some_and(|s| s.eq_ignore_ascii_case(&name)) {
                return Err(Fail::of(format!(
                    "Cannot remove sheet '{name}': it is referenced as the source of a pivot table in this workbook. Remove or repoint the pivot table first."
                )));
            }
        }
    }
    let Some(workbook) = book.part(&doc.wb_part).await else {
        return Err(Fail::of("Workbook not found".to_string()));
    };
    let index = doc
        .sheets
        .iter()
        .position(|s| s.part == entry.part)
        .unwrap_or(0);
    let orphans: Vec<String> = tags(&workbook)
        .filter(|t| t.kind == Kind::Start && t.is("definedName"))
        .filter_map(|t| {
            let rest = &workbook[t.end..];
            let end = memchr::memchr(b'<', rest).unwrap_or(rest.len());
            let body = unescape(&rest[..end]);
            names_sheet(&body, &name).then(|| t.attr("name")).flatten()
        })
        .collect();
    if !orphans.is_empty() {
        let mut uses = Vec::new();
        for other in doc.sheets.iter().filter(|s| s.part != entry.part) {
            let Some(xml) = book.part(&other.part).await else {
                continue;
            };
            for (cell, formula) in cell_formulas(&xml) {
                if let Some(n) = orphans.iter().find(|n| uses_name(&formula, n)) {
                    uses.push(format!("{}!{cell} (uses '{n}')", other.name));
                }
            }
        }
        if !uses.is_empty() {
            return Err(Fail::of(format!(
                "Cannot remove sheet '{name}': defined name(s) [{}] are referenced by formulas in {}. Remove or repoint the formulas first.",
                orphans.join(", "),
                uses.join(", ")
            )));
        }
    }
    let rel_id = tags(&workbook)
        .filter(|t| t.kind != Kind::End && t.is("sheet"))
        .nth(index)
        .and_then(|t| t.attr("id"));
    let mut workbook = strip(&workbook, "sheet", |t| {
        t.attr("name").as_deref() == Some(name.as_str())
    });
    workbook = strip(&workbook, "definedName", |t| {
        orphans
            .iter()
            .any(|o| t.attr("name").as_deref() == Some(o.as_str()))
            || t.attr("localSheetId").and_then(|v| v.parse::<usize>().ok()) == Some(index)
    });
    workbook = shift_local_ids(&workbook, index + 1, -1);
    if !tags(&workbook).any(|t| t.kind != Kind::End && t.is("definedName")) {
        workbook = strip(&workbook, "definedNames", |_| true);
    }
    let remaining = doc.sheets.len() - 1;
    let mut out = Vec::with_capacity(workbook.len());
    let mut last = 0;
    for tag in tags(&workbook) {
        if tag.kind == Kind::End || !tag.is("workbookView") {
            continue;
        }
        let Some(active) = tag.attr("activeTab").and_then(|v| v.parse::<usize>().ok()) else {
            continue;
        };
        if active >= remaining {
            let fixed = remaining.saturating_sub(1).to_string();
            out.extend_from_slice(&workbook[last..tag.start]);
            out.extend(retag(&tag, &[("activeTab", Some(&fixed))], tag.kind));
            last = tag.end;
        }
    }
    out.extend_from_slice(&workbook[last..]);
    book.put(&doc.wb_part, out);
    if let Some(id) = rel_id {
        book.put(
            &wb_rels_part,
            strip(&wb_rels, "Relationship", |t| {
                t.attr("Id").as_deref() == Some(id.as_str())
            }),
        );
    }
    drop_owned(book, &entry.part).await;
    for other in doc.sheets.iter().filter(|s| s.part != entry.part) {
        let Some(xml) = book.part(&other.part).await else {
            continue;
        };
        if let Some(done) = without_stale_values(&xml, &name) {
            book.put(&other.part, done);
        }
    }
    Ok(())
}

/// `part` dropped with every part its relationships reach that no other
/// part still reaches, directly or through a part it keeps, and their
/// content types.
async fn drop_owned(book: &mut Book<'_>, part: &str) {
    let mut gone = vec![part.to_string()];
    let mut at = 0;
    while at < gone.len() {
        let current = gone[at].clone();
        at += 1;
        let Some(rels) = book.part(&rels_of(&current)).await else {
            continue;
        };
        for (_, _, target) in relationships(&rels, &current) {
            if target.starts_with("http") || gone.contains(&target) || book.size(&target).is_none()
            {
                continue;
            }
            gone.push(target);
        }
    }
    let mut queue: Vec<String> = book
        .names()
        .iter()
        .filter(|n| n.ends_with(".rels"))
        .map(|n| owner_of(n))
        .filter(|o| !gone.contains(o))
        .collect();
    let mut kept: Vec<String> = Vec::new();
    while let Some(owner) = queue.pop() {
        let Some(rels) = book.part(&rels_of(&owner)).await else {
            continue;
        };
        for (_, _, target) in relationships(&rels, &owner) {
            if target == part || kept.contains(&target) {
                continue;
            }
            kept.push(target.clone());
            if gone.contains(&target) {
                queue.push(target);
            }
        }
    }
    let dropped: Vec<String> = gone
        .into_iter()
        .enumerate()
        .filter(|(i, name)| *i == 0 || !kept.contains(name))
        .map(|(_, name)| name)
        .collect();
    if let Some(types) = book.part("[Content_Types].xml").await {
        let trimmed = strip(&types, "Override", |t| {
            t.attr("PartName").is_some_and(|p| {
                dropped
                    .iter()
                    .any(|d| p.trim_start_matches('/').eq_ignore_ascii_case(d))
            })
        });
        if trimmed != types {
            book.put("[Content_Types].xml", trimmed);
        }
    }
    for name in dropped {
        let rels = rels_of(&name);
        if book.size(&rels).is_some() {
            book.drop_part(&rels);
        }
        book.drop_part(&name);
    }
}

/// The part a relationships part belongs to.
fn owner_of(rels: &str) -> String {
    let (dir, file) = rels.rsplit_once('/').unwrap_or(("", rels));
    let dir = dir
        .strip_suffix("_rels")
        .unwrap_or(dir)
        .trim_end_matches('/');
    let file = file.strip_suffix(".rels").unwrap_or(file);
    if dir.is_empty() {
        file.to_string()
    } else {
        resolve(&format!("{dir}/x"), file)
    }
}

/// The text of each sparkline's data range in a worksheet.
fn sparkline_formulas(xml: &[u8]) -> Vec<String> {
    tags(xml)
        .filter(|t| t.kind == Kind::Start && t.is("f") && !t.prefix().is_empty())
        .map(|t| {
            let rest = &xml[t.end..];
            let end = memchr::memchr(b'<', rest).unwrap_or(rest.len());
            unescape(&rest[..end])
        })
        .collect()
}

/// Each cell's reference and formula text in a worksheet.
fn cell_formulas(xml: &[u8]) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut cell = String::new();
    for t in tags(xml) {
        if t.kind != Kind::End && t.is("c") {
            cell = t.attr("r").unwrap_or_default();
        } else if t.kind == Kind::Start && t.is("f") && t.prefix().is_empty() {
            let rest = &xml[t.end..];
            let end = memchr::memchr(b'<', rest).unwrap_or(rest.len());
            out.push((cell.clone(), unescape(&rest[..end])));
        }
    }
    out
}

/// Whether `formula` uses the defined name `name` as a whole word.
fn uses_name(formula: &str, name: &str) -> bool {
    let lower = formula.to_lowercase();
    let needle = name.to_lowercase();
    let word = |c: Option<char>| c.is_some_and(|c| c.is_alphanumeric() || c == '_');
    let mut at = 0;
    while let Some(found) = lower[at..].find(&needle) {
        let start = at + found;
        let end = start + needle.len();
        if !word(lower[..start].chars().next_back()) && !word(lower[end..].chars().next()) {
            return true;
        }
        at = end;
    }
    false
}

/// A worksheet with the stored value of each formula that names `sheet`
/// dropped, as the value went with the sheet; None when none did.
fn without_stale_values(xml: &[u8], sheet: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(xml.len());
    let mut last = 0;
    let mut changed = false;
    let mut stale = false;
    for t in tags(xml) {
        if t.kind != Kind::End && t.is("c") {
            stale = false;
        } else if t.kind == Kind::Start && t.is("f") && t.prefix().is_empty() {
            let rest = &xml[t.end..];
            let end = memchr::memchr(b'<', rest).unwrap_or(rest.len());
            stale = names_sheet(&unescape(&rest[..end]), sheet);
        } else if stale && t.kind != Kind::End && t.is("v") {
            let end = element_end(xml, &t).unwrap_or(t.end);
            out.extend_from_slice(&xml[last..t.start]);
            last = end;
            changed = true;
            stale = false;
        }
    }
    changed.then(|| {
        out.extend_from_slice(&xml[last..]);
        out
    })
}
