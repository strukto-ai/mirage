// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.
//! A worksheet's cells: rewriting the ones a command sets, in row and
//! column order, each replaced cell keeping its style, and reading cells,
//! number formats and comments the way `get` reports them.

use std::collections::BTreeMap;

use super::xml::{Kind, Tag, element_end, escape, retag, tags};

/// What a cell is set to.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Val {
    /// A number, as the text its value is stored as.
    Num(String),
    Str(String),
    /// A date as its serial day count, shown as `yyyy-mm-dd`.
    Date(f64),
    Formula(String),
    Clear,
}

pub(super) type Edits = BTreeMap<u32, BTreeMap<u32, Val>>;

/// A1 as (row, column), each from 1; None past XFD1048576.
pub(super) fn cell_ref(text: &str) -> Option<(u32, u32)> {
    let b = text.as_bytes();
    let letters = b.iter().take_while(|c| c.is_ascii_alphabetic()).count();
    if letters == 0 || letters > 3 || letters == b.len() {
        return None;
    }
    let col = b[..letters].iter().fold(0u32, |acc, c| {
        acc * 26 + u32::from(c.to_ascii_uppercase() - b'A' + 1)
    });
    let digits = &text[letters..];
    if !digits.bytes().all(|c| c.is_ascii_digit()) || digits.starts_with('0') {
        return None;
    }
    let row: u32 = digits.parse().ok()?;
    (col <= 16384 && (1..=1_048_576).contains(&row)).then_some((row, col))
}

pub(super) fn col_name(mut col: u32) -> String {
    let mut s = Vec::new();
    while col > 0 {
        s.push(b'A' + ((col - 1) % 26) as u8);
        col = (col - 1) / 26;
    }
    s.reverse();
    String::from_utf8(s).unwrap_or_default()
}

/// The serial day count of a `YYYY-MM-DD` date, as Excel counts from 1900.
pub(super) fn date_serial(text: &str) -> Option<f64> {
    let mut parts = text.split('-');
    let (y, m, d) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() || y.len() != 4 || m.len() != 2 || d.len() != 2 {
        return None;
    }
    let (y, m, d): (i64, i64, i64) = (y.parse().ok()?, m.parse().ok()?, d.parse().ok()?);
    let days_in = [
        31,
        if y % 4 == 0 && (y % 100 != 0 || y % 400 == 0) {
            29
        } else {
            28
        },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=12).contains(&m) || d < 1 || d > days_in[(m - 1) as usize] || y < 1900 {
        return None;
    }
    let days = |y: i64, m: i64, d: i64| {
        let y = if m <= 2 { y - 1 } else { y };
        let era = y.div_euclid(400);
        let yoe = y - era * 400;
        let doy = (153 * ((m + 9) % 12) + 2) / 5 + d - 1;
        era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy
    };
    Some((days(y, m, d) - days(1899, 12, 30)) as f64)
}

/// Why a worksheet could not take its edits.
#[derive(Debug, PartialEq)]
pub(super) enum Refused {
    /// The cell holds the master of a formula other cells share.
    Shared(String),
    NoSheetData,
}

pub(super) struct Rewritten {
    pub(super) xml: Vec<u8>,
    /// A formula was overwritten, so the calculation chain is stale.
    pub(super) formula_replaced: bool,
}

fn cell_xml(
    p: &str,
    row: u32,
    col: u32,
    style: Option<u32>,
    val: &Val,
    styles: &mut Option<Styles>,
) -> String {
    let r = format!("{}{row}", col_name(col));
    let s = |style: Option<u32>| style.map(|s| format!(" s=\"{s}\"")).unwrap_or_default();
    match val {
        Val::Num(text) => format!("<{p}c r=\"{r}\"{}><{p}v>{text}</{p}v></{p}c>", s(style)),
        Val::Str(text) => format!(
            "<{p}c r=\"{r}\"{} t=\"str\"><{p}v>{}</{p}v></{p}c>",
            s(style),
            escape(text)
        ),
        Val::Date(serial) => {
            let style = styles
                .as_mut()
                .map_or(style, |st| Some(st.date_style(style.unwrap_or(0))));
            format!("<{p}c r=\"{r}\"{}><{p}v>{serial}</{p}v></{p}c>", s(style))
        }
        Val::Formula(f) => format!(
            "<{p}c r=\"{r}\"{}><{p}f>{}</{p}f></{p}c>",
            s(style),
            escape(f)
        ),
        Val::Clear => style
            .map(|st| format!("<{p}c r=\"{r}\" s=\"{st}\"/>"))
            .unwrap_or_default(),
    }
}

