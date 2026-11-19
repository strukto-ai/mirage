mod doc;
mod inflate;
mod info;
mod text;

use serde::Deserialize;

use self::doc::{Doc, Measured, Refused};
use self::text::Mode;
use crate::jq::time::Zone;
use crate::request::{Opening, Request, failed, failure_text};
use crate::task::{File, Host};
use crate::{Stream, StreamError, parse_config, task};

/// The exit status of a refused option.
const USAGE: i32 = 99;
/// How much of the document each read gathers before the workspace is asked
/// whether what is held so far still fits.
const READ_WINDOW: u64 = 1 << 20;

#[derive(Deserialize)]
struct TextConfig {
    /// The PDF operand as typed, `-` for standard input.
    #[serde(deserialize_with = "crate::latin1")]
    file: Vec<u8>,
    /// The text file operand as typed, `-` for standard output.
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    output: Option<Vec<u8>>,
    #[serde(default)]
    first: Option<i64>,
    #[serde(default)]
    last: Option<i64>,
    #[serde(default)]
    layout: bool,
    #[serde(default)]
    raw: bool,
    #[serde(default)]
    nopgbrk: bool,
    #[serde(default)]
    nodiag: bool,
    #[serde(default)]
    enc: Option<String>,
    #[serde(default)]
    eol: Option<String>,
    #[serde(default)]
    quiet: bool,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    owner_password: Option<Vec<u8>>,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    user_password: Option<Vec<u8>>,
}

#[derive(Deserialize)]
struct InfoConfig {
    #[serde(deserialize_with = "crate::latin1")]
    file: Vec<u8>,
    #[serde(default)]
    first: Option<i64>,
    #[serde(default)]
    last: Option<i64>,
    /// The session's `TZ`, which dates print in.
    #[serde(default)]
    zone: Option<String>,
    #[serde(default)]
    quiet: bool,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    owner_password: Option<Vec<u8>>,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    user_password: Option<Vec<u8>>,
}

pub fn open_text(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: TextConfig = parse_config(config)?;
    Ok(task::spawn(|host| pdftotext(host, config)))
}

pub fn open_info(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: InfoConfig = parse_config(config)?;
    Ok(task::spawn(|host| pdfinfo(host, config)))
}

fn shown(name: &[u8]) -> String {
    String::from_utf8_lossy(name).into_owned()
}

/// Where messages go: standard error, unless `-q` silenced them.
struct Say<'h> {
    host: &'h Host,
    quiet: bool,
}

impl Say<'_> {
    fn line(&self, text: &str) {
        if !self.quiet {
            self.host.warn(format!("{text}\n").as_bytes());
        }
    }
}

/// The document's bytes, read whole, or the status its refusal exits
/// with once worded.
async fn read(host: &Host, say: &Say<'_>, name: &[u8]) -> Result<Vec<u8>, i32> {
    let opening = if name == b"-" {
        Opening::Name
    } else {
        Opening::Operand(1)
    };
    let mut open = Some((name.to_vec(), opening));
    let mut data = Vec::new();
    loop {
        let (reply, mut chunk) = host
            .ask(Request::Read {
                fd: 0,
                open: open.take(),
                least: READ_WINDOW,
            })
            .await;
        if failed(&reply) {
            if reply.names(&["EISDIR"]) {
                damaged(say, true);
                return Err(1);
            }
            say.line(&format!(
                "I/O Error: Couldn't open file '{}': {}.",
                shown(name),
                shown(&failure_text(&reply))
            ));
            return Err(1);
        }
        if data.is_empty() {
            data = chunk;
        } else {
            data.append(&mut chunk);
        }
        let size = data.len() as u64;
        host.ask(Request::Memory { size }).await;
        if reply.end {
            return Ok(data);
        }
    }
}

/// The reader's account of bytes that hold no document it can parse.
fn damaged(say: &Say<'_>, headless: bool) {
    if headless {
        say.line("Syntax Warning: May not be a PDF file (continuing anyway)");
    }
    say.line("Syntax Error: Couldn't find trailer dictionary");
    say.line("Syntax Error: Couldn't find trailer dictionary");
    say.line("Syntax Error: Couldn't read xref table");
}

/// The document opened, or the status its refusal exits with once worded.
fn parse(
    say: &Say<'_>,
    bytes: Vec<u8>,
    owner: Option<&[u8]>,
    user: Option<&[u8]>,
) -> Result<Doc, i32> {
    if bytes.is_empty() {
        say.line("Syntax Error: Document stream is empty");
        return Err(1);
    }
    let head = &bytes[..bytes.len().min(1024)];
    let headless = !head.windows(5).any(|w| w == b"%PDF-");
    let passwords: Vec<&[u8]> = owner.into_iter().chain(user).collect();
    match Doc::open(bytes, &passwords) {
        Ok(doc) => {
            if headless {
                say.line("Syntax Warning: May not be a PDF file (continuing anyway)");
            }
            Ok(doc)
        }
        Err(Refused::Password) => {
            say.line("Command Line Error: Incorrect password");
            Err(1)
        }
        Err(Refused::Damaged) => {
            damaged(say, headless);
            Err(1)
        }
    }
}

