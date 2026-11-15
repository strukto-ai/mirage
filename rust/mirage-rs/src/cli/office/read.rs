// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! The workbook read as OfficeCLI's tree: the workbook node with its
//! document, calculation and theme properties, each sheet with its view,
//! print and protection settings, its rows, its cells with every style
//! property, its comments, and a range of cells, each node built from the
//! parts the way OfficeCLI 1.0.161's `get` builds it.

use super::book::{Book, relationships, rels_of};
use super::node::{Json, Node, Value, number_text};
use super::sheet::{cell_ref, col_name};
use super::style::{self, hex, theme_name};
use super::xml::{Kind, Tag, element_end, runs_text, tags, unescape, unescape_attribute};

/// A sheet as the workbook lists it.
#[derive(Clone, Debug)]
pub(super) struct Entry {
    pub(super) name: String,
    pub(super) part: String,
    pub(super) state: Option<String>,
}

impl Entry {
    pub(super) fn hidden(&self) -> bool {
        matches!(self.state.as_deref(), Some("hidden" | "veryHidden"))
    }
}

/// A run of rich text and the properties its run node shows.
#[derive(Clone, Debug, Default)]
pub(super) struct Run {
    pub(super) text: String,
    pub(super) props: Vec<(String, Value)>,
}

/// A shared string: its text, the first phonetic guide over it, its runs.
#[derive(Clone, Debug, Default)]
struct Item {
    text: String,
    phonetic: Option<String>,
    runs: Vec<Run>,
}

/// The workbook-wide parts every node reads.
pub(super) struct Doc {
    pub(super) wb_part: String,
    pub(super) sheets: Vec<Entry>,
    shared: Vec<Item>,
    pub(super) styles: style::Book,
    date1904: bool,
    workbook: Vec<u8>,
}

/// A part's text after `tag`, up to the next tag.
fn text_after(xml: &[u8], tag: &Tag<'_>) -> String {
    let rest = &xml[tag.end..];
    let end = memchr::memchr(b'<', rest).unwrap_or(rest.len());
    unescape(&rest[..end])
}

fn truthy(v: &str) -> bool {
    matches!(v, "1" | "true")
}

/// The run properties of `<rPr>` inside `xml`, as a run node shows them.
fn run_props(xml: &[u8]) -> Vec<(String, Value)> {
    let mut node = Node::default();
    let find = |name: &str| tags(xml).find(|t| t.kind != Kind::End && t.is(name));
    if find("b").is_some() {
        node.flag("bold");
    }
    if find("i").is_some() {
        node.flag("italic");
    }
    if find("strike").is_some() {
        node.flag("strike");
    }
    if let Some(u) = find("u") {
        node.str(
            "underline",
            if u.attr("val").as_deref() == Some("double") {
                "double"
            } else {
                "single"
            },
        );
    }
    match find("vertAlign").and_then(|v| v.attr("val")).as_deref() {
        Some("superscript") => node.flag("superscript"),
        Some("subscript") => node.flag("subscript"),
        _ => {}
    }
    if let Some(sz) = find("sz")
        .and_then(|s| s.attr("val"))
        .and_then(|s| s.parse::<f64>().ok())
    {
        node.str("size", format!("{}pt", style::two_places(sz)));
    }
    if let Some(rgb) = find("color").and_then(|c| c.attr("rgb")) {
        node.str("color", hex(&rgb));
    }
    if let Some(font) = find("rFont").and_then(|f| f.attr("val")) {
        node.str("font", font);
    }
    node.format
}

/// The runs of rich text in `xml`, each with its properties.
fn runs(xml: &[u8]) -> Vec<Run> {
    let mut out = Vec::new();
    for tag in tags(xml) {
        if tag.kind != Kind::Start || !tag.is("r") {
            continue;
        }
        let end = element_end(xml, &tag).unwrap_or(tag.end);
        let inner = &xml[tag.start..end];
        let text = tags(inner)
            .find(|t| t.kind == Kind::Start && t.is("t"))
            .map(|t| text_after(inner, &t))
            .unwrap_or_default();
        let props = tags(inner)
            .find(|t| t.kind == Kind::Start && t.is("rPr"))
            .map(|t| run_props(&inner[t.start..element_end(inner, &t).unwrap_or(t.end)]))
            .unwrap_or_default();
        out.push(Run { text, props });
    }
    out
}

fn shared_items(xml: &[u8]) -> Vec<Item> {
    let mut out = Vec::new();
    for tag in tags(xml) {
        if tag.kind == Kind::Empty && tag.is("si") {
            out.push(Item::default());
            continue;
        }
        if tag.kind != Kind::Start || !tag.is("si") {
            continue;
        }
        let end = element_end(xml, &tag).unwrap_or(tag.end);
        let inner = &xml[tag.start..end];
        let phonetic = tags(inner)
            .find(|t| t.kind == Kind::Start && t.is("rPh"))
            .and_then(|t| {
                let ph = &inner[t.start..element_end(inner, &t).unwrap_or(t.end)];
                let text = runs_text_all(ph);
                (!text.is_empty()).then_some(text)
            });
        out.push(Item {
            text: runs_text(inner),
            phonetic,
            runs: runs(inner),
        });
    }
    out
}

/// Every `<t>` inside `xml` joined, phonetic runs included.
fn runs_text_all(xml: &[u8]) -> String {
    tags(xml)
        .filter(|t| t.kind == Kind::Start && t.is("t"))
        .map(|t| text_after(xml, &t))
        .collect()
}

/// The part a relationship of `kind` from `part` points at.
pub(super) async fn related(book: &mut Book<'_>, part: &str, kind: &str) -> Option<String> {
    let rels = relationships(&book.part(&rels_of(part)).await?, part);
    rels.into_iter()
        .find(|(_, k, _)| k.ends_with(kind))
        .map(|(_, _, t)| t)
}

impl Doc {
    /// The workbook's own parts, None when it is not a workbook.
    pub(super) async fn load(book: &mut Book<'_>) -> Option<Doc> {
        let mut wb_part = "xl/workbook.xml".to_string();
        if let Some(root) = book.part("_rels/.rels").await {
            if let Some((_, _, target)) = relationships(&root, "")
                .into_iter()
                .find(|(_, kind, _)| kind.ends_with("/officeDocument"))
            {
                wb_part = target;
            }
        }
        let rels = relationships(&book.part(&rels_of(&wb_part)).await?, &wb_part);
        let workbook = book.part(&wb_part).await?;
        let sheets = tags(&workbook)
            .filter(|t| t.kind != Kind::End && t.is("sheet"))
            .filter_map(|t| {
                let id = t.attr("id")?;
                let part = rels.iter().find(|(rid, _, _)| *rid == id)?.2.clone();
                Some(Entry {
                    name: t.attr("name")?,
                    part,
                    state: t.attr("state"),
                })
            })
            .collect();
        let date1904 = tags(&workbook)
            .find(|t| t.kind != Kind::End && t.is("workbookPr"))
            .and_then(|t| t.attr("date1904"))
            .is_some_and(|v| truthy(&v));
        let target = |kind: &str| {
            rels.iter()
                .find(|(_, k, _)| k.ends_with(kind))
                .map(|(_, _, t)| t.clone())
        };
        let shared = match target("/sharedStrings") {
            Some(part) => shared_items(&book.part(&part).await.unwrap_or_default()),
            None => Vec::new(),
        };
        let styles = match target("/styles") {
            Some(part) => style::Book::read(&book.part(&part).await.unwrap_or_default()),
            None => style::Book::default(),
        };
        Some(Doc {
            wb_part,
            sheets,
            shared,
            styles,
            date1904,
            workbook,
        })
    }

