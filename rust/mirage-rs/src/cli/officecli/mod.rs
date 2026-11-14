//! officecli's workbook commands as OfficeCLI 1.0.161 (iOfficeAI,
//! Apache-2.0) answers them: `create`, `get`, `query`, `set`, `remove` and
//! `batch` over an .xlsx the host spools, with its paths (`/`, `/Sheet`,
//! `/Sheet/A1`, `/Sheet/A1:B2`, `/Sheet/row[N]`, `Sheet!A1`,
//! `/Sheet/comment[N]`), its selectors, output lines, `--json` envelopes,
//! messages and exit codes. A command rewrites only the parts it changes
//! and copies every other part from the spool as it stands. Divergences: a
//! formula is stored and shown without a computed value, `query` reads
//! cells, rows, comments and sheets only, and `batch` runs `get`, `query`,
//! `set` and `remove` items.

mod batch;
mod book;
mod node;
mod query;
mod read;
mod sheet;
mod style;
#[cfg(test)]
mod tests;
mod xml;

use serde::Deserialize;

use self::batch::Item;
use self::book::{Book, Refusal, package, relationships, rels_of};
use self::node::{Json, Node, lines, matches};
use self::query::Scope;
use self::read::{Doc, Grid, comment_node, comments, related};
use self::sheet::{
    Edits, Refused, Styles, Val, cell_ref, col_name, date_serial, notes, without_refs,
    without_shape,
};
use self::xml::{Kind, retag, tags};
use crate::request::{Opening, Request, failed, failure_text};
use crate::task::Host;
use crate::zip::{Piece, write_out};
use crate::{Stream, StreamError, parse_config, task};

#[derive(Deserialize)]
struct Config {
    command: String,
    /// The workbook as typed, which messages name.
    #[serde(deserialize_with = "crate::latin1")]
    file: Vec<u8>,
    /// The workbook's absolute path, which the host reads and writes.
    #[serde(deserialize_with = "crate::latin1")]
    absolute: Vec<u8>,
    #[serde(default)]
    path: Option<String>,
    #[serde(default)]
    props: Vec<String>,
    #[serde(default)]
    force: bool,
    #[serde(default)]
    json: bool,
    #[serde(default)]
    depth: Option<i64>,
    #[serde(default)]
    find: Option<String>,
    #[serde(default)]
    commands: Option<String>,
    /// `--input` as typed, the stream's second operand.
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    input: Option<Vec<u8>>,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    input_absolute: Option<Vec<u8>>,
    #[serde(default)]
    stop_on_error: bool,
    #[serde(default)]
    best_effort: bool,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    Ok(task::spawn(|host| run(host, config)))
}

/// A refusal: the message `Error:` prints and the code `--json` names.
#[derive(Debug)]
pub(super) struct Fail {
    message: String,
    code: Option<&'static str>,
    hint: Option<(&'static str, Option<&'static str>)>,
}

impl Fail {
    /// A refusal its message names the code of, as OfficeCLI infers one.
    pub(super) fn of(message: String) -> Fail {
        let code =
            if message.starts_with("Sheet not found:") || message.starts_with("Path not found:") {
                Some("not_found")
            } else if message.contains("Unsupported file type") {
                Some("unsupported_type")
            } else if message.starts_with("invalid ") {
                Some("invalid_value")
            } else {
                None
            };
        Fail {
            message,
            code,
            hint: None,
        }
    }

    pub(super) fn coded(message: String, code: &'static str) -> Fail {
        Fail {
            message,
            code: Some(code),
            hint: None,
        }
    }

    fn missing(absolute: &[u8]) -> Fail {
        Fail {
            message: format!("File not found: {}", text(absolute)),
            code: Some("file_not_found"),
            hint: Some((
                "Check the file path. Use an absolute path or a path relative to the current directory.",
                Some("officecli create <path> --type docx|xlsx|pptx"),
            )),
        }
    }

    fn envelope(&self) -> Json {
        let mut error = vec![
            ("error", Json::Str(self.message.clone())),
            (
                "code",
                Json::Str(self.code.unwrap_or("internal_error").to_string()),
            ),
        ];
        if let Some((suggestion, help)) = self.hint {
            error.push(("suggestion", Json::Str(suggestion.to_string())));
            if let Some(help) = help {
                error.push(("help", Json::Str(help.to_string())));
            }
        }
        Json::obj(vec![
            ("success", Json::Bool(false)),
            ("error", Json::obj(error)),
        ])
    }
}

/// Why a set changed nothing: the refusal, or the properties it does not
/// take.
enum SetFail {
    Fail(Fail),
    Unsupported {
        keys: Vec<String>,
        element: &'static str,
        valid: &'static [&'static str],
    },
}

impl From<Fail> for SetFail {
    fn from(f: Fail) -> SetFail {
        SetFail::Fail(f)
    }
}

/// What a path names; a sheet as typed, resolved against the workbook.
#[derive(Debug, PartialEq)]
enum Target {
    Workbook,
    Sheet(String),
    Cell(String, (u32, u32)),
    Range(String, (u32, u32), (u32, u32)),
    Row(String, Option<u32>),
    Comment(String, usize),
    Run(String, (u32, u32), usize),
}

impl Target {
    fn sheet(&self) -> Option<&str> {
        match self {
            Target::Workbook => None,
            Target::Sheet(s)
            | Target::Cell(s, _)
            | Target::Range(s, ..)
            | Target::Row(s, _)
            | Target::Comment(s, _)
            | Target::Run(s, ..) => Some(s),
        }
    }

    fn cell(&self) -> Option<(u32, u32)> {
        match self {
            Target::Cell(_, at) | Target::Range(_, at, _) | Target::Run(_, at, _) => Some(*at),
            _ => None,
        }
    }
}

fn range_ref(text: &str) -> Option<((u32, u32), (u32, u32))> {
    let (a, b) = text.split_once(':')?;
    Some((cell_ref(a)?, cell_ref(b)?))
}

