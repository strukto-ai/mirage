// Adapted from OfficeCLI 1.0.161.
// https://github.com/iOfficeAI/OfficeCLI/tree/v1.0.161
// Licensed under Apache-2.0. See licenses/third_party/officecli.txt.

use super::batch::{self, Item};
use super::errors::{Fail, SetFail};
use super::media::{self, Media};
use super::node::{Json, Node, lines, matches};
use super::package::*;
use super::query::{Warning, filter_selector, text_matches};
use super::types::Place;
use super::types::{Config, Out, Outcome, Output, unsupported_text};
use super::xml::text;
use super::{VERBS, batch_source, item_warnings, pairs, print_batch};
use super::{slides, word};
use crate::request::failure_text;
use crate::task::Host;

/// Which handler reads the document.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Kind {
    Word,
    Slides,
}

impl Kind {
    pub(super) fn of(file: &str) -> Option<Kind> {
        let lower = file.to_ascii_lowercase();
        if lower.ends_with(".docx") {
            Some(Kind::Word)
        } else if lower.ends_with(".pptx") {
            Some(Kind::Slides)
        } else {
            None
        }
    }

    fn ext(self) -> &'static str {
        match self {
            Kind::Word => "docx",
            Kind::Slides => "pptx",
        }
    }

    fn get(self, pkg: &Pkg<'_>, path: &str, depth: usize) -> Result<Node, Fail> {
        let node = match self {
            Kind::Word => word::api::get(pkg, path, depth)?,
            Kind::Slides => slides::api::get(pkg, path, depth)?,
        };
        if node.kind == "error" {
            return Err(enriched(
                node.text
                    .unwrap_or_else(|| format!("Path not found: {path}")),
            ));
        }
        Ok(node)
    }

    /// The handler's own pass over a selector.
    fn dispatch(self, pkg: &Pkg<'_>, selector: &str) -> Result<Vec<Node>, Fail> {
        let found = match self {
            Kind::Word => word::api::query(pkg, selector)?,
            Kind::Slides => return slides::api::query(pkg, selector),
        };
        Ok(if selector.is_empty() || selector.starts_with('/') {
            found
        } else {
            take_nth(selector, found)
        })
    }

    fn query(
        self,
        pkg: &Pkg<'_>,
        selector: &str,
        find: Option<&str>,
    ) -> Result<(Vec<Node>, Vec<Warning>), Fail> {
        let (results, warnings) = filter_selector(selector, &|s| self.dispatch(pkg, s), false)?;
        let kept = match find.filter(|f| !f.is_empty()) {
            None => results,
            Some(f) => {
                let mut kept = Vec::new();
                for n in results {
                    if let Some(t) = &n.text {
                        if text_matches(t, f)? {
                            kept.push(n);
                        }
                    }
                }
                kept
            }
        };
        Ok((kept, warnings))
    }

    fn set(
        self,
        pkg: &mut Pkg<'_>,
        path: &str,
        props: &[(String, String)],
    ) -> Result<(String, Vec<String>), SetFail> {
        match self {
            Kind::Word => word::api::set(pkg, path, props),
            Kind::Slides => slides::api::set(pkg, path, props),
        }
    }

    fn remove(self, pkg: &mut Pkg<'_>, path: &str) -> Result<(String, Vec<String>), Fail> {
        match self {
            Kind::Word => word::api::remove(pkg, path),
            Kind::Slides => slides::api::remove(pkg, path),
        }
    }

    fn hydrate(self, pkg: &Pkg<'_>, results: &mut [Node]) {
        for n in results.iter_mut() {
            if n.child_count == 0 || !n.children.is_empty() || n.path.is_empty() {
                continue;
            }
            if let Ok(full) = self.get(pkg, &n.path, 1) {
                n.children = full.children;
            }
        }
    }
}

/// What a placed shape's position line and overlap check read: the
/// shape's own properties and those of the other shapes on its slide.
struct PlacementView {
    own: Option<(String, Vec<(String, String)>)>,
    siblings: Vec<(String, Vec<(String, String)>)>,
}

