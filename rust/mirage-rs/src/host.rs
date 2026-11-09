//! A host serving a stream's requests from memory, as the Python and
//! TypeScript hosts serve them: reads three bytes at a time so records
//! cross chunks, writes held until a flush commits them.

use std::collections::HashMap;

use serde_json::{Value as Json, json};

use crate::Stream;

/// A read that fails: after `after` bytes, with `errno` and its words.
#[derive(Clone)]
pub(crate) struct Fault {
    pub(crate) after: usize,
    pub(crate) errno: &'static str,
    pub(crate) text: &'static str,
}

enum Writer {
    Append(Vec<u8>),
    Replace(Vec<u8>),
}

#[derive(Default)]
pub(crate) struct Host {
    pub(crate) files: HashMap<String, Vec<u8>>,
    pub(crate) faults: HashMap<String, Fault>,
    pub(crate) directories: Vec<String>,
    /// The permission bits a `chmod` request set.
    pub(crate) modes: HashMap<String, u32>,
    /// The modification times a `stat` request reports, in seconds.
    pub(crate) mtimes: HashMap<String, i64>,
    /// Links by name and what each holds, which reads and writes follow.
    pub(crate) links: HashMap<String, String>,
    /// Standard input, and once a run ends what it left unread.
    pub(crate) stdin: Vec<u8>,
    stdin_fd: Option<u64>,
    inputs: HashMap<u64, (Vec<u8>, Option<Fault>)>,
    /// What a range opened past and the file's length, for its first reply.
    ranges: HashMap<u64, (usize, usize)>,
    /// The bytes every read sent.
    pub(crate) sent: usize,
    /// The most one read sends; none sends three.
    pub(crate) chunk: Option<usize>,
    spools: HashMap<u64, Vec<u8>>,
    writers: HashMap<String, Writer>,
    pub(crate) out: Vec<u8>,
    pub(crate) err: Vec<u8>,
    /// How many `drain` calls the stream took.
    pub(crate) drains: usize,
}

fn text(value: &Json) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

fn failure(errno: &str, text: &str) -> Json {
    json!({"error": text, "errno": errno})
}

/// A name with `.` and `..` walked, as a namespace walks one.
fn normal(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            _ => parts.push(part),
        }
    }
    let joined = parts.join("/");
    if path.starts_with('/') {
        format!("/{joined}")
    } else {
        joined
    }
}

impl Host {
    pub(crate) fn with(files: &[(&str, &str)], stdin: &str) -> Host {
        Host {
            stdin: stdin.as_bytes().to_vec(),
            files: files
                .iter()
                .map(|(name, body)| (name.to_string(), body.as_bytes().to_vec()))
                .collect(),
            ..Host::default()
        }
    }

    /// What a name leads to through its links.
    fn follow(&self, path: &str) -> String {
        let mut name = normal(path);
        for _ in 0..40 {
            let Some(target) = self.links.get(&name) else {
                break;
            };
            name = match (target.starts_with('/'), name.rfind('/')) {
                (false, Some(slash)) => normal(&format!("{}{target}", &name[..=slash])),
                _ => normal(target),
            };
        }
        name
    }

    pub(crate) fn commit(&mut self, path: Option<&str>) {
        let names: Vec<String> = match path {
            Some(path) => vec![path.to_owned()],
            None => self.writers.keys().cloned().collect(),
        };
        for name in names {
            match self.writers.remove(&name) {
                Some(Writer::Append(data)) => self.files.entry(name).or_default().extend(data),
                Some(Writer::Replace(data)) => {
                    self.files.insert(name, data);
                }
                None => {}
            }
        }
    }

    /// A command line of the few forms the tests run.
    fn shell(&mut self, command: &str, stdin: Option<Vec<u8>>) -> (Vec<u8>, i64) {
        let input = stdin.unwrap_or_else(|| std::mem::take(&mut self.stdin));
        match command {
            "cat" => (input, 0),
            "sort" => {
                let mut lines: Vec<&[u8]> = input.split_inclusive(|&c| c == b'\n').collect();
                lines.sort();
                (lines.concat(), 0)
            }
            _ if command.starts_with("echo ") => (format!("{}\n", &command[5..]).into_bytes(), 0),
            _ if command.starts_with("exit ") => (Vec::new(), command[5..].parse().unwrap_or(0)),
            _ => (Vec::new(), 127),
        }
    }