fn target(path: &str) -> Option<Target> {
    if path == "/" {
        return Some(Target::Workbook);
    }
    if !path.starts_with('/') {
        let (name, at) = path.rsplit_once('!')?;
        let name = name
            .strip_prefix('\'')
            .and_then(|n| n.strip_suffix('\''))
            .unwrap_or(name)
            .to_string();
        if let Some((a, b)) = range_ref(at) {
            return Some(Target::Range(name, a, b));
        }
        return Some(Target::Cell(name, cell_ref(at)?));
    }
    let rest = &path[1..];
    let Some((name, tail)) = rest.split_once('/') else {
        return (!rest.is_empty()).then(|| Target::Sheet(rest.to_string()));
    };
    let name = name.to_string();
    if let Some(n) = tail
        .strip_prefix("comment[")
        .and_then(|t| t.strip_suffix(']'))
    {
        return Some(Target::Comment(name, n.parse().ok()?));
    }
    if let Some(n) = tail.strip_prefix("row[").and_then(|t| t.strip_suffix(']')) {
        if n.eq_ignore_ascii_case("last()") {
            return Some(Target::Row(name, None));
        }
        return Some(Target::Row(name, Some(n.parse().ok()?)));
    }
    if let Some((at, sub)) = tail.split_once('/') {
        let cell = cell_ref(at)?;
        let n = sub
            .strip_prefix("run[")
            .and_then(|t| t.strip_suffix(']'))?
            .parse()
            .ok()?;
        return Some(Target::Run(name, cell, n));
    }
    if let Some((a, b)) = range_ref(tail) {
        return Some(Target::Range(name, a, b));
    }
    Some(Target::Cell(name, cell_ref(tail)?))
}

/// Why a set or remove path names nothing it changes: a cell path with a
/// tail is a cell not found, as OfficeCLI reads it.
fn unsupported_path(command: &str, path: &str) -> Fail {
    let tail = path.trim_start_matches('/').split_once('/').map(|(_, t)| t);
    match tail {
        Some(t)
            if command == "remove"
                && t.split_once('/')
                    .is_some_and(|(head, _)| cell_ref(head).is_some()) =>
        {
            Fail::of(format!("Cell {t} not found"))
        }
        _ => Fail::of(format!("Unsupported path: {path}")),
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// Where a command's output goes: as text, or as one JSON envelope.
struct Out<'h> {
    host: &'h Host,
    json: bool,
}

impl Out<'_> {
    fn fail(&self, f: &Fail) -> i32 {
        if self.json {
            self.host
                .print(format!("{}\n", f.envelope().pretty()).as_bytes());
        } else {
            self.host.warn(format!("Error: {}\n", f.message).as_bytes());
        }
        1
    }

    /// A command's one-line success message.
    fn done(&self, message: &str) -> i32 {
        if self.json {
            let env = Json::obj(vec![
                ("success", Json::Bool(true)),
                ("data", Json::Str(message.to_string())),
                ("message", Json::Str(message.to_string())),
            ]);
            self.host.print(format!("{}\n", env.pretty()).as_bytes());
        } else {
            self.host.print(format!("{message}\n").as_bytes());
        }
        0
    }

    fn data(&self, data: Json, warnings: Option<Json>, success: bool) {
        let mut env = vec![("success", Json::Bool(success)), ("data", data)];
        if let Some(w) = warnings {
            env.push(("warnings", w));
        }
        self.host
            .print(format!("{}\n", Json::obj(env).pretty()).as_bytes());
    }

    fn unsupported(&self, path: &str, keys: &[String], element: &str, valid: &[&str]) -> i32 {
        if self.json {
            let warnings = keys
                .iter()
                .map(|k| {
                    Json::obj(vec![
                        (
                            "message",
                            Json::Str(format!(
                                "Unsupported property: {k} (valid {element} props: {})",
                                valid.join(", ")
                            )),
                        ),
                        ("code", Json::Str("unsupported_property".to_string())),
                    ])
                })
                .collect();
            let env = Json::obj(vec![
                ("success", Json::Bool(false)),
                (
                    "message",
                    Json::Str(format!("Error: No properties applied to {path}")),
                ),
                ("warnings", Json::Arr(warnings)),
            ]);
            self.host.print(format!("{}\n", env.pretty()).as_bytes());
        } else {
            self.host
                .print(format!("Error: No properties applied to {path}\n").as_bytes());
            self.host
                .warn(format!("{}\n", unsupported_text(keys, element, valid)).as_bytes());
        }
        2
    }
}

fn unsupported_text(keys: &[String], element: &str, valid: &[&str]) -> String {
    format!(
        "UNSUPPORTED props: {} (valid {element} props: {}). Run 'officecli help <format> <element>' to see valid props, or raw-set for raw XML.",
        keys.join(", "),
        valid.join(", ")
    )
}

async fn open_book<'h>(host: &'h Host, config: &Config) -> Result<(Book<'h>, Doc), Fail> {
    let mut book = match Book::open(host, &config.file).await {
        Ok(book) => book,
        Err(Refusal::Missing) => return Err(Fail::missing(&config.absolute)),
        Err(Refusal::Unreadable) => {
            return Err(Fail::of(format!(
                "Not a workbook officecli reads: {}",
                text(&config.file)
            )));
        }
        Err(Refusal::Host(why)) => return Err(Fail::of(text(&why))),
    };
    let Some(doc) = Doc::load(&mut book).await else {
        return Err(Fail::of(format!(
            "Not a workbook officecli reads: {}",
            text(&config.file)
        )));
    };
    Ok((book, doc))
}