/// The view `placement` reads, taken before the package is saved: empty
/// unless `wanted` and the deck placed a shape at `path`.
fn placement_view(kind: Kind, pkg: &Pkg<'_>, wanted: bool, path: &str) -> PlacementView {
    let empty = PlacementView {
        own: None,
        siblings: Vec::new(),
    };
    if !wanted || !matches!(kind, Kind::Slides) {
        return empty;
    }
    let props = |n: &Node| -> Vec<(String, String)> {
        n.format
            .iter()
            .map(|(k, v)| (k.clone(), v.text()))
            .collect()
    };
    let Ok(node) = kind.get(pkg, path, 1) else {
        return empty;
    };
    if matches!(
        node.kind.as_str(),
        "slide" | "paragraph" | "run" | "cell" | "row" | "tc" | "tr"
    ) {
        return empty;
    }
    let slide = path
        .strip_prefix("/slide[")
        .and_then(|r| r.split_once(']'))
        .map(|(n, _)| format!("/slide[{n}]"));
    let siblings = slide
        .and_then(|s| kind.get(pkg, &s, 1).ok())
        .map(|s| {
            s.children
                .iter()
                .filter(|c| c.path != path && c.path != node.path)
                .map(|c| (c.path.clone(), props(c)))
                .collect()
        })
        .unwrap_or_default();
    PlacementView {
        own: Some((node.path.clone(), props(&node))),
        siblings,
    }
}

/// A placed shape's position line, `x: X  y: Y  width: W  height: H`, and
/// a warning for each other shape at exactly its spot.
fn placement(
    _kind: Kind,
    view: &PlacementView,
    _path: &str,
) -> (Option<String>, Vec<super::types::Advice>) {
    let Some((_, own)) = &view.own else {
        return (None, Vec::new());
    };
    let get =
        |p: &[(String, String)], k: &str| p.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    let (Some(x), Some(y)) = (get(own, "x"), get(own, "y")) else {
        return (None, Vec::new());
    };
    let line = format!(
        "x: {x}  y: {y}  width: {}  height: {}",
        get(own, "width").unwrap_or_else(|| "?".to_string()),
        get(own, "height").unwrap_or_else(|| "?".to_string())
    );
    let names: Vec<String> = view
        .siblings
        .iter()
        .filter(|(_, p)| {
            get(p, "x").as_deref() == Some(x.as_str())
                && get(p, "y").as_deref() == Some(y.as_str())
                && !(x == "0cm" && y == "0cm")
        })
        .map(|(path, p)| get(p, "name").unwrap_or_else(|| path.clone()))
        .collect();
    let advice = if names.is_empty() {
        Vec::new()
    } else {
        vec![super::types::Advice {
            message: format!("Same position as {}", names.join(", ")),
            code: "position_overlap",
            suggestion: Some("Use --prop x=... y=... to set distinct positions".to_string()),
        }]
    };
    (Some(line), advice)
}

