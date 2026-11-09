//! GitHub calls as requests to the host, which holds the token and the
//! connection pool and answers through the workspace's network policy.

use std::collections::BTreeMap;

use super::json::{Json, quoted};
use crate::request::Request;
use crate::task::Host;

pub(crate) const GRAPHQL_PATH: &str = "graphql";

pub(crate) type Pairs = [(String, String)];

/// One gh install as the commands see it: the host to ask, and the
/// repository and branch a checkout would give.
pub(crate) struct Account {
    pub(crate) host: Host,
    pub(crate) repo: Option<String>,
    pub(crate) branch: Option<String>,
    pub(crate) token_mask: String,
    pub(crate) base_url: Option<String>,
    pub(crate) version: String,
    pub(crate) argv_len: usize,
    pub(crate) argv: Vec<String>,
}

impl Account {
    /// Whether the line spelled an option out, for what gh tells apart by
    /// a flag having been set rather than by its value.
    pub(crate) fn argv_has(&self, option: &str) -> bool {
        let long = format!("{option}=");
        self.argv
            .iter()
            .any(|word| word == option || word.starts_with(&long))
    }
}

/// A call GitHub answered with a status the caller cannot use.
#[derive(Debug)]
pub(crate) struct ApiError {
    pub(crate) message: String,
    /// What go-gh's HandleHTTPError joins from the response.
    pub(crate) joined: String,
    pub(crate) status: u16,
    pub(crate) body: String,
    pub(crate) url: String,
    pub(crate) headers: BTreeMap<String, String>,
    pub(crate) data: Json,
    /// The call was a query gh builds from a struct, whose client words
    /// an HTTP failure its own way.
    pub(crate) built_query: bool,
}

/// Go's http.StatusText, which `gh api -i` prints after a status code.
pub(crate) fn http_reason(status: u16) -> &'static str {
    match status {
        100 => "Continue",
        101 => "Switching Protocols",
        102 => "Processing",
        103 => "Early Hints",
        200 => "OK",
        201 => "Created",
        202 => "Accepted",
        203 => "Non-Authoritative Information",
        204 => "No Content",
        205 => "Reset Content",
        206 => "Partial Content",
        207 => "Multi-Status",
        208 => "Already Reported",
        226 => "IM Used",
        300 => "Multiple Choices",
        301 => "Moved Permanently",
        302 => "Found",
        303 => "See Other",
        304 => "Not Modified",
        305 => "Use Proxy",
        307 => "Temporary Redirect",
        308 => "Permanent Redirect",
        400 => "Bad Request",
        401 => "Unauthorized",
        402 => "Payment Required",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        406 => "Not Acceptable",
        407 => "Proxy Authentication Required",
        408 => "Request Timeout",
        409 => "Conflict",
        410 => "Gone",
        411 => "Length Required",
        412 => "Precondition Failed",
        413 => "Request Entity Too Large",
        414 => "Request URI Too Long",
        415 => "Unsupported Media Type",
        416 => "Requested Range Not Satisfiable",
        417 => "Expectation Failed",
        418 => "I'm a teapot",
        421 => "Misdirected Request",
        422 => "Unprocessable Entity",
        423 => "Locked",
        424 => "Failed Dependency",
        425 => "Too Early",
        426 => "Upgrade Required",
        428 => "Precondition Required",
        429 => "Too Many Requests",
        431 => "Request Header Fields Too Large",
        451 => "Unavailable For Legal Reasons",
        500 => "Internal Server Error",
        501 => "Not Implemented",
        502 => "Bad Gateway",
        503 => "Service Unavailable",
        504 => "Gateway Timeout",
        505 => "HTTP Version Not Supported",
        506 => "Variant Also Negotiates",
        507 => "Insufficient Storage",
        508 => "Loop Detected",
        510 => "Not Extended",
        511 => "Network Authentication Required",
        _ => "",
    }
}

/// Why a command stopped.
#[derive(Debug)]
pub(crate) enum Failure {
    /// In the command's own words and exit status.
    Usage(String, i32),
    /// Worded after the command's name, exit 1.
    Value(String),
    /// No response came back.
    Connection(String),
    Api(Box<ApiError>),
    /// Worded as `Value`, after what the command already printed.
    Printed {
        output: Vec<u8>,
        message: String,
    },
}

impl Failure {
    pub(crate) fn text(&self) -> String {
        match self {
            Failure::Usage(message, _)
            | Failure::Value(message)
            | Failure::Connection(message)
            | Failure::Printed { message, .. } => message.clone(),
            Failure::Api(error) => error.text(),
        }
    }
}

impl ApiError {
    /// The failure as go-gh's HTTPError words it.
    fn text(&self) -> String {
        if self.built_query {
            return format!(
                "non-200 OK status code: {} {} body: {}",
                self.status,
                http_reason(self.status),
                quoted(&self.body)
            );
        }
        let message = &self.joined;
        match message.split_once('\n') {
            Some((first, rest)) => format!("HTTP {}: {first} ({})\n{rest}", self.status, self.url),
            None if message.is_empty() => format!("HTTP {} ({})", self.status, self.url),
            None => format!("HTTP {}: {message} ({})", self.status, self.url),
        }
    }
}