async fn run(host: Host, config: Config) -> i32 {
    let out = Out {
        host: &host,
        json: config.json,
    };
    let path = config.path.clone().unwrap_or_else(|| "/".to_string());
    match config.command.as_str() {
        "create" => create(&out, &config).await,
        "query" => {
            if path.trim().is_empty() {
                return out.fail(&Fail::coded(
                    "'query' requires a selector (e.g. paragraph, shape, row[Score>80])."
                        .to_string(),
                    "invalid_input",
                ));
            }
            let (mut book, doc) = match open_book(&host, &config).await {
                Ok(b) => b,
                Err(f) => return out.fail(&f),
            };
            let scope = scope(&mut book, &doc).await;
            match search(&scope, &path, config.find.as_deref()) {
                Ok((mut results, warnings)) => {
                    for note in scope.notes.borrow().iter() {
                        host.warn(format!("{note}\n").as_bytes());
                    }
                    if out.json {
                        hydrate(&doc, &scope, &mut results);
                        let w = (!warnings.is_empty()).then(|| {
                            Json::Arr(warnings.iter().map(query::Warning::json).collect())
                        });
                        out.data(matches(&results), w, true);
                    } else {
                        for w in &warnings {
                            host.warn(format!("{}\n", w.message).as_bytes());
                        }
                        if !results.is_empty() {
                            host.print(format!("{}\n", lines(&results)).as_bytes());
                        } else {
                            let file = text(&config.file);
                            let ext = file
                                .rsplit_once('.')
                                .map_or(String::new(), |(_, e)| e.to_ascii_lowercase());
                            host.warn(format!("No matches. Run 'officecli help {ext} query' for selector syntax.\n").as_bytes());
                        }
                    }
                    0
                }
                Err(f) => out.fail(&f),
            }
        }
        "get" => {
            let (mut book, doc) = match open_book(&host, &config).await {
                Ok(b) => b,
                Err(f) => return out.fail(&f),
            };
            let depth = config.depth.unwrap_or(1);
            if depth < 0 {
                return out.fail(&Fail::coded(
                    format!("Invalid --depth {depth}: must be >= 0."),
                    "invalid_value",
                ));
            }
            match fetch(&mut book, &doc, &path, (depth as usize).max(1)).await {
                Ok(mut node) => {
                    if depth == 0 {
                        node.children.clear();
                    }
                    if out.json {
                        out.data(matches(&[node]), None, true);
                    } else {
                        host.print(node.tree().as_bytes());
                    }
                    0
                }
                Err(f) => out.fail(&f),
            }
        }
        "set" | "remove" => {
            let Some(goal) = target(&path) else {
                return out.fail(&unsupported_path(&config.command, &path));
            };
            if config.command == "set" && config.props.is_empty() {
                return out.fail(&Fail::of(format!(
                    "No properties to set at {path}. Pass at least one --prop key=value."
                )));
            }
            let (mut book, doc) = match open_book(&host, &config).await {
                Ok(b) => b,
                Err(f) => return out.fail(&f),
            };
            let done = if config.command == "set" {
                let pairs = config
                    .props
                    .iter()
                    .map(|p| {
                        p.split_once('=')
                            .map_or((p.trim().to_string(), String::new()), |(k, v)| {
                                (k.trim().to_string(), v.to_string())
                            })
                    })
                    .collect::<Vec<_>>();
                set(&mut book, &doc, &goal, &path, &pairs).await
            } else {
                remove(&mut book, &doc, &goal, &path)
                    .await
                    .map_err(SetFail::Fail)
            };
            let line = match done {
                Ok(line) => line,
                Err(SetFail::Fail(f)) => return out.fail(&f),
                Err(SetFail::Unsupported {
                    keys,
                    element,
                    valid,
                }) => return out.unsupported(&path, &keys, element, valid),
            };
            if book.changed() {
                if let Some(reply) = book.save(&host, &config.absolute).await {
                    return out.fail(&Fail::of(text(&failure_text(&reply))));
                }
            }
            out.done(&line)
        }
        "batch" => run_batch(&out, &config).await,
        other => out.fail(&Fail::of(format!("Unknown command: {other}"))),
    }
}

async fn create(out: &Out<'_>, config: &Config) -> i32 {
    let file = text(&config.file);
    if !file.to_ascii_lowercase().ends_with(".xlsx") {
        let ext = file
            .rsplit_once('.')
            .map_or(String::new(), |(_, e)| format!(".{e}"));
        return out.fail(&Fail::of(format!("Unsupported file type: {ext}")));
    }
    if !config.force && out.host.stat(&config.absolute).await.is_some() {
        let mut fail = Fail::coded(
            format!("File already exists: {file}. Use --force to overwrite."),
            "file_exists",
        );
        fail.hint = Some(("Add --force flag or remove the file first.", None));
        return out.fail(&fail);
    }
    if let Some(reply) = write_out(out.host, &config.absolute, vec![Piece::Made(blank())]).await {
        return out.fail(&Fail::of(text(&failure_text(&reply))));
    }
    out.done(&format!(
        "Created: {}",
        if out.json {
            text(&config.absolute)
        } else {
            file
        }
    ))
}