/// The worksheet with `edits` applied; every byte outside the edited cells
/// stays as it was.
pub(super) fn rewrite(
    xml: &[u8],
    mut edits: Edits,
    styles: &mut Option<Styles>,
) -> Result<Rewritten, Refused> {
    let (mut min_r, mut min_c, mut max_r, mut max_c) = (u32::MAX, u32::MAX, 0, 0);
    for (r, cells) in &edits {
        for c in cells.keys() {
            (min_r, max_r, min_c, max_c) =
                (min_r.min(*r), max_r.max(*r), min_c.min(*c), max_c.max(*c));
        }
    }
    let mut out = Vec::with_capacity(xml.len() + 1024);
    let mut last = 0usize;
    let mut p = String::new();
    let mut root = false;
    let mut in_data = false;
    let mut cur: Option<(u32, BTreeMap<u32, Val>)> = None;
    let (mut implicit_row, mut implicit_col) = (0u32, 0u32);
    let mut skip_until = 0usize;
    let mut formula_replaced = false;
    let row_cells = |p: &str, r: u32, cells: &BTreeMap<u32, Val>, styles: &mut Option<Styles>| {
        cells
            .iter()
            .map(|(c, v)| cell_xml(p, r, *c, None, v, styles))
            .collect::<String>()
    };
    for tag in tags(xml) {
        if tag.start < skip_until {
            continue;
        }
        if !root && tag.kind != Kind::End {
            root = true;
            p = String::from_utf8_lossy(tag.prefix()).into_owned();
        }
        match (tag.kind, tag.local()) {
            (Kind::Empty | Kind::Start, b"dimension") if !edits.is_empty() => {
                if let Some(range) = tag.attr("ref") {
                    let mut ends = range.split(':');
                    let a = ends.next().and_then(cell_ref).unwrap_or((1, 1));
                    let b = ends.next().and_then(cell_ref).unwrap_or(a);
                    let grown = (
                        a.0.min(min_r),
                        a.1.min(min_c),
                        b.0.max(max_r),
                        b.1.max(max_c),
                    );
                    if grown != (a.0, a.1, b.0, b.1) {
                        let span = format!(
                            "{}{}:{}{}",
                            col_name(grown.1),
                            grown.0,
                            col_name(grown.3),
                            grown.2
                        );
                        out.extend_from_slice(&xml[last..tag.start]);
                        out.extend(retag(&tag, &[("ref", Some(&span))], tag.kind));
                        last = tag.end;
                    }
                }
            }
            (Kind::Empty, b"sheetData") if !edits.is_empty() => {
                out.extend_from_slice(&xml[last..tag.start]);
                out.extend(retag(&tag, &[], Kind::Start));
                for (r, cells) in std::mem::take(&mut edits) {
                    let body = row_cells(&p, r, &cells, styles);
                    if !body.is_empty() {
                        out.extend(format!("<{p}row r=\"{r}\">{body}</{p}row>").into_bytes());
                    }
                }
                out.extend(format!("</{}>", String::from_utf8_lossy(tag.name)).into_bytes());
                last = tag.end;
            }
            (Kind::Start, b"sheetData") => in_data = true,
            (Kind::End, b"sheetData") => {
                in_data = false;
                out.extend_from_slice(&xml[last..tag.start]);
                for (r, cells) in std::mem::take(&mut edits) {
                    let body = row_cells(&p, r, &cells, styles);
                    if !body.is_empty() {
                        out.extend(format!("<{p}row r=\"{r}\">{body}</{p}row>").into_bytes());
                    }
                }
                last = tag.start;
            }
            (Kind::Start | Kind::Empty, b"row") if in_data => {
                let r = tag
                    .attr("r")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(implicit_row + 1);
                (implicit_row, implicit_col) = (r, 0);
                let before: Vec<u32> = edits.range(..r).map(|(k, _)| *k).collect();
                if !before.is_empty() {
                    out.extend_from_slice(&xml[last..tag.start]);
                    for k in before {
                        let cells = edits.remove(&k).unwrap_or_default();
                        let body = row_cells(&p, k, &cells, styles);
                        if !body.is_empty() {
                            out.extend(format!("<{p}row r=\"{k}\">{body}</{p}row>").into_bytes());
                        }
                    }
                    last = tag.start;
                }
                let mine = edits.remove(&r);
                match (tag.kind, mine) {
                    (Kind::Empty, Some(cells)) => {
                        let body = row_cells(&p, r, &cells, styles);
                        if !body.is_empty() {
                            out.extend_from_slice(&xml[last..tag.start]);
                            out.extend(retag(&tag, &[], Kind::Start));
                            out.extend(body.into_bytes());
                            out.extend(
                                format!("</{}>", String::from_utf8_lossy(tag.name)).into_bytes(),
                            );
                            last = tag.end;
                        }
                    }
                    (Kind::Start, mine) => cur = mine.map(|m| (r, m)),
                    _ => {}
                }
            }
            (Kind::End, b"row") if in_data => {
                if let Some((r, cells)) = cur.take() {
                    out.extend_from_slice(&xml[last..tag.start]);
                    out.extend(row_cells(&p, r, &cells, styles).into_bytes());
                    last = tag.start;
                }
            }
            (Kind::Start | Kind::Empty, b"c") if in_data => {
                let (r, c) = tag
                    .attr("r")
                    .and_then(|v| cell_ref(&v))
                    .unwrap_or((implicit_row, implicit_col + 1));
                implicit_col = c;
                let Some((row, cells)) = cur.as_mut() else {
                    continue;
                };
                let before: Vec<u32> = cells.range(..c).map(|(k, _)| *k).collect();
                if !before.is_empty() {
                    out.extend_from_slice(&xml[last..tag.start]);
                    for k in before {
                        let v = cells.remove(&k).unwrap_or(Val::Clear);
                        out.extend(cell_xml(&p, *row, k, None, &v, styles).into_bytes());
                    }
                    last = tag.start;
                }
                if let Some(v) = cells.remove(&c) {
                    let style = tag.attr("s").and_then(|s| s.parse().ok());
                    let end = element_end(xml, &tag).ok_or(Refused::NoSheetData)?;
                    for inner in tags(&xml[tag.end.min(end)..end]) {
                        if inner.kind != Kind::End && inner.is("f") {
                            formula_replaced = true;
                            if inner.attr("t").as_deref() == Some("shared")
                                && inner.attr("ref").is_some()
                            {
                                return Err(Refused::Shared(format!("{}{r}", col_name(c))));
                            }
                        }
                    }
                    out.extend_from_slice(&xml[last..tag.start]);
                    out.extend(cell_xml(&p, r, c, style, &v, styles).into_bytes());
                    last = end;
                    skip_until = end;
                }
            }
            _ => {}
        }
    }
    if !edits.is_empty() {
        return Err(Refused::NoSheetData);
    }
    out.extend_from_slice(&xml[last..]);
    Ok(Rewritten {
        xml: out,
        formula_replaced,
    })
}

