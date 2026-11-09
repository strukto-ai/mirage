// The --jq output and the github.com host rule follow go-gh v2.13.0
// (MIT; see licenses/third_party/go-gh.txt).

use super::constants::{API_BASE, CONNECT_HINT, GITHUB_HOST, INVALID_LIMIT, gojq_raised};
use super::template::render_template;
use crate::core::github::client::{Account, Failure, Result, usage, value};
use crate::core::github::json::{Json, Obj, float_text, quote_into, quoted};
use crate::core::github::repo::{RepoRef, parse_repo, repo_host, urlsplit};
use crate::request::{Reply, Request};

/// What a command answered with.
#[derive(Default)]
pub(crate) struct Out {
    pub(crate) stdout: Vec<u8>,
    pub(crate) stderr: Vec<u8>,
    pub(crate) exit: i32,
}

impl Out {
    pub(crate) fn text(text: impl Into<String>) -> Out {
        Out {
            stdout: text.into().into_bytes(),
            ..Out::default()
        }
    }

    pub(crate) fn failed(stderr: impl Into<String>) -> Out {
        Out {
            stderr: stderr.into().into_bytes(),
            exit: 1,
            ..Out::default()
        }
    }

    pub(crate) fn warned(stderr: impl Into<String>) -> Out {
        Out {
            stderr: stderr.into().into_bytes(),
            ..Out::default()
        }
    }
}

/// The flags the host's parser read, by dest: a boolean, a number, text,
/// a repeated option's list, or a path as `{"path": ...}`.
pub(crate) struct Flags(pub(crate) Obj);

impl Flags {
    pub(crate) fn raw(&self, name: &str) -> Option<&Json> {
        self.0.find(name).filter(|value| !value.is_null())
    }

    pub(crate) fn as_bool(&self, name: &str) -> bool {
        match self.0.get(name) {
            Json::Bool(value) => *value,
            Json::Int(value) => *value > 0,
            _ => false,
        }
    }

    /// Whether a gh boolean flag is on: given bare, or as `=true`.
    pub(crate) fn gh_bool(&self, name: &str) -> bool {
        self.as_bool(name) || self.as_str(name) == Some("true")
    }

    pub(crate) fn as_int(&self, name: &str) -> Option<i64> {
        match self.0.get(name) {
            Json::Int(value) => i64::try_from(*value).ok(),
            Json::Str(text) => text.parse().ok(),
            _ => None,
        }
    }

    pub(crate) fn as_str(&self, name: &str) -> Option<&str> {
        self.0.get(name).as_str()
    }

    pub(crate) fn as_nonempty(&self, name: &str) -> Option<&str> {
        self.as_str(name).filter(|text| !text.is_empty())
    }

    pub(crate) fn as_list(&self, name: &str) -> Vec<String> {
        match self.0.get(name) {
            Json::Arr(items) => items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect(),
            Json::Str(text) => vec![text.clone()],
            _ => Vec::new(),
        }
    }
}

/// Refuse a repository on a host this install cannot reach, in gh's words.
pub(crate) fn check_host(account: &Account, host: Option<&str>) -> Result<()> {
    let Some(host) = host else { return Ok(()) };
    let host = host.to_lowercase();
    if host == GITHUB_HOST || host.ends_with(&format!(".{GITHUB_HOST}")) {
        return Ok(());
    }
    let base = account
        .base_url
        .as_deref()
        .filter(|base| !base.is_empty())
        .and_then(urlsplit)
        .and_then(|split| split.hostname());
    if base.as_deref() == Some(host.as_str()) {
        return Ok(());
    }
    value(format!("error connecting to {host}\n{CONNECT_HINT}"))
}

/// The host the install's GitHub serves its pages from.
pub(crate) fn web_host(account: &Account) -> Result<String> {
    let base = match account.base_url.as_deref() {
        None => return Ok(GITHUB_HOST.to_owned()),
        Some(base) if base.trim_end_matches('/') == API_BASE => return Ok(GITHUB_HOST.to_owned()),
        Some(base) => base,
    };
    let split = urlsplit(base);
    let host = split.as_ref().and_then(|split| split.hostname());
    match (split, host) {
        (Some(split), Some(host))
            if matches!(split.scheme.as_str(), "http" | "https") && valid_port(&split.netloc) =>
        {
            Ok(host)
        }
        _ => value("Invalid URL"),
    }
}