/// A workbook of one empty sheet, Sheet1, set to calculate when opened.
fn blank() -> Vec<u8> {
    const MAIN: &str = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
    const REL: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
    const PKG: &str = "http://schemas.openxmlformats.org/package/2006/relationships";
    let head = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n";
    package(&[
        ("[Content_Types].xml", format!("{head}<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/><Override PartName=\"/xl/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml\"/></Types>").into_bytes()),
        ("_rels/.rels", format!("{head}<Relationships xmlns=\"{PKG}\"><Relationship Id=\"rId1\" Type=\"{REL}/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>").into_bytes()),
        ("xl/workbook.xml", format!("{head}<workbook xmlns=\"{MAIN}\" xmlns:r=\"{REL}\"><sheets><sheet name=\"Sheet1\" sheetId=\"1\" r:id=\"rId1\"/></sheets><calcPr fullCalcOnLoad=\"1\"/></workbook>").into_bytes()),
        ("xl/_rels/workbook.xml.rels", format!("{head}<Relationships xmlns=\"{PKG}\"><Relationship Id=\"rId1\" Type=\"{REL}/worksheet\" Target=\"worksheets/sheet1.xml\"/><Relationship Id=\"rId2\" Type=\"{REL}/styles\" Target=\"styles.xml\"/></Relationships>").into_bytes()),
        ("xl/worksheets/sheet1.xml", format!("{head}<worksheet xmlns=\"{MAIN}\" xmlns:r=\"{REL}\"><sheetData/></worksheet>").into_bytes()),
        ("xl/styles.xml", format!("{head}<styleSheet xmlns=\"{MAIN}\"><fonts count=\"1\"><font><sz val=\"11\"/><name val=\"Calibri\"/></font></fonts><fills count=\"2\"><fill><patternFill patternType=\"none\"/></fill><fill><patternFill patternType=\"gray125\"/></fill></fills><borders count=\"1\"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\"/></cellStyleXfs><cellXfs count=\"1\"><xf numFmtId=\"0\" fontId=\"0\" fillId=\"0\" borderId=\"0\" xfId=\"0\"/></cellXfs><cellStyles count=\"1\"><cellStyle name=\"Normal\" xfId=\"0\" builtinId=\"0\"/></cellStyles></styleSheet>").into_bytes()),
    ])
}

/// The sheet a typed name stands for: by name without case, or
/// `sheet[N]` / `sheet[last()]` by position.
fn resolve_sheet<'d>(
    doc: &'d Doc,
    name: &str,
    cell: Option<(u32, u32)>,
) -> Result<(usize, &'d read::Entry), Fail> {
    let lower = name.to_ascii_lowercase();
    if let Some(n) = lower
        .strip_prefix("sheet[")
        .and_then(|t| t.strip_suffix(']'))
    {
        let index = if n == "last()" {
            doc.sheets.len()
        } else {
            n.parse().unwrap_or(0)
        };
        if let Some(entry) = index.checked_sub(1).and_then(|i| doc.sheets.get(i)) {
            return Ok((index - 1, entry));
        }
    }
    doc.sheet(name)
        .ok_or_else(|| Fail::of(doc.missing(name, cell)))
}

/// The node a path names, children `depth` levels down.
async fn fetch(book: &mut Book<'_>, doc: &Doc, path: &str, depth: usize) -> Result<Node, Fail> {
    let Some(goal) = target(path) else {
        let tail = path
            .trim_start_matches('/')
            .split_once('/')
            .map_or(path, |(_, t)| t);
        if !tail.is_empty() && tail.bytes().all(|b| b.is_ascii_digit()) {
            return Err(Fail::of(format!(
                "Invalid cell reference: '{tail}'. Expected format like 'A1', 'B2'."
            )));
        }
        if tail
            .split_once('/')
            .is_some_and(|(head, _)| cell_ref(head).is_some())
        {
            return Err(Fail::of(format!(
                "Invalid cell reference: '{tail}'. Expected format like 'A1', 'B2', 'XFD1048576'."
            )));
        }
        return Err(Fail::of(format!("Element not found: {tail}")));
    };
    if goal == Target::Workbook {
        return Ok(doc.workbook_node(book, depth).await);
    }
    let typed = goal.sheet().unwrap_or_default().to_string();
    let (index, entry) = resolve_sheet(doc, &typed, goal.cell())?;
    let shown = if typed.to_ascii_lowercase().starts_with("sheet[") {
        entry.name.clone()
    } else {
        typed.clone()
    };
    let grid = Grid::load(book, &entry.part).await;
    Ok(match goal {
        Target::Workbook => unreachable!("the workbook is answered above"),
        Target::Sheet(_) => doc.sheet_node(&grid, index, &format!("/{shown}"), depth),
        Target::Cell(_, (r, c)) => match grid.find(r, c) {
            Some(cell) => doc.cell_node(&grid, &shown, cell, depth),
            None => doc.empty_cell(&grid, &shown, r, c),
        },
        Target::Range(_, a, b) => doc.range_node(&grid, &shown, a, b),
        Target::Row(_, at) => {
            let index = at.unwrap_or_else(|| grid.rows.iter().map(|r| r.r).max().unwrap_or(0));
            if at.is_none() && index == 0 {
                let mut node = Node::new(format!("/{shown}/row[last()]"), "row");
                node.text = Some("(empty)".to_string());
                return Ok(node);
            }
            doc.row_node(
                &grid,
                &shown,
                &format!("/{shown}/row[{index}]"),
                index,
                depth,
            )
        }
        Target::Comment(_, n) => {
            let list = sheet_comments(book, &entry.part).await;
            if list.is_empty() {
                return Err(Fail::of(format!(
                    "comment[{n}] not found (sheet has no comments)"
                )));
            }
            let comment = n
                .checked_sub(1)
                .and_then(|i| list.get(i))
                .ok_or_else(|| Fail::of(format!("comment[{n}] not found")))?;
            comment_node(&shown, comment, n)
        }
        Target::Run(_, (r, c), n) => {
            let at = format!("{}{r}", col_name(c));
            let cell = grid
                .find(r, c)
                .ok_or_else(|| Fail::of(format!("Cell {at} not found")))?;
            let Some(count) = doc.runs_of(cell) else {
                return Err(Fail::of(format!("Cell {at} is not a rich text cell")));
            };
            let node = doc.cell_node(&grid, &shown, cell, 1);
            node.children
                .into_iter()
                .nth(n.wrapping_sub(1))
                .ok_or_else(|| Fail::of(format!("Run index {n} out of range (1-{count})")))?
        }
    })
}

async fn sheet_comments(book: &mut Book<'_>, part: &str) -> Vec<read::Comment> {
    match related(book, part, "/comments").await {
        Some(p) => comments(&book.part(&p).await.unwrap_or_default()),
        None => Vec::new(),
    }
}