/// The styles part: each cell format's number format, the custom formats
/// by id, and the date format a set date adds.
pub(super) struct Styles {
    pub(super) xml: Vec<u8>,
    xf_fmt: Vec<u32>,
    custom: BTreeMap<u32, String>,
    added: BTreeMap<u32, u32>,
    pub(super) dirty: bool,
}

/// ECMA-376's built-in number formats, by id.
const BUILTIN: [(u32, &str); 28] = [
    (1, "0"),
    (2, "0.00"),
    (3, "#,##0"),
    (4, "#,##0.00"),
    (9, "0%"),
    (10, "0.00%"),
    (11, "0.00E+00"),
    (12, "# ?/?"),
    (13, "# ??/??"),
    (14, "mm-dd-yy"),
    (15, "d-mmm-yy"),
    (16, "d-mmm"),
    (17, "mmm-yy"),
    (18, "h:mm AM/PM"),
    (19, "h:mm:ss AM/PM"),
    (20, "h:mm"),
    (21, "h:mm:ss"),
    (22, "m/d/yy h:mm"),
    (37, "#,##0 ;(#,##0)"),
    (38, "#,##0 ;[Red](#,##0)"),
    (39, "#,##0.00;(#,##0.00)"),
    (40, "#,##0.00;[Red](#,##0.00)"),
    (45, "mm:ss"),
    (46, "[h]:mm:ss"),
    (47, "mmss.0"),
    (48, "##0.0E+0"),
    (49, "@"),
    (0, "General"),
];

const DATE_FORMAT: &str = "yyyy-mm-dd";