fn valid_port(netloc: &str) -> bool {
    let info = netloc.rsplit_once('@').map_or(netloc, |(_, tail)| tail);
    let tail = match info.rfind(']') {
        Some(at) => &info[at + 1..],
        None => info,
    };
    match tail.split_once(':') {
        Some((_, port)) if !port.is_empty() => port.parse::<u16>().is_ok(),
        _ => true,
    }
}

/// A URL GitHub answered with, as the path the install's base resolves.
pub(crate) fn relative_path(account: &Account, url: &str) -> String {
    let Some(split) = urlsplit(url) else {
        return url.to_owned();
    };
    let prefix = account
        .base_url
        .as_deref()
        .and_then(urlsplit)
        .map_or_else(String::new, |base| {
            base.path.trim_end_matches('/').to_owned()
        });
    let path = split
        .path
        .strip_prefix(&prefix)
        .unwrap_or(&split.path)
        .to_owned();
    if split.query.is_empty() {
        path
    } else {
        format!("{path}?{}", split.query)
    }
}

/// The repository a line is about: the one it named, else the install's.
pub(crate) fn gh_repo(account: &Account, spec: Option<&str>) -> Result<RepoRef> {
    let named = match spec.filter(|spec| !spec.is_empty()) {
        Some(spec) => spec,
        None => account.repo.as_deref().unwrap_or(""),
    };
    if named.is_empty() {
        return value("no repository given; pass one or set `repo` on the install");
    }
    named_repo(account, named)
}

/// A repository a line names, refused when this install cannot reach its
/// host.
pub(crate) fn named_repo(account: &Account, spec: &str) -> Result<RepoRef> {
    let target = parse_repo(spec)?;
    check_host(account, repo_host(spec)?.as_deref())?;
    Ok(target)
}

pub(crate) fn repo_for(account: &Account, flags: &Flags) -> Result<RepoRef> {
    gh_repo(account, flags.as_str("repo"))
}

/// A list verb's `--limit`, refused below 1 the way gh refuses it; a
/// `refusal` of None takes any value.
pub(crate) fn list_limit(flags: &Flags, default: i64, refusal: Option<&str>) -> Result<i64> {
    let limit = flags.as_int("limit").unwrap_or(default);
    match refusal {
        Some(refusal) if limit < 1 => usage(format!("{refusal}: {limit}")),
        _ => Ok(limit),
    }
}

pub(crate) fn limit_or_refuse(flags: &Flags, default: i64) -> Result<i64> {
    list_limit(flags, default, Some(INVALID_LIMIT))
}

/// The number a selector spells out, `#` optional.
pub(crate) fn subject_number(raw: &str) -> Option<i128> {
    let digits = raw.strip_prefix('#').unwrap_or(raw);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// The subject a selector names outright: its number, or its URL, of
/// which gh reads the path alone.
pub(crate) fn numbered_subject(
    account: &Account,
    flags: &Flags,
    raw: &str,
    url_kind: &str,
) -> Result<Option<(RepoRef, i128)>> {
    if let Some(number) = subject_number(raw) {
        return Ok(Some((repo_for(account, flags)?, number)));
    }
    let Some(url) = urlsplit(raw) else {
        return Ok(None);
    };
    if !matches!(url.scheme.as_str(), "http" | "https") {
        return Ok(None);
    }
    let Some(path) = url.path.strip_prefix('/') else {
        return Ok(None);
    };
    let parts: Vec<&str> = path.splitn(4, '/').collect();
    if parts.len() < 4 || parts[0].is_empty() || parts[1].is_empty() {
        return Ok(None);
    }
    if !matches!(parts[2], "issues" | "pull") || (url_kind == "pull" && parts[2] != "pull") {
        return Ok(None);
    }
    let end = parts[3]
        .find(|c: char| !c.is_ascii_digit())
        .unwrap_or(parts[3].len());
    let Ok(number) = parts[3][..end].parse::<i128>() else {
        return Ok(None);
    };
    check_host(account, url.hostname().as_deref())?;
    Ok(Some((
        parse_repo(&format!("{}/{}", parts[0], parts[1]))?,
        number,
    )))
}

pub(crate) fn repo_number(
    account: &Account,
    flags: &Flags,
    raw: &str,
    label: &str,
    url_kind: &str,
) -> Result<(RepoRef, i128)> {
    match numbered_subject(account, flags, raw, url_kind)? {
        Some(found) => Ok(found),
        None => value(format!("invalid {label} format: {}", quoted(raw))),
    }
}

/// The branch the install's `branch` stands in for a checkout's.
pub(crate) fn current_branch(account: &Account) -> Option<&str> {
    account
        .branch
        .as_deref()
        .filter(|branch| !branch.is_empty())
}

/// Repeatable comma-separated flags, in order.
pub(crate) fn csv_values(values: &[String]) -> Vec<String> {
    values
        .iter()
        .flat_map(|value| value.split(','))
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_owned)
        .collect()
}