/// The message go-gh's HandleHTTPError joins from a response: `reason` when
/// the body is not JSON.
fn joined_message(
    status: u16,
    reason: &str,
    headers: &BTreeMap<String, String>,
    data: &Json,
) -> String {
    let kind = headers.get("content-type").map_or("", String::as_str);
    let media = kind.split(';').next().unwrap_or(kind);
    if !media.ends_with("/json") && !media.ends_with("+json") {
        return format!("{status} {reason}");
    }
    let errors = data.get("errors");
    if !matches!(data, Json::Obj(_)) || !matches!(errors, Json::Null | Json::Arr(_)) {
        return String::new();
    }
    let mut messages = vec![data.get("message").text().to_owned()];
    messages.extend(errors.items().iter().map(error_item));
    messages.retain(|message| !message.is_empty());
    messages.join("\n")
}

/// One entry of a response's `errors`, in go-gh's words.
fn error_item(item: &Json) -> String {
    match item {
        Json::Str(text) => text.clone(),
        Json::Obj(_) => match item.get("code").text() {
            "" | "custom" => item.get("message").text().to_owned(),
            code => format!(
                "{}.{} {}",
                item.get("resource").text(),
                item.get("field").text(),
                match code {
                    "missing" | "missing_field" => "is missing",
                    "invalid" | "unprocessable" => "is invalid",
                    "already_exists" => "already exists",
                    other => other,
                }
            ),
        },
        _ => String::new(),
    }
}

pub(crate) type Result<T> = std::result::Result<T, Failure>;

pub(crate) fn value<T>(message: impl Into<String>) -> Result<T> {
    Err(Failure::Value(message.into()))
}

pub(crate) fn usage<T>(message: impl Into<String>) -> Result<T> {
    Err(Failure::Usage(message.into(), 1))
}

/// A response body, by what its type says it holds.
#[derive(Debug)]
pub(crate) enum Body {
    Empty,
    Json(Json),
    Text(String),
    Bytes(Vec<u8>),
}

pub(crate) struct Response {
    pub(crate) status: u16,
    pub(crate) headers: BTreeMap<String, String>,
    pub(crate) data: Body,
    pub(crate) raw: Vec<u8>,
}

impl Body {
    pub(crate) fn into_json(self) -> Json {
        match self {
            Body::Json(value) => value,
            Body::Text(text) => Json::Str(text),
            Body::Empty | Body::Bytes(_) => Json::Null,
        }
    }

    pub(crate) fn into_bytes(self) -> Vec<u8> {
        match self {
            Body::Bytes(bytes) => bytes,
            Body::Text(text) => text.into_bytes(),
            Body::Empty | Body::Json(_) => Vec::new(),
        }
    }
}

/// A body as the caller reads it: JSON decoded (text when it does not
/// parse), no type, a text type or a UTF-8 charset as text, and anything
/// else, such as a run's log archive, as bytes.
fn decoded(body: &[u8], content_type: &str) -> Body {
    if body.is_empty() {
        return Body::Empty;
    }
    let (mime, rest) = content_type.split_once(';').unwrap_or((content_type, ""));
    let mime = mime.trim().to_ascii_lowercase();
    let charset = rest
        .split(';')
        .find_map(|part| {
            let part = part.trim();
            let lowered = part.to_ascii_lowercase();
            lowered
                .starts_with("charset=")
                .then(|| part[8..].trim().trim_matches('"').to_ascii_lowercase())
        })
        .unwrap_or_default();
    let text = || String::from_utf8_lossy(body).into_owned();
    if mime.is_empty() {
        return Body::Text(text());
    }
    if mime == "application/json" || mime == "application/scim+json" {
        let content = text();
        return match Json::parse(content.as_bytes()) {
            Ok(value) => Body::Json(value),
            Err(_) => Body::Text(content),
        };
    }
    if mime.starts_with("text/") || charset == "utf-8" {
        return Body::Text(text());
    }
    Body::Bytes(body.to_vec())
}

/// One call to GitHub, keeping the status and headers.
pub(crate) async fn github_request_response(
    account: &Account,
    method: &str,
    path: &str,
    body: Option<&Json>,
    params: &Pairs,
    headers: &Pairs,
) -> Result<Response> {
    let body = body.map(|value| value.dump().into_bytes());
    exchange(account, method, path, body, false, params, headers).await
}

/// One call whose body is the bytes given, as `gh api --input` sends a
/// file without reading it.
pub(crate) async fn github_request_bytes(
    account: &Account,
    method: &str,
    path: &str,
    body: &[u8],
    params: &Pairs,
    headers: &Pairs,
) -> Result<Response> {
    exchange(
        account,
        method,
        path,
        Some(body.to_vec()),
        true,
        params,
        headers,
    )
    .await
}