    /// The sheet a path names, its name matched without case.
    pub(super) fn sheet(&self, name: &str) -> Option<(usize, &Entry)> {
        self.sheets
            .iter()
            .enumerate()
            .find(|(_, s)| s.name.eq_ignore_ascii_case(name))
    }

    /// The message OfficeCLI gives for a sheet no path names.
    pub(super) fn missing(&self, name: &str, cell: Option<(u32, u32)>) -> String {
        let names: Vec<&str> = self.sheets.iter().map(|s| s.name.as_str()).collect();
        let first = names.first().copied().unwrap_or("Sheet1");
        let cell = cell.map_or_else(|| "A1".to_string(), |(r, c)| format!("{}{r}", col_name(c)));
        format!(
            "Sheet not found: \"{name}\". Available sheets: [{}]. Use DOM path \"/{first}/{cell}\" or Excel notation \"{first}!{cell}\".",
            names.join(", ")
        )
    }
}

#[derive(Clone, Debug, Default)]
pub(super) struct Formula {
    text: String,
    kind: Option<String>,
    reference: Option<String>,
    si: Option<String>,
}

/// A stored cell.
#[derive(Clone, Debug, Default)]
pub(super) struct CellData {
    pub(super) row: u32,
    pub(super) col: u32,
    t: Option<String>,
    s: u32,
    v: Option<String>,
    inline: Option<String>,
    f: Option<Formula>,
}

impl CellData {
    pub(super) fn has_formula(&self) -> bool {
        self.f.is_some()
    }
}

#[derive(Clone, Debug, Default)]
pub(super) struct RowData {
    pub(super) r: u32,
    attrs: Vec<(String, String)>,
    pub(super) cells: Vec<CellData>,
}

impl RowData {
    fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    pub(super) fn hidden(&self) -> bool {
        self.attr("hidden").is_some_and(truthy)
    }
}

#[derive(Clone, Debug, Default)]
struct Link {
    cell: String,
    id: Option<String>,
    location: Option<String>,
    tooltip: Option<String>,
    display: Option<String>,
}

/// A worksheet read for `get`: its rows, merged ranges, hyperlinks and
/// the targets their relationships name.
#[derive(Debug, Default)]
pub(super) struct Grid {
    pub(super) rows: Vec<RowData>,
    merges: Vec<String>,
    links: Vec<Link>,
    targets: Vec<(String, String)>,
    /// The charts its drawing holds.
    pub(super) charts: usize,
    xml: Vec<u8>,
}

fn attrs_of(tag: &Tag<'_>) -> Vec<(String, String)> {
    tag.attrs()
        .into_iter()
        .filter(|(k, _)| !k.starts_with(b"xmlns"))
        .map(|(k, v)| {
            let key = String::from_utf8_lossy(k);
            (
                key.rsplit(':').next().unwrap_or(&key).to_string(),
                unescape_attribute(v),
            )
        })
        .collect()
}

impl Grid {
    pub(super) async fn load(book: &mut Book<'_>, part: &str) -> Grid {
        let xml = book.part(part).await.unwrap_or_default();
        let mut grid = Grid::read(xml);
        if let Some(rels) = book.part(&rels_of(part)).await {
            if !grid.links.is_empty() {
                grid.targets = tags(&rels)
                    .filter(|t| t.kind != Kind::End && t.is("Relationship"))
                    .filter_map(|t| Some((t.attr("Id")?, t.attr("Target")?)))
                    .collect();
            }
            if let Some((_, _, drawing)) = relationships(&rels, part)
                .into_iter()
                .find(|(_, k, _)| k.ends_with("/drawing"))
            {
                if let Some(d) = book.part(&drawing).await {
                    grid.charts = charts(&d);
                }
            }
        }
        grid
    }

    pub(super) fn read(xml: Vec<u8>) -> Grid {
        let mut grid = Grid::default();
        let mut in_data = false;
        let mut cell: Option<CellData> = None;
        let (mut implicit_row, mut implicit_col) = (0u32, 0u32);
        let mut skip_to = 0usize;
        for tag in tags(&xml) {
            if tag.start < skip_to {
                continue;
            }
            match (tag.kind, tag.local()) {
                (Kind::Start, b"sheetData") => in_data = true,
                (Kind::End, b"sheetData") => in_data = false,
                (Kind::Start | Kind::Empty, b"row") if in_data => {
                    let attrs = attrs_of(&tag);
                    let r = attrs
                        .iter()
                        .find(|(k, _)| k == "r")
                        .and_then(|(_, v)| v.parse().ok())
                        .unwrap_or(implicit_row + 1);
                    (implicit_row, implicit_col) = (r, 0);
                    grid.rows.push(RowData {
                        r,
                        attrs,
                        cells: Vec::new(),
                    });
                }
                (Kind::Start | Kind::Empty, b"c") if in_data => {
                    let at = tag.attr("r").and_then(|v| cell_ref(&v));
                    let col = at.map_or(implicit_col + 1, |(_, c)| c);
                    implicit_col = col;
                    let c = CellData {
                        row: at.map_or(implicit_row, |(r, _)| r),
                        col,
                        t: tag.attr("t"),
                        s: tag.attr("s").and_then(|v| v.parse().ok()).unwrap_or(0),
                        ..CellData::default()
                    };
                    if tag.kind == Kind::Empty {
                        if let Some(row) = grid.rows.last_mut() {
                            row.cells.push(c);
                        }
                    } else {
                        cell = Some(c);
                    }
                }
                (Kind::End, b"c") if in_data => {
                    if let (Some(c), Some(row)) = (cell.take(), grid.rows.last_mut()) {
                        row.cells.push(c);
                    }
                }
                (Kind::Start, b"v") if cell.is_some() => {
                    let text = text_after(&xml, &tag);
                    if let Some(c) = cell.as_mut() {
                        c.v = Some(text);
                    }
                }
                (Kind::Empty, b"v") if cell.is_some() => {
                    if let Some(c) = cell.as_mut() {
                        c.v = Some(String::new());
                    }
                }
                (Kind::Start | Kind::Empty, b"f") if cell.is_some() => {
                    let text = if tag.kind == Kind::Start {
                        text_after(&xml, &tag)
                    } else {
                        String::new()
                    };
                    if let Some(c) = cell.as_mut() {
                        c.f = Some(Formula {
                            text,
                            kind: tag.attr("t"),
                            reference: tag.attr("ref"),
                            si: tag.attr("si"),
                        });
                    }
                }
                (Kind::Start, b"is") if cell.is_some() => {
                    let end = element_end(&xml, &tag).unwrap_or(tag.end);
                    let text = runs_text(&xml[tag.start..end]);
                    if let Some(c) = cell.as_mut() {
                        c.inline = Some(text);
                    }
                    skip_to = end;
                }
                (Kind::Empty, b"is") if cell.is_some() => {
                    if let Some(c) = cell.as_mut() {
                        c.inline = Some(String::new());
                    }
                }
                (Kind::Start | Kind::Empty, b"mergeCell") if !in_data => {
                    if let Some(r) = tag.attr("ref") {
                        grid.merges.push(r);
                    }
                }
                (Kind::Start | Kind::Empty, b"hyperlink") if !in_data => grid.links.push(Link {
                    cell: tag.attr("ref").unwrap_or_default(),
                    id: tag
                        .attrs()
                        .iter()
                        .find(|(k, _)| *k == b"r:id" || k.ends_with(b":id"))
                        .map(|(_, v)| unescape_attribute(v)),
                    location: tag.attr("location"),
                    tooltip: tag.attr("tooltip"),
                    display: tag.attr("display"),
                }),
                _ => {}
            }
        }
        grid.xml = xml;
        grid
    }

