use crate::glob::CompiledGlob;

use super::{Mode, PathScope, Text, VarScope, Visibility};

const SLASH: u32 = 47;

pub fn is_glob(entry: &[u32]) -> bool {
    entry.iter().any(|unit| matches!(unit, 42 | 63 | 91))
}

pub fn anchor_depth(entry: &[u32]) -> usize {
    trimmed(entry)
        .split(|unit| *unit == SLASH)
        .take_while(|part| !part.is_empty() && !is_glob(part))
        .count()
}

pub fn classify_paths(entries: &[Text]) -> PathScope {
    let (patterns, paths) = entries.iter().cloned().partition(|entry| is_glob(entry));
    PathScope { paths, patterns }
}

pub fn classify_vars(entries: &[Text]) -> VarScope {
    let (patterns, names) = entries.iter().cloned().partition(|entry| is_glob(entry));
    VarScope { names, patterns }
}

fn trimmed(path: &[u32]) -> &[u32] {
    let start = path
        .iter()
        .position(|unit| *unit != SLASH)
        .unwrap_or(path.len());
    let end = path
        .iter()
        .rposition(|unit| *unit != SLASH)
        .map_or(start, |i| i + 1);
    &path[start..end]
}

pub(crate) fn norm_abs(path: &[u32]) -> Text {
    let mut normalized = vec![SLASH];
    normalized.extend_from_slice(trimmed(path));
    normalized
}

pub(crate) fn under(path: &[u32], root: &[u32]) -> bool {
    root == [SLASH]
        || path == root
        || (path.starts_with(root) && path.get(root.len()) == Some(&SLASH))
}

fn strict_under(path: &[u32], root: &[u32]) -> bool {
    path != root && under(path, root)
}

fn pattern_head(pattern: &[u32]) -> Text {
    let norm = norm_abs(pattern);
    let fixed: Vec<&[u32]> = norm
        .split(|unit| *unit == SLASH)
        .take_while(|part| !is_glob(part))
        .collect();
    norm_abs(&fixed.join(&SLASH))
}

pub fn show_head(entry: &[u32]) -> Text {
    if is_glob(entry) {
        pattern_head(entry)
    } else {
        norm_abs(entry)
    }
}

struct Exact {
    path: Text,
    depth: usize,
}

struct Pattern {
    head: Option<Text>,
    depth: usize,
    matcher: CompiledGlob,
}

impl Pattern {
    fn new(pattern: &[u32]) -> Self {
        let anchored = pattern.contains(&SLASH);
        Self {
            head: anchored.then(|| pattern_head(pattern)),
            depth: if anchored { anchor_depth(pattern) } else { 0 },
            matcher: CompiledGlob::new(if anchored {
                norm_abs(pattern)
            } else {
                pattern.to_vec()
            }),
        }
    }

    fn matches(&self, parts: &[&[u32]]) -> bool {
        if self.head.is_none() {
            return parts.iter().any(|part| self.matcher.matches(part));
        }
        let mut prefix = Vec::new();
        parts.iter().any(|part| {
            prefix.push(SLASH);
            prefix.extend_from_slice(part);
            self.matcher.matches(&prefix)
        })
    }
}

struct Shown {
    path: Text,
    head: Text,
    depth: usize,
    mode: Option<Mode>,
    pattern: Option<Pattern>,
}

impl Shown {
    fn matches(&self, norm: &[u32], parts: &[&[u32]]) -> bool {
        match &self.pattern {
            Some(pattern) => pattern.head.is_some() && pattern.matches(parts),
            None => under(norm, &self.head),
        }
    }
}

pub struct VisibilityMatcher {
    exact: Vec<Exact>,
    patterns: Vec<Pattern>,
    shown: Vec<Shown>,
    names: Vec<Text>,
    vars: Vec<CompiledGlob>,
}

impl VisibilityMatcher {
    pub fn new(spec: Visibility) -> Self {
        Self {
            exact: spec
                .hidden
                .paths
                .iter()
                .map(|path| Exact {
                    path: norm_abs(path),
                    depth: anchor_depth(path),
                })
                .collect(),
            patterns: spec
                .hidden
                .patterns
                .iter()
                .map(|path| Pattern::new(path))
                .collect(),
            shown: spec
                .shown
                .into_iter()
                .map(|entry| Shown {
                    head: show_head(&entry.path),
                    depth: anchor_depth(&entry.path),
                    mode: entry.mode,
                    pattern: is_glob(&entry.path).then(|| Pattern::new(&entry.path)),
                    path: entry.path,
                })
                .collect(),
            names: spec.vars.names,
            vars: spec
                .vars
                .patterns
                .into_iter()
                .map(CompiledGlob::new)
                .collect(),
        }
    }