    fn read(&mut self, fd: u64, request: &Json) -> (Json, Vec<u8>) {
        let (mut reply, data) = self.read_input(fd, request);
        if let Some(opened) = self.ranges.remove(&fd) {
            reply["skipped"] = json!(opened.0);
            reply["size"] = json!(opened.1);
        }
        (reply, data)
    }

    fn read_input(&mut self, fd: u64, request: &Json) -> (Json, Vec<u8>) {
        let path = request["path"].as_str();
        if let Some(spool) = request["spool"].as_u64() {
            let skip = request["skip"].as_u64().unwrap_or(0) as usize;
            let held = self.spools.get(&spool).cloned().unwrap_or_default();
            let mut held = held.get(skip..).unwrap_or_default().to_vec();
            if let Some(size) = request["size"].as_u64() {
                held.truncate(size as usize);
                return (json!({}), held);
            }
            self.inputs.insert(fd, (held, None));
        }
        if let Some(path) = path {
            let file = request["file"] == json!(true);
            if self.directories.iter().any(|dir| dir == path) {
                return (failure("EISDIR", "Is a directory"), Vec::new());
            }
            let source = match path {
                "-" | "/dev/stdin" if !file => {
                    self.stdin_fd = Some(fd);
                    Some(std::mem::take(&mut self.stdin))
                }
                _ => self.files.get(&self.follow(path)).cloned(),
            };
            let fault = self.faults.get(path).cloned();
            match (source, &fault) {
                // A range opens past `skip`, at most `size` bytes, saying
                // how far it skipped and the file's length.
                (Some(source), _)
                    if request["skip"].is_u64() && !matches!(path, "-" | "/dev/stdin") =>
                {
                    let length = source.len();
                    let start = (request["skip"].as_u64().unwrap_or(0) as usize).min(length);
                    let end = request["size"]
                        .as_u64()
                        .map_or(length, |size| (start + size as usize).min(length));
                    self.ranges.insert(fd, (start, length));
                    self.inputs.insert(fd, (source[start..end].to_vec(), fault));
                }
                (Some(source), _) => {
                    self.inputs.insert(fd, (source, fault));
                }
                (None, Some(fault)) => {
                    self.inputs.insert(fd, (Vec::new(), Some(fault.clone())));
                }
                (None, None) => {
                    return (failure("ENOENT", "No such file or directory"), Vec::new());
                }
            }
        }
        let Some((input, fault)) = self.inputs.get_mut(&fd) else {
            return (json!({"end": true}), Vec::new());
        };
        if let Some(fault) = fault.as_mut() {
            if fault.after == 0 {
                let reply = failure(fault.errno, fault.text);
                self.inputs.remove(&fd);
                return (reply, Vec::new());
            }
        }
        if input.is_empty() {
            self.inputs.remove(&fd);
            return (json!({"end": true}), Vec::new());
        }
        let mut take = input.len().min(self.chunk.unwrap_or(3));
        if let Some(fault) = fault.as_mut() {
            take = take.min(fault.after);
            fault.after -= take;
        }
        let chunk: Vec<u8> = input.drain(..take).collect();
        self.sent += chunk.len();
        // A gathered read's last bytes come with the end, as hosts send them.
        if input.is_empty() && fault.is_none() && request["least"].is_u64() {
            self.inputs.remove(&fd);
            return (json!({"end": true}), chunk);
        }
        (json!({}), chunk)
    }