    pub(super) fn cells(&self) -> impl Iterator<Item = &CellData> {
        self.rows.iter().flat_map(|r| r.cells.iter())
    }

    pub(super) fn find(&self, row: u32, col: u32) -> Option<&CellData> {
        self.rows
            .iter()
            .find(|r| r.r == row)
            .and_then(|r| r.cells.iter().find(|c| c.col == col))
    }

    /// The row indices the sheet holds, each once.
    pub(super) fn distinct_rows(&self) -> usize {
        let mut seen: Vec<u32> = self.rows.iter().map(|r| r.r).filter(|r| *r != 0).collect();
        seen.sort_unstable();
        seen.dedup();
        seen.len()
    }

    /// The text of a shared formula's member, shifted from its master.
    fn formula_text(&self, cell: &CellData) -> Option<String> {
        let f = cell.f.as_ref()?;
        if !f.text.is_empty() || f.kind.as_deref() != Some("shared") {
            return Some(f.text.clone());
        }
        let si = f.si.as_deref()?;
        let master = self.cells().find(|c| {
            c.f.as_ref().is_some_and(|m| {
                m.kind.as_deref() == Some("shared")
                    && m.si.as_deref() == Some(si)
                    && !m.text.is_empty()
            })
        })?;
        let text = &master.f.as_ref()?.text;
        Some(shift(
            text,
            i64::from(cell.row) - i64::from(master.row),
            i64::from(cell.col) - i64::from(master.col),
        ))
    }
}

/// The graphic frames of a drawing that hold a chart.
fn charts(xml: &[u8]) -> usize {
    let mut count = 0;
    for tag in tags(xml) {
        if tag.kind == Kind::Start && tag.is("graphicFrame") {
            let end = element_end(xml, &tag).unwrap_or(tag.end);
            if tags(&xml[tag.end..end]).any(|t| t.kind != Kind::End && t.is("chart")) {
                count += 1;
            }
        }
    }
    count
}