/// A command's only argument, refused as gh's ExactArgs refuses one.
pub(crate) fn exact_one<'a>(texts: &'a [String], missing: &str) -> Result<&'a String> {
    match texts {
        [only] => Ok(only),
        [] => usage(missing),
        _ => usage("too many arguments"),
    }
}

/// A title with its runs of whitespace closed up, as gh's tables print
/// one.
pub(crate) fn one_line(text: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in text.trim().chars() {
        if matches!(c, '\t' | '\n' | '\x0c' | '\r' | ' ') {
            gap = true;
            continue;
        }
        if gap {
            out.push(' ');
            gap = false;
        }
        out.push(c);
    }
    out
}

/// A row of a table printed where stdout is no terminal.
pub(crate) fn tsv(fields: &[String]) -> String {
    format!("{}\n", fields.join("\t"))
}

/// A time in a table printed where stdout is no terminal: RFC 3339, Go's
/// zero time when there is none.
pub(crate) fn time_field(value: &Json) -> String {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .unwrap_or("0001-01-01T00:00:00Z")
        .to_owned()
}

/// Nanoseconds since the epoch of a GitHub timestamp.
pub(crate) fn instant(text: &str) -> Option<i128> {
    let (date, rest) = text.split_once('T')?;
    let mut parts = date.split('-');
    let year: i64 = parts.next()?.parse().ok()?;
    let month: i64 = parts.next()?.parse().ok()?;
    let day: i64 = parts.next()?.parse().ok()?;
    let split = rest.find(['Z', '+', '-'])?;
    let (clock, zone) = rest.split_at(split);
    let mut units = clock.split(':');
    let hour: i64 = units.next()?.parse().ok()?;
    let minute: i64 = units.next()?.parse().ok()?;
    let (whole, fraction) = units
        .next()?
        .split_once('.')
        .unwrap_or((clock.rsplit(':').next()?, ""));
    let second: i64 = whole.parse().ok()?;
    let nanos: i128 = format!("{fraction:0<9}").get(..9)?.parse().ok()?;
    let offset = match zone.split_at(1) {
        ("Z", _) => 0,
        (sign, tail) => {
            let (h, m) = tail.split_once(':')?;
            let span = h.parse::<i64>().ok()? * 3600 + m.parse::<i64>().ok()? * 60;
            if sign == "-" { -span } else { span }
        }
    };
    let shifted = if month <= 2 { year - 1 } else { year };
    let era = shifted.div_euclid(400);
    let of_era = shifted.rem_euclid(400);
    let of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let of_cycle = of_era * 365 + of_era / 4 - of_era / 100 + of_year;
    let days = era * 146_097 + of_cycle - 719_468;
    let seconds = days * 86_400 + hour * 3600 + minute * 60 + second - offset;
    Some(i128::from(seconds) * 1_000_000_000 + nanos)
}

