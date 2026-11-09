// Follows gh 2.85.0's pkg/cmd/api (MIT; see licenses/third_party/gh.txt).

use std::collections::BTreeMap;

use super::accessor::{Flags, Out, jq_lines, read_cli_file};
use super::args::wrong_count;
use crate::core::github::client::{
    Account, Failure, GRAPHQL_PATH, Response, Result, github_request_bytes,
    github_request_response, http_reason, usage, value,
};
use crate::core::github::json::{Json, Obj, quoted};
use crate::core::github::placeholder::expand;
use crate::core::github::repo::urlsplit;

/// One response as `gh api` prints it.
struct Printed {
    data: Json,
    raw: Vec<u8>,
    decoded: bool,
    head: String,
}

/// A failing response: its body verbatim, and its head as for any other.
struct Failed {
    body: Vec<u8>,
    head: String,
}

/// One `-F` literal as the JSON type it spells.
fn typed(text: &str) -> Json {
    match text {
        "true" => true.into(),
        "false" => false.into(),
        "null" => Json::Null,
        _ => {
            let digits = text.strip_prefix('-').unwrap_or(text);
            if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) {
                if let Ok(number) = text.parse::<i128>() {
                    return Json::Int(number);
                }
            }
            text.into()
        }
    }
}

fn key_parts(key: &str) -> Result<Vec<Option<String>>> {
    let invalid = || Failure::Value(format!(r#"invalid field key: "{key}""#));
    let head_end = key.find(['[', ']']).unwrap_or(key.len());
    if head_end == 0 {
        return Err(invalid());
    }
    let mut parts = vec![Some(key[..head_end].to_owned())];
    let mut rest = &key[head_end..];
    while !rest.is_empty() {
        let inner = rest.strip_prefix('[').ok_or_else(invalid)?;
        let end = inner.find(['[', ']']).ok_or_else(invalid)?;
        if !inner[end..].starts_with(']') {
            return Err(invalid());
        }
        let name = &inner[..end];
        parts.push((!name.is_empty()).then(|| name.to_owned()));
        rest = &inner[end + 1..];
    }
    Ok(parts)
}

fn wanted(next: &Option<String>) -> Json {
    if next.is_none() {
        Json::Arr(Vec::new())
    } else {
        Json::Obj(Obj::new())
    }
}

fn same_kind(a: &Json, b: &Json) -> bool {
    matches!(
        (a, b),
        (Json::Arr(_), Json::Arr(_)) | (Json::Obj(_), Json::Obj(_))
    )
}

const MIXED: &str = "field nesting mixes an object and an array";

fn put(container: &mut Json, parts: &[Option<String>], item: Option<&Json>) -> Result<()> {
    let tail = &parts[1..];
    if let Some(token) = &parts[0] {
        let Json::Obj(obj) = container else {
            return value(MIXED);
        };
        if tail.is_empty() {
            obj.set(token.as_str(), item.cloned().unwrap_or_default());
            return Ok(());
        }
        let fresh = wanted(&tail[0]);
        if !obj
            .find(token)
            .is_some_and(|child| same_kind(child, &fresh))
        {
            obj.set(token.as_str(), fresh);
        }
        return put(obj.find_mut(token).expect("set above"), tail, item);
    }
    let Json::Arr(items) = container else {
        return value(MIXED);
    };
    if tail.is_empty() {
        if let Some(item) = item {
            items.push(item.clone());
        }
        return Ok(());
    }
    let fresh = wanted(&tail[0]);
    let mut reuse = items.last().is_some_and(|child| same_kind(child, &fresh));
    if reuse {
        if let (Some(Json::Obj(child)), Some(next)) = (items.last(), &tail[0]) {
            reuse = !child.has(next) || (tail.len() > 1 && tail[1].is_none());
        }
    }
    if !reuse {
        items.push(fresh);
    }
    put(items.last_mut().expect("pushed above"), tail, item)
}

async fn fields(account: &Account, flags: &Flags) -> Result<Obj> {
    let mut out = Json::Obj(Obj::new());
    for pair in flags.as_list("raw_field") {
        let Some((key, item)) = pair.split_once('=') else {
            return value(format!("invalid key: {}", quoted(&pair)));
        };
        put(&mut out, &key_parts(key)?, Some(&Json::from(item)))?;
    }
    for pair in flags.as_list("field") {
        let split = pair.split_once('=');
        let (key, item) = match split {
            Some((key, item)) => (key, Some(item)),
            None if pair.ends_with("[]") => (pair.as_str(), None),
            None => return value(format!("invalid key: {}", quoted(&pair))),
        };
        let landed = match item {
            None => None,
            Some(item) => {
                let expanded = expand(item, account)?;
                Some(match expanded.strip_prefix('@') {
                    Some(path) => {
                        let bytes = read_cli_file(account, None, Some(path), "--field")
                            .await
                            .map_err(|failure| {
                                Failure::Value(format!(
                                    "error parsing {} value: {}",
                                    quoted(key),
                                    failure.text()
                                ))
                            })?;
                        Json::Str(String::from_utf8_lossy(&bytes).into_owned())
                    }
                    None => typed(&expanded),
                })
            }
        };
        put(&mut out, &key_parts(key)?, landed.as_ref())?;
    }
    Ok(match out {
        Json::Obj(obj) => obj,
        _ => Obj::new(),
    })
}

fn request_headers(flags: &Flags) -> Result<Vec<(String, String)>> {
    let mut headers: Vec<(String, String)> = Vec::new();
    for header in flags.as_list("header") {
        let split = header
            .split_once(':')
            .filter(|(key, _)| !key.trim().is_empty());
        let Some((key, item)) = split else {
            return value(format!(
                "header {} requires a value separated by ':'",
                quoted(&header)
            ));
        };
        let key = key.trim().to_owned();
        let item = item.trim().to_owned();
        match headers.iter_mut().find(|(name, _)| *name == key) {
            Some(slot) => slot.1 = item,
            None => headers.push((key, item)),
        }
    }
    Ok(headers)
}

async fn input_body(account: &Account, flags: &Flags) -> Result<Option<Vec<u8>>> {
    if flags.raw("input").is_none() {
        return Ok(None);
    }
    read_cli_file(account, Some("input"), None, "--input")
        .await
        .map(Some)
}

fn query_value(item: &Json) -> String {
    match item {
        Json::Str(text) => text.clone(),
        other => other.dump(),
    }
}

fn next_path(link: Option<&str>, base_url: Option<&str>) -> Option<String> {
    let link = link.filter(|link| !link.is_empty())?;
    for item in link.split(',') {
        let item = item.trim_start();
        let Some(rest) = item.strip_prefix('<') else {
            continue;
        };
        let Some((target, tail)) = rest.split_once('>') else {
            continue;
        };
        if target.is_empty() {
            continue;
        }
        let Some(tail) = tail.trim_start().strip_prefix(';') else {
            continue;
        };
        let Some(rel) = tail.trim_start().strip_prefix("rel=\"") else {
            continue;
        };
        let Some((rel, _)) = rel.split_once('"') else {
            continue;
        };
        if rel.is_empty() || !rel.split_whitespace().any(|word| word == "next") {
            continue;
        }
        let parsed = urlsplit(target).unwrap_or_default();
        let (path, query) = if parsed.scheme.is_empty() {
            let (path, query) = target.split_once('?').unwrap_or((target, ""));
            (path.to_owned(), query.to_owned())
        } else {
            (parsed.path, parsed.query)
        };
        let mut path = if path.starts_with('/') {
            path
        } else {
            format!("/{path}")
        };
        let base = urlsplit(base_url.unwrap_or("")).unwrap_or_default();
        let base_path = base.path.trim_end_matches('/');
        if !base_path.is_empty()
            && (path == base_path || path.starts_with(&format!("{base_path}/")))
        {
            path = match &path[base_path.len()..] {
                "" => "/".to_owned(),
                rest => rest.to_owned(),
            };
        }
        return Some(if query.is_empty() {
            path
        } else {
            format!("{path}?{query}")
        });
    }
    None
}

fn canonical(name: &str) -> String {
    name.to_lowercase()
        .split('-')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().chain(chars).collect::<String>(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join("-")
}

/// The status line and headers `gh api -i` prints before a body. The
/// body arrives decoded, so the headers describing its encoded form are
/// dropped.
fn response_head(status: u16, headers: &BTreeMap<String, String>) -> String {
    let decoded = headers.contains_key("content-encoding");
    let dropped = |name: &str| {
        name == "Status" || (decoded && matches!(name, "Content-Encoding" | "Content-Length"))
    };
    let mut lines: Vec<(String, &String)> = headers
        .iter()
        .map(|(name, item)| (canonical(name), item))
        .filter(|(name, _)| !dropped(name))
        .collect();
    lines.sort();
    let rows: String = lines
        .iter()
        .map(|(name, item)| format!("{name}: {item}\r\n"))
        .collect();
    format!("HTTP/1.1 {status} {}\n{rows}\r\n", http_reason(status))
}

/// What gh reports from a JSON error body, empty when it names nothing.
fn server_error(data: &Json, status: u16) -> String {
    let Some(obj) = data.as_obj() else {
        return String::new();
    };
    let message = obj.get("message").text();
    if let Json::Str(errors) = obj.get("errors") {
        if !errors.is_empty() {
            return if message.is_empty() {
                errors.clone()
            } else {
                format!("{errors} ({message})")
            };
        }
    }
    if !message.is_empty() {
        return format!("{message} (HTTP {status})");
    }
    match obj.get("errors") {
        Json::Arr(entries) => entries
            .iter()
            .filter_map(|entry| match entry {
                Json::Str(text) => Some(text.clone()),
                Json::Obj(_) => Some(entry.get("message").text().to_owned()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn joined(parts: Vec<Vec<u8>>, between: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for (at, part) in parts.into_iter().enumerate() {
        if at > 0 {
            out.extend_from_slice(between);
        }
        out.extend(part);
    }
    out
}

fn with_head(page: &Printed) -> Vec<u8> {
    let mut out = page.head.clone().into_bytes();
    out.extend_from_slice(&page.raw);
    out
}

fn failed_part(failure: &Failed) -> Vec<u8> {
    let mut out = failure.head.clone().into_bytes();
    out.extend_from_slice(&failure.body);
    out
}

/// The bodies of `--paginate` joined as gh's paginatedArrayReader joins
/// them, so array pages print as one array.
fn joined_pages(pages: &[Printed], more: bool) -> Vec<u8> {
    let mut out = Vec::new();
    let count = pages.len();
    for (at, page) in pages.iter().enumerate() {
        let mut text: &[u8] = &page.raw;
        let mut lead: &[u8] = b"";
        if page.decoded {
            if at > 0 && text.starts_with(b"[") {
                lead = if text.starts_with(b"[]") { b" " } else { b"," };
                text = &text[1..];
            }
            if (more || at + 1 < count) && text.ends_with(b"]") {
                text = &text[..text.len() - 1];
            }
        }
        out.extend_from_slice(lead);
        out.extend_from_slice(text);
    }
    out
}

fn with_printed(failure: Failure, before: Vec<u8>) -> Failure {
    match failure {
        Failure::Printed { output, message } => {
            let mut all = before;
            all.extend(output);
            Failure::Printed {
                output: all,
                message,
            }
        }
        other => other,
    }
}

/// The completed pages, then a failing response's body.
async fn render_pages(
    account: &Account,
    pages: &[Printed],
    flags: &Flags,
    failure: Option<&Failed>,
) -> Result<Vec<u8>> {
    let include = flags.gh_bool("include");
    let between: &[u8] = if include { b"\n" } else { b"" };
    let heads = || pages.iter().map(|page| page.head.clone().into_bytes());
    if flags.gh_bool("silent") {
        let every: Vec<Vec<u8>> = heads()
            .chain(failure.map(|failure| failure.head.clone().into_bytes()))
            .collect();
        return Ok(joined(every, between));
    }
    let slurp = flags.gh_bool("slurp");
    let mut comma = between.to_vec();
    comma.push(b',');
    let printed = || pages.iter().map(with_head);
    if slurp {
        if let Some(failure) = failure {
            let parts: Vec<Vec<u8>> = printed().chain([failed_part(failure)]).collect();
            let mut out = b"[".to_vec();
            out.extend(joined(parts, &comma));
            out.push(b']');
            return Ok(out);
        }
    }
    if let Some(program) = flags.as_str("jq").filter(|program| !program.is_empty()) {
        if !include || slurp {
            let data: Vec<Json> = pages.iter().map(|page| page.data.clone()).collect();
            let values = if slurp { vec![Json::Arr(data)] } else { data };
            let mut out = joined(heads().collect(), between);
            let lines = jq_lines(account, &values, program)
                .await
                .map_err(|failure| with_printed(failure, out.clone()))?;
            out.extend(lines.into_bytes());
            if let Some(failure) = failure {
                out.extend_from_slice(&failure.body);
            }
            return Ok(out);
        }
        let mut parts: Vec<Vec<u8>> = Vec::new();
        for page in pages {
            match jq_lines(account, std::slice::from_ref(&page.data), program).await {
                Ok(lines) => {
                    let mut part = page.head.clone().into_bytes();
                    part.extend(lines.into_bytes());
                    parts.push(part);
                }
                Err(failure) => {
                    parts.push(page.head.clone().into_bytes());
                    return Err(with_printed(failure, joined(parts, between)));
                }
            }
        }
        parts.extend(failure.map(failed_part));
        return Ok(joined(parts, between));
    }
    if slurp {
        let mut out = b"[".to_vec();
        out.extend(joined(printed().collect(), &comma));
        out.push(b']');
        return Ok(out);
    }
    if include {
        let parts: Vec<Vec<u8>> = printed().chain(failure.map(failed_part)).collect();
        return Ok(joined(parts, between));
    }
    let mut out = joined_pages(pages, failure.is_some());
    if let Some(failure) = failure {
        out.extend_from_slice(&failure.body);
    }
    Ok(out)
}

async fn failed(
    account: &Account,
    pages: &[Printed],
    flags: &Flags,
    failure: Failed,
    diagnostic: String,
) -> Result<Out> {
    Ok(Out {
        stdout: render_pages(account, pages, flags, Some(&failure)).await?,
        stderr: format!("gh: {diagnostic}\n").into_bytes(),
        exit: 1,
    })
}

fn printed(response: Response, head: String) -> Printed {
    let decoded = matches!(response.data, crate::core::github::client::Body::Json(_));
    Printed {
        raw: response.raw,
        decoded,
        data: response.data.into_json(),
        head,
    }
}

/// A GraphQL body as gh groups one: `query` and `operationName` at the top and
/// every other field under `variables`.
fn graphql_body(fields: &Obj) -> Obj {
    let mut top = Obj::new();
    let mut variables = Obj::new();
    for (key, item) in fields.iter() {
        if key == "query" || key == "operationName" {
            top.set(key.clone(), item.clone());
        } else {
            variables.set(key.clone(), item.clone());
        }
    }
    if !variables.is_empty() {
        top.set("variables", Json::Obj(variables));
    }
    top
}

/// Where a request carries its fields: the query string or a JSON body.
fn placed(fields: &Obj, in_query: bool, graphql: bool) -> (Vec<(String, String)>, Option<Json>) {
    if in_query {
        let params = fields
            .iter()
            .map(|(key, item)| (key.clone(), query_value(item)))
            .collect();
        (params, None)
    } else if fields.is_empty() {
        (Vec::new(), None)
    } else if graphql {
        (Vec::new(), Some(Json::Obj(graphql_body(fields))))
    } else {
        (Vec::new(), Some(Json::Obj(fields.clone())))
    }
}

/// Reads `pageInfo` objects in document order until both fields have been seen.
fn scan_page_info(data: &Json, cursor: &mut Option<String>, more: &mut Option<bool>) {
    match data {
        Json::Arr(items) => {
            for item in items {
                scan_page_info(item, cursor, more);
            }
        }
        Json::Obj(fields) => {
            for (key, item) in fields.iter() {
                if cursor.is_some() && more.is_some() {
                    return;
                }
                match (key.as_str(), item) {
                    ("pageInfo", Json::Obj(info)) => {
                        if let Json::Str(text) = info.get("endCursor") {
                            *cursor = Some(text.clone());
                        }
                        if let Json::Bool(next) = info.get("hasNextPage") {
                            *more = Some(*next);
                        }
                    }
                    _ => scan_page_info(item, cursor, more),
                }
            }
        }
        _ => {}
    }
}

/// The `endCursor` of a GraphQL answer that has another page.
fn end_cursor(data: &Json) -> Option<String> {
    let (mut cursor, mut more) = (None, None);
    scan_page_info(data, &mut cursor, &mut more);
    cursor.filter(|text| more == Some(true) && !text.is_empty())
}

/// The combinations `gh api` refuses before it reads a field.
fn check_flags(flags: &Flags, endpoint: &str) -> Result<()> {
    let paginate = flags.gh_bool("paginate");
    let method = flags.as_str("method").unwrap_or("GET");
    if paginate && !method.eq_ignore_ascii_case("GET") && endpoint != GRAPHQL_PATH {
        return usage("the `--paginate` option is not supported for non-GET requests");
    }
    if paginate && flags.raw("input").is_some() {
        return usage("the `--paginate` option is not supported with `--input`");
    }
    let jq = flags.as_nonempty("jq").is_some();
    let template = flags.as_nonempty("template").is_some();
    if flags.gh_bool("slurp") {
        if jq || template {
            return usage("the `--slurp` option is not supported with `--jq` or `--template`");
        }
        if !paginate {
            return usage("`--paginate` required when passing `--slurp`");
        }
    }
    let outputs = [
        flags.gh_bool("verbose"),
        flags.gh_bool("silent"),
        jq,
        template,
    ];
    if outputs.iter().filter(|on| **on).count() > 1 {
        return usage("only one of `--template`, `--jq`, `--silent`, or `--verbose` may be used");
    }
    Ok(())
}

/// The supported, noninteractive `gh api` surface.
pub(crate) async fn api(account: &Account, flags: &Flags, texts: &[String]) -> Result<Out> {
    let [endpoint] = texts else {
        return wrong_count(1, texts);
    };
    check_flags(flags, endpoint)?;
    let mut fields = fields(account, flags).await?;
    let input = input_body(account, flags).await?;
    let fallback = if !fields.is_empty() || input.is_some() {
        "POST"
    } else {
        "GET"
    };
    let method = flags.as_str("method").unwrap_or(fallback);
    let upper = method.to_uppercase();
    let wire = if upper.is_empty() {
        "GET"
    } else {
        upper.as_str()
    };
    let mut path = expand(endpoint, account)?;
    if path != GRAPHQL_PATH && !path.starts_with('/') {
        path = format!("/{path}");
    }
    let graphql = path == GRAPHQL_PATH;
    let in_query = input.is_some() || upper == "GET";
    let (mut params, mut body) = placed(&fields, in_query, graphql);
    let include = flags.gh_bool("include");
    let headers = request_headers(flags)?;
    let mut pages: Vec<Printed> = Vec::new();
    let mut current = Some(path);
    while let Some(target) = current.take() {
        let answer = match &input {
            Some(bytes) => {
                github_request_bytes(account, wire, &target, bytes, &params, &headers).await
            }
            None => {
                github_request_response(account, wire, &target, body.as_ref(), &params, &headers)
                    .await
            }
        };
        let response = match answer {
            Ok(response) => response,
            Err(Failure::Api(error)) => {
                let head = if include {
                    response_head(error.status, &error.headers)
                } else {
                    String::new()
                };
                let diagnostic = match server_error(&error.data, error.status) {
                    text if text.is_empty() => format!("HTTP {}", error.status),
                    text => text,
                };
                let failure = Failed {
                    body: error.body.into_bytes(),
                    head,
                };
                return failed(account, &pages, flags, failure, diagnostic).await;
            }
            Err(failure) => return Err(failure),
        };
        let head = if include {
            response_head(response.status, &response.headers)
        } else {
            String::new()
        };
        let link = response.headers.get("link").cloned();
        let status = response.status;
        let page = printed(response, head);
        if endpoint == "graphql" {
            let diagnostic = server_error(&page.data, status);
            if !diagnostic.is_empty() {
                let failure = Failed {
                    body: page.raw,
                    head: page.head,
                };
                return failed(account, &pages, flags, failure, diagnostic).await;
            }
        }
        let cursor = end_cursor(&page.data);
        pages.push(page);
        if !flags.gh_bool("paginate") {
            continue;
        }
        if !graphql {
            params.clear();
            current = next_path(link.as_deref(), account.base_url.as_deref());
        } else if let Some(cursor) = cursor {
            fields.set("endCursor", cursor);
            (params, body) = placed(&fields, in_query, graphql);
            current = Some(target);
        }
    }
    Ok(Out {
        stdout: render_pages(account, &pages, flags, None).await?,
        ..Out::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nested(pairs: &[(&str, Option<&str>)]) -> String {
        let mut out = Json::Obj(Obj::new());
        for (key, item) in pairs {
            let landed = item.map(typed);
            put(&mut out, &key_parts(key).unwrap(), landed.as_ref()).unwrap();
        }
        out.dump()
    }

    #[test]
    fn a_graphql_body_nests_its_variables() {
        let mut fields = Obj::new();
        fields.set("query", "q");
        fields.set("operationName", "o");
        fields.set("id", "x");
        assert_eq!(
            Json::Obj(graphql_body(&fields)).dump(),
            r#"{"query":"q","operationName":"o","variables":{"id":"x"}}"#
        );
        fields = Obj::new();
        fields.set("query", "q");
        assert_eq!(Json::Obj(graphql_body(&fields)).dump(), r#"{"query":"q"}"#);
    }

    #[test]
    fn a_graphql_answer_names_its_next_page() {
        let answer = |more: &str| {
            Json::parse(
                format!(
                    r#"{{"data":{{"a":[{{"pageInfo":{{"hasNextPage":{more},"endCursor":"c"}}}}]}}}}"#
                )
                .as_bytes(),
            )
            .unwrap()
        };
        assert_eq!(end_cursor(&answer("true")).as_deref(), Some("c"));
        assert_eq!(end_cursor(&answer("false")), None);
    }

    #[test]
    fn a_field_key_builds_objects_and_arrays() {
        assert_eq!(nested(&[("a[b]", Some("1"))]), r#"{"a":{"b":1}}"#);
        assert_eq!(
            nested(&[("a[]", Some("x")), ("a[]", Some("y"))]),
            r#"{"a":["x","y"]}"#
        );
        assert_eq!(nested(&[("a[]", None)]), r#"{"a":[]}"#);
        assert_eq!(
            nested(&[
                ("p[][n]", Some("1")),
                ("p[][v]", Some("2")),
                ("p[][n]", Some("3"))
            ]),
            r#"{"p":[{"n":1,"v":2},{"n":3}]}"#
        );
    }

    #[test]
    fn a_key_with_unbalanced_brackets_is_refused() {
        assert!(key_parts("a[").is_err());
        assert!(key_parts("[a]").is_err());
        assert!(key_parts("a]b").is_err());
    }

    #[test]
    fn minus_f_reads_the_type_it_spells() {
        assert_eq!(typed("true"), Json::Bool(true));
        assert_eq!(typed("null"), Json::Null);
        assert_eq!(typed("-12"), Json::Int(-12));
        assert_eq!(typed("1.5"), Json::from("1.5"));
    }

    #[test]
    fn the_next_page_comes_from_its_link_relation() {
        let link = r#"<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=3>; rel="next""#;
        assert_eq!(next_path(Some(link), None).as_deref(), Some("/x?page=3"));
        let ghe = r#"<https://ghe/api/v3/x?page=2>; rel="next""#;
        assert_eq!(
            next_path(Some(ghe), Some("https://ghe/api/v3")).as_deref(),
            Some("/x?page=2")
        );
        assert_eq!(next_path(Some(r#"<a>; rel="last""#), None), None);
    }

    #[test]
    fn headers_print_canonically_and_sorted() {
        let mut headers = BTreeMap::new();
        headers.insert("x-b".to_owned(), "2".to_owned());
        headers.insert("content-type".to_owned(), "t".to_owned());
        headers.insert("status".to_owned(), "200".to_owned());
        assert_eq!(
            response_head(200, &headers),
            "HTTP/1.1 200 OK\nContent-Type: t\r\nX-B: 2\r\n\r\n"
        );
    }

    #[test]
    fn a_json_error_body_names_its_failure() {
        let body = |text: &str| Json::parse(text.as_bytes()).unwrap();
        assert_eq!(
            server_error(&body(r#"{"message":"No"}"#), 404),
            "No (HTTP 404)"
        );
        assert_eq!(
            server_error(&body(r#"{"errors":[{"message":"a"},"b"]}"#), 200),
            "a\nb"
        );
        assert_eq!(server_error(&body(r#"{"data":1}"#), 200), "");
    }

    fn page(raw: &str) -> Printed {
        Printed {
            data: Json::Null,
            raw: raw.as_bytes().to_vec(),
            decoded: true,
            head: String::new(),
        }
    }

    #[test]
    fn array_pages_join_into_one_array() {
        let pages = [page("[1]"), page("[]"), page("[2]")];
        assert_eq!(joined_pages(&pages, false), b"[1 ,2]");
    }
}