/// Every sheet read for a query.
async fn scope<'d>(book: &mut Book<'_>, doc: &'d Doc) -> Scope<'d> {
    let mut grids = Vec::new();
    let mut notes = Vec::new();
    let mut tables = Vec::new();
    for entry in &doc.sheets {
        grids.push(Grid::load(book, &entry.part).await);
        notes.push(sheet_comments(book, &entry.part).await);
        tables.push(read::tables(book, &entry.part).await);
    }
    Scope {
        doc,
        grids,
        comments: notes,
        tables,
        notes: Default::default(),
    }
}

/// A query's matches, narrowed by `--find`.
fn search(
    scope: &Scope<'_>,
    selector: &str,
    find: Option<&str>,
) -> Result<(Vec<Node>, Vec<query::Warning>), Fail> {
    let (mut results, warnings) = scope.filter(selector)?;
    if let Some(f) = find.filter(|f| !f.is_empty()) {
        let mut kept = Vec::new();
        for n in results {
            if let Some(t) = &n.text {
                if query::text_matches(t, f)? {
                    kept.push(n);
                }
            }
        }
        results = kept;
    }
    Ok((results, warnings))
}

/// Each match that counts children it does not list given them, as the
/// JSON form lists them.
fn hydrate(doc: &Doc, scope: &Scope<'_>, results: &mut [Node]) {
    for n in results
        .iter_mut()
        .filter(|n| n.child_count > 0 && n.children.is_empty())
    {
        let Some(goal) = target(&n.path) else {
            continue;
        };
        let Some((index, _)) = goal.sheet().and_then(|s| doc.sheet(s)) else {
            continue;
        };
        let grid = &scope.grids[index];
        let name = goal.sheet().unwrap_or_default().to_string();
        n.children = match goal {
            Target::Sheet(_) => doc.listing(grid, &name, 1),
            Target::Row(_, Some(r)) => doc.row_node(grid, &name, &n.path, r, 1).children,
            _ => continue,
        };
    }
}

/// A number as the text officecli stores, or None when `value` is not one.
fn number(value: &str) -> Option<String> {
    let v = value.trim();
    let ok = !v.is_empty()
        && v.bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'-' | b'+' | b'.' | b'e' | b'E'));
    let n: f64 = v.parse().ok().filter(|n: &f64| ok && n.is_finite())?;
    Some(if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    })
}

async fn styles_of(book: &mut Book<'_>, wb_part: &str) -> Option<(String, Styles)> {
    let part = related(book, wb_part, "/styles").await?;
    let xml = book.part(&part).await?;
    Some((part, Styles::new(xml)))
}

const CELL_PROPS: &[&str] = &["value", "formula", "type"];
const SHEET_PROPS: &[&str] = &["hidden"];

/// The line officecli prints once the change is saved, or why nothing
/// changed.
async fn set(
    book: &mut Book<'_>,
    doc: &Doc,
    goal: &Target,
    path: &str,
    pairs: &[(String, String)],
) -> Result<String, SetFail> {
    let (valid, element) = match goal {
        Target::Cell(..) => (CELL_PROPS, "cell"),
        Target::Sheet(_) => (SHEET_PROPS, "sheet"),
        _ => return Err(Fail::of(format!("Unsupported path: {path}")).into()),
    };
    let keys: Vec<String> = pairs
        .iter()
        .map(|(k, _)| k.clone())
        .filter(|k| !valid.contains(&k.to_ascii_lowercase().as_str()))
        .collect();
    if !keys.is_empty() {
        return Err(SetFail::Unsupported {
            keys,
            element,
            valid,
        });
    }
    let get = |key: &str| {
        pairs
            .iter()
            .rev()
            .find(|(k, _)| k.eq_ignore_ascii_case(key))
            .map(|(_, v)| v.clone())
    };
    let shown: Vec<String> = pairs.iter().map(|(k, v)| format!("{k}={v}")).collect();
    match goal {
        Target::Sheet(name) => {
            let (_, entry) = resolve_sheet(doc, name, None)?;
            let hide = matches!(
                get("hidden")
                    .unwrap_or_default()
                    .to_ascii_lowercase()
                    .as_str(),
                "true" | "1" | "yes"
            );
            if hide
                && !doc
                    .sheets
                    .iter()
                    .any(|s| s.name != entry.name && !s.hidden())
            {
                return Err(Fail::of(format!("Cannot hide sheet '{}': a workbook must keep at least one visible sheet, or Excel refuses to open the file. Unhide another sheet first.", entry.name)).into());
            }
            let Some(xml) = book.part(&doc.wb_part).await else {
                return Err(Fail::of("workbook part missing".to_string()).into());
            };
            let mut out = Vec::with_capacity(xml.len());
            let mut last = 0;
            for tag in tags(&xml) {
                if tag.kind != Kind::End
                    && tag.is("sheet")
                    && tag.attr("name").as_deref() == Some(entry.name.as_str())
                {
                    out.extend_from_slice(&xml[last..tag.start]);
                    out.extend(retag(
                        &tag,
                        &[("state", hide.then_some("hidden"))],
                        tag.kind,
                    ));
                    last = tag.end;
                }
            }
            out.extend_from_slice(&xml[last..]);
            book.put(&doc.wb_part, out);
            Ok(format!("Updated {path}: {}", shown.join(", ")))
        }
        Target::Cell(name, (row, col)) => {
            let (_, entry) = resolve_sheet(doc, name, Some((*row, *col)))?;
            let kind = get("type").map(|t| t.to_ascii_lowercase());
            let val = match (get("formula"), get("value")) {
                (Some(f), _) => Val::Formula(f.trim_start_matches('=').to_string()),
                (None, Some(v)) if v.is_empty() => Val::Clear,
                (None, Some(v)) => match kind.as_deref() {
                    Some("string") => Val::Str(v),
                    Some("number") => match number(&v) {
                        Some(n) => Val::Num(n),
                        None => {
                            return Err(Fail::of(format!("Invalid number for {path}: {v}")).into());
                        }
                    },
                    _ => number(&v)
                        .map(Val::Num)
                        .or_else(|| date_serial(&v).map(Val::Date))
                        .unwrap_or(Val::Str(v)),
                },
                (None, None) => {
                    return Err(Fail::of(format!(
                        "No properties to set at {path}. Pass at least one --prop key=value."
                    ))
                    .into());
                }
            };
            let mut styles = match val {
                Val::Date(_) => styles_of(book, &doc.wb_part).await.map(|(_, s)| s),
                _ => None,
            };
            let Some(xml) = book.part(&entry.part).await else {
                return Err(Fail::of("worksheet part missing".to_string()).into());
            };
            let mut edits = Edits::new();
            edits.entry(*row).or_default().insert(*col, val);
            let rewritten = match sheet::rewrite(&xml, edits, &mut styles) {
                Ok(r) => r,
                Err(Refused::Shared(cell)) => return Err(Fail::of(format!("{cell} is the master of a shared formula that other cells use, which officecli here does not rewrite")).into()),
                Err(Refused::NoSheetData) => return Err(Fail::of("worksheet has no sheetData".to_string()).into()),
            };
            book.put(&entry.part, rewritten.xml);
            if let Some(st) = styles.filter(|s| s.dirty) {
                if let Some((part, _)) = styles_of(book, &doc.wb_part).await {
                    book.put(&part, st.xml);
                }
            }
            if rewritten.formula_replaced {
                drop_calc_chain(book, &doc.wb_part).await;
            }
            let applied = match kind.as_deref() {
                Some("string") => " (applied: type=String)",
                Some("number") => " (applied: type=Number)",
                _ => "",
            };
            Ok(format!("Updated {path}: {}{applied}", shown.join(", ")))
        }
        _ => Err(Fail::of(format!("Unsupported path: {path}")).into()),
    }
}