/// A length of time as Go prints a Duration.
pub(crate) fn go_duration(nanos: i128) -> String {
    if nanos == 0 {
        return "0s".to_owned();
    }
    let sign = if nanos < 0 { "-" } else { "" };
    let size = nanos.unsigned_abs();
    let fixed = |value: u128, unit: u128| {
        let text = format!(
            "{}.{:0width$}",
            value / unit,
            value % unit,
            width = unit.ilog10() as usize
        );
        text.trim_end_matches('0').trim_end_matches('.').to_owned()
    };
    if size < 1_000 {
        return format!("{sign}{size}ns");
    }
    if size < 1_000_000 {
        return format!("{sign}{}µs", fixed(size, 1_000));
    }
    if size < 1_000_000_000 {
        return format!("{sign}{}ms", fixed(size, 1_000_000));
    }
    let seconds = fixed(size % 60_000_000_000, 1_000_000_000);
    let minutes = size / 60_000_000_000;
    if minutes == 0 {
        return format!("{sign}{seconds}s");
    }
    if minutes < 60 {
        return format!("{sign}{minutes}m{seconds}s");
    }
    format!("{sign}{}h{}m{seconds}s", minutes / 60, minutes % 60)
}

/// A path-valued option's file, read through the workspace, or `-` from
/// standard input.
pub(crate) async fn read_cli_file(
    account: &Account,
    flag: Option<&str>,
    path: Option<&str>,
    option: &str,
) -> Result<Vec<u8>> {
    let (reply, data) = account
        .host
        .ask(Request::ReadFile {
            flag: flag.map(str::to_owned),
            path: path.map(str::to_owned),
            option: option.to_owned(),
        })
        .await;
    match reply.error {
        Some(error) => value(error),
        None => Ok(data),
    }
}

/// Mutually exclusive inline and file or stdin text options.
pub(crate) async fn body_value(
    account: &Account,
    flags: &Flags,
    inline: &str,
    file: &str,
    required: bool,
    clash: Option<&str>,
) -> Result<Option<String>> {
    let spelled = |name: &str| name.replace('_', "-");
    let given = flags.as_str(inline);
    let source = flags.raw(file).is_some();
    if let (true, true, Some(clash)) = (given.is_some(), source, clash) {
        return usage(clash);
    }
    if source {
        let option = format!("--{}", spelled(file));
        let bytes = read_cli_file(account, Some(file), None, &option).await?;
        return Ok(Some(String::from_utf8_lossy(&bytes).into_owned()));
    }
    if let Some(given) = given {
        return Ok(Some(given.to_owned()));
    }
    if required {
        return value(format!(
            "--{} or --{} is required",
            spelled(inline),
            spelled(file)
        ));
    }
    Ok(None)
}

/// A REST snake_case key in gh's JSON field spelling.
pub(crate) fn camel_key(key: &str) -> String {
    let mut parts = key.split('_');
    let mut out = parts.next().unwrap_or("").to_owned();
    for part in parts {
        let mut chars = part.chars();
        if let Some(first) = chars.next() {
            out.extend(first.to_uppercase());
            out.push_str(chars.as_str());
        }
    }
    out
}

/// A REST object normalized for typed gh JSON output.
pub(crate) fn camel(value: &Json) -> Json {
    match value {
        Json::Arr(items) => Json::Arr(items.iter().map(camel).collect()),
        Json::Obj(obj) => {
            let mut out = Obj::new();
            for (key, item) in obj.iter() {
                out.set(camel_key(key), camel(item));
            }
            if let Some(url) = out.remove("htmlUrl") {
                out.set("url", url);
            }
            if let Some(user) = out.remove("user") {
                out.set("author", user);
            }
            Json::Obj(out)
        }
        other => other.clone(),
    }
}

fn number_of(value: &Json) -> Option<f64> {
    match value {
        Json::Int(number) => Some(*number as f64),
        Json::Float(number) => Some(*number),
        _ => None,
    }
}

fn marshal_string(text: &str, out: &mut String) {
    let mut quoted = String::new();
    quote_into(text, &mut quoted);
    for c in quoted.chars() {
        match c {
            '<' | '>' | '&' | '\u{2028}' | '\u{2029}' => {
                out.push_str(&format!("\\u{:04x}", u32::from(c)));
            }
            c => out.push(c),
        }
    }
}

fn gojq_string(text: &str, out: &mut String) {
    let mut quoted = String::new();
    quote_into(text, &mut quoted);
    out.push_str(&quoted.replace('\u{7f}', "\\u007f"));
}

