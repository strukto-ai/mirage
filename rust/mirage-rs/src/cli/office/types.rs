// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.

use super::errors::Fail;
use super::node::Json;
use crate::task::Host;
use serde::Deserialize;

#[derive(Deserialize)]
pub(super) struct Config {
    pub(super) command: String,
    /// The workbook as typed, which messages name.
    #[serde(deserialize_with = "crate::latin1")]
    pub(super) file: Vec<u8>,
    /// The workbook's absolute path, which the host reads and writes.
    #[serde(deserialize_with = "crate::latin1")]
    pub(super) absolute: Vec<u8>,
    #[serde(default)]
    pub(super) path: Option<String>,
    #[serde(default)]
    pub(super) props: Vec<String>,
    #[serde(default)]
    pub(super) force: bool,
    #[serde(default)]
    pub(super) json: bool,
    #[serde(default)]
    pub(super) depth: Option<i64>,
    #[serde(default)]
    pub(super) find: Option<String>,
    #[serde(default)]
    pub(super) commands: Option<String>,
    /// `--input` as typed, the stream's second operand.
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    pub(super) input: Option<Vec<u8>>,
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    pub(super) input_absolute: Option<Vec<u8>>,
    #[serde(default)]
    pub(super) stop_on_error: bool,
    #[serde(default)]
    pub(super) best_effort: bool,
    /// `add --type`.
    #[serde(default, rename = "type")]
    pub(super) kind: Option<String>,
    #[serde(default)]
    pub(super) from: Option<String>,
    #[serde(default)]
    pub(super) index: Option<i64>,
    #[serde(default)]
    pub(super) after: Option<String>,
    #[serde(default)]
    pub(super) before: Option<String>,
    /// `move --to`.
    #[serde(default)]
    pub(super) to: Option<String>,
    /// `swap`'s second path.
    #[serde(default)]
    pub(super) path2: Option<String>,
}

/// Where a command's output goes: as text, or as one JSON envelope.
pub(super) struct Out<'h> {
    pub(super) host: &'h Host,
    pub(super) json: bool,
}

impl Out<'_> {
    pub(super) fn fail(&self, f: &Fail) -> i32 {
        if self.json {
            self.host
                .print(format!("{}\n", f.envelope().pretty()).as_bytes());
        } else {
            self.host.warn(format!("Error: {}\n", f.message).as_bytes());
        }
        1
    }

    /// A command's one-line success message.
    pub(super) fn done(&self, message: &str) -> i32 {
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

    pub(super) fn data(&self, data: Json, warnings: Option<Json>, success: bool) {
        let mut env = vec![("success", Json::Bool(success)), ("data", data)];
        if let Some(w) = warnings {
            env.push(("warnings", w));
        }
        self.host
            .print(format!("{}\n", Json::obj(env).pretty()).as_bytes());
    }

    /// The line of a set that applied some props, then the ones it left.
    pub(super) fn partly(
        &self,
        message: &str,
        keys: &[String],
        element: &str,
        valid: &[&str],
    ) -> i32 {
        if self.json {
            let env = Json::obj(vec![
                ("success", Json::Bool(true)),
                ("data", Json::Str(message.to_string())),
                ("message", Json::Str(message.to_string())),
                ("warnings", unsupported_warnings(keys, element, valid)),
            ]);
            self.host.print(format!("{}\n", env.pretty()).as_bytes());
        } else {
            self.host.print(format!("{message}\n").as_bytes());
            self.host
                .warn(format!("{}\n", unsupported_text(keys, element, valid)).as_bytes());
        }
        2
    }

    pub(super) fn unsupported(
        &self,
        path: &str,
        keys: &[String],
        element: &str,
        valid: &[&str],
    ) -> i32 {
        if self.json {
            let env = Json::obj(vec![
                ("success", Json::Bool(false)),
                (
                    "message",
                    Json::Str(format!("Error: No properties applied to {path}")),
                ),
                ("warnings", unsupported_warnings(keys, element, valid)),
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

/// One `unsupported_property` warning per key, as `--json` lists them.
pub(super) fn unsupported_warnings(keys: &[String], element: &str, valid: &[&str]) -> Json {
    Json::Arr(
        keys.iter()
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
            .collect(),
    )
}

pub(super) fn unsupported_text(keys: &[String], element: &str, valid: &[&str]) -> String {
    format!(
        "UNSUPPORTED props: {} (valid {element} props: {}). Run 'office help <format> <element>' to see valid props, or raw-set for raw XML.",
        keys.join(", "),
        valid.join(", ")
    )
}

/// An advisory line `add` or `set` prints on stderr: its message, the code
/// `--json` names and a suggestion.
pub(super) struct Advice {
    pub(super) message: String,
    pub(super) code: &'static str,
    pub(super) suggestion: Option<String>,
}

/// What a batch item answered: a line of text, or nodes when `--json`.
pub(super) enum Output {
    Text(String),
    Data(Json),
}

pub(super) struct Outcome {
    pub(super) index: usize,
    pub(super) result: Result<Output, (String, Option<&'static str>)>,
    pub(super) warnings: Vec<String>,
}

/// A position `add` and `move` take: an index or an anchor path.
pub(super) struct Place<'a> {
    pub(super) index: Option<i64>,
    pub(super) after: Option<&'a str>,
    pub(super) before: Option<&'a str>,
}

/// What `add` answers: the new element's path, the props it did not read
/// and its advisory warnings.
pub(super) type Added = (String, Vec<String>, Vec<String>);