    pub fn hide_depth(&self, path: &[u32]) -> Option<usize> {
        let norm = norm_abs(path);
        let parts: Vec<_> = norm
            .split(|unit| *unit == SLASH)
            .filter(|part| !part.is_empty())
            .collect();
        self.exact
            .iter()
            .filter(|entry| under(&norm, &entry.path))
            .map(|entry| entry.depth)
            .chain(
                self.patterns
                    .iter()
                    .filter(|pattern| pattern.matches(&parts))
                    .map(|pattern| pattern.depth),
            )
            .max()
    }

    pub fn show_depth(&self, path: &[u32]) -> Option<usize> {
        let norm = norm_abs(path);
        let parts: Vec<_> = norm
            .split(|unit| *unit == SLASH)
            .filter(|part| !part.is_empty())
            .collect();
        self.shown
            .iter()
            .filter(|entry| entry.matches(&norm, &parts))
            .map(|entry| entry.depth)
            .max()
    }

    pub fn path_visible(&self, path: &[u32]) -> bool {
        let Some(hidden) = self.hide_depth(path) else {
            return true;
        };
        if self.show_depth(path).is_some_and(|depth| depth > hidden) {
            return true;
        }
        let norm = norm_abs(path);
        for entry in &self.shown {
            if entry.head == norm {
                if entry.head != entry.path && entry.depth > hidden {
                    return true;
                }
            } else if strict_under(&entry.head, &norm) && self.path_visible(&entry.head) {
                return true;
            }
        }
        false
    }

    pub fn shown_mode(&self, path: &[u32]) -> Option<(usize, Mode)> {
        let norm = norm_abs(path);
        let parts: Vec<_> = norm
            .split(|unit| *unit == SLASH)
            .filter(|part| !part.is_empty())
            .collect();
        let mut best: Option<(usize, Mode)> = None;
        for entry in &self.shown {
            let Some(mode) = entry.mode else {
                continue;
            };
            if !entry.matches(&norm, &parts) {
                continue;
            }
            best = match best {
                None => Some((entry.depth, mode)),
                Some((depth, _)) if entry.depth > depth => Some((entry.depth, mode)),
                Some((depth, old)) if entry.depth == depth => Some((depth, old.min(mode))),
                found => found,
            };
        }
        best
    }

    pub fn path_covers(&self, path: &[u32], ancestors: bool) -> bool {
        let norm = norm_abs(path);
        self.exact
            .iter()
            .map(|entry| &entry.path)
            .chain(self.patterns.iter().filter_map(|entry| entry.head.as_ref()))
            .any(|head| head == &norm || (ancestors && under(head, &norm)))
    }

    pub fn hides_intersect(&self, path: &[u32]) -> bool {
        if self.patterns.iter().any(|entry| entry.head.is_none()) {
            return true;
        }
        if self.hide_depth(path).is_some() || self.path_covers(path, true) {
            return true;
        }
        let norm = norm_abs(path);
        self.patterns
            .iter()
            .filter_map(|entry| entry.head.as_ref())
            .any(|head| head == &[SLASH] || strict_under(&norm, head))
    }

    pub fn move_reveals(&self, src: &[u32], dst: &[u32]) -> bool {
        if self.exact.is_empty() && self.patterns.is_empty() {
            return false;
        }
        let source = norm_abs(src);
        let destination = norm_abs(dst);
        if source == [SLASH] {
            return true;
        }
        if let Some(hidden) = self.hide_depth(&source) {
            if self.path_visible(&source)
                && self.show_depth(&source).unwrap_or(0) <= hidden
                && self.path_visible(&destination)
            {
                return true;
            }
        }
        for entry in &self.exact {
            if !strict_under(&entry.path, &source) {
                continue;
            }
            let mut mapped = if destination == [SLASH] {
                Vec::new()
            } else {
                destination.clone()
            };
            mapped.extend_from_slice(&entry.path[source.len()..]);
            if self.path_visible(&mapped) {
                return true;
            }
        }
        self.patterns
            .iter()
            .filter_map(|entry| entry.head.as_ref())
            .any(|head| under(head, &source) || under(&source, head))
    }