/// What `set` echoes after its line when a value landed in another form
/// than it was given: each property the change touched that a requested
/// key accounts for, as `get` now shows it.
fn applied_suffix(
    applied: &[(String, String)],
    before: Option<&[(String, String)]>,
    after: Option<&[(String, String)]>,
) -> String {
    let Some(after) = after else {
        return String::new();
    };
    if applied.is_empty() {
        return String::new();
    }
    let camel = |key: &str, req: &str| {
        key.len() > req.len()
            && key[..req.len()].eq_ignore_ascii_case(req)
            && key[req.len()..].starts_with(|c: char| c.is_ascii_uppercase())
    };
    let prefix = |a: &str, b: &str| {
        a.len() > b.len() + 1
            && a[..b.len()].eq_ignore_ascii_case(b)
            && a.as_bytes()[b.len()] == b'.'
    };
    let diff_attributable = |key: &str, req: &(String, String)| {
        key.eq_ignore_ascii_case(&req.0)
            || prefix(key, &req.0)
            || prefix(&req.0, key)
            || camel(key, &req.0)
    };
    let segment = |req: &str, value: &str| {
        req.contains(':') && {
            let v = value.trim().trim_start_matches('#');
            req.split(':')
                .any(|s| s.trim().trim_start_matches('#').eq_ignore_ascii_case(v))
        }
    };
    let fallback = |kv: &(String, String), req: &(String, String)| {
        kv.0.eq_ignore_ascii_case(&req.0)
            || (prefix(&kv.0, &req.0) && kv.1 == req.1)
            || (camel(&kv.0, &req.0) && segment(&req.1, &kv.1))
    };
    let diff: Vec<&(String, String)> = match before {
        Some(before) => after
            .iter()
            .filter(|kv| {
                !before
                    .iter()
                    .any(|b| b.0.eq_ignore_ascii_case(&kv.0) && b.1 == kv.1)
            })
            .collect(),
        None => Vec::new(),
    };
    let mut picked: Vec<(String, String)> = Vec::new();
    for req in applied {
        let from_diff: Vec<&(String, String)> = diff
            .iter()
            .copied()
            .filter(|kv| diff_attributable(&kv.0, req))
            .collect();
        let chosen: Vec<&(String, String)> = if from_diff.is_empty() {
            after.iter().filter(|kv| fallback(kv, req)).collect()
        } else {
            from_diff
        };
        for kv in chosen {
            match picked.iter_mut().find(|p| p.0.eq_ignore_ascii_case(&kv.0)) {
                Some(p) => p.1 = kv.1.clone(),
                None => picked.push(kv.clone()),
            }
        }
    }
    if picked.is_empty() {
        return String::new();
    }
    picked.sort_by_key(|(k, _)| k.to_lowercase());
    let identical = applied.iter().all(|r| {
        picked
            .iter()
            .any(|d| d.0.eq_ignore_ascii_case(&r.0) && d.1 == r.1)
    }) && picked.iter().all(|d| {
        applied
            .iter()
            .any(|r| d.0.eq_ignore_ascii_case(&r.0) && d.1 == r.1)
    });
    if identical {
        return String::new();
    }
    let shown: Vec<String> = picked.iter().map(|(k, v)| format!("{k}={v}")).collect();
    format!(" (applied: {})", shown.join(", "))
}