/// A formula with each relative reference moved by `rows` and `cols`.
fn shift(formula: &str, rows: i64, cols: i64) -> String {
    let chars: Vec<char> = formula.chars().collect();
    let mut out = String::with_capacity(formula.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == '"' || c == '\'' {
            let quote = c;
            out.push(c);
            i += 1;
            while i < chars.len() {
                out.push(chars[i]);
                i += 1;
                if chars[i - 1] == quote {
                    if chars.get(i) == Some(&quote) {
                        out.push(quote);
                        i += 1;
                        continue;
                    }
                    break;
                }
            }
            continue;
        }
        let boundary =
            i == 0 || !(chars[i - 1].is_alphanumeric() || matches!(chars[i - 1], '_' | '.'));
        if boundary && (c == '$' || c.is_ascii_alphabetic()) {
            let start = i;
            let mut j = i;
            let col_abs = chars[j] == '$';
            if col_abs {
                j += 1;
            }
            let letters_start = j;
            while j < chars.len() && chars[j].is_ascii_alphabetic() {
                j += 1;
            }
            let letters: String = chars[letters_start..j].iter().collect();
            let row_abs = chars.get(j) == Some(&'$');
            let mut k = if row_abs { j + 1 } else { j };
            let digits_start = k;
            while k < chars.len() && chars[k].is_ascii_digit() {
                k += 1;
            }
            let digits: String = chars[digits_start..k].iter().collect();
            let next = chars.get(k);
            let ends = !next.is_some_and(|n| n.is_alphanumeric() || matches!(n, '_' | '(' | '.'));
            if (1..=3).contains(&letters.len()) && !digits.is_empty() && ends {
                if let Some((row, col)) = cell_ref(&format!("{letters}{digits}")) {
                    let col = if col_abs {
                        i64::from(col)
                    } else {
                        i64::from(col) + cols
                    };
                    let row = if row_abs {
                        i64::from(row)
                    } else {
                        i64::from(row) + rows
                    };
                    if col >= 1 && row >= 1 {
                        out.push_str(&format!(
                            "{}{}{}{}",
                            if col_abs { "$" } else { "" },
                            col_name(col as u32),
                            if row_abs { "$" } else { "" },
                            row
                        ));
                        i = k;
                        continue;
                    }
                }
            }
            let word_end = (start + 1..chars.len())
                .find(|&p| !(chars[p].is_alphanumeric() || matches!(chars[p], '_' | '.')))
                .unwrap_or(chars.len());
            out.extend(&chars[start..word_end]);
            i = word_end;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// A cell's type as OfficeCLI names it, before any formula inference.
pub(super) fn type_name(cell: &CellData) -> &'static str {
    match cell.t.as_deref() {
        Some("str") => "String",
        Some("s") => "SharedString",
        Some("b") => "Boolean",
        Some("e") => "Error",
        Some("inlineStr") => "InlineString",
        Some("d") => "Date",
        _ => "Number",
    }
}

fn numeric(text: &str) -> Option<f64> {
    let t = text.trim();
    if t.is_empty() {
        return None;
    }
    t.parse::<f64>().ok().filter(|n| n.is_finite())
}

impl Doc {
    /// A shared-string cell's runs, None for any other cell.
    pub(super) fn runs_of(&self, cell: &CellData) -> Option<usize> {
        self.item(cell).map(|i| i.runs.len())
    }

    fn item(&self, cell: &CellData) -> Option<&Item> {
        if cell.t.as_deref() != Some("s") {
            return None;
        }
        self.shared
            .get(cell.v.as_deref()?.trim().parse::<usize>().ok()?)
    }

    /// What the cell shows.
    pub(super) fn display(&self, cell: &CellData) -> String {
        if cell.t.as_deref() == Some("inlineStr") {
            return cell.inline.clone().unwrap_or_default();
        }
        let value = cell.v.clone().unwrap_or_default();
        if let Some(item) = self.item(cell) {
            return item.text.clone();
        }
        if cell.t.as_deref() == Some("b") {
            return (if value == "1" { "TRUE" } else { "FALSE" }).to_string();
        }
        if value.is_empty() && cell.f.is_some() {
            return "#OCLI_NOTEVAL!".to_string();
        }
        if cell.t.is_none() {
            if let Some(n) = numeric(&value) {
                if let Some(shown) = self.styles.display(n, cell.s, self.date1904) {
                    return shown;
                }
            }
        }
        value
    }

    /// The value a filter compares: the stored number, else what shows.
    pub(super) fn compared(&self, cell: &CellData) -> String {
        if cell.t.is_none() {
            if let Some(raw) = cell.v.as_deref().filter(|v| numeric(v).is_some()) {
                return raw.to_string();
            }
        }
        self.display(cell)
    }

    /// The cell's node, its rich-text runs listed when `depth` reaches
    /// them.
    pub(super) fn cell_node(
        &self,
        grid: &Grid,
        sheet: &str,
        cell: &CellData,
        depth: usize,
    ) -> Node {
        let at = format!("{}{}", col_name(cell.col), cell.row);
        let formula = grid.formula_text(cell);
        let raw = cell.v.clone().unwrap_or_default();
        let mut kind = type_name(cell);
        if cell.t.is_none() && formula.is_some() && !raw.is_empty() && numeric(&raw).is_none() {
            kind = "String";
        }
        let shown = self.display(cell);
        let mut node = Node::new(format!("/{sheet}/{at}"), "cell");
        node.text = Some(shown.clone());
        node.preview = Some(at.clone());
        node.str("type", kind);
        if let Some(f) = &formula {
            node.str("formula", f.clone());
            if !raw.is_empty() {
                node.str("cachedValue", raw.clone());
            }
            node.set("evaluated", Value::Bool(!raw.is_empty()));
        }
        if let Some(f) = cell
            .f
            .as_ref()
            .filter(|f| f.kind.as_deref() == Some("array"))
        {
            node.flag("arrayformula");
            if let Some(r) = &f.reference {
                node.str("arrayref", r.clone());
            }
        }
        if shown.is_empty() && formula.is_none() {
            node.flag("empty");
        }
        let item = self.item(cell);
        if let Some(ph) = item.and_then(|i| i.phonetic.clone()) {
            node.str("phonetic", ph);
        }
        if let Some(link) = grid.links.iter().find(|l| l.cell.eq_ignore_ascii_case(&at)) {
            if let Some(id) = &link.id {
                if let Some((_, target)) = grid.targets.iter().find(|(rid, _)| rid == id) {
                    node.str("link", trimmed_url(target));
                }
            } else if let Some(loc) = link.location.as_ref().filter(|l| !l.is_empty()) {
                node.str("link", format!("#{loc}"));
            }
            if let Some(t) = link.tooltip.as_ref().filter(|t| !t.is_empty()) {
                node.str("tooltip", t.clone());
            }
            if let Some(d) = link.display.as_ref().filter(|d| !d.is_empty()) {
                node.str("display", d.clone());
            }
        }
        self.styles.describe(cell.s, &mut node);
        merge_of(grid, cell.row, cell.col, &at, &mut node);
        if let Some(item) = item.filter(|i| !i.runs.is_empty()) {
            node.flag("richtext");
            node.child_count = item.runs.len();
            if depth > 0 {
                for (i, run) in item.runs.iter().enumerate() {
                    let mut child = Node::new(format!("/{sheet}/{at}/run[{}]", i + 1), "run");
                    child.text = Some(run.text.clone());
                    child.format = run.props.clone();
                    node.children.push(child);
                }
            }
        }
        node
    }

    /// The node of a cell nothing is stored in.
    pub(super) fn empty_cell(&self, grid: &Grid, sheet: &str, row: u32, col: u32) -> Node {
        let at = format!("{}{row}", col_name(col));
        let mut node = Node::new(format!("/{sheet}/{at}"), "cell");
        node.text = Some("(empty)".to_string());
        node.preview = Some(at.clone());
        merge_of(grid, row, col, &at, &mut node);
        node
    }
}

fn trimmed_url(target: &str) -> String {
    if let Some((scheme, rest)) = target.split_once("://") {
        if !scheme.is_empty() && rest.find('/').is_some_and(|at| &rest[at..] == "/") {
            return target.trim_end_matches('/').to_string();
        }
    }
    target.to_string()
}

fn merge_of(grid: &Grid, row: u32, col: u32, at: &str, node: &mut Node) {
    for range in &grid.merges {
        let Some((a, b)) = range.split_once(':') else {
            continue;
        };
        let (Some((r1, c1)), Some((r2, c2))) = (cell_ref(a), cell_ref(b)) else {
            continue;
        };
        if (r1..=r2).contains(&row) && (c1..=c2).contains(&col) {
            node.str("merge", range.clone());
            if a.eq_ignore_ascii_case(at) {
                node.flag("mergeAnchor");
            }
            return;
        }
    }
}

/// Whether a cell carries content, as a listing counts it.
fn has_content(cell: &CellData) -> bool {
    cell.f.is_some()
        || cell.v.as_deref().is_some_and(|v| !v.is_empty())
        || cell.inline.is_some()
        || (cell.t.is_some() && cell.v.is_some())
}

fn row_height(row: &RowData) -> Option<String> {
    row.attr("ht")
        .and_then(|h| h.parse::<f64>().ok())
        .map(|h| format!("{}pt", number_text(h)))
}

/// The row properties every row node shows.
fn row_props(row: &RowData, node: &mut Node, custom_height: bool) {
    if let Some(h) = row_height(row) {
        node.str("height", h);
    }
    if row.attr("hidden").is_some_and(truthy) {
        node.flag("hidden");
    }
    if custom_height && row.attr("customHeight").is_some_and(truthy) {
        node.flag("customHeight");
    }
    if let Some(level) = row
        .attr("outlineLevel")
        .and_then(|l| l.parse::<i64>().ok())
        .filter(|l| *l > 0)
    {
        node.set("outlineLevel", Value::Int(level));
    }
    if row.attr("collapsed").is_some_and(truthy) {
        node.flag("collapsed");
    }
}

/// The row properties a query may filter on though no row carries them.
pub(super) const ROW_KEYS: &[&str] = &[
    "height",
    "hidden",
    "outlineLevel",
    "collapsed",
    "customHeight",
];

impl Doc {
    /// A sheet's rows as a listing shows them: rows with content or row
    /// properties, each with its cells that carry content.
    pub(super) fn listing(&self, grid: &Grid, sheet: &str, depth: usize) -> Vec<Node> {
        let mut seen = Vec::new();
        let mut out = Vec::new();
        for row in &grid.rows {
            if row.r != 0 && seen.contains(&row.r) {
                continue;
            }
            seen.push(row.r);
            let content: Vec<&CellData> = row.cells.iter().filter(|c| has_content(c)).collect();
            let meaningful = row.attrs.iter().any(|(k, _)| k != "r" && k != "spans");
            if content.is_empty() && !meaningful {
                continue;
            }
            let mut node = Node::new(format!("/{sheet}/row[{}]", row.r), "row");
            node.child_count = content.len();
            row_props(row, &mut node, false);
            if depth > 0 {
                for cell in content {
                    node.children
                        .push(self.cell_node(grid, sheet, cell, depth - 1));
                }
            }
            out.push(node);
        }
        out
    }

    /// A row a path names.
    pub(super) fn row_node(
        &self,
        grid: &Grid,
        sheet: &str,
        path: &str,
        index: u32,
        depth: usize,
    ) -> Node {
        let Some(row) = grid.rows.iter().find(|r| r.r == index) else {
            let mut node = Node::new(path, "row");
            node.text = Some("(empty)".to_string());
            node.preview = Some(format!("row {index}"));
            return node;
        };
        let mut node = Node::new(path, "row");
        node.child_count = row.cells.len();
        row_props(row, &mut node, false);
        const CURATED: [&str; 8] = [
            "r",
            "ht",
            "height",
            "hidden",
            "outlineLevel",
            "collapsed",
            "customHeight",
            "spans",
        ];
        for (k, v) in &row.attrs {
            if !CURATED.contains(&k.as_str()) && !node.has(k) {
                node.str(k, v.clone());
            }
        }
        if depth > 0 {
            for cell in &row.cells {
                node.children.push(self.cell_node(grid, sheet, cell, 1));
            }
        }
        node
    }

    /// Every row as `query row` lists it.
    pub(super) fn query_rows(&self, grid: &Grid, sheet: &str) -> Vec<Node> {
        let mut out = Vec::new();
        for row in grid.rows.iter().filter(|r| r.r != 0) {
            let mut node = Node::new(format!("/{sheet}/row[{}]", row.r), "row");
            node.child_count = row.cells.len();
            node.preview = Some(row.r.to_string());
            node.declared = ROW_KEYS;
            node.search = Some(
                row.cells
                    .iter()
                    .map(|c| self.display(c))
                    .collect::<Vec<_>>()
                    .join(" "),
            );
            row_props(row, &mut node, true);
            out.push(node);
        }
        out
    }

    /// The cells of a range, an empty one in place of each cell nothing
    /// is stored in.
    pub(super) fn range_node(
        &self,
        grid: &Grid,
        sheet: &str,
        (r1, c1): (u32, u32),
        (r2, c2): (u32, u32),
    ) -> Node {
        let range = format!("{}{r1}:{}{r2}", col_name(c1), col_name(c2));
        let mut node = Node::new(format!("/{sheet}/{range}"), "range");
        node.preview = Some(range);
        for r in r1..=r2 {
            for c in c1..=c2 {
                match grid.find(r, c) {
                    Some(cell) => node.children.push(self.cell_node(grid, sheet, cell, 1)),
                    None => {
                        let at = format!("{}{r}", col_name(c));
                        let mut empty = Node::new(format!("/{sheet}/{at}"), "cell");
                        empty.text = Some(String::new());
                        empty.preview = Some(at);
                        empty.str("type", "Number");
                        empty.flag("empty");
                        node.children.push(empty);
                    }
                }
            }
        }
        node.child_count = node.children.len();
        node
    }
}

/// One comment as `get` reads it.
#[derive(Clone, Debug, Default)]
pub(super) struct Comment {
    pub(super) cell: String,
    author: String,
    text: String,
    runs: Vec<Run>,
}

/// A comments part's comments, in order.
pub(super) fn comments(xml: &[u8]) -> Vec<Comment> {
    let mut authors = Vec::new();
    let mut out = Vec::new();
    for tag in tags(xml) {
        if tag.kind == Kind::Start && tag.is("author") {
            authors.push(text_after(xml, &tag));
        }
    }
    for tag in tags(xml) {
        if tag.kind == Kind::End || !tag.is("comment") {
            continue;
        }
        let end = element_end(xml, &tag).unwrap_or(tag.end);
        let inner = &xml[tag.start..end];
        let author = tag
            .attr("authorId")
            .and_then(|a| a.parse::<usize>().ok())
            .unwrap_or(0);
        out.push(Comment {
            cell: tag.attr("ref").unwrap_or_else(|| "?".to_string()),
            author: authors
                .get(author)
                .cloned()
                .unwrap_or_else(|| "Unknown".to_string()),
            text: runs_text_all(inner),
            runs: runs(inner),
        });
    }
    out
}

/// A comment's node.
pub(super) fn comment_node(sheet: &str, comment: &Comment, index: usize) -> Node {
    let mut node = Node::new(format!("/{sheet}/comment[{index}]"), "comment");
    node.text = Some(comment.text.clone());
    node.preview = Some(format!("{}: {}", comment.cell, comment.text));
    node.str("ref", comment.cell.clone());
    node.str("author", comment.author.clone());
    node.str("anchoredTo", format!("/{sheet}/{}", comment.cell));
    if comment.runs.len() > 1 {
        let runs = comment
            .runs
            .iter()
            .map(|r| {
                let mut fields = vec![("text".to_string(), Json::Str(r.text.clone()))];
                for (k, v) in &r.props {
                    fields.push((
                        k.clone(),
                        match v {
                            Value::Bool(b) => Json::Bool(*b),
                            other => Json::Str(other.text()),
                        },
                    ));
                }
                Json::Obj(fields)
            })
            .collect();
        node.str("runs", Json::Arr(runs).compact_escaped());
    }
    if let Some(run) = comment.runs.first().filter(|_| comment.runs.len() <= 1) {
        let prop = |k: &str| {
            run.props
                .iter()
                .find(|(n, _)| n == k)
                .map(|(_, v)| v.text())
        };
        if prop("bold").is_some() {
            node.flag("font.bold");
        }
        if prop("italic").is_some() {
            node.flag("font.italic");
        }
        if let Some(u) = prop("underline") {
            node.str("font.underline", u);
        }
        if let Some(c) = prop("color") {
            node.str("font.color", c);
        }
        if let Some(s) = prop("size").filter(|s| s != "9pt") {
            node.str("font.size", s);
        }
        if let Some(f) = prop("font").filter(|f| f != "Tahoma") {
            node.str("font.name", f);
        }
    }
    node
}

/// A W3C date-time as OfficeCLI prints a document date, in UTC.
fn round_trip_date(text: &str) -> Option<String> {
    let t = text.trim();
    let (date, rest) = t.split_once('T')?;
    let mut parts = date.split('-');
    let (y, mo, d): (i64, i64, i64) = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
    );
    let (clock, offset) = match rest.find(['Z', '+', '-']) {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, "Z"),
    };
    let mut hms = clock.split(':');
    let h: i64 = hms.next()?.parse().ok()?;
    let mi: i64 = hms.next()?.parse().ok()?;
    let sec_text = hms.next().unwrap_or("0");
    let (s, frac) = sec_text
        .split_once('.')
        .map_or((sec_text, ""), |(s, f)| (s, f));
    let s: i64 = s.parse().ok()?;
    let ticks: i64 = format!("{:0<7}", frac.chars().take(7).collect::<String>())
        .parse()
        .unwrap_or(0);
    let offset_min = if offset == "Z" || offset.is_empty() {
        0
    } else {
        let sign = if offset.starts_with('-') { -1 } else { 1 };
        let (oh, om) = offset[1..].split_once(':').unwrap_or((&offset[1..], "0"));
        sign * (oh.parse::<i64>().ok()? * 60 + om.parse::<i64>().unwrap_or(0))
    };
    let days = {
        let y = if mo <= 2 { y - 1 } else { y };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let doy = (153 * ((mo + 9) % 12) + 2) / 5 + d - 1;
        era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468
    };
    let total = days * 86400 + h * 3600 + mi * 60 + s - offset_min * 60;
    let (day, secs) = (total.div_euclid(86400), total.rem_euclid(86400));
    let z = day + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let dd = doy - (153 * mp + 2) / 5 + 1;
    let mm = if mp < 10 { mp + 3 } else { mp - 9 };
    let yy = yoe + era * 400 + i64::from(mm <= 2);
    Some(format!(
        "{yy:04}-{mm:02}-{dd:02}T{:02}:{:02}:{:02}.{ticks:07}+00:00",
        secs / 3600,
        secs / 60 % 60,
        secs % 60
    ))
}

