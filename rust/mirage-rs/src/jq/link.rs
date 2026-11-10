// Adapted from jq 1.8.2 (MIT), src/linker.c. See licenses/third_party/jq.txt.

//! jq's linker: the files a program's imports name. The stream walks the
//! imports as `process_dependencies` does, last first and depth first,
//! and asks the host for each file a search path could hold it at; a file
//! read twice by one program is one module. `finish` writes the modules
//! it found, a dependency before whatever imports it, for the run to
//! compile, or fails with jq's report of what it could not load. Reading
//! is the test of whether a file is there, so a file costs one request.

use std::collections::{HashMap, VecDeque};
use std::io::{self, Write};

use serde::{Deserialize, Serialize};
use serde_json::json;

use super::builtin::invalid_module_path;
use super::main::EXHAUSTED;
use super::parse::{Scanned, Scanner};
use super::syntax::{self, Def, Import, Parsed};
use super::value::Value;
use crate::{
    Stream, StreamError,
    constants::{MAX_LINKS, WORK},
    parse_config,
};

/// The search list of a jq run no `-L` gave one to.
pub(crate) const DEFAULT_SEARCH: [&str; 3] = ["~/.jq", "$ORIGIN/../lib/jq", "$ORIGIN/../lib"];

/// What `get_jq_origin` answers: this jq has no directory of its own.
const JQ_ORIGIN: &str = ".";

const MAIN_IN_LIBRARY: &str =
    "jq: error: jq: error: library should only have function definitions, not a main expression";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Kind {
    Code,
    Data,
    Raw,
}

/// One import that found its file: the name it binds, none for `include`,
/// and the module it names.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Dep {
    pub(crate) alias: Option<String>,
    pub(crate) module: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Module {
    pub(crate) path: String,
    pub(crate) text: String,
    pub(crate) kind: Kind,
    pub(crate) deps: Vec<Dep>,
}

/// What the linker found: every module, and the program's own imports.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Linked {
    pub(crate) modules: Vec<Module>,
    pub(crate) deps: Vec<Dep>,
}

/// A module as the compiler takes it.
pub(crate) enum Body {
    Code(Vec<Def>),
    Data(Value),
}

pub(crate) struct Unit<'a> {
    pub(crate) file: &'a str,
    pub(crate) source: &'a str,
    pub(crate) body: Body,
    pub(crate) deps: &'a [Dep],
}

/// Each module parsed for the compiler.
pub(crate) fn units(linked: &Linked) -> Result<Vec<Unit<'_>>, String> {
    linked
        .modules
        .iter()
        .map(|module| {
            let body = match module.kind {
                Kind::Code => Body::Code(
                    library(&module.text, &module.path)
                        .map_err(|errors| syntax::report(&errors))?
                        .0,
                ),
                Kind::Data => Body::Data(Value::array(documents(module.text.as_bytes())?)),
                Kind::Raw => Body::Data(Value::string(module.text.as_str())),
            };
            Ok(Unit {
                file: &module.path,
                source: &module.text,
                body,
                deps: &module.deps,
            })
        })
        .collect()
}

/// jq_parse_library: a file's definitions and imports, or what jq reports.
fn library(text: &str, path: &str) -> Result<(Vec<Def>, Vec<Import>), Vec<String>> {
    syntax::parse_library(text, path, MAIN_IN_LIBRARY)
}

/// Every JSON document in `bytes`, or the parse error that stopped them.
fn documents(bytes: &[u8]) -> Result<Vec<Value>, String> {
    let mut scanner = Scanner::values(false, false);
    let mut sink = Vec::new();
    let mut values = Vec::new();
    let (mut fed, mut finished) = (0, false);
    loop {
        match scanner.take() {
            Some(Scanned::Value(value)) => {
                values.push(value);
                continue;
            }
            Some(Scanned::Error(message)) => return Err(message),
            None => {}
        }
        let step = if scanner.busy() {
            scanner.drain(&mut sink)
        } else if fed < bytes.len() {
            let stop = (fed + WORK).min(bytes.len());
            let fed_now = scanner.feed(&bytes[fed..stop], &mut sink);
            fed = stop;
            fed_now
        } else if !finished {
            finished = true;
            scanner.finish(&mut sink)
        } else {
            return Ok(values);
        };
        step.map_err(|error| error.to_string())?;
        sink.clear();
    }
}