    pub fn leads_hidden(&self, path: &[u32], links: &[(Text, Text)], max_hops: usize) -> bool {
        if links.is_empty() {
            return false;
        }
        let mut pending: Vec<Text> = path
            .split(|unit| *unit == SLASH)
            .rev()
            .filter(|part| !part.is_empty() && *part != [46])
            .map(<[u32]>::to_vec)
            .collect();
        let mut walked: Vec<Text> = Vec::new();
        let mut hops = 0;
        while let Some(part) = pending.pop() {
            if part == [46, 46] {
                walked.pop();
                continue;
            }
            let mut name = vec![SLASH];
            if !walked.is_empty() {
                name.extend(walked.join(&SLASH));
                name.push(SLASH);
            }
            name.extend_from_slice(&part);
            let Some((_, target)) = links.iter().find(|(link, _)| link == &name) else {
                if hops > 0
                    && pending.last().is_some_and(|next| next == &[46, 46])
                    && !self.path_visible(&name)
                {
                    return true;
                }
                walked.push(part);
                continue;
            };
            if !self.path_visible(&name) {
                return true;
            }
            hops += 1;
            if hops > max_hops {
                return false;
            }
            if target.first() == Some(&SLASH) {
                walked.clear();
            }
            pending.extend(
                target
                    .split(|unit| *unit == SLASH)
                    .rev()
                    .filter(|part| !part.is_empty() && *part != [46])
                    .map(<[u32]>::to_vec),
            );
        }
        let mut landing = vec![SLASH];
        landing.extend(walked.join(&SLASH));
        hops > 0 && !self.path_visible(&landing)
    }

    pub fn var_hidden(&self, name: &[u32]) -> bool {
        self.names.iter().any(|exact| exact == name)
            || self.vars.iter().any(|pattern| pattern.matches(name))
    }

    pub fn effective_mode(
        &self,
        path: &[u32],
        prefix: &[u32],
        configured: Mode,
        cap: Option<Mode>,
    ) -> Mode {
        let mut best = cap.map(|mode| (anchor_depth(&norm_abs(prefix)), mode));
        if let Some((depth, mode)) = self.shown_mode(path) {
            best = match best {
                None => Some((depth, mode)),
                Some((old, _)) if depth > old => Some((depth, mode)),
                Some((old, prior)) if depth == old => Some((old, prior.min(mode))),
                found => found,
            };
        }
        configured.min(best.map_or(configured, |(_, mode)| mode))
    }

    pub fn strongest_mode(&self, prefix: &[u32], configured: Mode, cap: Option<Mode>) -> Mode {
        let norm = norm_abs(prefix);
        self.shown
            .iter()
            .filter_map(|entry| {
                entry
                    .mode
                    .filter(|_| under(&entry.head, &norm) || under(&norm, &entry.head))
            })
            .map(|mode| configured.min(mode))
            .fold(configured.min(cap.unwrap_or(Mode::Exec)), Mode::max)
    }