/// The text of the first element named `name` in `xml`.
fn element_text(xml: &[u8], name: &str) -> Option<String> {
    let tag = tags(xml).find(|t| t.kind != Kind::End && t.is(name))?;
    Some(if tag.kind == Kind::Start {
        text_after(xml, &tag)
    } else {
        String::new()
    })
}

impl Doc {
    /// The workbook node: its document properties, settings, theme and
    /// application properties, and its sheets.
    pub(super) async fn workbook_node(&self, book: &mut Book<'_>, depth: usize) -> Node {
        let mut node = Node::new("/", "workbook");
        let root = book
            .part("_rels/.rels")
            .await
            .map(|r| relationships(&r, ""))
            .unwrap_or_default();
        let target = |kind: &str| {
            root.iter()
                .find(|(_, k, _)| k.ends_with(kind))
                .map(|(_, _, t)| t.clone())
        };
        if let Some(part) = target("/core-properties") {
            let core = book.part(&part).await.unwrap_or_default();
            for (key, name) in [
                ("title", "title"),
                ("author", "creator"),
                ("subject", "subject"),
                ("keywords", "keywords"),
                ("description", "description"),
                ("category", "category"),
                ("lastModifiedBy", "lastModifiedBy"),
                ("revisionNumber", "revision"),
            ] {
                if let Some(v) = element_text(&core, name) {
                    node.str(key, v);
                }
            }
            for (key, name) in [("created", "created"), ("modified", "modified")] {
                if let Some(v) = element_text(&core, name).and_then(|v| round_trip_date(&v)) {
                    node.str(key, v);
                }
            }
        }
        self.settings(&mut node);
        if let Some(part) = related(book, &self.wb_part.clone(), "/theme").await {
            theme(&book.part(&part).await.unwrap_or_default(), &mut node);
        }
        if let Some(part) = target("/extended-properties") {
            let app = book.part(&part).await.unwrap_or_default();
            for (key, name, int) in [
                ("template", "Template", false),
                ("manager", "Manager", false),
                ("company", "Company", false),
                ("application", "Application", false),
                ("applicationVersion", "AppVersion", false),
                ("pages", "Pages", true),
                ("words", "Words", true),
                ("characters", "Characters", true),
                ("lines", "Lines", true),
                ("paragraphs", "Paragraphs", true),
                ("totalTime", "TotalTime", true),
            ] {
                if let Some(v) = element_text(&app, name) {
                    let value = match v.parse::<i64>() {
                        Ok(n) if int => Value::Int(n),
                        _ => Value::Str(v),
                    };
                    node.set(&format!("extended.{key}"), value);
                }
            }
        }
        for entry in &self.sheets {
            let grid = Grid::load(book, &entry.part).await;
            let mut sheet = Node::new(format!("/{}", entry.name), "sheet");
            sheet.preview = Some(entry.name.clone());
            sheet.child_count = grid.distinct_rows() + grid.charts;
            if depth > 1 {
                sheet.children = self.listing(&grid, &entry.name, depth - 1);
                sheet.child_count = sheet.children.len();
            }
            node.children.push(sheet);
        }
        node.child_count = node.children.len();
        node
    }