    fn write(&mut self, request: &Json, data: Vec<u8>) -> Json {
        let path = self.follow(&text(&request["path"]));
        if path.starts_with("/missing/") {
            return failure("ENOENT", "No such file or directory");
        }
        if path.starts_with("/denied/") {
            return failure("EACCES", "Permission denied");
        }
        if path.starts_with("/full/") {
            return failure("EDQUOT", "Disk quota exceeded");
        }
        let window = match (request["spool"].as_u64(), request["size"].as_u64()) {
            (Some(fd), Some(size)) => {
                let skip = request["skip"].as_u64().unwrap_or(0) as usize;
                Some(self.spools[&fd][skip..skip + size as usize].to_vec())
            }
            _ => None,
        };
        if let (Some(window), true) = (&window, request["create"] == json!(true)) {
            self.files.insert(path, window.clone());
            return json!({});
        }
        if request["whole"] == json!(true) {
            self.files.insert(path, data);
            return json!({});
        }
        if request["atomic"] == json!(true) || request["create"] == json!(true) {
            self.writers.insert(path, Writer::Replace(data));
            return json!({});
        }
        if request["append"] == json!(false) {
            self.commit(None);
            self.files.insert(path.clone(), Vec::new());
        }
        let data = match request["spool"].as_u64() {
            Some(_) if window.is_some() => window.unwrap_or_default(),
            Some(fd) => {
                let skip = request["skip"].as_u64().unwrap_or(0) as usize;
                let spool = self.spools.remove(&fd).unwrap_or_default();
                spool.get(skip..).unwrap_or_default().to_vec()
            }
            None => data,
        };
        if !data.is_empty() {
            match self
                .writers
                .entry(path)
                .or_insert(Writer::Append(Vec::new()))
            {
                Writer::Append(held) | Writer::Replace(held) => held.extend(data),
            }
        }
        json!({})
    }