/// One office command on a Word document or a PowerPoint deck.
pub(super) async fn run(host: &Host, config: &Config, kind: Kind) -> i32 {
    let out = Out {
        host,
        json: config.json,
    };
    let path = config.path.clone().unwrap_or_else(|| "/".to_string());
    match config.command.as_str() {
        "get" => {
            let pkg = match Pkg::open(host, config).await {
                Ok(p) => p,
                Err(f) => return out.fail(&f),
            };
            let depth = config.depth.unwrap_or(1);
            if depth < 0 {
                return out.fail(&Fail::coded(
                    format!("Invalid --depth {depth}: must be >= 0."),
                    "invalid_value",
                ));
            }
            match kind.get(&pkg, &path, (depth as usize).max(1)) {
                Ok(mut node) => {
                    if depth == 0 {
                        node.children.clear();
                    }
                    node.strip_internal();
                    if out.json {
                        out.data(matches(&[node]), None, true);
                    } else {
                        host.print(node.tree().as_bytes());
                    }
                    0
                }
                Err(f) => out.fail(&f),
            }
        }
        "query" => {
            if path.trim().is_empty() {
                return out.fail(&Fail::coded(
                    "'query' requires a selector (e.g. paragraph, shape, row[Score>80])."
                        .to_string(),
                    "invalid_input",
                ));
            }
            let pkg = match Pkg::open(host, config).await {
                Ok(p) => p,
                Err(f) => return out.fail(&f),
            };
            match kind.query(&pkg, &path, config.find.as_deref()) {
                Ok((mut results, warnings)) => {
                    if out.json {
                        kind.hydrate(&pkg, &mut results);
                        for n in &mut results {
                            n.strip_internal();
                        }
                        let w = (!warnings.is_empty())
                            .then(|| Json::Arr(warnings.iter().map(Warning::json).collect()));
                        out.data(matches(&results), w, true);
                    } else {
                        for w in &warnings {
                            host.warn(format!("{}\n", w.message).as_bytes());
                        }
                        for n in &mut results {
                            n.strip_internal();
                        }
                        if results.is_empty() {
                            host.warn(
                                format!(
                                    "No matches. Run 'office help {} query' for selector syntax.\n",
                                    kind.ext()
                                )
                                .as_bytes(),
                            );
                        } else {
                            host.print(format!("{}\n", lines(&results)).as_bytes());
                        }
                    }
                    0
                }
                Err(f) => out.fail(&f),
            }
        }
        "set" | "remove" => {
            if config.command == "set" && config.props.is_empty() {
                return out.fail(&Fail::of(format!(
                    "No properties to set at {path}. Pass at least one --prop key=value."
                )));
            }
            let mut pkg = match Pkg::open(host, config).await {
                Ok(p) => p,
                Err(f) => return out.fail(&f),
            };
            let props = pairs(&config.props);
            let before = (config.command == "set")
                .then(|| snapshot(kind, &pkg, &path))
                .flatten();
            let done = if config.command == "set" {
                kind.set(&mut pkg, &path, &props)
            } else {
                kind.remove(&mut pkg, &path).map_err(SetFail::Fail)
            };
            let (message, warnings, left) = match done {
                Ok((message, warnings)) => (message, warnings, None),
                Err(SetFail::Partial {
                    message,
                    warnings,
                    keys,
                    element,
                    valid,
                }) => (message, warnings, Some((keys, element, valid))),
                Err(SetFail::Fail(f)) => return out.fail(&f),
                Err(SetFail::Unsupported {
                    keys,
                    element,
                    valid,
                }) => return out.unsupported(&path, &keys, element, valid),
            };
            let message = if config.command == "set" {
                let after = snapshot(kind, &pkg, &path);
                let applied: Vec<(String, String)> = props
                    .iter()
                    .filter(|(k, _)| left.as_ref().is_none_or(|(keys, ..)| !keys.contains(k)))
                    .cloned()
                    .collect();
                format!(
                    "{message}{}",
                    applied_suffix(&applied, before.as_deref(), after.as_deref())
                )
            } else {
                message
            };
            for w in &warnings {
                host.warn(format!("{w}\n").as_bytes());
            }
            let moved = config.command == "set"
                && props.iter().any(|(k, _)| {
                    ["x", "left", "y", "top", "width", "w", "height", "h"]
                        .iter()
                        .any(|p| k.eq_ignore_ascii_case(p))
                });
            let view = placement_view(kind, &pkg, moved, &path);
            if pkg.dirty() {
                if let Some(reply) = pkg.save(host, &config.absolute).await {
                    return out.fail(&Fail::of(text(&failure_text(&reply))));
                }
            }
            let (spatial, advice) = placement(kind, &view, &path);
            let message = match &spatial {
                Some(line) => format!("{message}\n  {line}"),
                None => message,
            };
            if let Some((keys, element, valid)) = left {
                return out.partly(&message, &keys, element, valid);
            }
            match spatial {
                Some(_) if !out.json => {
                    host.print(format!("{message}\n").as_bytes());
                    for a in &advice {
                        host.warn(format!("  WARNING: {}\n", a.message).as_bytes());
                    }
                    0
                }
                _ => out.done(&message),
            }
        }
        "batch" => run_batch(&out, config, kind).await,
        "create" => super::create(&out, config).await,
        "add" | "move" | "swap" => {
            if config.command == "add" {
                if let Some(fail) = super::add_usage(config) {
                    return out.fail(&fail);
                }
            }
            let mut pkg = match Pkg::open(host, config).await {
                Ok(p) => p,
                Err(f) => return out.fail(&f),
            };
            let place = Place {
                index: config.index,
                after: config.after.as_deref(),
                before: config.before.as_deref(),
            };
            let kind_name = config.kind.clone().unwrap_or_default();
            let props = pairs(&config.props);
            let images = if config.command == "add" {
                media::gather(host, media::sources(&kind_name, &props)).await
            } else {
                Media::new()
            };
            let done: Result<(String, Vec<String>, Vec<String>), Fail> =
                match (kind, config.command.as_str()) {
                    (Kind::Word, "add") => {
                        word::edit::add(&mut pkg, &path, &kind_name, &place, &props, &images)
                    }
                    (Kind::Word, "move") => {
                        word::edit::move_to(&mut pkg, &path, config.to.as_deref(), &place)
                            .map(|m| (m, Vec::new(), Vec::new()))
                    }
                    (Kind::Word, "swap") => word::edit::swap(
                        &mut pkg,
                        &path,
                        config.path2.as_deref().unwrap_or_default(),
                    )
                    .map(|m| (m, Vec::new(), Vec::new())),
                    (Kind::Slides, "add") => {
                        slides::edit::add(&mut pkg, &path, &kind_name, &place, &props, &images)
                    }
                    (Kind::Slides, "move") => {
                        slides::edit::move_to(&mut pkg, &path, config.to.as_deref(), &place)
                            .map(|m| (m, Vec::new(), Vec::new()))
                    }
                    (Kind::Slides, "swap") => slides::edit::swap(
                        &mut pkg,
                        &path,
                        config.path2.as_deref().unwrap_or_default(),
                    )
                    .map(|m| (m, Vec::new(), Vec::new())),
                    _ => Err(Fail::of(format!("Unknown command: {}", config.command))),
                };
            let (line, unread, warnings) = match done {
                Ok(d) => d,
                Err(f) => return out.fail(&f),
            };
            for w in &warnings {
                host.warn(format!("{w}\n").as_bytes());
            }
            let pkg_view = placement_view(kind, &pkg, config.command == "add", &line);
            if pkg.dirty() {
                if let Some(reply) = pkg.save(host, &config.absolute).await {
                    return out.fail(&Fail::of(text(&failure_text(&reply))));
                }
            }
            if config.command == "add" {
                let (spatial, advice) = placement(kind, &pkg_view, &line);
                super::added(
                    &out,
                    &kind_name,
                    &line,
                    &unread,
                    spatial.as_deref(),
                    &advice,
                )
            } else {
                out.done(&line)
            }
        }
        other => out.fail(&Fail::of(format!("Unknown command: {other}"))),
    }
}