    fn settings(&self, node: &mut Node) {
        let wb = &self.workbook;
        let first = |name: &str| tags(wb).find(|t| t.kind != Kind::End && t.is(name));
        let on = |t: &Tag<'_>, k: &str| t.attr(k).is_some_and(|v| truthy(&v));
        if let Some(p) = first("workbookPr") {
            if on(&p, "date1904") {
                node.flag("workbook.date1904");
            }
            if let Some(c) = p.attr("codeName") {
                node.str("workbook.codeName", c);
            }
            if on(&p, "filterPrivacy") {
                node.flag("workbook.filterPrivacy");
            }
            if let Some(s) = p.attr("showObjects") {
                node.str("workbook.showObjects", s);
            }
            if on(&p, "backupFile") {
                node.flag("workbook.backupFile");
            }
            if on(&p, "dateCompatibility") {
                node.flag("workbook.dateCompatibility");
            }
        }
        let calc = first("calcPr");
        node.set(
            "calc.fullPrecision",
            Value::Bool(
                calc.as_ref()
                    .and_then(|c| c.attr("fullPrecision"))
                    .is_none_or(|v| truthy(&v)),
            ),
        );
        if let Some(c) = &calc {
            if let Some(m) = c.attr("calcMode") {
                node.str("calc.mode", m);
            }
            if on(c, "iterate") {
                node.flag("calc.iterate");
            }
            if let Some(n) = c.attr("iterateCount").and_then(|n| n.parse::<i64>().ok()) {
                node.set("calc.iterateCount", Value::Int(n));
            }
            if let Some(d) = c.attr("iterateDelta").and_then(|n| n.parse::<f64>().ok()) {
                node.set("calc.iterateDelta", Value::Num(d));
            }
            if on(c, "fullCalcOnLoad") {
                node.flag("calc.fullCalcOnLoad");
            }
            if let Some(r) = c.attr("refMode") {
                node.str("calc.refMode", r);
            }
        }
        if let Some(view) = first("workbookView") {
            if let Some(t) = view
                .attr("activeTab")
                .and_then(|t| t.parse::<i64>().ok())
                .filter(|t| *t != 0)
            {
                node.set("activeTab", Value::Int(t));
            }
            if let Some(f) = view
                .attr("firstSheet")
                .and_then(|t| t.parse::<i64>().ok())
                .filter(|t| *t != 0)
            {
                node.set("firstSheet", Value::Int(f));
            }
        }
        if let Some(p) = first("workbookProtection") {
            if on(&p, "lockStructure") {
                node.flag("workbook.lockStructure");
            }
            if on(&p, "lockWindows") {
                node.flag("workbook.lockWindows");
            }
            if let Some(h) = p.attr("workbookPassword").filter(|h| !h.is_empty()) {
                node.str("workbook.passwordHash", h);
                node.str("workbook.password", "***");
            }
        }
    }