    pub(crate) fn serve(&mut self, header: &[u8], data: Vec<u8>) -> (Json, Vec<u8>) {
        let request: Json = serde_json::from_slice(header).expect("a JSON request");
        let fd = request["fd"].as_u64().unwrap_or(0);
        match request["op"].as_str().unwrap_or_default() {
            "read" => self.read(fd, &request),
            "close" => {
                self.inputs.remove(&fd);
                self.spools.remove(&fd);
                (json!({}), Vec::new())
            }
            "write" => (self.write(&request, data), Vec::new()),
            "stat" => {
                let path = text(&request["path"]);
                let mut kind = if self.directories.contains(&path) {
                    json!({"kind": "dir"})
                } else if self.files.contains_key(&path) {
                    match self.modes.get(&path) {
                        Some(mode) => json!({"kind": "file", "mode": mode}),
                        None => json!({"kind": "file"}),
                    }
                } else {
                    json!({})
                };
                if let Some(mtime) = self.mtimes.get(&path) {
                    kind["mtime"] = json!(mtime);
                }
                (kind, Vec::new())
            }
            "mkdir" => {
                let path = text(&request["path"]);
                if path.starts_with("/denied") || self.files.contains_key(&path) {
                    return (failure("EACCES", "Permission denied"), Vec::new());
                }
                self.directories.push(path);
                (json!({}), Vec::new())
            }
            "chmod" => {
                let path = text(&request["path"]);
                if !self.files.contains_key(&path) {
                    return (failure("ENOENT", "No such file or directory"), Vec::new());
                }
                let mode = request["mode"].as_u64().unwrap_or_default() as u32;
                self.modes.insert(path, mode);
                (json!({}), Vec::new())
            }
            "unlink" => {
                let path = text(&request["path"]);
                if self.links.remove(&path).is_some() || self.files.remove(&path).is_some() {
                    return (json!({}), Vec::new());
                }
                (failure("ENOENT", "No such file or directory"), Vec::new())
            }
            "readlink" => {
                let path = normal(&text(&request["path"]));
                if path.contains("denied/") {
                    return (failure("EACCES", "Permission denied"), Vec::new());
                }
                if let Some(target) = self.links.get(&path) {
                    let mtime = self.mtimes.get(&path);
                    return (json!({"target": target, "mtime": mtime}), Vec::new());
                }
                if self.files.contains_key(&path) || self.directories.contains(&path) {
                    return (json!({}), Vec::new());
                }
                (failure("ENOENT", "No such file or directory"), Vec::new())
            }
            "copy" | "rename" => {
                let (from, to) = (text(&request["path"]), text(&request["to"]));
                if to.starts_with("/missing/") {
                    return (failure("ENOENT", "No such file or directory"), Vec::new());
                }
                if self.directories.contains(&to) {
                    return (failure("EISDIR", "Is a directory"), Vec::new());
                }
                if request["op"] == json!("rename") {
                    if let Some(target) = self.links.remove(&from) {
                        self.links.insert(to, target);
                        return (json!({}), Vec::new());
                    }
                }
                let source = self.follow(&from);
                let Some(body) = self.files.get(&source).cloned() else {
                    return (failure("ENOENT", "No such file or directory"), Vec::new());
                };
                if request["op"] == json!("rename") {
                    self.files.remove(&source);
                }
                if let Some(mode) = self.modes.get(&source).copied() {
                    self.modes.insert(to.clone(), mode);
                }
                self.files.insert(to, body);
                (json!({}), Vec::new())
            }
            "unread" => {
                match self.stdin_fd.and_then(|fd| self.inputs.get_mut(&fd)) {
                    Some((held, _)) => held.splice(0..0, data),
                    None => self.stdin.splice(0..0, data),
                };
                (json!({}), Vec::new())
            }
            "rmdir" => {
                let path = text(&request["path"]);
                let inside = format!("{path}/");
                let mut names = self.files.keys().chain(self.directories.iter());
                let busy = names.any(|name| name.starts_with(&inside));
                match self.directories.iter().position(|dir| *dir == path) {
                    Some(at) if !busy => {
                        self.directories.remove(at);
                        (json!({}), Vec::new())
                    }
                    Some(_) => (failure("ENOTEMPTY", "Directory not empty"), Vec::new()),
                    None => (failure("ENOENT", "No such file or directory"), Vec::new()),
                }
            }
            "flush" => {
                let path = request["path"].as_str();
                // A full disk refuses the bytes as they land.
                if path.is_some_and(|path| path.starts_with("/brim/")) {
                    self.writers.remove(path.unwrap_or_default());
                    return (failure("ENOSPC", "No space left on device"), Vec::new());
                }
                // A conditional write finds the file changed at its commit.
                if path.is_some_and(|path| path.starts_with("/stale/")) {
                    self.writers.remove(path.unwrap_or_default());
                    let reply = failure(
                        "STALE_WRITE",
                        "changed since it was read; read it again before writing",
                    );
                    return (reply, Vec::new());
                }
                self.commit(path);
                (json!({}), Vec::new())
            }
            "spool" => {
                self.spools.entry(fd).or_default().extend(data);
                (json!({}), Vec::new())
            }
            "emit" => {
                match (request["skip"].as_u64(), request["size"].as_u64()) {
                    (Some(skip), Some(size)) => {
                        let held = &self.spools[&fd];
                        self.out
                            .extend_from_slice(&held[skip as usize..(skip + size) as usize]);
                    }
                    _ => self.out.extend(self.spools.remove(&fd).unwrap_or_default()),
                }
                (json!({}), Vec::new())
            }
            "fill" => {
                let into = request["into"].as_u64().unwrap_or(0);
                let mut held = Vec::new();
                let (mut reply, mut chunk) = self.read(into, &request);
                while reply.get("end").is_none() {
                    if reply.get("error").is_some() {
                        return (reply, Vec::new());
                    }
                    held.append(&mut chunk);
                    (reply, chunk) = self.read(into, &json!({}));
                }
                let size = held.len();
                self.spools.insert(into, held);
                (json!({"size": size}), Vec::new())
            }
            "run" => {
                let stdin = request["stdin"]
                    .as_u64()
                    .map(|fd| self.spools.remove(&fd).unwrap_or_default());
                let (output, status) = self.shell(&text(&request["command"]), stdin);
                match request["stdout"].as_u64() {
                    Some(fd) => {
                        self.inputs.insert(fd, (output, None));
                    }
                    None => self.out.extend(output),
                }
                (json!({"status": status}), Vec::new())
            }
            op => panic!("unknown request {op}"),
        }
    }

    /// Run a stream to its end, serving every request; its status.
    pub(crate) fn drive(&mut self, stream: &mut dyn Stream) -> i32 {
        loop {
            while stream.busy() {
                stream.drain(&mut self.out).expect("drains");
                self.drains += 1;
            }
            stream.take_stderr(&mut self.err);
            let mut data = Vec::new();
            let Some(header) = stream.request(&mut data) else {
                break;
            };
            let (reply, data) = self.serve(&header, data);
            stream
                .respond(reply.to_string().as_bytes(), &data, &mut self.out)
                .expect("answers");
        }
        stream.finish(&mut self.out).expect("finishes");
        stream.take_stderr(&mut self.err);
        if let Some((held, _)) = self.stdin_fd.take().and_then(|fd| self.inputs.remove(&fd)) {
            self.stdin = held;
        }
        self.spools.clear();
        self.inputs.clear();
        stream.status()
    }
}
