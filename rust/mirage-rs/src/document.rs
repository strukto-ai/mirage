use serde::{Deserialize, Serialize};

use crate::policy::{Text, Whitespace};
use crate::{Stream, StreamError, parse_config};

// Text travels as code points, just as it does in the policy matcher. A
// document can name a filesystem path containing a lone surrogate.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Doc {
    Null,
    Text(Text),
    List(Vec<Doc>),
    Map(Vec<(Doc, Doc)>),
    Invalid,
}

type Answer = Result<Doc, String>;

impl Doc {
    fn text(value: &str) -> Self {
        Self::Text(value.chars().map(u32::from).collect())
    }

    fn named(&self, name: &str) -> bool {
        matches!(self, Self::Text(text) if text.iter().copied().eq(name.chars().map(u32::from)))
    }

    fn field(&self, name: &str) -> Option<&Self> {
        match self {
            Self::Map(fields) => fields
                .iter()
                .find(|(key, _)| key.named(name))
                .map(|(_, value)| value),
            _ => None,
        }
    }

    fn get(&self, name: &str) -> &Self {
        self.field(name).unwrap_or(&Self::Null)
    }

    fn list(&self, where_: &str, expected: &str) -> Result<&[Doc], String> {
        match self {
            Self::Null => Ok(&[]),
            Self::List(items) => Ok(items),
            _ => Err(format!("{where_} must be {expected}")),
        }
    }

    fn mapping(&self, where_: &str) -> Result<&[(Doc, Doc)], String> {
        match self {
            Self::Map(fields) => Ok(fields),
            _ => Err(format!("{where_} must be a mapping")),
        }
    }

    fn shown(&self) -> String {
        match self {
            Self::Text(text) => text
                .iter()
                .map(|&unit| {
                    char::from_u32(unit)
                        .map_or_else(|| format!("\\u{unit:04x}"), |ch| ch.to_string())
                })
                .collect(),
            _ => "<non-string>".into(),
        }
    }
}