    /// A sheet's node with its properties and, past depth 0, its rows.
    pub(super) fn sheet_node(&self, grid: &Grid, index: usize, path: &str, depth: usize) -> Node {
        let entry = &self.sheets[index];
        let name = path.trim_start_matches('/');
        let mut node = Node::new(path, "sheet");
        node.preview = Some(name.to_string());
        node.child_count = grid.distinct_rows() + grid.charts;
        let xml = &grid.xml;
        let top = top_level(xml);
        let find = |n: &str| top.iter().find(|t| t.is(n));
        if let Some(view) =
            find("sheetViews").and_then(|v| inside(xml, v).into_iter().find(|t| t.is("sheetView")))
        {
            let panes = inside(xml, &view);
            if let Some(pane) = panes
                .iter()
                .find(|t| t.is("pane"))
                .filter(|p| p.attr("state").as_deref() == Some("frozen"))
            {
                let x = pane
                    .attr("xSplit")
                    .and_then(|v| v.parse::<f64>().ok())
                    .unwrap_or(0.0) as u32;
                let y = pane
                    .attr("ySplit")
                    .and_then(|v| v.parse::<f64>().ok())
                    .unwrap_or(0.0) as u32;
                node.str("freeze", format!("{}{}", col_name(x + 1), y + 1));
            }
            if let Some(z) = view
                .attr("zoomScale")
                .and_then(|z| z.parse::<i64>().ok())
                .filter(|z| *z != 100)
            {
                node.set("zoom", Value::Int(z));
            }
            if view.attr("showGridLines").is_some_and(|v| !truthy(&v)) {
                node.set("gridlines", Value::Bool(false));
            }
            if view.attr("showRowColHeaders").is_some_and(|v| !truthy(&v)) {
                node.set("headings", Value::Bool(false));
            }
            if view.attr("rightToLeft").is_some_and(|v| truthy(&v)) {
                node.str("direction", "rtl");
            }
        }
        if let Some(tab) =
            find("sheetPr").and_then(|p| inside(xml, p).into_iter().find(|t| t.is("tabColor")))
        {
            if let Some(rgb) = tab.attr("rgb") {
                let rgb = if rgb.len() == 8 && rgb.is_ascii() {
                    rgb[2..].to_string()
                } else {
                    rgb
                };
                node.str("tabColor", hex(&rgb));
            } else if let Some(name) = tab
                .attr("theme")
                .and_then(|t| t.parse().ok())
                .and_then(|t| theme_name(t, tab.attr("tint").and_then(|v| v.parse().ok())))
            {
                node.str("tabColor", name);
            }
        }
        if let Some(r) = find("autoFilter").and_then(|a| a.attr("ref")) {
            node.str("autoFilter", r);
        }
        if entry.hidden() {
            node.flag("hidden");
            node.str(
                "visibility",
                if entry.state.as_deref() == Some("veryHidden") {
                    "veryHidden"
                } else {
                    "hidden"
                },
            );
        }
        if let Some(p) =
            find("sheetProtection").filter(|p| p.attr("sheet").is_some_and(|v| truthy(&v)))
        {
            node.flag("protect");
            for (attr, key) in [
                ("password", "passwordHash"),
                ("algorithmName", "protection.algorithm"),
                ("hashValue", "protection.hash"),
                ("saltValue", "protection.salt"),
            ] {
                if let Some(v) = p.attr(attr).filter(|v| !v.is_empty()) {
                    node.str(key, v);
                }
            }
            if let Some(n) = p.attr("spinCount").and_then(|n| n.parse::<i64>().ok()) {
                node.set("protection.spinCount", Value::Int(n));
            }
        }
        if let Some(setup) = find("pageSetup") {
            if let Some(o) = setup.attr("orientation") {
                node.str("orientation", o);
            }
            if let Some(p) = setup.attr("paperSize").and_then(|p| p.parse::<i64>().ok()) {
                node.set("paperSize", Value::Int(p));
            }
            if let Some(w) = setup.attr("fitToWidth") {
                node.str(
                    "fitToPage",
                    format!(
                        "{w}x{}",
                        setup.attr("fitToHeight").unwrap_or_else(|| "1".to_string())
                    ),
                );
            }
        }
        let defined = |name: &str| {
            tags(&self.workbook)
                .filter(|t| t.kind == Kind::Start && t.is("definedName"))
                .find(|t| {
                    t.attr("name").as_deref() == Some(name)
                        && t.attr("localSheetId").and_then(|v| v.parse::<usize>().ok())
                            == Some(index)
                })
                .map(|t| text_after(&self.workbook, &t))
        };
        if let Some(area) = defined("_xlnm.Print_Area") {
            node.str(
                "printArea",
                area.split_once('!')
                    .map_or(area.clone(), |(_, r)| r.to_string()),
            );
        }
        if let Some(titles) = defined("_xlnm.Print_Titles") {
            for tok in titles.split(',').map(str::trim).filter(|t| !t.is_empty()) {
                let range = tok.split_once('!').map_or(tok, |(_, r)| r).replace('$', "");
                let left = range.split(':').next().unwrap_or_default();
                match left.chars().next() {
                    Some(c) if c.is_ascii_digit() => node.str("printTitleRows", range.clone()),
                    Some(c) if c.is_alphabetic() => node.str("printTitleCols", range.clone()),
                    _ => {}
                }
            }
        }
        if let Some(pm) = find("pageMargins") {
            for side in ["top", "bottom", "left", "right", "header", "footer"] {
                if let Some(v) = pm.attr(side).and_then(|v| v.parse::<f64>().ok()) {
                    node.str(
                        &format!("margin.{side}"),
                        format!("{}in", number_text((v * 1000.0).round() / 1000.0)),
                    );
                }
            }
        }
        if let Some(hf) = find("headerFooter") {
            let inner = inside(xml, hf);
            for (child, key) in [("oddHeader", "header"), ("oddFooter", "footer")] {
                if let Some(t) = inner.iter().find(|t| t.is(child)) {
                    node.str(
                        key,
                        if t.kind == Kind::Start {
                            text_after(xml, t)
                        } else {
                            String::new()
                        },
                    );
                }
            }
        }
        if let Some(sort) = find("sortState") {
            let conditions: Vec<String> = inside(xml, sort)
                .into_iter()
                .filter(|t| t.is("sortCondition"))
                .map(|c| {
                    let r = c.attr("ref").unwrap_or_default();
                    let col: String = r
                        .split(':')
                        .next()
                        .unwrap_or_default()
                        .chars()
                        .take_while(|ch| ch.is_ascii_uppercase())
                        .collect();
                    format!(
                        "{col}:{}",
                        if c.attr("descending").is_some_and(|v| truthy(&v)) {
                            "desc"
                        } else {
                            "asc"
                        }
                    )
                })
                .collect();
            node.str("sort", conditions.join(","));
        }
        for (element, key) in [("rowBreaks", "rowBreaks"), ("colBreaks", "colBreaks")] {
            if let Some(b) = find(element) {
                let ids: Vec<String> = inside(xml, b)
                    .into_iter()
                    .filter(|t| t.is("brk"))
                    .map(|t| t.attr("id").unwrap_or_default())
                    .collect();
                if !ids.is_empty() {
                    node.str(key, ids.join(","));
                }
            }
        }
        if depth > 0 {
            node.children = self.listing(grid, name, depth);
            node.child_count = node.children.len();
        }
        node
    }
}

/// The worksheet's own child elements.
fn top_level(xml: &[u8]) -> Vec<Tag<'_>> {
    let mut out = Vec::new();
    let mut depth = 0usize;
    let mut skip_to = 0usize;
    for tag in tags(xml) {
        if tag.start < skip_to {
            continue;
        }
        match tag.kind {
            Kind::Start if depth == 1 && tag.is("sheetData") => {
                skip_to = element_end(xml, &tag).unwrap_or(tag.end);
            }
            Kind::Start => {
                if depth == 1 {
                    out.push(tag);
                }
                depth += 1;
            }
            Kind::Empty if depth == 1 => out.push(tag),
            Kind::End => depth = depth.saturating_sub(1),
            Kind::Empty => {}
        }
    }
    out
}

