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
    pub(crate) stdin: Vec<u8>,
    inputs: HashMap<u64, (Vec<u8>, Option<Fault>)>,
    spools: HashMap<u64, Vec<u8>>,
    writers: HashMap<String, Writer>,
    pub(crate) out: Vec<u8>,
    pub(crate) err: Vec<u8>,
}

fn text(value: &Json) -> String {
    value.as_str().unwrap_or_default().to_owned()
}

fn failure(errno: &str, text: &str) -> Json {
    json!({"error": text, "errno": errno})
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

    fn read(&mut self, fd: u64, path: Option<&str>, file: bool) -> (Json, Vec<u8>) {
        if let Some(path) = path {
            if self.directories.iter().any(|dir| dir == path) {
                return (failure("EISDIR", "Is a directory"), Vec::new());
            }
            let source = match path {
                "-" | "/dev/stdin" if !file => Some(std::mem::take(&mut self.stdin)),
                _ => self.files.get(path).cloned(),
            };
            let fault = self.faults.get(path).cloned();
            match (source, &fault) {
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
        let mut take = input.len().min(3);
        if let Some(fault) = fault.as_mut() {
            take = take.min(fault.after);
            fault.after -= take;
        }
        let chunk: Vec<u8> = input.drain(..take).collect();
        (json!({}), chunk)
    }

    fn write(&mut self, request: &Json, data: Vec<u8>) -> Json {
        let path = text(&request["path"]);
        if path.starts_with("/missing/") {
            return failure("ENOENT", "No such file or directory");
        }
        if path.starts_with("/denied/") {
            return failure("EACCES", "Permission denied");
        }
        if path.starts_with("/stale/") {
            return failure(
                "STALE_WRITE",
                "changed since it was read; read it again before writing",
            );
        }
        if request["atomic"] == json!(true) {
            self.writers.insert(path, Writer::Replace(data));
            return json!({});
        }
        if request["append"] == json!(false) {
            self.commit(None);
            self.files.insert(path.clone(), Vec::new());
        }
        let data = match request["spool"].as_u64() {
            Some(fd) => {
                let spool = self.spools.remove(&fd).unwrap_or_default();
                let skip = request["skip"].as_u64().unwrap_or(0) as usize;
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
            "read" => self.read(fd, request["path"].as_str(), request["file"] == json!(true)),
            "close" => {
                self.inputs.remove(&fd);
                (json!({}), Vec::new())
            }
            "write" => (self.write(&request, data), Vec::new()),
            "flush" => {
                self.commit(request["path"].as_str());
                (json!({}), Vec::new())
            }
            "spool" => {
                self.spools.entry(fd).or_default().extend(data);
                (json!({}), Vec::new())
            }
            "emit" => {
                let spool = self.spools.remove(&fd).unwrap_or_default();
                self.out.extend(spool);
                (json!({}), Vec::new())
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
        stream.status()
    }
}