/// The pages a range names, `first` and `last` as given: a first below
/// one reads as one, a last below one or past the end as the last page.
fn range(
    say: &Say<'_>,
    pages: usize,
    first: Option<i64>,
    last: Option<i64>,
) -> Result<(usize, usize), i32> {
    let first = first.unwrap_or(1).max(1);
    let last = match last {
        Some(l) if l >= 1 && (l as u64) <= pages as u64 => l,
        _ => pages as i64,
    };
    if first > last {
        say.line(&format!(
            "Command Line Error: Wrong page range given: the first page ({first}) can not be after the last page ({last})."
        ));
        return Err(USAGE);
    }
    Ok((first as usize, last as usize))
}

/// The text file a document's text goes to when none is named: its name
/// with `.pdf` in any case swapped for `.txt`, else `.txt` added.
fn text_name(file: &[u8]) -> Vec<u8> {
    let stem = if file.len() >= 4 && file[file.len() - 4..].eq_ignore_ascii_case(b".pdf") {
        &file[..file.len() - 4]
    } else {
        file
    };
    let mut name = stem.to_vec();
    name.extend_from_slice(b".txt");
    name
}

async fn pdftotext(host: Host, config: TextConfig) -> i32 {
    let say = Say {
        host: &host,
        quiet: config.quiet,
    };
    if let Some(enc) = &config.enc {
        if enc != "UTF-8" {
            say.line(&format!(
                "Syntax Error: Couldn't find unicodeMap file for the '{enc}' encoding"
            ));
            say.line("Command Line Error: Couldn't get text encoding");
            return USAGE;
        }
    }
    let eol = match config.eol.as_deref() {
        None | Some("unix") => "\n",
        Some("dos") => "\r\n",
        Some("mac") => "\r",
        Some(_) => {
            say.line("Bad '-eol' value on command line");
            "\n"
        }
    };
    let bytes = match read(&host, &say, &config.file).await {
        Ok(bytes) => bytes,
        Err(status) => return status,
    };
    let doc = match parse(
        &say,
        bytes,
        config.owner_password.as_deref(),
        config.user_password.as_deref(),
    ) {
        Ok(doc) => doc,
        Err(status) => return status,
    };
    let output = match &config.output {
        Some(name) => name.clone(),
        None if config.file == b"-" => {
            say.line(
                "Command Line Error: You have to provide an output filename when reading from stdin.",
            );
            return USAGE;
        }
        None => text_name(&config.file),
    };
    let (first, last) = match range(&say, doc.pages, config.first, config.last) {
        Ok(pages) => pages,
        Err(status) => return status,
    };
    let mode = if config.layout {
        Mode::Layout
    } else if config.raw {
        Mode::Raw
    } else {
        Mode::Reading
    };
    let mut file = (output != b"-").then(|| File::new(output.clone()));
    let mut measured = Measured::default();
    for page in first..=last {
        let content = doc.content(&host, page - 1, &mut measured).await;
        let glyphs = doc.glyphs(page - 1, mode == Mode::Raw, content);
        let mut out = text::page(&glyphs, mode, config.nodiag);
        if !config.nopgbrk {
            out.push('\x0c');
        }
        if eol != "\n" {
            out = out.replace('\n', eol);
        }
        match file.as_mut() {
            Some(file) => {
                if !file.take(&host, out.as_bytes()).await {
                    break;
                }
            }
            None => {
                host.print(out.as_bytes());
                host.pause().await;
            }
        }
    }
    if let Some(mut file) = file {
        file.close(&host).await;
        if file.failed.is_some() {
            say.line(&format!(
                "I/O Error: Couldn't open text file '{}'",
                shown(&output)
            ));
            return 2;
        }
    }
    0
}

async fn pdfinfo(host: Host, config: InfoConfig) -> i32 {
    let say = Say {
        host: &host,
        quiet: config.quiet,
    };
    let bytes = match read(&host, &say, &config.file).await {
        Ok(bytes) => bytes,
        Err(status) => return status,
    };
    let size = if config.file == b"-" {
        0
    } else {
        bytes.len() as u64
    };
    let head: Vec<u8> = bytes[..bytes.len().min(1 << 20)].to_vec();
    let tail_len = bytes.len();
    let doc = match parse(
        &say,
        bytes,
        config.owner_password.as_deref(),
        config.user_password.as_deref(),
    ) {
        Ok(doc) => doc,
        Err(status) => return status,
    };
    let listed = config.last.is_some_and(|l| l >= 1);
    let (first, last) = match range(&say, doc.pages, config.first, config.last) {
        Ok(pages) => pages,
        Err(status) => return status,
    };
    let pages = if listed {
        Some((first, last))
    } else if first == 1 {
        None
    } else {
        Some((1, 0))
    };
    let zone = Zone::parse(config.zone.as_deref().unwrap_or("UTC"));
    let (out, warnings) = info::render(&doc, &head, tail_len, size, pages, &zone);
    if !warnings.is_empty() && !config.quiet {
        host.warn(warnings.as_bytes());
    }
    host.print(out.as_bytes());
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_names_swap_the_pdf_extension() {
        assert_eq!(text_name(b"report.pdf"), b"report.txt");
        assert_eq!(text_name(b"UP.PDF"), b"UP.txt");
        assert_eq!(text_name(b"noext"), b"noext.txt");
        assert_eq!(text_name(b"dir/a.b.pdf"), b"dir/a.b.txt");
    }
}