/// The elements inside `parent`, opening tags only.
fn inside<'a>(xml: &'a [u8], parent: &Tag<'a>) -> Vec<Tag<'a>> {
    if parent.kind == Kind::Empty {
        return Vec::new();
    }
    let end = element_end(xml, parent).unwrap_or(parent.end);
    tags(&xml[parent.end..end])
        .filter(|t| t.kind != Kind::End)
        .map(|mut t| {
            t.start += parent.end;
            t.end += parent.end;
            t
        })
        .collect()
}

fn theme(xml: &[u8], node: &mut Node) {
    let Some(root) = tags(xml).find(|t| t.kind != Kind::End && t.is("theme")) else {
        return;
    };
    if let Some(n) = root.attr("name") {
        node.str("theme.name", n);
    }
    let all: Vec<Tag<'_>> = tags(xml).filter(|t| t.kind != Kind::End).collect();
    if let Some(scheme) = all.iter().find(|t| t.is("clrScheme")) {
        if let Some(n) = scheme.attr("name") {
            node.str("theme.colorScheme", n);
        }
        let inner = inside(xml, scheme);
        for slot in [
            "dk1", "lt1", "dk2", "lt2", "accent1", "accent2", "accent3", "accent4", "accent5",
            "accent6", "hlink", "folHlink",
        ] {
            let Some(at) = inner.iter().position(|t| t.is(slot)) else {
                continue;
            };
            let value = inner.get(at + 1).and_then(|c| {
                if c.is("srgbClr") {
                    c.attr("val")
                } else if c.is("sysClr") {
                    c.attr("lastClr")
                } else {
                    None
                }
            });
            if let Some(v) = value {
                node.str(&format!("theme.color.{slot}"), hex(&v));
            }
        }
    }
    if let Some(fonts) = all.iter().find(|t| t.is("fontScheme")) {
        if let Some(n) = fonts.attr("name") {
            node.str("theme.fontScheme", n);
        }
        let inner = inside(xml, fonts);
        for group in ["major", "minor"] {
            let Some(at) = inner.iter().position(|t| t.is(&format!("{group}Font"))) else {
                continue;
            };
            let end = element_end(xml, &inner[at]).unwrap_or(inner[at].end);
            let members: Vec<&Tag<'_>> = inner
                .iter()
                .skip(at + 1)
                .take_while(|t| t.start < end)
                .collect();
            for (child, key) in [("latin", "latin"), ("ea", "eastAsia")] {
                if let Some(face) = members
                    .iter()
                    .find(|t| t.is(child))
                    .and_then(|t| t.attr("typeface"))
                {
                    node.str(&format!("theme.font.{group}.{key}"), face);
                }
            }
        }
    }
    if let Some(n) = all
        .iter()
        .find(|t| t.is("fmtScheme"))
        .and_then(|t| t.attr("name"))
    {
        node.str("theme.formatScheme", n);
    }
}

/// A range of cells as (first column, first row, last column, last row).
pub(super) type Range = (u32, u32, u32, u32);

/// A table: its name, its range, whether it has a header row and a
/// totals row, and its column names.
#[derive(Clone, Debug, Default)]
pub(super) struct Table {
    pub(super) name: String,
    pub(super) range: Range,
    pub(super) header: bool,
    pub(super) totals: bool,
    pub(super) columns: Vec<String>,
}

/// A range like `A1:D7` as (first column, first row, last column, last
/// row).
pub(super) fn bounds(range: &str) -> Option<Range> {
    let clean = range.replace('$', "");
    match clean.split_once(':') {
        Some((a, b)) => {
            let ((r1, c1), (r2, c2)) = (cell_ref(a)?, cell_ref(b)?);
            Some((c1, r1, c2, r2))
        }
        None => cell_ref(&clean).map(|(r, c)| (c, r, c, r)),
    }
}

/// The tables a worksheet defines.
pub(super) async fn tables(book: &mut Book<'_>, part: &str) -> Vec<Table> {
    let Some(rels) = book.part(&rels_of(part)).await else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (_, kind, target) in relationships(&rels, part) {
        if !kind.ends_with("/table") {
            continue;
        }
        let Some(xml) = book.part(&target).await else {
            continue;
        };
        let Some(root) = tags(&xml).find(|t| t.kind != Kind::End && t.is("table")) else {
            continue;
        };
        let Some(range) = root.attr("ref").and_then(|r| bounds(&r)) else {
            continue;
        };
        let number = |k: &str| root.attr(k).and_then(|v| v.parse::<u32>().ok());
        out.push(Table {
            name: root.attr("name").unwrap_or_else(|| "table".to_string()),
            range,
            header: number("headerRowCount").unwrap_or(1) != 0,
            totals: number("totalsRowCount").unwrap_or(0) > 0
                || root.attr("totalsRowShown").is_some_and(|v| truthy(&v)),
            columns: tags(&xml)
                .filter(|t| t.kind != Kind::End && t.is("tableColumn"))
                .map(|t| t.attr("name").unwrap_or_default())
                .collect(),
        });
    }
    out
}

impl Doc {
    /// Table-shaped blocks a sheet's cells form: a row of at least two
    /// text headers with at least one row of data under it, outside every
    /// defined table, each as its range and its column names.
    pub(super) fn detect_tables(
        &self,
        grid: &Grid,
        defined: &[Range],
    ) -> Vec<(Range, Vec<String>)> {
        let mut occupied: std::collections::HashMap<(u32, u32), (String, bool)> =
            std::collections::HashMap::new();
        for cell in grid.cells() {
            let val = self.display(cell);
            if val.is_empty() {
                continue;
            }
            let text = cell.f.is_none() && numeric(&val).is_none();
            occupied.insert((cell.col, cell.row), (val, text));
        }
        let mut anchors: Vec<(u32, u32)> = occupied
            .keys()
            .copied()
            .filter(|&(c, r)| {
                !occupied.contains_key(&(c, r.wrapping_sub(1)))
                    && !occupied.contains_key(&(c.wrapping_sub(1), r))
            })
            .collect();
        anchors.sort_by_key(|&(c, r)| (r, c));
        let mut claimed = std::collections::HashSet::new();
        let mut out = Vec::new();
        for (ac, ar) in anchors {
            if claimed.contains(&(ac, ar))
                || !occupied.get(&(ac, ar)).is_some_and(|(_, text)| *text)
            {
                continue;
            }
            let mut c = ac;
            while occupied.contains_key(&(c, ar)) {
                c += 1;
            }
            let end_col = c - 1;
            if end_col < ac + 1 {
                continue;
            }
            let mut last = ar;
            loop {
                let r = last + 1;
                if !(ac..=end_col).any(|cc| occupied.contains_key(&(cc, r))) {
                    break;
                }
                last = r;
            }
            if last == ar {
                continue;
            }
            let block = (ac, ar, end_col, last);
            if defined
                .iter()
                .any(|d| d.0 <= block.2 && block.0 <= d.2 && d.1 <= block.3 && block.1 <= d.3)
            {
                continue;
            }
            for r in ar..=last {
                for cc in ac..=end_col {
                    claimed.insert((cc, r));
                }
            }
            let names = (ac..=end_col)
                .map(|cc| {
                    occupied
                        .get(&(cc, ar))
                        .map(|(v, _)| v.clone())
                        .unwrap_or_default()
                })
                .collect();
            out.push((block, names));
        }
        out
    }
}