impl Styles {
    pub(super) fn new(xml: Vec<u8>) -> Styles {
        let mut styles = Styles {
            xml,
            xf_fmt: Vec::new(),
            custom: BTreeMap::new(),
            added: BTreeMap::new(),
            dirty: false,
        };
        styles.scan();
        styles
    }

    fn scan(&mut self) {
        self.xf_fmt.clear();
        let mut in_xfs = false;
        let mut depth = 0usize;
        for tag in tags(&self.xml) {
            match tag.kind {
                Kind::Start if tag.is("cellXfs") => (in_xfs, depth) = (true, 0),
                Kind::End if tag.is("cellXfs") => in_xfs = false,
                Kind::Start | Kind::Empty if in_xfs && depth == 0 && tag.is("xf") => {
                    self.xf_fmt.push(
                        tag.attr("numFmtId")
                            .and_then(|v| v.parse().ok())
                            .unwrap_or(0),
                    );
                    if tag.kind == Kind::Start {
                        depth += 1;
                    }
                }
                Kind::Start if in_xfs => depth += 1,
                Kind::End if in_xfs => depth = depth.saturating_sub(1),
                Kind::Empty if tag.is("numFmt") => {
                    if let (Some(id), Some(code)) = (
                        tag.attr("numFmtId").and_then(|v| v.parse().ok()),
                        tag.attr("formatCode"),
                    ) {
                        self.custom.insert(id, code);
                    }
                }
                _ => {}
            }
        }
    }

    /// The number format a cell format shows, by id and code; None for
    /// General.
    pub(super) fn number_format(&self, style: u32) -> Option<(u32, String)> {
        let id = *self.xf_fmt.get(style as usize)?;
        if id == 0 {
            return None;
        }
        let code = self.custom.get(&id).cloned().or_else(|| {
            BUILTIN
                .iter()
                .find(|(b, _)| *b == id)
                .map(|(_, c)| (*c).to_string())
        })?;
        Some((id, code))
    }

    /// The cell format a set date takes: `base` when it already shows
    /// `yyyy-mm-dd`, else a copy of it that does, added once.
    pub(super) fn date_style(&mut self, base: u32) -> u32 {
        if self
            .number_format(base)
            .is_some_and(|(_, code)| code == DATE_FORMAT)
        {
            return base;
        }
        if let Some(&s) = self.added.get(&base) {
            return s;
        }
        let id = match self.custom.iter().find(|(_, code)| *code == DATE_FORMAT) {
            Some((id, _)) => *id,
            None => {
                let id = self
                    .custom
                    .keys()
                    .copied()
                    .max()
                    .map_or(164, |m| m.max(163) + 1);
                self.add_format(id);
                id
            }
        };
        let index = self.add_xf(base, id);
        self.added.insert(base, index);
        self.dirty = true;
        index
    }

    fn add_format(&mut self, id: u32) {
        let all: Vec<Tag<'_>> = tags(&self.xml).collect();
        let root = all.iter().find(|t| t.kind == Kind::Start).copied();
        let p = root
            .map(|t| String::from_utf8_lossy(t.prefix()).into_owned())
            .unwrap_or_default();
        let entry = format!("<{p}numFmt numFmtId=\"{id}\" formatCode=\"{DATE_FORMAT}\"/>");
        let open = all
            .iter()
            .find(|t| t.kind == Kind::Start && t.is("numFmts"))
            .copied();
        let close = all
            .iter()
            .find(|t| t.kind == Kind::End && t.is("numFmts"))
            .copied();
        let xml = match (open, close, root) {
            (Some(open), Some(close), _) => {
                let count = (self.custom.len() + 1).to_string();
                [
                    &self.xml[..open.start],
                    &retag(&open, &[("count", Some(&count))], Kind::Start),
                    &self.xml[open.end..close.start],
                    entry.as_bytes(),
                    &self.xml[close.start..],
                ]
                .concat()
            }
            (_, _, Some(root)) => {
                let block = format!("<{p}numFmts count=\"1\">{entry}</{p}numFmts>");
                [
                    &self.xml[..root.end],
                    block.as_bytes(),
                    &self.xml[root.end..],
                ]
                .concat()
            }
            _ => return,
        };
        self.xml = xml;
        self.custom.insert(id, DATE_FORMAT.to_string());
    }