fn object(fields: Vec<(&str, Doc)>) -> Doc {
    Doc::Map(
        fields
            .into_iter()
            .map(|(key, value)| (Doc::text(key), value))
            .collect(),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    op: String,
    raw: Doc,
    #[serde(default)]
    where_: Text,
    #[serde(default)]
    names: Option<String>,
    #[serde(default)]
    root: Text,
    #[serde(default)]
    dialect: Whitespace,
}

pub(crate) fn whitespace(unit: u32, dialect: Whitespace) -> bool {
    matches!(unit, 0x9..=0xd | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000)
        || match dialect {
            Whitespace::Python => matches!(unit, 0x1c..=0x1f | 0x85),
            Whitespace::EcmaScript => unit == 0xfeff,
        }
}

fn nonblank(value: &Doc, dialect: Whitespace) -> bool {
    matches!(value, Doc::Text(text) if text.iter().any(|&unit| !whitespace(unit, dialect)))
}

fn strings(raw: &Doc, at: &str, names: Option<&str>, dialect: Whitespace) -> Answer {
    let entries = raw.list(at, "a list of strings")?;
    for (i, entry) in entries.iter().enumerate() {
        if !matches!(entry, Doc::Text(_)) {
            return Err(format!("{at}[{i}] must be a string"));
        }
        if let Some(names) = names.filter(|_| !nonblank(entry, dialect)) {
            return Err(format!("{at}[{i}] must name {names}"));
        }
    }
    Ok(Doc::List(entries.to_vec()))
}

fn fields(raw: &Doc, allowed: &[&str], at: &str) -> Result<(), String> {
    for (key, _) in raw.mapping(at)? {
        if !allowed.iter().any(|name| key.named(name)) {
            return Err(format!(
                "{at}: unknown field `{}` (allowed: {})",
                key.shown(),
                allowed.join(", ")
            ));
        }
    }
    Ok(())
}

fn absolute(raw: &Doc, at: &str) -> Result<(), String> {
    for (i, entry) in raw.list(at, "a list of strings")?.iter().enumerate() {
        let Doc::Text(text) = entry else {
            return Err(format!("{at}[{i}] must be a string"));
        };
        if text.first() == Some(&47) || (crate::policy::is_glob(text) && !text.contains(&47)) {
            continue;
        }
        return Err(format!(
            "{at}[{i}] must be an absolute path or a name pattern: {:?} is relative",
            entry.shown()
        ));
    }
    Ok(())
}

fn under(raw: &Doc, root: &[u32], at: &str) -> Result<(), String> {
    if root == [47] {
        return Ok(());
    }
    for (i, entry) in raw.list(at, "a list of strings")?.iter().enumerate() {
        let Doc::Text(text) = entry else {
            return Err(format!("{at}[{i}] must be a string"));
        };
        if text.first() != Some(&47)
            || text == root
            || (text.starts_with(root) && text.get(root.len()) == Some(&47))
        {
            continue;
        }
        return Err(format!(
            "{at}[{i}] is outside the mount it is written under: {:?} is not below {:?}",
            entry.shown(),
            Doc::Text(root.to_vec()).shown()
        ));
    }
    Ok(())
}

const VERBS: [&str; 3] = ["allow", "ask", "deny"];
const LEAF_FIELDS: [&str; 2] = ["decision", "reason"];
const RULE_KEYS: [&str; 3] = ["decision", "reason", "paths"];
const FLAT_EXAMPLE: &str = "commands: {\"*\": allow, rm: {--recursive: {--force: deny}}, gh: {pr: {merge: {--admin: deny}}}}";

fn verb(raw: &Doc) -> bool {
    VERBS.iter().any(|name| raw.named(name))
}

fn leaf_like(raw: &Doc) -> bool {
    match raw {
        Doc::Map(_) => RULE_KEYS
            .iter()
            .any(|name| !matches!(raw.get(name), Doc::Null)),
        _ => true,
    }
}

fn key_name(key: &Doc, at: &str) -> Result<Text, String> {
    match key {
        Doc::Text(text) => Ok(text.clone()),
        _ => Err(format!(
            "{at}: every key must be a string; quote a number or a boolean, as \"5\""
        )),
    }
}

fn dashed(name: &[u32]) -> bool {
    name.len() > 1 && name[0] == u32::from(b'-')
}

fn shown(name: &[u32]) -> String {
    Doc::Text(name.to_vec()).shown()
}

/// Where a rule's paths go now: the folder entry each path names
/// (`/data/keep/*` and `/data/keep/**` give
/// `mounts[/data/keep].commands.rm`), one entry per folder when the
/// paths name several, or, when a path is a glob, relative or empty,
/// which no one folder spells, an entry per folder or a hide. `key` is
/// the rule's place under its `commands` block.
fn no_paths(raw: &Doc, at: &str, key: &str) -> String {
    let paths = match raw.get("paths") {
        Doc::List(items) => items.iter().collect(),
        text @ Doc::Text(_) => vec![text],
        _ => Vec::new(),
    };
    let mut folders: Vec<String> = Vec::new();
    for path in paths {
        let Some(folder) = folder_of(path) else {
            return format!(
                "{at}: a rule takes no paths; scope it to each folder with mounts[<folder>].commands{key}, or hide those paths with paths.hide"
            );
        };
        if !folders.contains(&folder) {
            folders.push(folder);
        }
    }
    match folders.as_slice() {
        [] => format!(
            "{at}: a rule takes no paths; scope it to a folder with mounts[<folder>].commands{key}"
        ),
        [folder] => format!(
            "{at}: a rule takes no paths; scope it to a folder with mounts[{folder}].commands{key}"
        ),
        [rest @ .., last] => {
            let entry = |folder: &String| format!("mounts[{folder}].commands{key}");
            let rest: Vec<String> = rest.iter().map(entry).collect();
            format!(
                "{at}: a rule takes no paths; give each folder its own entry: {} and {}",
                rest.join(", "),
                entry(last)
            )
        }
    }
}

/// The folder an old rule's absolute path names, with a trailing
/// `/*` or `/**` dropped; `None` for a glob, a relative path, an empty
/// path or a value that is not text.
fn folder_of(path: &Doc) -> Option<String> {
    let Doc::Text(path) = path else {
        return None;
    };
    if path.first() != Some(&47) {
        return None;
    }
    let path = path
        .strip_suffix(&[47, 42, 42])
        .or_else(|| path.strip_suffix(&[47, 42]))
        .unwrap_or(path);
    let path = path.strip_suffix(&[47]).unwrap_or(path);
    if path.is_empty() {
        Some("/".to_owned())
    } else if crate::policy::is_glob(path) {
        None
    } else {
        Some(shown(path))
    }
}

fn leaf(raw: &Doc, at: &str, key: &str) -> Answer {
    if verb(raw) {
        return Ok(object(vec![
            ("decision", raw.clone()),
            ("reason", Doc::text("")),
        ]));
    }
    if !matches!(raw, Doc::Map(_)) {
        return Err(format!(
            "{at} must be allow, ask, deny or a {{decision, reason}} mapping"
        ));
    }
    if raw.field("paths").is_some() {
        return Err(no_paths(raw, at, key));
    }
    fields(raw, &LEAF_FIELDS, at)?;
    let decision = raw.get("decision");
    if !verb(decision) {
        return Err(format!("{at}.decision must be allow, ask or deny"));
    }
    let reason = match raw.field("reason") {
        None => Doc::text(""),
        Some(Doc::Text(text)) => Doc::Text(text.clone()),
        Some(_) => return Err(format!("{at}.reason must be a string")),
    };
    Ok(object(vec![
        ("decision", decision.clone()),
        ("reason", reason),
    ]))
}

fn one_decision(raw: &Doc, at: &str, root: &str) -> Answer {
    let key = at.strip_prefix(root).unwrap_or_default();
    match raw {
        Doc::List(_) => Err(format!("{at}: a rule is one decision, not a list")),
        Doc::Text(_) if !verb(raw) => Err(format!(
            "{at}: `{}` is no decision; write allow, ask or deny",
            raw.shown()
        )),
        _ => leaf(raw, at, key),
    }
}

fn words(raw: &Doc, at: &str, root: &str, each: fn(&Doc, &str, &str) -> Answer) -> Answer {
    let fields = raw.mapping(at)?;
    if fields.is_empty() {
        return Err(format!("{at} names no word"));
    }
    let mut out = Vec::new();
    for (key, value) in fields {
        let word = key_name(key, at)?;
        let target = each(value, &format!("{at}[{}]", shown(&word)), root)?;
        out.push((Doc::Text(word), target));
    }
    Ok(Doc::Map(out))
}

fn value_rule(raw: &Doc, at: &str, root: &str) -> Answer {
    if leaf_like(raw) {
        return Ok(object(vec![
            ("decision", one_decision(raw, at, root)?),
            ("options", Doc::Map(Vec::new())),
        ]));
    }
    let mut decision = Doc::Null;
    let mut options = Vec::new();
    for (key, value) in raw.mapping(at)? {
        let name = key_name(key, at)?;
        let here = format!("{at}.{}", shown(&name));
        if name == [u32::from(b'*')] {
            decision = one_decision(value, &here, root)?;
        } else if dashed(&name) && name != [u32::from(b'-'), u32::from(b'*')] {
            options.push((Doc::Text(name), option_rule(value, &here, root)?));
        } else {
            return Err(format!(
                "{at}: `{}` is no option; under a value, name the options that must also be present",
                shown(&name)
            ));
        }
    }
    Ok(object(vec![
        ("decision", decision),
        ("options", Doc::Map(options)),
    ]))
}

fn option_rule(raw: &Doc, at: &str, root: &str) -> Answer {
    if leaf_like(raw) {
        return Ok(object(vec![
            ("decision", one_decision(raw, at, root)?),
            ("values", Doc::Map(Vec::new())),
            ("options", Doc::Map(Vec::new())),
        ]));
    }
    let mut decision = Doc::Null;
    let mut values = Doc::Map(Vec::new());
    let mut options = Vec::new();
    for (key, value) in raw.mapping(at)? {
        let name = key_name(key, at)?;
        let here = format!("{at}.{}", shown(&name));
        if name == [u32::from(b'*')] {
            decision = one_decision(value, &here, root)?;
        } else if Doc::Text(name.clone()).named("values") {
            values = words(value, &here, root, value_rule)?;
        } else if name == [u32::from(b'-'), u32::from(b'*')] {
            return Err(format!(
                "{here}: -* belongs on a command, not under an option"
            ));
        } else if dashed(&name) {
            options.push((Doc::Text(name), option_rule(value, &here, root)?));
        } else if Doc::Text(name.clone()).named("operands") {
            return Err(format!(
                "{here}: operands belong on a command, not under an option"
            ));
        } else {
            return Err(format!(
                "{at}: `{}` is no option; a value goes under values",
                shown(&name)
            ));
        }
    }
    Ok(object(vec![
        ("decision", decision),
        ("values", values),
        ("options", Doc::Map(options)),
    ]))
}

fn command_node(raw: &Doc, at: &str, root: &str) -> Answer {
    let empty = || Doc::Map(Vec::new());
    if leaf_like(raw) {
        return Ok(object(vec![
            ("decision", one_decision(raw, at, root)?),
            ("subcommands", empty()),
            ("options", empty()),
            ("other_options", Doc::Null),
            ("operands", empty()),
        ]));
    }
    let mut decision = Doc::Null;
    let mut other = Doc::Null;
    let mut operands = empty();
    let mut subcommands = Vec::new();
    let mut options = Vec::new();
    for (key, value) in raw.mapping(at)? {
        let name = key_name(key, at)?;
        let here = format!("{at}.{}", shown(&name));
        if name == [u32::from(b'*')] {
            decision = one_decision(value, &here, root)?;
        } else if name == [u32::from(b'-'), u32::from(b'*')] {
            other = one_decision(value, &here, root)?;
        } else if dashed(&name) {
            options.push((Doc::Text(name), option_rule(value, &here, root)?));
        } else if Doc::Text(name.clone()).named("operands") {
            operands = words(value, &here, root, command_node)?;
        } else if Doc::Text(name.clone()).named("values") {
            return Err(format!("{here}: values belong under an option"));
        } else {
            subcommands.push((Doc::Text(name), command_node(value, &here, root)?));
        }
    }
    if !subcommands.is_empty() && !matches!(&operands, Doc::Map(fields) if fields.is_empty()) {
        return Err(format!(
            "{at}: operands sit on a command without subcommands; this one names subcommands"
        ));
    }
    Ok(object(vec![
        ("decision", decision),
        ("subcommands", Doc::Map(subcommands)),
        ("options", Doc::Map(options)),
        ("other_options", other),
        ("operands", operands),
    ]))
}

/// Whether a `commands` block is written in the flat format: an `allow`,
/// `ask` or `deny` list holding a command pattern or a rule mapping,
/// which a tree, whose rule is one decision, never holds.
fn flat(raw: &Doc) -> bool {
    VERBS.iter().any(|name| match raw.get(name) {
        Doc::List(items) => {
            items.is_empty()
                || items.iter().any(|item| match item {
                    Doc::Map(_) => matches!(item.get("decision"), Doc::Null),
                    _ => !verb(item),
                })
        }
        _ => false,
    })
}

/// Whether a flat block holds a rule that names paths and no command,
/// which the tree has no place for.
fn path_only(raw: &Doc) -> bool {
    VERBS.iter().any(|name| match raw.get(name) {
        Doc::List(items) => items.iter().any(|item| {
            matches!(item, Doc::Map(_))
                && matches!(item.get("command"), Doc::Null)
                && matches!(item.get("commands"), Doc::Null)
                && !matches!(item.get("paths"), Doc::Null)
        }),
        _ => false,
    })
}

fn tree(raw: &Doc, at: &str) -> Answer {
    if flat(raw) {
        let hide = if path_only(raw) {
            "; a rule with paths and no command has no place in the tree, \
             so hide those paths with paths.hide"
        } else {
            ""
        };
        return Err(format!(
            "{at} is in the old flat format (allow, ask and deny lists of command patterns); \
             write it as a tree of command names instead, for example {FLAT_EXAMPLE}{hide}"
        ));
    }
    let fields = raw.mapping(at)?;
    let mut decision = Doc::Null;
    let mut commands = Vec::new();
    for (key, value) in fields {
        let name = key_name(key, at)?;
        let here = format!("{at}.{}", shown(&name));
        if name == [u32::from(b'*')] {
            decision = one_decision(value, &here, at)?;
        } else if dashed(&name) {
            return Err(format!(
                "{at}: the option {} needs a command; put it under one",
                shown(&name)
            ));
        } else if RULE_KEYS
            .iter()
            .chain(&["operands", "values"])
            .any(|reserved| Doc::Text(name.clone()).named(reserved))
        {
            return Err(format!(
                "{at}: `{}` needs a command; the block maps command names, and \"*\" stands for every command not named",
                shown(&name)
            ));
        } else {
            commands.push((Doc::Text(name), command_node(value, &here, at)?));
        }
    }
    Ok(object(vec![
        ("decision", decision),
        ("subcommands", Doc::Map(commands)),
        ("options", Doc::Map(Vec::new())),
        ("other_options", Doc::Null),
        ("operands", Doc::Map(Vec::new())),
    ]))
}

/// A tree written as JSON, read the way a host reads it, for the
/// matcher's tests.
#[cfg(test)]
pub(crate) fn tree_of(value: &serde_json::Value) -> Result<crate::policy::tree::Node, String> {
    use crate::policy::Outcome;
    use crate::policy::tree::{Leaf, Node, OptionRule, ValueRule};
    use serde_json::Value;

    fn doc(value: &Value) -> Doc {
        match value {
            Value::Null => Doc::Null,
            Value::String(text) => Doc::text(text),
            Value::Array(items) => Doc::List(items.iter().map(doc).collect()),
            Value::Object(fields) => Doc::Map(
                fields
                    .iter()
                    .map(|(key, item)| (Doc::text(key), doc(item)))
                    .collect(),
            ),
            _ => Doc::Invalid,
        }
    }
    fn text(raw: &Doc) -> Text {
        match raw {
            Doc::Text(text) => text.clone(),
            _ => Text::new(),
        }
    }
    fn pairs(raw: &Doc) -> &[(Doc, Doc)] {
        match raw {
            Doc::Map(fields) => fields,
            _ => &[],
        }
    }
    fn leaf(raw: &Doc) -> Option<Leaf> {
        if matches!(raw, Doc::Null) {
            return None;
        }
        let verb = raw.get("decision");
        let decision = if verb.named("deny") {
            Outcome::Deny
        } else if verb.named("ask") {
            Outcome::Ask
        } else {
            Outcome::Allow
        };
        Some(Leaf {
            decision,
            reason: text(raw.get("reason")),
        })
    }
    fn options(raw: &Doc) -> Vec<(Text, OptionRule)> {
        pairs(raw)
            .iter()
            .map(|(key, value)| (text(key), option(value)))
            .collect()
    }
    fn option(raw: &Doc) -> OptionRule {
        OptionRule {
            decision: leaf(raw.get("decision")),
            values: pairs(raw.get("values"))
                .iter()
                .map(|(key, value)| {
                    (
                        text(key),
                        ValueRule {
                            decision: leaf(value.get("decision")),
                            options: options(value.get("options")),
                        },
                    )
                })
                .collect(),
            options: options(raw.get("options")),
        }
    }
    fn node(raw: &Doc) -> Node {
        Node {
            decision: leaf(raw.get("decision")),
            subcommands: pairs(raw.get("subcommands"))
                .iter()
                .map(|(key, value)| (text(key), node(value)))
                .collect(),
            options: options(raw.get("options")),
            other_options: leaf(raw.get("other_options")),
            operands: pairs(raw.get("operands"))
                .iter()
                .map(|(key, value)| (text(key), node(value)))
                .collect(),
        }
    }
    Ok(node(&tree(&doc(value), "commands")?))
}

fn hide_group(raw: &Doc, at: &str, dialect: Whitespace) -> Answer {
    fields(raw, &["patterns", "reason"], at)?;
    let patterns = strings(
        raw.get("patterns"),
        &format!("{at} patterns"),
        Some("a path"),
        dialect,
    )?;
    if matches!(&patterns, Doc::List(items) if items.is_empty()) {
        return Err(format!("{at} must list at least one pattern"));
    }
    let reason = raw.get("reason");
    if !nonblank(reason, dialect) {
        return Err(format!("{at} reason must be a non-empty string"));
    }
    Ok(object(vec![
        ("patterns", patterns),
        ("reason", reason.clone()),
    ]))
}

fn mode(raw: &Doc, at: &str) -> Answer {
    match raw {
        Doc::Null => Ok(Doc::Null),
        Doc::Text(_) => {
            for (name, alias) in [("read", "r"), ("write", "rw"), ("exec", "rwx")] {
                if raw.named(name) || raw.named(alias) {
                    return Ok(Doc::text(name));
                }
            }
            Err(format!("invalid mount mode: '{}'", raw.shown()))
        }
        _ => Err(format!("{at} modes must be a mode name or alias")),
    }
}

fn show(raw: &Doc, at: &str, dialect: Whitespace) -> Answer {
    let pairs = match raw {
        Doc::Null => Vec::new(),
        Doc::List(items) => items.iter().map(|path| (path, &Doc::Null)).collect(),
        Doc::Map(fields) => fields.iter().map(|(path, mode)| (path, mode)).collect(),
        _ => {
            return Err(format!(
                "{at} must be a mapping of path to mode or a list of paths"
            ));
        }
    };
    let mut out = Vec::new();
    for (path, value) in pairs {
        if !nonblank(path, dialect) {
            return Err(format!("{at} entries must name a path"));
        }
        if !matches!(path, Doc::Text(text) if text.first() == Some(&47)) {
            return Err(format!(
                "{at} entries anchor to a place, so each is absolute: '{}' is not",
                path.shown()
            ));
        }
        out.push(object(vec![
            ("path", path.clone()),
            ("mode", mode(value, at)?),
        ]));
    }
    Ok(Doc::List(out))
}

fn paths(raw: &Doc, at: &str, dialect: Whitespace) -> Answer {
    fields(raw, &["hide", "show", "reasons"], at)?;
    let mut flat = Vec::new();
    let mut reasons = Vec::new();
    for (i, entry) in raw
        .get("hide")
        .list(&format!("{at}.hide"), "a list")?
        .iter()
        .enumerate()
    {
        if matches!(entry, Doc::Map(_)) {
            let group = hide_group(entry, &format!("{at}.hide[{i}] group"), dialect)?;
            flat.extend_from_slice(group.get("patterns").list(at, "a list")?);
            reasons.push(group);
        } else {
            flat.push(entry.clone());
        }
    }
    for entry in raw
        .get("reasons")
        .list(&format!("{at}.reasons"), "a list of groups")?
    {
        if !matches!(entry, Doc::Map(_)) {
            return Err(format!(
                "{at}.reasons entries must be groups of patterns and a reason"
            ));
        }
        reasons.push(hide_group(entry, &format!("{at}.reasons group"), dialect)?);
    }
    let hide = strings(
        &Doc::List(flat),
        &format!("{at}.hide"),
        Some("a path"),
        dialect,
    )?;
    absolute(&hide, &format!("{at}.hide"))?;
    let show = show(raw.get("show"), &format!("{at}.show"), dialect)?;
    let mut out = vec![("hide", hide)];
    if !matches!(&show, Doc::List(items) if items.is_empty()) {
        out.push(("show", show));
    }
    if !reasons.is_empty() {
        out.push(("reasons", Doc::List(reasons)));
    }
    Ok(object(out))
}

fn config_fields(raw: &Doc, allowed: &[&str], at: &str) -> Result<(), String> {
    for (key, _) in raw.mapping(at)? {
        if !allowed.iter().any(|name| key.named(name)) {
            return Err(format!(
                "unknown {at} key `{}` (allowed: {})",
                key.shown(),
                allowed.join(", ")
            ));
        }
    }
    Ok(())
}

fn typed_fields(raw: &Doc, kind: &str, at: &str) -> Result<(), String> {
    if matches!(raw, Doc::Null) {
        return Ok(());
    }
    raw.mapping(&format!("config `{at}`"))?;
    let known: &[&str] = match (kind, at) {
        ("store_group", "store.sessions") => &["ram", "disk", "redis", "s3"],
        ("store_group", _) => &["ram", "disk", "redis"],
        _ => &["ram", "redis"],
    };
    let default_type = Doc::text("ram");
    let tag = match raw.get("type") {
        Doc::Null if kind == "store_group" => &default_type,
        Doc::Null => {
            return Err(format!(
                "config `{at}` needs a `type` (one of {})",
                known.join(", ")
            ));
        }
        value => value,
    };
    let Doc::Text(_) = tag else {
        return Err(format!(
            "config `{at}` type must be a string (one of {})",
            known.join(", ")
        ));
    };
    if !known.iter().any(|name| tag.named(name)) {
        return Err(format!(
            "unknown {at} type `{}` (expected one of {})",
            tag.shown(),
            known.join(", ")
        ));
    }
    let fields: &[&str] = match (kind, tag.shown().as_str()) {
        ("cache", "ram") => &["type", "limit", "max_drain_bytes"],
        ("cache", _) => &["type", "limit", "max_drain_bytes", "url", "key_prefix"],
        ("index", "ram") => &["type", "ttl"],
        ("index", _) => &["type", "ttl", "url", "key_prefix"],
        (_, "ram") => &["type"],
        (_, "disk") => &["type", "root"],
        (_, "redis") => &["type", "url", "key_prefix"],
        _ => &[
            "type",
            "bucket",
            "region",
            "endpoint_url",
            "aws_access_key_id",
            "aws_secret_access_key",
            "aws_session_token",
            "aws_profile",
            "path_style",
            "timeout",
            "proxy",
            "key_prefix",
            "default_content_type",
        ],
    };
    config_fields(raw, fields, &format!("{at} ({})", tag.shown()))
}

fn store(raw: &Doc) -> Result<(), String> {
    if matches!(raw, Doc::Null) {
        return Ok(());
    }
    raw.mapping("config `store`")?;
    let tag = raw.get("type");
    if !matches!(tag, Doc::Null) {
        if !matches!(tag, Doc::Text(_)) {
            return Err("config `store` type must be a string (one of ram, disk, redis)".into());
        }
        if !["ram", "disk", "redis"].iter().any(|name| tag.named(name)) {
            return Err(format!(
                "unknown store type `{}` (expected one of ram, disk, redis)",
                tag.shown()
            ));
        }
    }
    config_fields(
        raw,
        &[
            "type",
            "url",
            "key_prefix",
            "root",
            "namespace",
            "logs",
            "sessions",
            "execution",
        ],
        "store",
    )?;
    for group in ["namespace", "logs", "sessions", "execution"] {
        let block = raw.get(group);
        if matches!(block, Doc::Null) {
            continue;
        }
        let at = format!("store.{group}");
        block.mapping(&format!("config `{at}`"))?;
        if block.get("type").named("s3") && group != "sessions" {
            return Err(format!(
                "config `{at}` cannot be s3: the s3 store hosts only the sessions group; keep the {group} plane on another store and put the s3 store under `store.sessions`"
            ));
        }
        if group == "logs" && block.get("type").named("redis") {
            return Err(
                "config `store.logs` cannot be redis: history only grows; keep it on ram or disk"
                    .into(),
            );
        }
        if group == "execution" && block.get("type").named("disk") {
            return Err("config `store.execution` cannot be disk: a job's console is a stream other processes follow; keep the execution plane on ram or redis".into());
        }
        typed_fields(block, "store_group", &at)?;
    }
    Ok(())
}

fn workspace_fields(raw: &Doc, kind: &str, at: &str) -> Answer {
    match kind {
        "cache" | "index" => typed_fields(raw, kind, at)?,
        "store" => store(raw)?,
        "workspace" => config_fields(
            raw,
            &[
                "mounts",
                "io",
                "command_limits",
                "max_memory",
                "max_body_bytes",
                "max_env",
                "network",
                "system_time",
                "clis",
                "machines",
                "route_policy",
                "profiles",
                "profile",
                "processes",
                "mode",
                "read",
                "write",
                "default_session_id",
                "workspace_id",
                "cache",
                "index",
                "store",
                "env",
                "secrets",
            ],
            at,
        )?,
        "mount" => config_fields(
            raw,
            &[
                "vfs",
                "mode",
                "config",
                "command_limits",
                "backend",
                "mountpoint",
                "read",
                "ttl",
                "write",
                "index",
            ],
            at,
        )?,
        "cli" => config_fields(raw, &["cli", "script", "machine", "runtime", "config"], at)?,
        "source" => config_fields(raw, &["source", "config"], at)?,
        "io" => config_fields(raw, &["buffer_bytes"], at)?,
        _ => return Err(format!("unknown workspace block: {kind}")),
    }
    Ok(Doc::Null)
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    let Config {
        op,
        raw,
        where_: at,
        names,
        root,
        dialect,
    } = config;
    let at = Doc::Text(at).shown();
    let result = match op.as_str() {
        "strings" => strings(&raw, &at, names.as_deref(), dialect),
        "under" => under(&raw, &root, &at).map(|()| Doc::Null),
        "tree" => tree(&raw, &at),
        "paths" => paths(&raw, &at, dialect),
        "config" => workspace_fields(&raw, names.as_deref().unwrap_or("workspace"), &at),
        _ => return Err(StreamError::new("document: unknown operation")),
    };
    let answer = match result {
        Ok(value) => serde_json::json!({"value": value}),
        Err(message) => serde_json::json!({"error": message}),
    };
    Ok(Box::new(Document(
        serde_json::to_vec(&answer).expect("document serializes"),
    )))
}

struct Document(Vec<u8>);

impl Stream for Document {
    fn feed(&mut self, _data: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Ok(())
    }
    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        out.append(&mut self.0);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(values: &[&str]) -> Doc {
        Doc::List(values.iter().map(|s| Doc::text(s)).collect())
    }

    #[test]
    fn typed_fields_do_not_coerce_and_keep_host_whitespace() {
        assert_eq!(
            strings(&Doc::Null, "allow", None, Whitespace::Python).unwrap(),
            texts(&[])
        );
        assert!(
            strings(&Doc::text("rm"), "allow", None, Whitespace::Python)
                .unwrap_err()
                .contains("a list of strings")
        );
        assert!(
            strings(
                &Doc::List(vec![Doc::Invalid]),
                "allow",
                None,
                Whitespace::Python
            )
            .unwrap_err()
            .contains("allow[0] must be a string")
        );
        assert!(
            strings(
                &texts(&["\u{85}"]),
                "allow",
                Some("a command"),
                Whitespace::Python
            )
            .is_err()
        );
        assert!(
            strings(
                &texts(&["\u{85}"]),
                "allow",
                Some("a command"),
                Whitespace::EcmaScript
            )
            .is_ok()
        );
        assert!(
            strings(
                &texts(&["\u{feff}"]),
                "allow",
                Some("a command"),
                Whitespace::EcmaScript
            )
            .is_err()
        );
    }

    #[test]
    fn visibility_groups_and_show_modes_share_one_validation() {
        let raw = object(vec![
            (
                "hide",
                Doc::List(vec![
                    Doc::text("/secret"),
                    object(vec![
                        ("patterns", texts(&["*.pem"])),
                        ("reason", Doc::text("keys")),
                    ]),
                ]),
            ),
            ("show", object(vec![("/secret/public", Doc::text("r"))])),
        ]);
        let parsed = paths(&raw, "paths", Whitespace::Python).unwrap();
        assert_eq!(parsed.get("hide"), &texts(&["/secret", "*.pem"]));
        let Doc::List(shown) = parsed.get("show") else {
            panic!()
        };
        assert_eq!(shown[0].get("mode"), &Doc::text("read"));
        assert!(
            paths(
                &object(vec![("hide", texts(&["relative/path"]))]),
                "paths",
                Whitespace::Python
            )
            .is_err()
        );
        assert!(
            show(
                &object(vec![("/x", Doc::text("w"))]),
                "paths.show",
                Whitespace::Python
            )
            .is_err()
        );
        assert!(
            hide_group(
                &object(vec![("patterns", texts(&["/x"]))]),
                "group",
                Whitespace::Python
            )
            .is_err()
        );
    }

    #[test]
    fn surrogate_paths_round_trip_and_mount_boundaries_are_exact() {
        let path = Doc::Text(vec![47, 114, 47, 0xdc80]);
        let raw = object(vec![("hide", Doc::List(vec![path.clone()]))]);
        let encoded = serde_json::to_vec(&raw).unwrap();
        let decoded: Doc = serde_json::from_slice(&encoded).unwrap();
        let parsed = paths(&decoded, "paths", Whitespace::Python).unwrap();
        assert_eq!(parsed.get("hide"), &Doc::List(vec![path]));
        assert!(under(parsed.get("hide"), &[47, 114], "paths.hide").is_ok());
        assert!(
            under(
                &texts(&["/rooted/file"]),
                &[47, 114, 111, 111, 116],
                "paths.hide"
            )
            .is_err()
        );
        assert!(under(&texts(&["/anywhere"]), &[47], "paths.hide").is_ok());
    }

    #[test]
    fn workspace_keys_and_store_planes_fail_closed() {
        assert!(
            workspace_fields(&object(vec![("mounts", Doc::Null)]), "workspace", "config").is_ok()
        );
        assert!(
            workspace_fields(&object(vec![("mount", Doc::Null)]), "workspace", "config")
                .unwrap_err()
                .contains("unknown config key `mount`")
        );
        assert!(
            typed_fields(&object(vec![]), "index", "index")
                .unwrap_err()
                .contains("needs a `type`")
        );
        assert!(
            typed_fields(
                &object(vec![("type", Doc::text("ram")), ("limitt", Doc::Null)]),
                "cache",
                "cache"
            )
            .unwrap_err()
            .contains("unknown cache (ram) key `limitt`")
        );
        let s3 = object(vec![
            ("type", Doc::text("s3")),
            ("bucket", Doc::text("state")),
        ]);
        assert!(store(&object(vec![("sessions", s3.clone())])).is_ok());
        assert!(
            store(&object(vec![("namespace", s3)]))
                .unwrap_err()
                .contains("cannot be s3")
        );
        assert!(
            store(&object(vec![(
                "execution",
                object(vec![("type", Doc::text("disk"))])
            )]))
            .unwrap_err()
            .contains("cannot be disk")
        );
        assert!(
            store(&object(vec![(
                "logs",
                object(vec![("type", Doc::text("redis"))])
            )]))
            .unwrap_err()
            .contains("cannot be redis")
        );
        assert!(
            store(&object(vec![(
                "execution",
                object(vec![("type", Doc::text("other"))])
            )]))
            .unwrap_err()
            .contains("one of ram, disk, redis)")
        );
    }

    fn m(fields: &[(&str, Doc)]) -> Doc {
        Doc::Map(
            fields
                .iter()
                .map(|(key, value)| (Doc::text(key), value.clone()))
                .collect(),
        )
    }

    fn shape(raw: &Doc) -> Answer {
        tree(raw, "commands")
    }

    fn decisions(node: &Doc) -> Vec<String> {
        match node.get("decision") {
            leaf @ Doc::Map(_) => vec![leaf.get("decision").shown()],
            _ => Vec::new(),
        }
    }

    #[test]
    fn a_tree_reads_into_its_explicit_form() {
        let raw = m(&[
            ("*", Doc::text("allow")),
            (
                "gh",
                m(&[
                    ("*", Doc::text("deny")),
                    (
                        "pr",
                        m(&[(
                            "merge",
                            m(&[("*", Doc::text("allow")), ("--admin", Doc::text("deny"))]),
                        )]),
                    ),
                ]),
            ),
            (
                "curl",
                m(&[(
                    "--request",
                    m(&[(
                        "values",
                        m(&[("POST", m(&[("--insecure", Doc::text("deny"))]))]),
                    )]),
                )]),
            ),
            (
                "git",
                m(&[(
                    "checkout",
                    m(&[("operands", m(&[("release/*", Doc::text("ask"))]))]),
                )]),
            ),
            (
                "rm",
                m(&[
                    ("decision", Doc::text("deny")),
                    ("reason", Doc::text("kept")),
                ]),
            ),
        ]);
        let out = shape(&raw).unwrap();
        assert_eq!(decisions(&out), ["allow"]);
        let gh = out.get("subcommands").get("gh");
        assert_eq!(decisions(gh), ["deny"]);
        let merge = gh
            .get("subcommands")
            .get("pr")
            .get("subcommands")
            .get("merge");
        assert_eq!(decisions(merge), ["allow"]);
        assert_eq!(decisions(merge.get("options").get("--admin")), ["deny"]);
        let post = out
            .get("subcommands")
            .get("curl")
            .get("options")
            .get("--request")
            .get("values")
            .get("POST");
        assert_eq!(decisions(post.get("options").get("--insecure")), ["deny"]);
        let checkout = out
            .get("subcommands")
            .get("git")
            .get("subcommands")
            .get("checkout");
        assert_eq!(
            decisions(checkout.get("operands").get("release/*")),
            ["ask"]
        );
        let rm = out.get("subcommands").get("rm");
        assert_eq!(decisions(rm), ["deny"]);
        assert_eq!(rm.get("decision").get("reason").shown(), "kept");
        assert_eq!(rm.get("decision").field("paths"), None);
        assert_eq!(rm.get("other_options"), &Doc::Null);
    }

    #[test]
    fn a_rule_with_paths_names_the_folder_entry_to_write() {
        let rule = |paths: Doc| m(&[("decision", Doc::text("deny")), ("paths", paths)]);
        let cases = [
            (
                m(&[("rm", rule(texts(&["/data/keep/*"])))]),
                "commands.rm: a rule takes no paths; scope it to a folder with mounts[/data/keep].commands.rm",
            ),
            (
                m(&[("rm", rule(texts(&["/data/keep"])))]),
                "commands.rm: a rule takes no paths; scope it to a folder with mounts[/data/keep].commands.rm",
            ),
            (
                m(&[(
                    "gh",
                    m(&[("pr", m(&[("--admin", rule(texts(&["/repo/*"])))]))]),
                )]),
                "commands.gh.pr.--admin: a rule takes no paths; scope it to a folder with mounts[/repo].commands.gh.pr.--admin",
            ),
            (
                m(&[("rm", rule(Doc::text("/d/a")))]),
                "commands.rm: a rule takes no paths; scope it to a folder with mounts[/d/a].commands.rm",
            ),
            (
                m(&[("rm", rule(Doc::List(Vec::new())))]),
                "commands.rm: a rule takes no paths; scope it to a folder with mounts[<folder>].commands.rm",
            ),
            (
                m(&[("rm", rule(texts(&["/data/keep/**"])))]),
                "commands.rm: a rule takes no paths; scope it to a folder with mounts[/data/keep].commands.rm",
            ),
            (
                m(&[("rm", rule(texts(&["*.pem"])))]),
                "commands.rm: a rule takes no paths; scope it to each folder with mounts[<folder>].commands.rm, or hide those paths with paths.hide",
            ),
            (
                m(&[("rm", rule(texts(&["/data/secret*"])))]),
                "commands.rm: a rule takes no paths; scope it to each folder with mounts[<folder>].commands.rm, or hide those paths with paths.hide",
            ),
            (
                m(&[("rm", rule(texts(&["/data/*/sub/*"])))]),
                "commands.rm: a rule takes no paths; scope it to each folder with mounts[<folder>].commands.rm, or hide those paths with paths.hide",
            ),
            (
                m(&[("rm", rule(texts(&[""])))]),
                "commands.rm: a rule takes no paths; scope it to each folder with mounts[<folder>].commands.rm, or hide those paths with paths.hide",
            ),
            (
                m(&[("rm", rule(texts(&["/data/a/**", "/data/b/**"])))]),
                "commands.rm: a rule takes no paths; give each folder its own entry: mounts[/data/a].commands.rm and mounts[/data/b].commands.rm",
            ),
            (
                m(&[("rm", rule(texts(&["/a/*", "/b", "/c/**"])))]),
                "commands.rm: a rule takes no paths; give each folder its own entry: mounts[/a].commands.rm, mounts[/b].commands.rm and mounts[/c].commands.rm",
            ),
            (
                m(&[("rm", rule(texts(&["/data/keep/*", "/data/keep/**"])))]),
                "commands.rm: a rule takes no paths; scope it to a folder with mounts[/data/keep].commands.rm",
            ),
            (
                m(&[("rm", rule(texts(&["/data/a/*", "*.pem"])))]),
                "commands.rm: a rule takes no paths; scope it to each folder with mounts[<folder>].commands.rm, or hide those paths with paths.hide",
            ),
            (
                m(&[("*", m(&[("paths", texts(&["/vault/*"]))]))]),
                "commands.*: a rule takes no paths; scope it to a folder with mounts[/vault].commands.*",
            ),
        ];
        for (raw, error) in cases {
            assert_eq!(shape(&raw).unwrap_err(), error);
        }
        let mount = m(&[("rm", rule(texts(&["/d/keep/*"])))]);
        assert_eq!(
            tree(&mount, "mounts[/d].commands").unwrap_err(),
            "mounts[/d].commands.rm: a rule takes no paths; scope it to a folder with mounts[/d/keep].commands.rm"
        );
    }

    #[test]
    fn a_rule_is_one_decision_at_every_place_it_stands() {
        let list = || texts(&["allow", "deny"]);
        let cases = [
            (m(&[("*", list())]), "commands.*"),
            (m(&[("rm", list())]), "commands.rm"),
            (m(&[("rm", texts(&["deny"]))]), "commands.rm"),
            (m(&[("rm", m(&[("*", list())]))]), "commands.rm.*"),
            (m(&[("rm", m(&[("-*", list())]))]), "commands.rm.-*"),
            (m(&[("gh", m(&[("pr", list())]))]), "commands.gh.pr"),
            (
                m(&[("rm", m(&[("--force", list())]))]),
                "commands.rm.--force",
            ),
            (
                m(&[("rm", m(&[("--force", m(&[("*", list())]))]))]),
                "commands.rm.--force.*",
            ),
            (
                m(&[(
                    "curl",
                    m(&[("--request", m(&[("values", m(&[("POST", list())]))]))]),
                )]),
                "commands.curl.--request.values[POST]",
            ),
            (
                m(&[(
                    "curl",
                    m(&[(
                        "--request",
                        m(&[("values", m(&[("POST", m(&[("*", list())]))]))]),
                    )]),
                )]),
                "commands.curl.--request.values[POST].*",
            ),
            (
                m(&[("git", m(&[("operands", m(&[("main", list())]))]))]),
                "commands.git.operands[main]",
            ),
        ];
        for (raw, at) in cases {
            assert_eq!(
                shape(&raw).unwrap_err(),
                format!("{at}: a rule is one decision, not a list")
            );
        }
        assert_eq!(
            tree(&m(&[("rm", list())]), "mounts[/d].commands").unwrap_err(),
            "mounts[/d].commands.rm: a rule is one decision, not a list"
        );
    }

    #[test]
    fn the_flat_format_is_named_and_refused() {
        for raw in [
            m(&[("deny", texts(&["rm -rf"]))]),
            m(&[("allow", texts(&["*", "gh pr view"]))]),
            m(&[("ask", Doc::List(vec![m(&[("commands", texts(&["rm"]))])]))]),
            m(&[("deny", Doc::List(Vec::new()))]),
        ] {
            let error = shape(&raw).unwrap_err();
            assert!(error.contains("old flat format"), "{error}");
            assert!(error.contains("tree of command names"), "{error}");
        }
        assert_eq!(
            shape(&m(&[("deny", texts(&["ask", "deny"]))])).unwrap_err(),
            "commands.deny: a rule is one decision, not a list"
        );
        let sealed = m(&[(
            "deny",
            Doc::List(vec![m(&[("paths", texts(&["/data/secret*"]))])]),
        )]);
        assert!(shape(&sealed).unwrap_err().contains("paths.hide"));
        let named = m(&[("deny", Doc::List(vec![m(&[("commands", texts(&["rm"]))])]))]);
        assert!(!shape(&named).unwrap_err().contains("paths.hide"));
    }

    #[test]
    fn a_misplaced_key_is_refused_with_where_it_goes() {
        let cases = [
            (
                m(&[(
                    "curl",
                    m(&[("--request", m(&[("DELETE", Doc::text("deny"))]))]),
                )]),
                "a value goes under values",
            ),
            (
                m(&[("curl", m(&[("values", m(&[("x", Doc::text("deny"))]))]))]),
                "values belong under an option",
            ),
            (m(&[("--force", Doc::text("deny"))]), "needs a command"),
            (m(&[("decision", Doc::text("deny"))]), "needs a command"),
            (
                m(&[(
                    "git",
                    m(&[
                        ("add", Doc::text("deny")),
                        ("operands", m(&[("x", Doc::text("deny"))])),
                    ]),
                )]),
                "without subcommands",
            ),
            (m(&[("rm", Doc::text("never"))]), "no decision"),
            (
                m(&[("rm", Doc::List(Vec::new()))]),
                "commands.rm: a rule is one decision, not a list",
            ),
            (
                m(&[("rm", m(&[("reason", Doc::text("x"))]))]),
                "decision must be allow, ask or deny",
            ),
            (
                m(&[(
                    "rm",
                    m(&[("decision", Doc::text("deny")), ("reason", Doc::Null)]),
                )]),
                "reason must be a string",
            ),
            (
                m(&[(
                    "rm",
                    m(&[("decision", Doc::text("deny")), ("pr", Doc::text("allow"))]),
                )]),
                "unknown field",
            ),
            (
                m(&[(
                    "rm",
                    m(&[(
                        "operands",
                        Doc::Map(vec![(Doc::Invalid, Doc::text("deny"))]),
                    )]),
                )]),
                "quote a number",
            ),
            (
                m(&[(
                    "rm",
                    m(&[(
                        "--force",
                        m(&[("operands", m(&[("x", Doc::text("deny"))]))]),
                    )]),
                )]),
                "operands belong on a command",
            ),
        ];
        for (raw, expected) in cases {
            let error = shape(&raw).unwrap_err();
            assert!(error.contains(expected), "{error} lacks {expected}");
        }
    }
}
