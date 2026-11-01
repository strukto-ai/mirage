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

    fn get(&self, name: &str) -> &Self {
        match self {
            Self::Map(fields) => fields
                .iter()
                .find(|(key, _)| key.named(name))
                .map_or(&Self::Null, |(_, value)| value),
            _ => &Self::Null,
        }
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
    reason: Text,
    #[serde(default)]
    dialect: Whitespace,
}

fn nonblank(value: &Doc, dialect: Whitespace) -> bool {
    matches!(value, Doc::Text(text) if text.iter().any(|&unit| !crate::policy::pattern::whitespace(unit, dialect)))
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

fn rule(raw: &Doc, at: &str, reason: &[u32], dialect: Whitespace) -> Answer {
    if matches!(raw, Doc::Text(_)) {
        return Ok(Doc::List(vec![object(vec![
            ("reason", Doc::Text(reason.to_vec())),
            (
                "commands",
                strings(
                    &Doc::List(vec![raw.clone()]),
                    &format!("{at}.commands"),
                    Some("a command"),
                    dialect,
                )?,
            ),
        ])]));
    }
    if !matches!(raw, Doc::Map(_)) {
        return Err(format!("{at} must be a command pattern or a mapping"));
    }
    fields(raw, &["reason", "commands", "paths"], at)?;
    let default_reason = Doc::Text(reason.to_vec());
    let reason = raw
        .mapping(at)?
        .iter()
        .find(|(key, _)| key.named("reason"))
        .map_or(&default_reason, |(_, value)| value);
    if !matches!(reason, Doc::Text(_)) {
        return Err(format!("{at}.reason must be a string"));
    }
    let commands = raw.get("commands");
    let paths = raw.get("paths");
    if let Doc::Map(entries) = commands {
        if !matches!(paths, Doc::Null) {
            return Err(format!(
                "{at} maps each command to its paths, so it takes no paths of its own"
            ));
        }
        if entries.is_empty() {
            return Err(format!("{at}.commands must name at least one command"));
        }
        let mut out = Vec::new();
        for (pattern, paths) in entries {
            if !nonblank(pattern, dialect) {
                return Err(format!("{at}.commands keys must name a command"));
            }
            let at = format!("{at}.commands[{}]", pattern.shown());
            let paths = strings(paths, &at, Some("a path"), dialect)?;
            if matches!(&paths, Doc::List(items) if items.is_empty()) {
                return Err(format!("{at} must list at least one path"));
            }
            out.push(object(vec![
                ("reason", reason.clone()),
                ("commands", Doc::List(vec![pattern.clone()])),
                ("paths", paths),
            ]));
        }
        return Ok(Doc::List(out));
    }
    if !matches!(commands, Doc::Null) && !matches!(paths, Doc::Null) {
        return Err(format!(
            "{at} lists commands beside paths; map each command to its paths instead"
        ));
    }
    if matches!(commands, Doc::Null) && matches!(paths, Doc::Null) {
        return Err(format!("{at} names no command and no path"));
    }
    Ok(Doc::List(vec![object(vec![
        ("reason", reason.clone()),
        (
            "commands",
            strings(
                commands,
                &format!("{at}.commands"),
                Some("a command"),
                dialect,
            )?,
        ),
        (
            "paths",
            strings(paths, &format!("{at}.paths"), Some("a path"), dialect)?,
        ),
    ])]))
}

fn rules(raw: &Doc, at: &str, reason: &[u32], dialect: Whitespace) -> Answer {
    let mut out = Vec::new();
    for (i, entry) in raw.list(at, "a list of rules")?.iter().enumerate() {
        if let Doc::List(items) = rule(entry, &format!("{at}[{i}]"), reason, dialect)? {
            out.extend(items);
        }
    }
    Ok(Doc::List(out))
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
        ("store_group", "store.workspace") => &["ram", "disk", "redis", "s3"],
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
            "observer",
            "workspace",
            "jobs",
        ],
        "store",
    )?;
    for group in ["namespace", "observer", "workspace", "jobs"] {
        let block = raw.get(group);
        if matches!(block, Doc::Null) {
            continue;
        }
        let at = format!("store.{group}");
        block.mapping(&format!("config `{at}`"))?;
        if block.get("type").named("s3") && group != "workspace" {
            return Err(format!(
                "config `{at}` cannot be s3: the s3 store hosts only the sessions+meta group; keep the {group} plane on ram or redis and pass the s3 store as the 'workspace' group override"
            ));
        }
        if group == "observer" && block.get("type").named("redis") {
            return Err("config `store.observer` cannot be redis: history only grows; keep it on ram or disk".into());
        }
        if group == "jobs" && block.get("type").named("disk") {
            return Err("config `store.jobs` cannot be disk: a job's console is a stream other processes follow; keep the jobs plane on ram or redis".into());
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
                "network",
                "system_time",
                "clis",
                "runtimes",
                "route_policy",
                "profiles",
                "profile",
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
        "cli" => config_fields(raw, &["cli", "script", "runtime", "config"], at)?,
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
        reason,
        dialect,
    } = config;
    let at = Doc::Text(at).shown();
    let result = match op.as_str() {
        "strings" => strings(&raw, &at, names.as_deref(), dialect),
        "absolute" => absolute(&raw, &at).map(|()| Doc::Null),
        "under" => under(&raw, &root, &at).map(|()| Doc::Null),
        "rule" => rule(&raw, &at, &reason, dialect),
        "rules" => rules(&raw, &at, &reason, dialect),
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
    fn scoped_commands_preserve_mapping_order_and_reject_ambiguous_rules() {
        let commands = object(vec![("z", texts(&["/last"])), ("a", texts(&["/first"]))]);
        let raw = object(vec![("commands", commands.clone())]);
        let Doc::List(parsed) = rule(&raw, "deny", &[120], Whitespace::Python).unwrap() else {
            panic!()
        };
        assert_eq!(parsed[0].get("commands"), &texts(&["z"]));
        assert_eq!(parsed[1].get("paths"), &texts(&["/first"]));
        assert_eq!(parsed[0].get("reason"), &Doc::text("x"));
        let mixed = object(vec![("commands", commands), ("paths", texts(&["/other"]))]);
        assert!(
            rule(&mixed, "deny", &[], Whitespace::Python)
                .unwrap_err()
                .contains("no paths of its own")
        );
        let mixed = object(vec![
            ("commands", texts(&["rm"])),
            ("paths", texts(&["/other"])),
        ]);
        assert!(
            rule(&mixed, "deny", &[], Whitespace::Python)
                .unwrap_err()
                .contains("map each command")
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
        assert!(store(&object(vec![("workspace", s3.clone())])).is_ok());
        assert!(
            store(&object(vec![("namespace", s3)]))
                .unwrap_err()
                .contains("cannot be s3")
        );
        assert!(
            store(&object(vec![(
                "jobs",
                object(vec![("type", Doc::text("disk"))])
            )]))
            .unwrap_err()
            .contains("cannot be disk")
        );
        assert!(
            store(&object(vec![(
                "observer",
                object(vec![("type", Doc::text("redis"))])
            )]))
            .unwrap_err()
            .contains("cannot be redis")
        );
        assert!(
            store(&object(vec![(
                "jobs",
                object(vec![("type", Doc::text("other"))])
            )]))
            .unwrap_err()
            .contains("one of ram, disk, redis)")
        );
    }

    #[test]
    fn a_reason_defaults_only_when_absent() {
        let invalid = object(vec![("commands", texts(&["rm"])), ("reason", Doc::Null)]);
        assert!(
            rule(&invalid, "deny", &[120], Whitespace::Python)
                .unwrap_err()
                .contains("reason must be a string")
        );
    }
}