    fn add_xf(&mut self, base: u32, fmt: u32) -> u32 {
        let fmt_text = fmt.to_string();
        let changes = [
            ("numFmtId", Some(fmt_text.as_str())),
            ("applyNumberFormat", Some("1")),
        ];
        let all: Vec<Tag<'_>> = tags(&self.xml).collect();
        let Some(open) = all
            .iter()
            .position(|t| t.kind == Kind::Start && t.is("cellXfs"))
        else {
            return base;
        };
        let mut index = 0u32;
        let mut depth = 0usize;
        let mut copy: Option<Vec<u8>> = None;
        let mut close = None;
        for tag in &all[open + 1..] {
            match tag.kind {
                Kind::End if depth == 0 && tag.is("cellXfs") => {
                    close = Some(*tag);
                    break;
                }
                Kind::Start | Kind::Empty if depth == 0 && tag.is("xf") => {
                    if index == base {
                        let end = element_end(&self.xml, tag).unwrap_or(tag.end);
                        copy = Some(
                            [
                                retag(tag, &changes, tag.kind),
                                self.xml[tag.end..end].to_vec(),
                            ]
                            .concat(),
                        );
                    }
                    index += 1;
                    if tag.kind == Kind::Start {
                        depth += 1;
                    }
                }
                Kind::Start => depth += 1,
                Kind::End => depth = depth.saturating_sub(1),
                Kind::Empty => {}
            }
        }
        let open_tag = all[open];
        let Some(close) = close else { return base };
        let p = String::from_utf8_lossy(open_tag.prefix()).into_owned();
        let new_xf = copy.unwrap_or_else(|| format!("<{p}xf numFmtId=\"{fmt}\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\" applyNumberFormat=\"1\"/>").into_bytes());
        let count = (index + 1).to_string();
        self.xml = [
            &self.xml[..open_tag.start],
            &retag(&open_tag, &[("count", Some(&count))], Kind::Start),
            &self.xml[open_tag.end..close.start],
            &new_xf,
            &self.xml[close.start..],
        ]
        .concat();
        self.xf_fmt.push(fmt);
        index
    }
}

/// One comment: the cell it is on and its bytes in the comments part.
pub(super) struct Note {
    pub(super) cell: String,
    pub(super) span: (usize, usize),
}

/// A comments part's comments, in order.
pub(super) fn notes(xml: &[u8]) -> Vec<Note> {
    tags(xml)
        .filter(|t| t.kind != Kind::End && t.is("comment"))
        .map(|t| Note {
            cell: t.attr("ref").unwrap_or_default(),
            span: (t.start, element_end(xml, &t).unwrap_or(t.end)),
        })
        .collect()
}

/// A legacy drawing with the note shape on `cell` taken out, as Excel
/// draws each comment's box; untouched when no shape is on it.
pub(super) fn without_shape(vml: &[u8], cell: (u32, u32)) -> Vec<u8> {
    let all: Vec<Tag<'_>> = tags(vml).collect();
    let text_of = |i: usize| -> Option<u32> {
        let (t, n) = (all.get(i)?, all.get(i + 1)?);
        String::from_utf8_lossy(&vml[t.end..n.start])
            .trim()
            .parse()
            .ok()
    };
    for (i, tag) in all.iter().enumerate() {
        if tag.kind != Kind::Start || !tag.is("shape") {
            continue;
        }
        let Some(end) = element_end(vml, tag) else {
            continue;
        };
        let (mut row, mut col) = (None, None);
        for (j, inner) in all.iter().enumerate().skip(i + 1) {
            if inner.start >= end {
                break;
            }
            if inner.kind == Kind::Start && inner.is("Row") {
                row = text_of(j);
            }
            if inner.kind == Kind::Start && inner.is("Column") {
                col = text_of(j);
            }
        }
        if row == Some(cell.0 - 1) && col == Some(cell.1 - 1) {
            return [&vml[..tag.start], &vml[end..]].concat();
        }
    }
    vml.to_vec()
}

/// A part with every element named `name` whose `ref` is `cell` taken out.
pub(super) fn without_refs(xml: &[u8], name: &str, cell: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(xml.len());
    let mut last = 0;
    let mut skip_until = 0;
    for tag in tags(xml) {
        if tag.start < skip_until || tag.kind == Kind::End || !tag.is(name) {
            continue;
        }
        if tag
            .attr("ref")
            .is_some_and(|r| r.eq_ignore_ascii_case(cell))
        {
            let end = element_end(xml, &tag).unwrap_or(tag.end);
            out.extend_from_slice(&xml[last..tag.start]);
            (last, skip_until) = (end, end);
        }
    }
    out.extend_from_slice(&xml[last..]);
    out
}