/// A decoded JSON value as Go writes it back out: compact, object keys
/// sorted as a Go map's are, every number a float64.
fn go_encoded(value: &Json, quote: fn(&str, &mut String), out: &mut String) {
    match value {
        Json::Obj(obj) => {
            let mut pairs: Vec<&(String, Json)> = obj.iter().collect();
            pairs.sort_by(|a, b| a.0.cmp(&b.0));
            out.push('{');
            for (at, (key, item)) in pairs.into_iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                quote(key, out);
                out.push(':');
                go_encoded(item, quote, out);
            }
            out.push('}');
        }
        Json::Arr(items) => {
            out.push('[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                go_encoded(item, quote, out);
            }
            out.push(']');
        }
        Json::Str(text) => quote(text, out),
        Json::Null => out.push_str("null"),
        Json::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        number => {
            let bound = f64::MAX;
            let clamped = number_of(number).unwrap_or(0.0).clamp(-bound, bound);
            out.push_str(&float_text(clamped));
        }
    }
}

/// A number as go-gh prints a float64 on its own line: no decimals when
/// it is whole and two otherwise.
fn fixed_number(number: f64) -> String {
    if number == 0.0 {
        return "0".to_owned();
    }
    if number.fract() == 0.0 {
        format!("{number:.0}")
    } else {
        format!("{number:.2}")
    }
}

/// One `--jq` output as go-gh prints it.
pub(crate) fn jq_line(value: &Json) -> String {
    match value {
        Json::Null => String::new(),
        Json::Str(text) => text.clone(),
        Json::Bool(flag) => flag.to_string(),
        Json::Int(_) | Json::Float(_) => fixed_number(number_of(value).unwrap_or(0.0)),
        other => {
            let mut out = String::new();
            go_encoded(other, marshal_string, &mut out);
            out
        }
    }
}

fn select(value: &Json, fields: &[String]) -> Json {
    let mut keys: Vec<&str> = fields.iter().map(String::as_str).collect();
    keys.sort_unstable();
    keys.dedup();
    let cut = |row: &Json| {
        let mut out = Obj::new();
        for key in &keys {
            out.set(*key, row.get(key).clone());
        }
        Json::Obj(out)
    };
    match value {
        Json::Arr(rows) => Json::Arr(rows.iter().map(cut).collect()),
        row => cut(row),
    }
}

/// The `--json` fields a line asked for, None without `--json`, refused
/// before any request as gh refuses them.
pub(crate) fn json_fields(flags: &Flags, allowed: &[&str]) -> Result<Option<Vec<String>>> {
    let Some(spelled) = flags.as_str("json") else {
        if flags.raw("jq").is_some() {
            return value("cannot use `--jq` without specifying `--json`");
        }
        if flags.raw("template").is_some() {
            return value("cannot use `--template` without specifying `--json`");
        }
        return Ok(None);
    };
    let fields = csv_values(&[spelled.to_owned()]);
    let mut known: Vec<&str> = allowed.to_vec();
    known.sort_unstable();
    let listing: Vec<String> = known.iter().map(|field| format!("  {field}")).collect();
    if fields.is_empty() {
        return value(format!(
            "Specify one or more comma-separated fields for `--json`:\n{}",
            listing.join("\n")
        ));
    }
    if let Some(unknown) = fields.iter().find(|field| !known.contains(&field.as_str())) {
        return value(format!(
            "Unknown JSON field: {}\nAvailable fields:\n{}",
            quoted(unknown),
            listing.join("\n")
        ));
    }
    Ok(Some(fields))
}

fn gojq_text(text: &str, string: bool) -> Result<String> {
    if string {
        return Ok(text.to_owned());
    }
    let parsed = Json::parse(text.as_bytes()).map_err(Failure::Value)?;
    let mut out = String::new();
    go_encoded(&parsed, gojq_string, &mut out);
    Ok(out)
}

