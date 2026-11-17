// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.

use super::node::Json;
use super::xml::text;

/// A refusal: the message `Error:` prints and the code `--json` names.
#[derive(Debug)]
pub(crate) struct Fail {
    pub(super) message: String,
    pub(super) code: Option<&'static str>,
    pub(super) suggestion: Option<String>,
    pub(super) help: Option<String>,
    pub(super) valid: Option<Vec<String>>,
}

impl Fail {
    /// A refusal its message names the code of, as OfficeCLI infers one.
    pub(crate) fn of(message: String) -> Fail {
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
            suggestion: None,
            help: None,
            valid: None,
        }
    }

    pub(crate) fn coded(message: String, code: &'static str) -> Fail {
        Fail {
            message,
            code: Some(code),
            suggestion: None,
            help: None,
            valid: None,
        }
    }

    pub(super) fn missing(absolute: &[u8]) -> Fail {
        Fail {
            message: format!("File not found: {}", text(absolute)),
            code: Some("file_not_found"),
            suggestion: Some(
                "Check the file path. Use an absolute path or a path relative to the current directory."
                    .to_string(),
            ),
            help: Some("office create <path> --type docx|xlsx|pptx".to_string()),
            valid: None,
        }
    }

    pub(super) fn envelope(&self) -> Json {
        let mut error = vec![
            ("error", Json::Str(self.message.clone())),
            (
                "code",
                Json::Str(self.code.unwrap_or("internal_error").to_string()),
            ),
        ];
        if let Some(suggestion) = &self.suggestion {
            error.push(("suggestion", Json::Str(suggestion.clone())));
        }
        if let Some(help) = &self.help {
            error.push(("help", Json::Str(help.clone())));
        }
        if let Some(valid) = &self.valid {
            error.push((
                "validValues",
                Json::Arr(valid.iter().map(|v| Json::Str(v.clone())).collect()),
            ));
        }
        Json::obj(vec![
            ("success", Json::Bool(false)),
            ("error", Json::obj(error)),
        ])
    }
}

/// Why a set did not apply every property: the refusal, the properties it
/// does not take, or those it left once the rest were applied.
pub(super) enum SetFail {
    Fail(Fail),
    Unsupported {
        keys: Vec<String>,
        element: &'static str,
        valid: &'static [&'static str],
    },
    Partial {
        message: String,
        warnings: Vec<String>,
        keys: Vec<String>,
        element: &'static str,
        valid: &'static [&'static str],
    },
}

/// The set's outcome once some props were applied: `Partial` when others
/// were left, else the line and warnings.
pub(super) fn partial(
    path: &str,
    props: &[(String, String)],
    took: &[String],
    warnings: Vec<String>,
    element: &'static str,
    valid: &'static [&'static str],
) -> Result<(String, Vec<String>), SetFail> {
    let taken = |k: &str| took.iter().any(|t| t.eq_ignore_ascii_case(k));
    let shown: Vec<String> = props
        .iter()
        .filter(|(k, _)| taken(k))
        .map(|(k, v)| format!("{k}={v}"))
        .collect();
    let message = format!("Updated {path}: {}", shown.join(", "));
    let keys: Vec<String> = props
        .iter()
        .map(|(k, _)| k.clone())
        .filter(|k| !taken(k))
        .collect();
    if keys.is_empty() {
        return Ok((message, warnings));
    }
    if shown.is_empty() {
        return Err(SetFail::Unsupported {
            keys,
            element,
            valid,
        });
    }
    Err(SetFail::Partial {
        message,
        warnings,
        keys,
        element,
        valid,
    })
}

impl From<Fail> for SetFail {
    fn from(f: Fail) -> SetFail {
        SetFail::Fail(f)
    }
}