    pub fn readonly_below(
        &self,
        path: &[u32],
        prefix: &[u32],
        configured: Mode,
        cap: Option<Mode>,
    ) -> Option<Text> {
        let norm = norm_abs(path);
        for entry in &self.shown {
            let Some(mode) = entry.mode else {
                continue;
            };
            if entry.pattern.is_some() {
                if mode == Mode::Read && (under(&entry.head, &norm) || under(&norm, &entry.head)) {
                    return Some(path.to_vec());
                }
            } else {
                let anchor = norm_abs(&entry.path);
                if strict_under(&anchor, &norm)
                    && self.effective_mode(&anchor, prefix, configured, cap) == Mode::Read
                {
                    return Some(anchor);
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::Show;
    use serde_json::Value;

    fn text(value: &str) -> Text {
        value.chars().map(u32::from).collect()
    }
    fn strings(value: &Value) -> Vec<Text> {
        value
            .as_array()
            .unwrap()
            .iter()
            .map(|value| text(value.as_str().unwrap()))
            .collect()
    }
    fn mode(value: &Value) -> Option<Mode> {
        match value.as_str() {
            Some("read") => Some(Mode::Read),
            Some("write") => Some(Mode::Write),
            Some("exec") => Some(Mode::Exec),
            None => None,
            Some(other) => panic!("unknown mode {other}"),
        }
    }
    fn matcher(hide: &[&str], show: &[(&str, Option<Mode>)]) -> VisibilityMatcher {
        VisibilityMatcher::new(Visibility {
            hidden: classify_paths(&hide.iter().map(|value| text(value)).collect::<Vec<_>>()),
            shown: show
                .iter()
                .map(|(path, mode)| Show {
                    path: text(path),
                    mode: *mode,
                })
                .collect(),
            ..Visibility::default()
        })
    }

    #[test]
    fn hydrated_component_patterns_keep_zero_anchor_depth() {
        let matcher = VisibilityMatcher::new(Visibility {
            hidden: PathScope {
                paths: Vec::new(),
                patterns: vec![text("secret")],
            },
            shown: vec![Show {
                path: text("/secret"),
                mode: None,
            }],
            ..Visibility::default()
        });
        assert_eq!(matcher.hide_depth(&text("/secret/x")), Some(0));
        assert!(matcher.path_visible(&text("/secret/x")));
    }

    #[test]
    fn pre_migration_shared_visibility_cases() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../../../integ/policy/matching.json")).unwrap();
        for case in corpus["visibility"].as_array().unwrap() {
            let matcher = VisibilityMatcher::new(Visibility {
                hidden: classify_paths(&strings(&case["hide"])),
                shown: case["show"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|entry| Show {
                        path: text(entry["path"].as_str().unwrap()),
                        mode: mode(&entry["mode"]),
                    })
                    .collect(),
                vars: classify_vars(&strings(&case["vars"])),
            });
            for query in case["queries"].as_array().unwrap() {
                let path = text(query["path"].as_str().unwrap());
                assert_eq!(
                    matcher.path_visible(&path),
                    query["visible"].as_bool().unwrap(),
                    "{query}"
                );
                assert_eq!(
                    matcher.hide_depth(&path),
                    query["hide_depth"].as_u64().map(|depth| depth as usize),
                    "{query}"
                );
                assert_eq!(
                    matcher.show_depth(&path),
                    query["show_depth"].as_u64().map(|depth| depth as usize),
                    "{query}"
                );
                assert_eq!(
                    matcher.shown_mode(&path),
                    query["mode"]
                        .as_array()
                        .map(|pair| (pair[0].as_u64().unwrap() as usize, mode(&pair[1]).unwrap())),
                    "{query}"
                );
                assert_eq!(
                    matcher.hides_intersect(&path),
                    query["hidden_under"].as_bool().unwrap(),
                    "{query}"
                );
            }
            for query in case["moves"].as_array().unwrap() {
                assert_eq!(
                    matcher.move_reveals(
                        &text(query["src"].as_str().unwrap()),
                        &text(query["dst"].as_str().unwrap())
                    ),
                    query["reveals"].as_bool().unwrap()
                );
            }
            for query in case["variables"].as_array().unwrap() {
                assert_eq!(
                    matcher.var_hidden(&text(query["name"].as_str().unwrap())),
                    query["hidden"].as_bool().unwrap()
                );
            }
        }
    }

    #[test]
    fn depth_ties_nested_hides_and_glob_show_anchors() {
        let vis = matcher(
            &["/repo", "/repo/public/private"],
            &[("/repo", None), ("/repo/public/*", None)],
        );
        assert!(vis.path_visible(&text("/repo")));
        assert!(vis.path_visible(&text("/repo/public")));
        assert!(vis.path_visible(&text("/repo/public/a")));
        assert!(!vis.path_visible(&text("/repo/public/private/a")));
        assert!(!vis.path_visible(&text("/repo/secret")));
        let tied = matcher(&["/repo/public"], &[("/repo/public/*", None)]);
        assert!(!tied.path_visible(&text("/repo/public")));
    }

    #[test]
    fn scopes_distinguish_containment_and_possible_intersection() {
        let vis = matcher(&["/repo/*/secret"], &[]);
        assert!(!vis.path_covers(&text("/repo/public"), true));
        assert!(vis.hides_intersect(&text("/repo/public")));
        assert!(!vis.hides_intersect(&text("/elsewhere")));
        assert!(vis.path_covers(&text("/repo"), false));
        assert!(!vis.path_covers(&text("/"), false));
        assert!(vis.path_covers(&text("/"), true));
        assert_eq!(anchor_depth(&text("/repo//private")), 1);
        assert_eq!(show_head(&text("/repo/public/*/key")), text("/repo/public"));
    }

    #[test]
    fn supplied_links_preserve_target_names_before_parent_steps() {
        let vis = matcher(&["/data/secret"], &[]);
        let links = vec![
            (text("/link"), text("/data/secret/../public")),
            (text("/relative"), text("data/secret")),
        ];
        assert!(vis.leads_hidden(&text("/link/file"), &links, 40));
        assert!(vis.leads_hidden(&text("/relative"), &links, 40));
        assert!(!vis.leads_hidden(&text("/unlinked"), &links, 40));
        let looped = vec![(text("/a"), text("/b")), (text("/b"), text("/a"))];
        assert!(!vis.leads_hidden(&text("/a"), &looped, 40));
    }

    #[test]
    fn moving_component_hides_keeps_names_hidden_but_anchored_hides_reveal() {
        assert!(!matcher(&["*.key"], &[]).move_reveals(&text("/repo"), &text("/public")));
        assert!(matcher(&["/repo/private"], &[]).move_reveals(&text("/repo"), &text("/public")));
        assert!(
            !matcher(&["/repo/private", "/public/private"], &[])
                .move_reveals(&text("/repo"), &text("/public"))
        );
        assert!(
            matcher(&["/repo/*/secret"], &[]).move_reveals(&text("/repo/sub"), &text("/public"))
        );
    }

    #[test]
    fn effective_modes_retain_depth_ties_caps_and_readonly_descendants() {
        let vis = matcher(
            &[],
            &[
                ("/repo/build", Some(Mode::Write)),
                ("/repo/build", Some(Mode::Exec)),
                ("/repo/build/locked", Some(Mode::Read)),
                ("/repo/bin/*", Some(Mode::Exec)),
            ],
        );
        assert_eq!(
            vis.shown_mode(&text("/repo/build/a")),
            Some((2, Mode::Write))
        );
        assert_eq!(
            vis.effective_mode(
                &text("/repo/build/a"),
                &text("/repo"),
                Mode::Exec,
                Some(Mode::Read)
            ),
            Mode::Write
        );
        assert_eq!(
            vis.effective_mode(
                &text("/repo/build/a"),
                &text("/repo"),
                Mode::Read,
                Some(Mode::Read)
            ),
            Mode::Read
        );
        assert_eq!(
            vis.effective_mode(
                &text("/repo/other"),
                &text("/repo"),
                Mode::Exec,
                Some(Mode::Read)
            ),
            Mode::Read
        );
        assert_eq!(
            vis.strongest_mode(&text("/repo"), Mode::Exec, Some(Mode::Read)),
            Mode::Exec
        );
        assert_eq!(
            vis.readonly_below(
                &text("/repo/build"),
                &text("/repo"),
                Mode::Exec,
                Some(Mode::Read)
            ),
            Some(text("/repo/build/locked"))
        );
        let tied = matcher(&[], &[("/repo/*", Some(Mode::Exec))]);
        assert_eq!(
            tied.effective_mode(
                &text("/repo/a"),
                &text("/repo"),
                Mode::Exec,
                Some(Mode::Read)
            ),
            Mode::Read
        );
        let pattern = matcher(&[], &[("/repo/*/locked", Some(Mode::Read))]);
        assert_eq!(
            pattern.readonly_below(&text("/repo/sub"), &text("/repo"), Mode::Exec, None),
            Some(text("/repo/sub"))
        );
    }

    #[test]
    fn lone_surrogates_and_non_bmp_units_use_existing_shell_glob_semantics() {
        let vis = VisibilityMatcher::new(Visibility {
            hidden: PathScope {
                patterns: vec![vec![47, 42, 0xd800]],
                ..PathScope::default()
            },
            ..Visibility::default()
        });
        assert_eq!(vis.hide_depth(&[47, 0x1f600, 0xd800]), Some(0));
        assert!(vis.path_visible(&[47, 0x1f600]));
        let negated = matcher(&["[^a]*.key"], &[]);
        assert!(!negated.path_visible(&text("/b.key")));
        assert!(negated.path_visible(&text("/a.key")));
    }
}