/// The message go-gh fails with when a run stopped early, None when that
/// stop ends the output without failing.
fn jq_failure(stop: &Reply) -> Result<Option<String>> {
    let Some(text) = stop.message.as_deref() else {
        return Ok(None);
    };
    Ok(match stop.kind.as_deref() {
        Some("halt") => Some(format!("halt error: {}", gojq_text(text, stop.string)?)),
        Some("error") if stop.own => Some(format!("error: {}", gojq_text(text, stop.string)?)),
        Some("error") => Some(match gojq_raised(text) {
            Some(raised) => format!("error: {raised}"),
            None => text.to_owned(),
        }),
        _ => None,
    })
}

/// The lines `--jq` prints for each value in turn, the program running in
/// the host's own jq. An error, or any `halt_error` on a value that is not
/// null, fails the command after the lines before it.
pub(crate) async fn jq_lines(account: &Account, values: &[Json], program: &str) -> Result<String> {
    let mut lines = String::new();
    for item in values {
        let (reply, outputs) = account
            .host
            .ask(Request::Jq {
                program: program.to_owned(),
                doc: item.dump().into_bytes(),
            })
            .await;
        if let Some(error) = reply.error.clone() {
            return Err(Failure::Value(error));
        }
        for text in outputs.split(|byte| *byte == b'\n') {
            if text.is_empty() {
                continue;
            }
            let parsed = Json::parse(text).map_err(Failure::Value)?;
            lines.push_str(&jq_line(&parsed));
            lines.push('\n');
        }
        if let Some(message) = jq_failure(&reply)? {
            return Err(Failure::Printed {
                output: lines.into_bytes(),
                message,
            });
        }
    }
    Ok(lines)
}

/// A typed verb as stable projected JSON, jq or human text.
pub(crate) async fn typed_out(
    account: &Account,
    value_: &Json,
    flags: &Flags,
    human: String,
    allowed: &[&str],
) -> Result<Out> {
    let Some(fields) = json_fields(flags, allowed)? else {
        return Ok(Out::text(human));
    };
    export_out(account, &select(value_, &fields), flags).await
}

/// `--json` output through `--jq` or `--template`, when one is given.
pub(crate) async fn export_out(account: &Account, selected: &Json, flags: &Flags) -> Result<Out> {
    if let Some(program) = flags.as_nonempty("jq") {
        let lines = jq_lines(account, std::slice::from_ref(selected), program).await?;
        return Ok(Out::text(lines));
    }
    if let Some(template) = flags.as_nonempty("template") {
        return Ok(Out::text(render_template(template, selected)?));
    }
    Ok(json_out(selected))
}

/// `--json` output as gh writes it where stdout is not a terminal.
pub(crate) fn json_out(value: &Json) -> Out {
    if value.is_null() {
        return Out::default();
    }
    let text = value
        .dump()
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029");
    Out::text(format!("{text}\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> Json {
        Json::parse(text.as_bytes()).unwrap()
    }

    #[test]
    fn rest_keys_become_gh_field_names() {
        let row = camel(&json(
            r#"{"html_url":"u","user":{"login":"a"},"run_attempt":2}"#,
        ));
        assert_eq!(row.get("url"), &Json::from("u"));
        assert_eq!(row.get("author").get("login"), &Json::from("a"));
        assert_eq!(row.get("runAttempt"), &Json::from(2i64));
    }

    #[test]
    fn csv_flags_split_trim_and_keep_their_order() {
        let values = vec!["b, a".to_owned(), ",c".to_owned()];
        assert_eq!(csv_values(&values), ["b", "a", "c"]);
    }

    #[test]
    fn jq_outputs_print_as_go_gh_prints_them() {
        assert_eq!(jq_line(&Json::Null), "");
        assert_eq!(jq_line(&Json::from("a<b")), "a<b");
        assert_eq!(jq_line(&Json::Float(1.0)), "1");
        assert_eq!(jq_line(&Json::Float(1.005)), "1.00");
        assert_eq!(jq_line(&Json::Float(-0.0)), "0");
        assert_eq!(
            jq_line(&json(r#"{"b":"<","a":[1]}"#)),
            r#"{"a":[1],"b":"\u003c"}"#
        );
    }

    #[test]
    fn a_selector_is_a_number_with_an_optional_hash() {
        assert_eq!(subject_number("#12"), Some(12));
        assert_eq!(subject_number("12"), Some(12));
        assert_eq!(subject_number("x"), None);
        assert_eq!(subject_number(""), None);
    }
}