async fn exchange(
    account: &Account,
    method: &str,
    path: &str,
    body: Option<Vec<u8>>,
    raw_body: bool,
    params: &Pairs,
    headers: &Pairs,
) -> Result<Response> {
    let (reply, data) = account
        .host
        .ask(Request::Http {
            method: method.to_owned(),
            path: path.to_owned(),
            params: params.to_vec(),
            headers: headers.to_vec(),
            body,
            raw_body,
        })
        .await;
    if let Some(error) = reply.error {
        return Err(Failure::Connection(error));
    }
    let status = reply.status.unwrap_or(0.0) as u16;
    if let Some(message) = reply.message {
        let body = String::from_utf8_lossy(&data).into_owned();
        let parsed = if body.is_empty() {
            Json::Null
        } else {
            Json::parse(body.as_bytes()).unwrap_or_else(|_| Json::Str(body.clone()))
        };
        return Err(Failure::Api(Box::new(ApiError {
            joined: joined_message(status, &message, &reply.headers, &parsed),
            message,
            status,
            body,
            url: reply.url.unwrap_or_default(),
            headers: reply.headers,
            data: parsed,
            built_query: false,
        })));
    }
    let content_type = reply
        .headers
        .get("content-type")
        .cloned()
        .unwrap_or_default();
    Ok(Response {
        status,
        headers: reply.headers,
        data: decoded(&data, &content_type),
        raw: data,
    })
}

/// One call to GitHub and its decoded body.
pub(crate) async fn github_request(
    account: &Account,
    method: &str,
    path: &str,
    body: Option<&Json>,
) -> Result<Json> {
    Ok(
        github_request_response(account, method, path, body, &[], &[])
            .await?
            .data
            .into_json(),
    )
}

/// A path segment percent-encoded, every byte but the unreserved ones.
pub(crate) fn quote(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"_.-~".contains(&byte) {
            out.push(char::from(byte));
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Bytes from base64 text, whatever is not in its alphabet skipped.
pub(crate) fn decode_base64(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let (mut bits, mut held) = (0u32, 0u32);
    for byte in text.bytes() {
        let digit = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => {
                (bits, held) = (0, 0);
                continue;
            }
            _ => continue,
        };
        bits = (bits << 6) | u32::from(digit);
        held += 6;
        if held >= 8 {
            held -= 8;
            out.push((bits >> held) as u8);
            bits &= (1 << held) - 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failure(status: u16, kind: &str, body: &str) -> ApiError {
        let headers = BTreeMap::from([("content-type".to_owned(), kind.to_owned())]);
        let data = Json::parse(body.as_bytes()).unwrap_or_default();
        ApiError {
            joined: joined_message(status, "Server Error", &headers, &data),
            message: String::new(),
            status,
            body: body.to_owned(),
            url: "https://x/y".to_owned(),
            headers,
            data,
            built_query: false,
        }
    }

    #[test]
    fn a_built_query_failure_reads_as_its_client_words_it() {
        let mut error = failure(500, "text/plain", "boom");
        error.built_query = true;
        assert_eq!(
            error.text(),
            r#"non-200 OK status code: 500 Internal Server Error body: "boom""#
        );
    }

    #[test]
    fn an_api_failure_reads_as_go_gh_words_it() {
        let json = "application/json; charset=utf-8";
        let text = |status, kind, body| failure(status, kind, body).text();
        assert_eq!(
            text(404, json, r#"{"message":"Not Found"}"#),
            "HTTP 404: Not Found (https://x/y)"
        );
        assert_eq!(
            text(
                422,
                json,
                r#"{"message":"Validation Failed","errors":[{"resource":"Label","field":"name","code":"already_exists"},"plain",{"code":"custom","message":"own"}]}"#
            ),
            "HTTP 422: Validation Failed (https://x/y)\nLabel.name already exists\nplain\nown"
        );
        assert_eq!(
            text(500, "text/plain", "boom"),
            "HTTP 500: 500 Server Error (https://x/y)"
        );
        assert_eq!(text(502, json, "not json"), "HTTP 502 (https://x/y)");
        assert_eq!(
            text(422, json, r#"{"errors":"text"}"#),
            "HTTP 422 (https://x/y)"
        );
    }

    #[test]
    fn a_body_reads_by_its_content_type() {
        assert!(matches!(decoded(b"", "application/json"), Body::Empty));
        assert!(matches!(
            decoded(b"{}", "application/json; charset=utf-8"),
            Body::Json(_)
        ));
        assert!(matches!(decoded(b"{", "application/json"), Body::Text(_)));
        assert!(matches!(decoded(b"x", ""), Body::Text(_)));
        assert!(matches!(decoded(b"x", "text/plain"), Body::Text(_)));
        assert!(matches!(
            decoded(b"x", "application/vnd.github.v3.diff; charset=UTF-8"),
            Body::Text(_)
        ));
        assert!(matches!(decoded(b"PK", "application/zip"), Body::Bytes(_)));
    }

    #[test]
    fn a_path_segment_encodes_all_but_the_unreserved() {
        assert_eq!(quote("v1.0-rc_1~/a b"), "v1.0-rc_1~%2Fa%20b");
    }

    #[test]
    fn base64_skips_line_breaks_and_padding() {
        assert_eq!(decode_base64("aGk=\nCg==\n"), b"hi\n");
    }
}