/// The calculation chain dropped, as a formula it lists was overwritten;
/// Excel rebuilds it on open.
async fn drop_calc_chain(book: &mut Book<'_>, wb_part: &str) {
    let Some(chain) = related(book, wb_part, "/calcChain").await else {
        return;
    };
    let rels = rels_of(wb_part);
    if let Some(xml) = book.part(&rels).await {
        let id = relationships(&xml, wb_part)
            .into_iter()
            .find(|(_, k, _)| k.ends_with("/calcChain"))
            .map(|(id, _, _)| id);
        if let Some(id) = id {
            book.put(
                &rels,
                strip(&xml, "Relationship", |t| {
                    t.attr("Id").as_deref() == Some(id.as_str())
                }),
            );
        }
    }
    if let Some(types) = book.part("[Content_Types].xml").await {
        let name = format!("/{chain}");
        book.put(
            "[Content_Types].xml",
            strip(&types, "Override", |t| {
                t.attr("PartName")
                    .is_some_and(|p| p.eq_ignore_ascii_case(&name))
            }),
        );
    }
    book.drop_part(&chain);
}

fn strip(xml: &[u8], name: &str, hit: impl Fn(&xml::Tag<'_>) -> bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(xml.len());
    let mut last = 0;
    let mut skip = 0;
    for tag in tags(xml) {
        if tag.start < skip || tag.kind == Kind::End || !tag.is(name) || !hit(&tag) {
            continue;
        }
        let end = xml::element_end(xml, &tag).unwrap_or(tag.end);
        out.extend_from_slice(&xml[last..tag.start]);
        (last, skip) = (end, end);
    }
    out.extend_from_slice(&xml[last..]);
    out
}

async fn remove(book: &mut Book<'_>, doc: &Doc, goal: &Target, path: &str) -> Result<String, Fail> {
    let Target::Comment(name, index) = goal else {
        return Err(Fail::of(format!("Unsupported path: {path}")));
    };
    let (_, entry) = resolve_sheet(doc, name, None)?;
    let part = related(book, &entry.part, "/comments").await;
    let xml = match &part {
        Some(p) => book.part(p).await.unwrap_or_default(),
        None => Vec::new(),
    };
    let all = notes(&xml);
    if all.is_empty() {
        return Err(Fail::of("No comments found in sheet".to_string()));
    }
    let note = index
        .checked_sub(1)
        .and_then(|i| all.get(i))
        .ok_or_else(|| {
            Fail::of(format!(
                "Comment index {index} out of range (1..{})",
                all.len()
            ))
        })?;
    let cell = note.cell.clone();
    let rest = [&xml[..note.span.0], &xml[note.span.1..]].concat();
    if let Some(p) = &part {
        book.put(p, rest);
    }
    if let (Some(vml), Some(at)) = (
        related(book, &entry.part, "/vmlDrawing").await,
        cell_ref(&cell),
    ) {
        if let Some(data) = book.part(&vml).await {
            let trimmed = without_shape(&data, at);
            if trimmed != data {
                book.put(&vml, trimmed);
            }
        }
    }
    if let Some(threaded) = related(book, &entry.part, "/threadedComment").await {
        if let Some(data) = book.part(&threaded).await {
            let trimmed = without_refs(&data, "threadedComment", &cell);
            if trimmed != data {
                book.put(&threaded, trimmed);
            }
        }
    }
    Ok(format!("Removed {path}"))
}

/// What a batch item answered: a line of text, or nodes when `--json`.
enum Output {
    Text(String),
    Data(Json),
}

struct Outcome {
    index: usize,
    result: Result<Output, (String, Option<&'static str>)>,
    warnings: Vec<String>,
}

const VERBS: [&str; 14] = [
    "meta", "get", "query", "set", "add", "import", "remove", "move", "swap", "view", "raw",
    "raw-set", "add-part", "validate",
];

/// One batch item against the open workbook.
async fn run_item(
    book: &mut Book<'_>,
    item: &Item,
    json: bool,
    notes: &mut Vec<String>,
) -> Result<Output, (String, Option<&'static str>)> {
    let fail = |f: Fail| (f.message, f.code);
    let verb = item.command.to_ascii_lowercase();
    let Some(doc) = Doc::load(book).await else {
        return Err(("Not a workbook officecli reads".to_string(), None));
    };
    match verb.as_str() {
        "meta" => Ok(Output::Text("meta".to_string())),
        "get" => {
            let path = item.path.clone().unwrap_or_else(|| "/".to_string());
            let depth = item.depth.unwrap_or(1).max(0) as usize;
            let node = fetch(book, &doc, &path, depth).await.map_err(fail)?;
            Ok(if json {
                Output::Data(matches(&[node]))
            } else {
                Output::Text(node.tree())
            })
        }
        "query" => {
            let selector = item
                .selector
                .clone()
                .or_else(|| item.path.clone())
                .unwrap_or_default();
            if selector.is_empty() {
                return Err(("'query' command requires 'selector' field. Example: {\"command\": \"query\", \"selector\": \"row[Score>80]\"}".to_string(), None));
            }
            let scope = scope(book, &doc).await;
            let (results, warnings) =
                search(&scope, &selector, item.text.as_deref()).map_err(fail)?;
            notes.extend(scope.notes.borrow().iter().cloned());
            notes.extend(warnings.into_iter().map(|w| w.message));
            Ok(if json {
                Output::Data(matches(&results))
            } else {
                Output::Text(lines(&results))
            })
        }
        "set" => {
            let Some(path) = item.path.clone().filter(|p| !p.is_empty()) else {
                return Err(("'set' command requires 'path' field. Example: {\"command\": \"set\", \"path\": \"/slide[1]\", \"props\": {\"bold\": \"true\"}}".to_string(), None));
            };
            let pairs = item.props.clone().unwrap_or_default();
            if pairs.is_empty() {
                return Err(("'set' command requires 'props' field with at least one key=value. Got empty/missing props.".to_string(), None));
            }
            let Some(goal) = target(&path) else {
                return Err((format!("Unsupported path: {path}"), None));
            };
            match set(book, &doc, &goal, &path, &pairs).await {
                Ok(line) => Ok(Output::Text(
                    line.replace(" (applied: type=String)", "")
                        .replace(" (applied: type=Number)", ""),
                )),
                Err(SetFail::Fail(f)) => Err(fail(f)),
                Err(SetFail::Unsupported {
                    keys,
                    element,
                    valid,
                }) => Err((unsupported_text(&keys, element, valid), None)),
            }
        }
        "remove" => {
            let Some(path) = item.path.clone().filter(|p| !p.is_empty()) else {
                return Err(("'remove' command requires 'path' field. Example: {\"command\": \"remove\", \"path\": \"/slide[1]/shape[2]\"}".to_string(), None));
            };
            let Some(goal) = target(&path) else {
                return Err(fail(unsupported_path("remove", &path)));
            };
            remove(book, &doc, &goal, &path)
                .await
                .map(Output::Text)
                .map_err(fail)
        }
        v if VERBS.contains(&v) => Err((
            format!(
                "Command '{}' is not supported here. Supported commands: meta, get, query, set, remove.",
                item.command
            ),
            None,
        )),
        _ => Err((
            format!(
                "Unknown command: '{}'. Valid commands: {}. Run `help batch` for the JSON item schema.",
                item.command,
                VERBS.join(", ")
            ),
            None,
        )),
    }
}

/// The batch's JSON as `--commands` gives it, or `--input` names, or
/// stdin holds.
async fn batch_source(host: &Host, config: &Config) -> Result<String, Fail> {
    if config.commands.is_some() && config.input.is_some() {
        return Err(Fail::of(
            "batch: --commands and --input are mutually exclusive. Pick one source.".to_string(),
        ));
    }
    if let Some(c) = &config.commands {
        return Ok(c.clone());
    }
    let (name, opening) = match &config.input {
        Some(name) if name.as_slice() != b"-" => (name.clone(), Opening::Operand(2)),
        _ => (b"-".to_vec(), Opening::Name),
    };
    let mut data = Vec::new();
    let mut open = Some((name, opening));
    loop {
        let (reply, mut chunk) = host
            .ask(Request::Read {
                fd: 9,
                open: open.take(),
                least: u64::MAX,
            })
            .await;
        if failed(&reply) {
            if reply.names(&["ENOENT", "ENOTDIR"]) {
                let shown = config
                    .input_absolute
                    .clone()
                    .or_else(|| config.input.clone())
                    .unwrap_or_default();
                return Err(Fail::of(format!("Input file not found: {}", text(&shown))));
            }
            return Err(Fail::of(text(&failure_text(&reply))));
        }
        data.append(&mut chunk);
        if reply.end {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&data).into_owned())
}

/// The warnings a batch item raises before it runs.
fn item_warnings(item: &Item) -> Vec<String> {
    let mut warnings = Vec::new();
    let verb = item.command.to_ascii_lowercase();
    if matches!(verb.as_str(), "get" | "query" | "view") {
        if let Some(props) = item.props.as_ref().filter(|p| !p.is_empty()) {
            let keys = props
                .iter()
                .map(|(k, _)| format!("\"{k}\""))
                .collect::<Vec<_>>()
                .join(", ");
            let hint = match verb.as_str() {
                "query" => {
                    "Put the output options on the item itself: \"compact\": true, \"fields\": \"x,y\"."
                }
                "view" => {
                    "A bounded view (start/end/max-lines/cols/range) is not available inside a batch yet — run `view` as its own command."
                }
                _ => "A get item takes \"path\" and \"depth\" only.",
            };
            warnings.push(format!(
                "'{}' ignores props ({keys}): a read item takes no props. {hint}",
                item.command
            ));
        }
    }
    let mut misplaced = Vec::new();
    if item.compact.is_some() {
        misplaced.push("\"compact\"");
    }
    if item.fields.is_some() {
        misplaced.push("\"fields\"");
    }
    if !misplaced.is_empty() && verb != "query" {
        warnings.push(format!(
            "'{}' does not read {}: they are query-item options. Ignored.",
            item.command,
            misplaced.join(" or ")
        ));
    }
    warnings
}

async fn run_batch(out: &Out<'_>, config: &Config) -> i32 {
    let host = out.host;
    let source = match batch_source(host, config).await {
        Ok(s) => s,
        Err(f) => return out.fail(&f),
    };
    let items: Vec<Item> = match batch::items(&source) {
        Ok(items) => items
            .into_iter()
            .filter(|i| !i.command.eq_ignore_ascii_case("meta"))
            .collect(),
        Err(message) => return out.fail(&Fail::of(message)),
    };
    if items.is_empty() {
        if host.stat(&config.absolute).await.is_none() {
            return out.fail(&Fail::missing(&config.absolute));
        }
        print_batch(out, &items, &[], false, &[]);
        return 0;
    }
    let (mut book, _) = match open_book(host, config).await {
        Ok(b) => b,
        Err(f) => return out.fail(&f),
    };
    let atomic = !config.best_effort
        && items.iter().any(|i| {
            !matches!(
                i.command.to_ascii_lowercase().as_str(),
                "get" | "query" | "view" | "validate" | "meta"
            )
        });
    let mut outcomes = Vec::new();
    let mut stderr = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let warnings = item_warnings(item);
        let mark = book.mark();
        let mut notes = Vec::new();
        let result = run_item(&mut book, item, config.json, &mut notes).await;
        if result.is_err() {
            book.restore(mark);
        }
        if config.json {
            stderr.extend(notes);
        } else {
            for n in &notes {
                host.warn(format!("{n}\n").as_bytes());
            }
        }
        let stop = result.is_err() && config.stop_on_error;
        outcomes.push(Outcome {
            index,
            result,
            warnings,
        });
        if stop {
            break;
        }
    }
    let any_failed = outcomes.iter().any(|o| o.result.is_err());
    let rolled_back = atomic && any_failed;
    if !rolled_back && book.changed() {
        if let Some(reply) = book.save(host, &config.absolute).await {
            return out.fail(&Fail::of(text(&failure_text(&reply))));
        }
    }
    print_batch(out, &items, &outcomes, rolled_back, &stderr);
    i32::from(any_failed)
}

/// What a batch run printed to stderr, as `--json` carries it.
fn stderr_warnings(lines: &[String]) -> Option<Json> {
    let list: Vec<Json> = lines
        .iter()
        .map(|l| {
            let code = if l.contains("UNSUPPORTED") {
                "unsupported_property"
            } else {
                "warning"
            };
            Json::obj(vec![
                ("message", Json::Str(l.trim().to_string())),
                ("code", Json::Str(code.to_string())),
            ])
        })
        .collect();
    (!list.is_empty()).then_some(Json::Arr(list))
}

fn print_batch(
    out: &Out<'_>,
    items: &[Item],
    outcomes: &[Outcome],
    rolled_back: bool,
    stderr: &[String],
) {
    let succeeded = outcomes.iter().filter(|o| o.result.is_ok()).count();
    let failed = outcomes.len() - succeeded;
    if out.json {
        let results = outcomes
            .iter()
            .map(|o| {
                let mut fields = vec![
                    ("index", Json::Int(o.index as i64)),
                    ("success", Json::Bool(o.result.is_ok())),
                ];
                match &o.result {
                    Ok(Output::Text(t)) => fields.push(("output", Json::Str(t.clone()))),
                    Ok(Output::Data(d)) => fields.push(("output", d.clone())),
                    Err((message, code)) => {
                        fields.push(("error", Json::Str(message.clone())));
                        if let Some(c) = code {
                            fields.push(("code", Json::Str(c.to_string())));
                        }
                        fields.push(("item", items[o.index].echo()));
                    }
                }
                if !o.warnings.is_empty() {
                    let w = o
                        .warnings
                        .iter()
                        .map(|m| {
                            Json::obj(vec![
                                ("message", Json::Str(m.clone())),
                                ("code", Json::Str("unsupported_property".to_string())),
                            ])
                        })
                        .collect();
                    fields.push(("warnings", Json::Arr(w)));
                }
                Json::obj(fields)
            })
            .collect();
        let mut summary = vec![
            ("total", Json::Int(items.len() as i64)),
            ("executed", Json::Int(outcomes.len() as i64)),
            ("succeeded", Json::Int(succeeded as i64)),
            ("failed", Json::Int(failed as i64)),
            ("skipped", Json::Int((items.len() - outcomes.len()) as i64)),
        ];
        if rolled_back {
            summary.push(("atomicRolledBack", Json::Bool(true)));
        }
        out.data(
            Json::obj(vec![
                ("results", Json::Arr(results)),
                ("summary", Json::obj(summary)),
            ]),
            stderr_warnings(stderr),
            failed == 0,
        );
        return;
    }
    let mut text = String::new();
    for (i, o) in outcomes.iter().enumerate() {
        match &o.result {
            Ok(Output::Text(t)) if !t.is_empty() => text.push_str(&format!("[{}] {t}\n", i + 1)),
            Ok(_) => text.push_str(&format!("[{}] OK\n", i + 1)),
            Err((message, _)) => text.push_str(&format!("[{}] ERROR: {message}\n", i + 1)),
        }
        for w in &o.warnings {
            text.push_str(&format!("  WARNING: {w}\n"));
        }
    }
    let note = if rolled_back {
        " (atomic: no changes were applied)"
    } else {
        ""
    };
    text.push_str(&format!(
        "\nBatch complete: {succeeded} succeeded, {failed} failed, {} total{note}\n",
        outcomes.len()
    ));
    out.host.print(text.as_bytes());
}