/// Each symlink in the namespace and what it points at.
pub(crate) type Links = HashMap<String, String>;

/// `path` made absolute against `cwd`, with no `.`, `..` or link left in
/// it, as jq_realpath leaves one that exists: a `..` after a link goes up
/// from where the link leads.
pub(crate) fn resolve(links: &Links, cwd: &str, path: &str) -> String {
    let whole = if path.starts_with('/') {
        path.to_owned()
    } else {
        format!("{cwd}/{path}")
    };
    let mut pending: VecDeque<String> = whole.split('/').map(str::to_owned).collect();
    let mut parts: Vec<String> = Vec::new();
    let mut hops = 0;
    while let Some(part) = pending.pop_front() {
        match part.as_str() {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => {
                parts.push(part);
                let target = links.get(&format!("/{}", parts.join("/")));
                let Some(target) = target.filter(|_| hops < MAX_LINKS) else {
                    continue;
                };
                hops += 1;
                parts.pop();
                if target.starts_with('/') {
                    parts.clear();
                }
                for step in target.rsplit('/') {
                    pending.push_front(step.to_owned());
                }
            }
        }
    }
    format!("/{}", parts.join("/"))
}

fn string_of(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.as_str().to_owned()),
        _ => None,
    }
}

fn dirname(path: &str) -> &str {
    match path.rfind('/') {
        Some(0) | None => "/",
        Some(at) => &path[..at],
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    program: String,
    #[serde(default)]
    library_paths: Vec<String>,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    home: Option<String>,
    #[serde(default)]
    memory: Option<usize>,
    #[serde(default)]
    links: Links,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FileReply {
    kind: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    directory: bool,
}

/// A file being read for its imports, with what it has found so far.
struct Frame {
    /// None for the program.
    path: Option<String>,
    text: String,
    alias: Option<String>,
    origin: String,
    imports: Vec<Import>,
    deps: Vec<Dep>,
}

/// An import waiting on the host: the files left that could hold it.
struct Probe {
    import: Import,
    candidates: VecDeque<String>,
}

struct Link {
    cwd: String,
    home: Option<String>,
    search: Vec<String>,
    frames: Vec<Frame>,
    probe: Option<Probe>,
    taken: bool,
    loaded: HashMap<String, usize>,
    modules: Vec<Module>,
    deps: Vec<Dep>,
    errors: Vec<String>,
    /// A failure that ends the walk, as a module that cannot be found does.
    stopped: bool,
    /// The bytes the run may hold, and those of the files kept so far.
    memory: usize,
    held: usize,
    links: Links,
}

/// Takes the linker's answer while it fits the room left.
struct Room<'a> {
    out: &'a mut Vec<u8>,
    left: usize,
}

impl Write for Room<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.left = self
            .left
            .checked_sub(bytes.len())
            .ok_or(io::ErrorKind::OutOfMemory)?;
        self.out.extend_from_slice(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let Config {
        program,
        library_paths,
        origin,
        cwd,
        home,
        memory,
        links,
    } = parse_config(config)?;
    let cwd = cwd.unwrap_or_else(|| "/".to_owned());
    let search = if library_paths.is_empty() {
        DEFAULT_SEARCH.map(str::to_owned).to_vec()
    } else {
        library_paths
            .iter()
            .map(|path| resolve(&links, &cwd, path))
            .collect()
    };
    // A program jq refuses has nothing to link: the run words its report.
    let imports = match syntax::parse(&program) {
        Parsed::Program(_, imports) => imports,
        Parsed::Invalid(_) => Vec::new(),
    };
    let origin = origin.unwrap_or_else(|| cwd.clone());
    let mut link = Link {
        cwd,
        home,
        search,
        frames: vec![Frame {
            path: None,
            text: String::new(),
            alias: None,
            origin,
            imports,
            deps: Vec::new(),
        }],
        probe: None,
        taken: false,
        loaded: HashMap::new(),
        modules: Vec::new(),
        deps: Vec::new(),
        errors: Vec::new(),
        stopped: false,
        memory: memory.unwrap_or(usize::MAX),
        held: 0,
        links,
    };
    link.walk();
    Ok(Box::new(link))
}

impl Link {
    /// build_lib_search_chain: where `import` looks, from the file that
    /// names it.
    fn search_list(&self, import: &Import, origin: &str) -> Vec<String> {
        let words: Vec<String> = match &import.search {
            None => std::iter::once(".".to_owned())
                .chain(self.search.iter().cloned())
                .collect(),
            Some(Value::Array(items)) => items.iter().filter_map(string_of).collect(),
            Some(other) => string_of(other).into_iter().collect(),
        };
        words
            .into_iter()
            .filter_map(|word| {
                let word = match word.strip_prefix("~/") {
                    Some(rest) => format!("{}/{rest}", self.home.as_deref()?),
                    None => word,
                };
                Some(if word == "." {
                    self.cwd.clone()
                } else if let Some(rest) = word.strip_prefix("$ORIGIN/") {
                    resolve(&self.links, &self.cwd, &format!("{JQ_ORIGIN}/{rest}"))
                } else if word.starts_with('/') {
                    resolve(&self.links, &self.cwd, &word)
                } else {
                    resolve(&self.links, &self.cwd, &format!("{origin}/{word}"))
                })
            })
            .collect()
    }

    /// find_lib's paths in the order it stats them.
    fn candidates(&self, import: &Import, origin: &str) -> VecDeque<String> {
        let suffix = if import.data { ".json" } else { ".jq" };
        let base = import.path.rsplit('/').next().unwrap_or(&import.path);
        self.search_list(import, origin)
            .into_iter()
            .flat_map(|dir| {
                [
                    resolve(&self.links, &dir, &format!("{}{suffix}", import.path)),
                    resolve(
                        &self.links,
                        &dir,
                        &format!("{}/{base}{suffix}", import.path),
                    ),
                ]
            })
            .collect()
    }

    /// Take imports until one needs the host to read a file, or none is
    /// left.
    fn walk(&mut self) {
        while self.probe.is_none() && !self.stopped {
            let Some(frame) = self.frames.last_mut() else {
                return;
            };
            let Some(import) = frame.imports.pop() else {
                self.close();
                continue;
            };
            if let Some(message) = invalid_module_path(&import.path) {
                self.unfound(import.optional, &message);
                continue;
            }
            let origin = frame.origin.clone();
            let candidates = self.candidates(&import, &origin);
            self.probe = Some(Probe { import, candidates });
            self.settle();
        }
    }

    /// Done with the probe's import if it needs no read: nothing is left
    /// to try, or the file it names next is already a module.
    fn settle(&mut self) {
        loop {
            let Some(probe) = &mut self.probe else {
                return;
            };
            let Some(path) = probe.candidates.front().cloned() else {
                let probe = self.probe.take().expect("a probe in progress");
                let message = format!("module not found: {}", probe.import.path);
                self.unfound(probe.import.optional, &message);
                return;
            };
            if probe.import.data {
                return;
            }
            if self.frames.iter().any(|f| f.path.as_deref() == Some(&path)) {
                self.probe = None;
                self.fail(&format!("circular import of {path}"));
                return;
            }
            let Some(&module) = self.loaded.get(&path) else {
                return;
            };
            let probe = self.probe.take().expect("a probe in progress");
            self.bind(probe.import.alias, module);
        }
    }

    fn unfound(&mut self, optional: bool, message: &str) {
        if !optional {
            self.fail(message);
        }
    }

    /// A failure jq stops linking at, worded as jq_report_error is called
    /// with it.
    fn fail(&mut self, message: &str) {
        self.errors.push(format!("jq: error: {message}\n"));
        self.stopped = true;
    }

    fn bind(&mut self, alias: Option<String>, module: usize) {
        if let Some(frame) = self.frames.last_mut() {
            frame.deps.push(Dep { alias, module });
        }
    }

    /// The file on top has no imports left: it becomes a module, a
    /// dependency of the file below it.
    fn close(&mut self) {
        let Some(mut frame) = self.frames.pop() else {
            return;
        };
        frame.deps.reverse();
        let Some(path) = frame.path else {
            self.deps = frame.deps;
            return;
        };
        let module = self.modules.len();
        self.modules.push(Module {
            path: path.clone(),
            text: frame.text,
            kind: Kind::Code,
            deps: frame.deps,
        });
        self.loaded.insert(path, module);
        self.bind(frame.alias, module);
    }

    /// load_library over a file the host read.
    fn load(&mut self, import: Import, path: String, bytes: &[u8]) {
        let text = String::from_utf8_lossy(bytes).into_owned();
        if import.data {
            if !import.raw {
                if let Err(message) = documents(text.as_bytes()) {
                    self.errors
                        .push(format!("jq: error loading data file {path}: {message}\n"));
                    return;
                }
            }
            let module = self.modules.len();
            self.modules.push(Module {
                path,
                text,
                kind: if import.raw { Kind::Raw } else { Kind::Data },
                deps: Vec::new(),
            });
            self.bind(import.alias, module);
            return;
        }
        match library(&text, &path) {
            Ok((_, imports)) => self.frames.push(Frame {
                origin: dirname(&path).to_owned(),
                path: Some(path),
                text,
                alias: import.alias,
                imports,
                deps: Vec::new(),
            }),
            Err(errors) => self.errors.extend(errors),
        }
    }
}

impl Stream for Link {
    fn feed(&mut self, _input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("jq: the linker reads no input"))
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !self.errors.is_empty() {
            return Err(StreamError::new(syntax::report(&self.errors)));
        }
        if self.probe.is_some() || !self.frames.is_empty() {
            return Err(StreamError::new("jq: the linker has imports left"));
        }
        let linked = Linked {
            modules: std::mem::take(&mut self.modules),
            deps: std::mem::take(&mut self.deps),
        };
        let room = Room {
            out,
            left: self.memory.saturating_sub(self.held),
        };
        serde_json::to_writer(room, &linked).map_err(|error| {
            if error.is_io() {
                StreamError::new(EXHAUSTED)
            } else {
                StreamError::new(format!("bad jq link: {error}"))
            }
        })
    }

    fn request(&mut self, _data: &mut Vec<u8>) -> Option<Vec<u8>> {
        let path = self.probe.as_ref()?.candidates.front()?;
        if self.taken {
            return None;
        }
        self.taken = true;
        Some(
            json!({ "op": "read", "path": path })
                .to_string()
                .into_bytes(),
        )
    }

    fn respond(
        &mut self,
        reply: &[u8],
        data: &[u8],
        _out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        if !std::mem::take(&mut self.taken) {
            return Err(StreamError::new("jq: the host answered no request"));
        }
        let reply: FileReply = parse_config(reply)?;
        let mut probe = self
            .probe
            .take()
            .ok_or_else(|| StreamError::new("jq: the host answered no request"))?;
        let path = probe
            .candidates
            .pop_front()
            .ok_or_else(|| StreamError::new("jq: the host answered no request"))?;
        match reply.kind.as_str() {
            "data" => {
                self.held = self.held.saturating_add(data.len());
                if self.held > self.memory {
                    return Err(StreamError::new(EXHAUSTED));
                }
                self.load(probe.import, path, data);
            }
            "missing" => {
                self.probe = Some(probe);
                self.settle();
            }
            "error" => {
                let reason = if reply.directory {
                    "It's a directory"
                } else {
                    &reply.message
                };
                self.errors.push(format!(
                    "jq: error loading data file {path}: Could not open {path}: {reason}\n"
                ));
            }
            kind => return Err(StreamError::new(format!("jq: unknown reply {kind}"))),
        }
        self.walk();
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open;

    const CWD: &str = "/w";

    /// What the linker makes of `program` over `files`, served as a host
    /// serves it: its answer or report, and each path it asked for.
    fn link(
        program: &str,
        paths: &[&str],
        files: &[(&str, &str)],
    ) -> (Result<Linked, String>, Vec<String>) {
        let config = json!({
            "program": program,
            "library_paths": paths,
            "origin": CWD,
            "cwd": CWD,
            "home": "/home/u",
        });
        let mut stream = open("jq_link", config.to_string().as_bytes()).expect("opens");
        let mut asked = Vec::new();
        let mut out = Vec::new();
        while let Some(header) = stream.request(&mut Vec::new()) {
            let header: serde_json::Value = serde_json::from_slice(&header).expect("json");
            let path = header["path"].as_str().expect("a path").to_owned();
            let (reply, data) = match files.iter().find(|(name, _)| *name == path) {
                Some((_, "<dir>")) => (json!({"kind": "error", "directory": true}), ""),
                Some((_, text)) => (json!({"kind": "data"}), *text),
                None => (json!({"kind": "missing"}), ""),
            };
            asked.push(path);
            stream
                .respond(reply.to_string().as_bytes(), data.as_bytes(), &mut out)
                .expect("answers");
        }
        let answer = match stream.finish(&mut out) {
            Ok(()) => Ok(serde_json::from_slice(&out).expect("a link")),
            Err(error) => Err(String::from_utf8_lossy(&error.stderr()).into_owned()),
        };
        (answer, asked)
    }

    /// `program` run with no input over the modules `files` hold.
    fn run(program: &str, paths: &[&str], files: &[(&str, &str)]) -> Result<String, String> {
        let linked = link(program, paths, files).0?;
        let config = json!({
            "program": program,
            "null_input": true,
            "compact": true,
            "library_paths": paths,
            "cwd": CWD,
            "linked": linked,
        });
        let mut stream = open("jq", config.to_string().as_bytes())
            .map_err(|error| String::from_utf8_lossy(&error.stderr()).into_owned())?;
        let mut out = Vec::new();
        stream.finish(&mut out).expect("finishes");
        while stream.busy() {
            stream.drain(&mut out).expect("runs");
        }
        Ok(String::from_utf8(out).expect("text"))
    }

    fn failed(program: &str, files: &[(&str, &str)]) -> String {
        run(program, &["lib"], files).expect_err("refused")
    }

    const A: (&str, &str) = ("/w/lib/a.jq", "def f: \"a.f\"; def g: f + \"+g\";");

    #[test]
    fn an_import_binds_under_its_alias_and_an_include_bare() {
        assert_eq!(
            run(
                r#"import "a" as x; include "a"; [x::f, x::g, f]"#,
                &["lib"],
                &[A]
            ),
            Ok("[\"a.f\",\"a.f+g\",\"a.f\"]\n".to_owned())
        );
    }

    #[test]
    fn a_file_is_named_or_found_in_the_directory_it_names() {
        let files = [
            ("/w/lib/d/d.jq", "def d: 1;"),
            ("/w/lib/s/deep.jq", "def s: 2;"),
        ];
        assert_eq!(
            run(
                r#"import "d" as d; import "s/deep" as s; [d::d, s::s]"#,
                &["lib"],
                &files
            ),
            Ok("[1,2]\n".to_owned())
        );
    }

    #[test]
    fn a_data_file_binds_both_names_and_raw_binds_its_text() {
        let files = [
            ("/w/lib/d.json", "{\"x\":1}\n[2]\n"),
            ("/w/lib/t.json", "\"raw\n"),
        ];
        assert_eq!(
            run(r#"import "d" as $d; [$d, $d::d[0].x]"#, &["lib"], &files),
            Ok("[[{\"x\":1},[2]],1]\n".to_owned())
        );
        assert_eq!(
            run(r#"import "t" as $t {raw:true}; $t"#, &["lib"], &files),
            Ok("\"\\\"raw\\n\"\n".to_owned())
        );
    }

    #[test]
    fn a_data_import_is_a_variable_loadvn_empties() {
        let files = [
            ("/w/lib/d.json", "[1]\n"),
            ("/w/lib/n.jq", "import \"d\" as $d; def h: $$$$d;"),
        ];
        for (program, expected) in [
            (
                r#"import "d" as $d; [$d, $$$$d, $d]"#,
                "[[[1]],[[1]],null]\n",
            ),
            (r#"import "d" as $d; $$$$d::d, $d"#, "[[1]]\nnull\n"),
            (r#"import "d" as $d; def f: $$$$d; f, f"#, "[[1]]\nnull\n"),
            (
                r#"import "d" as $d; import "d" as $e; $$$$d, $e"#,
                "[[1]]\n[[1]]\n",
            ),
            (
                r#"import "n" as n; import "d" as $d; n::h, n::h, $d"#,
                "[[1]]\nnull\n[[1]]\n",
            ),
        ] {
            assert_eq!(run(program, &["lib"], &files), Ok(expected.to_owned()));
        }
    }

    #[test]
    fn a_search_path_goes_up_from_where_a_link_leads() {
        let links: Links = [("/w/libs/current".to_owned(), "../releases/v1".to_owned())].into();
        assert_eq!(resolve(&links, "/w", "libs/current/.."), "/w/releases");
        assert_eq!(resolve(&links, "/w", "libs/current/x"), "/w/releases/v1/x");
        assert_eq!(resolve(&links, "/w", "libs/other/.."), "/w/libs");
        let looped: Links = [("/l".to_owned(), "/l".to_owned())].into();
        assert_eq!(resolve(&looped, "/", "/l"), "/l");
    }

    /// The linker over `files` with room for `memory` bytes.
    fn within(memory: usize, program: &str, files: &[(&str, &str)]) -> Result<Vec<u8>, String> {
        let message = |error: StreamError| String::from_utf8_lossy(&error.stderr()).into_owned();
        let config = json!({
            "program": program,
            "library_paths": ["lib"],
            "cwd": CWD,
            "memory": memory,
        });
        let mut stream = open("jq_link", config.to_string().as_bytes()).expect("opens");
        let mut out = Vec::new();
        while let Some(header) = stream.request(&mut Vec::new()) {
            let header: serde_json::Value = serde_json::from_slice(&header).expect("json");
            let path = header["path"].as_str().expect("a path");
            let (reply, data) = match files.iter().find(|(name, _)| *name == path) {
                Some((_, text)) => (json!({"kind": "data"}), *text),
                None => (json!({"kind": "missing"}), ""),
            };
            stream
                .respond(reply.to_string().as_bytes(), data.as_bytes(), &mut out)
                .map_err(message)?;
        }
        stream.finish(&mut out).map_err(message)?;
        Ok(out)
    }

    #[test]
    fn the_files_kept_and_the_answer_stay_inside_the_memory_room() {
        let body = format!("def f: \"{}\";", "x".repeat(50));
        let files = [
            ("/w/lib/a.jq", body.as_str()),
            ("/w/lib/b.jq", body.as_str()),
        ];
        let both = r#"import "a" as a; import "b" as b; a::f, b::f"#;
        let exhausted = Err(EXHAUSTED.to_owned());
        // Each file fits on its own, the two together do not.
        assert_eq!(within(body.len() + 8, both, &files), exhausted);
        // Both fit, but not a second copy of them as the answer.
        assert_eq!(within(body.len() * 2 + 8, both, &files), exhausted);
        let answer = within(10_000, both, &files).expect("links");
        assert!(serde_json::from_slice::<Linked>(&answer).is_ok());
    }

    #[test]
    fn a_definition_sees_what_came_before_it_and_exports_its_last_name() {
        let files = [("/w/lib/r.jq", "def f: 1; def g: f; def f: 2; def h: f;")];
        assert_eq!(
            run(r#"import "r" as r; [r::f, r::g, r::h]"#, &["lib"], &files),
            Ok("[2,1,2]\n".to_owned())
        );
        assert_eq!(
            failed(
                r#"import "o" as o; o::e"#,
                &[("/w/lib/o.jq", "def e: l; def l: 1;")]
            ),
            "jq: error: l/0 is not defined at /w/lib/o.jq, line 1, column 8:\n    \
             def e: l; def l: 1;\n           ^\njq: 1 compile error"
        );
    }

    #[test]
    fn a_later_import_wins_and_a_module_exports_only_its_own() {
        let files = [
            ("/w/lib/a1.jq", "def f: \"one\";"),
            ("/w/lib/a2.jq", "def f: \"two\";"),
            ("/w/lib/b.jq", "include \"a1\"; def h: f;"),
        ];
        assert_eq!(
            run(r#"include "a1"; include "a2"; f"#, &["lib"], &files),
            Ok("\"two\"\n".to_owned())
        );
        assert_eq!(
            run(r#"include "a1"; def f: "mine"; f"#, &["lib"], &files),
            Ok("\"mine\"\n".to_owned())
        );
        assert_eq!(
            run(r#"include "b"; h"#, &["lib"], &files),
            Ok("\"one\"\n".to_owned())
        );
        assert!(
            failed(r#"include "b"; f"#, &files)
                .starts_with("jq: error: f/0 is not defined at <top-level>")
        );
    }

    #[test]
    fn a_module_calls_through_its_imports_to_any_depth() {
        let files = [
            A,
            ("/w/lib/b.jq", "import \"a\" as a; def h: a::g + \"+h\";"),
        ];
        assert_eq!(
            run(r#"import "b" as b; b::h"#, &["lib"], &files),
            Ok("\"a.f+g+h\"\n".to_owned())
        );
    }

    #[test]
    fn an_unused_definition_goes_unchecked_and_a_used_one_names_its_file() {
        let files = [("/w/lib/u.jq", "def u: nosuch; def ok: 1;")];
        assert_eq!(
            run(r#"import "u" as x; x::ok"#, &["lib"], &files),
            Ok("1\n".to_owned())
        );
        assert_eq!(
            failed(r#"import "u" as x; x::u"#, &files),
            "jq: error: nosuch/0 is not defined at /w/lib/u.jq, line 1, column 8:\n    \
             def u: nosuch; def ok: 1;\n           ^^^^^^\njq: 1 compile error"
        );
    }

    #[test]
    fn loc_and_named_arguments_reach_a_module() {
        let files = [("/w/lib/l.jq", "def loc: $__loc__;")];
        assert_eq!(
            run(r#"import "l" as l; l::loc"#, &["lib"], &files),
            Ok("{\"file\":\"/w/lib/l.jq\",\"line\":1}\n".to_owned())
        );
    }

    #[test]
    fn the_search_list_reads_from_the_importing_file() {
        let (_, asked) = link(r#"import "m" as m; 1"#, &["lib", "/abs"], &[]);
        assert_eq!(
            asked,
            [
                "/w/m.jq",
                "/w/m/m.jq",
                "/w/lib/m.jq",
                "/w/lib/m/m.jq",
                "/abs/m.jq",
                "/abs/m/m.jq"
            ]
        );
        let (_, asked) = link(r#"import "m" as m; 1"#, &[], &[]);
        assert_eq!(
            asked,
            [
                "/w/m.jq",
                "/w/m/m.jq",
                "/home/u/.jq/m.jq",
                "/home/u/.jq/m/m.jq",
                "/lib/jq/m.jq",
                "/lib/jq/m/m.jq",
                "/lib/m.jq",
                "/lib/m/m.jq"
            ]
        );
        let (_, asked) = link(r#"import "m" as m {search: ["./s", 7]}; 1"#, &["lib"], &[]);
        assert_eq!(asked, ["/w/s/m.jq", "/w/s/m/m.jq"]);
        let files = [
            (
                "/w/lib/n.jq",
                "import \"o\" as o {search:\"../other\"}; def n: o::o;",
            ),
            ("/w/other/o.jq", "def o: 1;"),
        ];
        assert_eq!(
            run(r#"import "n" as n; n::n"#, &["lib"], &files),
            Ok("1\n".to_owned())
        );
        let files = [
            ("/w/lib/d.jq", "import \"s\" as s {search:\".\"}; def d: 1;"),
            ("/w/lib/s.jq", ""),
        ];
        assert_eq!(
            failed(r#"import "d" as d; d::d"#, &files),
            "jq: error: module not found: s\n\njq: 1 compile error"
        );
    }

    #[test]
    fn a_module_two_files_import_is_read_once() {
        let files = [
            A,
            ("/w/lib/b.jq", "import \"a\" as a; def b: a::f;"),
            ("/w/lib/c.jq", "import \"a\" as a; def c: a::f;"),
        ];
        let program = r#"import "b" as b; import "c" as c; [b::b, c::c]"#;
        let (linked, asked) = link(program, &["lib"], &files);
        assert_eq!(linked.expect("links").modules.len(), 3);
        assert_eq!(
            asked.iter().filter(|path| *path == "/w/lib/a.jq").count(),
            1
        );
        assert_eq!(
            run(program, &["lib"], &files),
            Ok("[\"a.f\",\"a.f\"]\n".to_owned())
        );
    }

    #[test]
    fn an_optional_import_that_is_missing_is_passed_over() {
        assert_eq!(
            run(r#"import "nope" as x {optional:true}; 1"#, &["lib"], &[]),
            Ok("1\n".to_owned())
        );
        assert_eq!(
            run(r#"import "../nope" as x {optional:true}; 1"#, &["lib"], &[]),
            Ok("1\n".to_owned())
        );
    }

    #[test]
    fn what_cannot_be_loaded_is_reported_in_jqs_words() {
        let report = |program: &str, files: &[(&str, &str)]| {
            link(program, &["lib"], files).0.expect_err("refused")
        };
        for (program, files, want) in [
            (
                r#"import "nope" as x; 1"#,
                vec![],
                "jq: error: module not found: nope\n\njq: 1 compile error",
            ),
            (
                r#"import "../a" as x; 1"#,
                vec![],
                "jq: error: Relative paths to modules may not traverse to parent directories (../a)\n\njq: 1 compile error",
            ),
            (
                r#"import "a/a" as x; 1"#,
                vec![],
                "jq: error: module names must not have equal consecutive components: a/a\n\njq: 1 compile error",
            ),
            (
                r#"import "c1" as x; x::c"#,
                vec![
                    ("/w/lib/c1.jq", "import \"c2\" as c; def c: 1;"),
                    ("/w/lib/c2.jq", "import \"c1\" as c; def d: 2;"),
                ],
                "jq: error: circular import of /w/lib/c1.jq\n\njq: 1 compile error",
            ),
            (
                r#"import "bad" as x; 1"#,
                vec![("/w/lib/bad.jq", "def bad: ;\n")],
                "jq: error: syntax error, unexpected ';' at /w/lib/bad.jq, line 1, column 10:\n    def bad: ;\n             ^\njq: 1 compile error",
            ),
            (
                r#"import "q" as x; 1"#,
                vec![("/w/lib/q.jq", ".\n")],
                "jq: error: jq: error: library should only have function definitions, not a main expression\njq: 1 compile error",
            ),
            (
                r#"import "isdir" as x; 1"#,
                vec![("/w/lib/isdir.jq", "<dir>")],
                "jq: error loading data file /w/lib/isdir.jq: Could not open /w/lib/isdir.jq: It's a directory\n\njq: 1 compile error",
            ),
            (
                r#"import "d" as $d; 1"#,
                vec![("/w/lib/d.json", "[1,2\n")],
                "jq: error loading data file /w/lib/d.json: Unfinished JSON term at EOF at line 2, column 0\n\njq: 1 compile error",
            ),
        ] {
            assert_eq!(report(program, &files), want, "{program}");
        }
    }

    #[test]
    fn get_search_list_answers_the_directories_typed() {
        assert_eq!(
            run("get_search_list", &["lib", "/abs/."], &[]),
            Ok("[\"/w/lib\",\"/abs\"]\n".to_owned())
        );
        assert_eq!(
            run("get_search_list", &[], &[]),
            Ok("[\"~/.jq\",\"$ORIGIN/../lib/jq\",\"$ORIGIN/../lib\"]\n".to_owned())
        );
    }
}