fn run_item(
    pkg: &mut Pkg<'_>,
    kind: Kind,
    item: &Item,
    json: bool,
    notes: &mut Vec<String>,
    images: &Media,
) -> Result<Output, (String, Option<&'static str>)> {
    let fail = |f: Fail| (f.message, f.code);
    let verb = item.command.to_ascii_lowercase();
    match verb.as_str() {
        "meta" => Ok(Output::Text("meta".to_string())),
        "get" => {
            let path = item.path.clone().unwrap_or_else(|| "/".to_string());
            let depth = item.depth.unwrap_or(1).max(0) as usize;
            let mut node = kind.get(pkg, &path, depth).map_err(fail)?;
            node.strip_internal();
            Ok(if json {
                Output::Data(matches(&[node]))
            } else {
                Output::Text(node.tree())
            })
        }
        "query" => {
            let selector = item
                .selector
                .clone()
                .or_else(|| item.path.clone())
                .unwrap_or_default();
            if selector.is_empty() {
                return Err(("'query' command requires 'selector' field. Example: {\"command\": \"query\", \"selector\": \"row[Score>80]\"}".to_string(), None));
            }
            let (mut results, warnings) = kind
                .query(pkg, &selector, item.text.as_deref())
                .map_err(fail)?;
            notes.extend(warnings.into_iter().map(|w| w.message));
            for n in &mut results {
                n.strip_internal();
            }
            Ok(if json {
                Output::Data(matches(&results))
            } else {
                Output::Text(lines(&results))
            })
        }
        "set" => {
            let Some(path) = item.path.clone().filter(|p| !p.is_empty()) else {
                return Err(("'set' command requires 'path' field. Example: {\"command\": \"set\", \"path\": \"/slide[1]\", \"props\": {\"bold\": \"true\"}}".to_string(), None));
            };
            let props = item.props.clone().unwrap_or_default();
            if props.is_empty() {
                return Err(("'set' command requires 'props' field with at least one key=value. Got empty/missing props.".to_string(), None));
            }
            match kind.set(pkg, &path, &props) {
                Ok((message, warnings)) => {
                    notes.extend(warnings);
                    Ok(Output::Text(message))
                }
                Err(SetFail::Partial {
                    message,
                    warnings,
                    keys,
                    element,
                    valid,
                }) => {
                    notes.extend(warnings);
                    Ok(Output::Text(format!(
                        "{message}\n{}",
                        unsupported_text(&keys, element, valid)
                    )))
                }
                Err(SetFail::Fail(f)) => Err(fail(f)),
                Err(SetFail::Unsupported {
                    keys,
                    element,
                    valid,
                }) => Err((unsupported_text(&keys, element, valid), None)),
            }
        }
        "remove" => {
            let Some(path) = item.path.clone().filter(|p| !p.is_empty()) else {
                return Err(("'remove' command requires 'path' field. Example: {\"command\": \"remove\", \"path\": \"/slide[1]/shape[2]\"}".to_string(), None));
            };
            let (message, warnings) = kind.remove(pkg, &path).map_err(fail)?;
            notes.extend(warnings);
            Ok(Output::Text(message))
        }
        "add" => {
            let Some(parent) = item
                .field("parent")
                .or_else(|| item.path.clone())
                .filter(|p| !p.is_empty())
            else {
                return Err(("'add' command requires 'parent' field. Example: {\"command\": \"add\", \"parent\": \"/slide[1]\", \"type\": \"shape\", \"props\": {\"text\": \"Hello\"}}".to_string(), None));
            };
            let kind_name = item.field("type").unwrap_or_default();
            if kind_name.is_empty() && item.field("from").is_none_or(|f| f.is_empty()) {
                return Err(("'add' command requires 'type' or 'from' field. Example: {\"command\": \"add\", \"parent\": \"/\", \"type\": \"slide\"}".to_string(), None));
            }
            let (after, before) = (item.field("after"), item.field("before"));
            let index = item.index();
            let place = Place {
                index,
                after: if index.is_none() {
                    after.as_deref().filter(|a| !a.is_empty())
                } else {
                    None
                },
                before: if index.is_none() && after.as_deref().is_none_or(str::is_empty) {
                    before.as_deref().filter(|b| !b.is_empty())
                } else {
                    None
                },
            };
            let props = item.props.clone().unwrap_or_default();
            let (at, unread, warnings) = match kind {
                Kind::Word => word::edit::add(pkg, &parent, &kind_name, &place, &props, images),
                Kind::Slides => slides::edit::add(pkg, &parent, &kind_name, &place, &props, images),
            }
            .map_err(fail)?;
            notes.extend(warnings);
            let at = at.split('\n').next().unwrap_or_default().to_string();
            let mut message = format!("Added {kind_name} at {at}");
            if !unread.is_empty() {
                message.push_str(&match kind {
                    Kind::Word => format!(
                        "\nWARNING: UNSUPPORTED props on {at}: {}",
                        unread
                            .iter()
                            .map(|k| format!("{k} (not supported)"))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                    Kind::Slides => format!(
                        "\nWARNING: UNSUPPORTED props: {}. Run 'office help <format> <element>' to see valid props, or raw-set for raw XML.",
                        unread.join(", ")
                    ),
                });
            }
            Ok(Output::Text(message))
        }
        "move" => {
            let path = item.path.clone().unwrap_or_else(|| "/".to_string());
            let (after, before) = (item.field("after"), item.field("before"));
            let index = item.index();
            let place = Place {
                index,
                after: if index.is_none() {
                    after.as_deref().filter(|a| !a.is_empty())
                } else {
                    None
                },
                before: if index.is_none() && after.as_deref().is_none_or(str::is_empty) {
                    before.as_deref().filter(|b| !b.is_empty())
                } else {
                    None
                },
            };
            let to = item.field("to");
            match kind {
                Kind::Word => word::edit::move_to(pkg, &path, to.as_deref(), &place),
                Kind::Slides => slides::edit::move_to(pkg, &path, to.as_deref(), &place),
            }
            .map(Output::Text)
            .map_err(fail)
        }
        "swap" => {
            let second = item
                .field("path2")
                .filter(|p| !p.is_empty())
                .or_else(|| item.field("to"));
            let (Some(first), Some(second)) = (
                item.path.clone().filter(|p| !p.is_empty()),
                second.filter(|p| !p.is_empty()),
            ) else {
                return Err(("'swap' command requires 'path' and 'path2' (or 'to') fields. Example: {\"command\": \"swap\", \"path\": \"/slide[1]\", \"path2\": \"/slide[2]\"}".to_string(), None));
            };
            match kind {
                Kind::Word => word::edit::swap(pkg, &first, &second),
                Kind::Slides => slides::edit::swap(pkg, &first, &second),
            }
            .map(Output::Text)
            .map_err(fail)
        }
        v if VERBS.contains(&v) => Err((
            format!(
                "Command '{}' is not supported here. Supported commands: meta, get, query, set, add, remove, move, swap.",
                item.command
            ),
            None,
        )),
        _ => Err((
            format!(
                "Unknown command: '{}'. Valid commands: {}",
                item.command,
                VERBS.join(", ")
            ),
            None,
        )),
    }
}

async fn run_batch(out: &Out<'_>, config: &Config, kind: Kind) -> i32 {
    let host = out.host;
    let source = match batch_source(host, config).await {
        Ok(s) => s,
        Err(f) => return out.fail(&f),
    };
    let items: Vec<Item> = match batch::items(&source) {
        Ok(items) => items
            .into_iter()
            .filter(|i| !i.command.eq_ignore_ascii_case("meta"))
            .collect(),
        Err(message) => return out.fail(&Fail::of(message)),
    };
    if items.is_empty() {
        if host.stat(&config.absolute).await.is_none() {
            return out.fail(&Fail::missing(&config.absolute));
        }
        print_batch(out, &items, &[], false, &[]);
        return 0;
    }
    let mut pkg = match Pkg::open(host, config).await {
        Ok(p) => p,
        Err(f) => return out.fail(&f),
    };
    let atomic = !config.best_effort
        && items.iter().any(|i| {
            !matches!(
                i.command.to_ascii_lowercase().as_str(),
                "get" | "query" | "view" | "validate" | "meta"
            )
        });
    let mut outcomes = Vec::new();
    let mut stderr = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let warnings = item_warnings(item);
        let snap = pkg.snapshot();
        let mut notes = Vec::new();
        let images = if item.command.eq_ignore_ascii_case("add") {
            let kind_name = item.field("type").unwrap_or_default();
            let props = item.props.clone().unwrap_or_default();
            media::gather(host, media::sources(&kind_name, &props)).await
        } else {
            Media::new()
        };
        let result = run_item(&mut pkg, kind, item, config.json, &mut notes, &images);
        if result.is_err() {
            pkg.restore(snap);
        }
        if config.json {
            stderr.extend(notes);
        } else {
            for n in &notes {
                host.warn(format!("{n}\n").as_bytes());
            }
        }
        let stop = result.is_err() && config.stop_on_error;
        outcomes.push(Outcome {
            index,
            result,
            warnings,
        });
        if stop {
            break;
        }
    }
    let any_failed = outcomes.iter().any(|o| o.result.is_err());
    let rolled_back = atomic && any_failed;
    if !rolled_back && pkg.dirty() {
        if let Some(reply) = pkg.save(host, &config.absolute).await {
            return out.fail(&Fail::of(text(&failure_text(&reply))));
        }
    }
    print_batch(out, &items, &outcomes, rolled_back, &stderr);
    i32::from(any_failed)
}

/// The properties `get` shows on the node at `path`, as text, or none
/// when it does not resolve.
fn snapshot(kind: Kind, pkg: &Pkg<'_>, path: &str) -> Option<Vec<(String, String)>> {
    if !path.starts_with('/') {
        return None;
    }
    let node = kind.get(pkg, path, 1).ok()?;
    Some(
        node.format
            .iter()
            .map(|(k, v)| (k.clone(), v.text()))
            .collect(),
    )
}
