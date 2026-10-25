use super::visibility::norm_abs;
use super::{
    HideReason, Mount, Paths, Profile, RestrictionPlan, Rule, Rules, Text, Visibility,
    classify_paths, classify_vars,
};

fn anchored(entries: &[Text], root: &[u32]) -> Vec<Text> {
    entries
        .iter()
        .map(|entry| {
            if entry.first() == Some(&47) {
                return entry.clone();
            }
            let mut out = root.to_vec();
            while out.last() == Some(&47) {
                out.pop();
            }
            out.push(47);
            out.extend_from_slice(entry);
            out
        })
        .collect()
}

fn scoped(rules: &[Rule], root: &[u32]) -> Vec<Rule> {
    rules
        .iter()
        .map(|rule| Rule {
            reason: rule.reason.clone(),
            commands: rule.commands.clone(),
            paths: anchored(&rule.paths, root),
            mount: Some(root.to_vec()),
        })
        .collect()
}

pub fn compile_profile(profile: &Profile) -> RestrictionPlan {
    let mut rules = Rules {
        allow: profile
            .commands
            .as_ref()
            .and_then(|commands| commands.allow.clone()),
        ..Rules::default()
    };
    let mut hidden = Vec::new();
    let mut shown = Vec::new();
    let mut reasons = Vec::new();
    let mut modes = Vec::new();
    if let Some(paths) = &profile.paths {
        hidden.extend_from_slice(&paths.hide);
        shown.extend_from_slice(&paths.show);
        reasons.extend_from_slice(&paths.reasons);
    }
    for entry in profile.mounts.as_deref().unwrap_or_default() {
        let root = norm_abs(&entry.prefix);
        if let Some(commands) = &entry.commands {
            rules.ask.extend(scoped(&commands.ask, &root));
            rules.deny.extend(scoped(&commands.deny, &root));
        }
        if let Some(paths) = &entry.paths {
            hidden.extend(anchored(&paths.hide, &root));
            shown.extend_from_slice(&paths.show);
            reasons.extend(paths.reasons.iter().map(|group| HideReason {
                patterns: anchored(&group.patterns, &root),
                reason: group.reason.clone(),
            }));
        }
        if let Some(mode) = entry.mode {
            modes.push((entry.prefix.clone(), mode));
        }
    }
    if let Some(commands) = &profile.commands {
        rules.ask.extend_from_slice(&commands.ask);
        rules.deny.extend_from_slice(&commands.deny);
    }
    RestrictionPlan {
        commands: if rules.allow.is_none() && rules.ask.is_empty() && rules.deny.is_empty() {
            None
        } else {
            Some(rules)
        },
        visibility: Visibility {
            hidden: classify_paths(&hidden),
            shown,
            vars: classify_vars(profile.vars.as_deref().unwrap_or_default()),
        },
        mount_modes: modes,
        hide_reasons: reasons,
    }
}

fn union(left: &[Text], right: &[Text]) -> Vec<Text> {
    let mut out = Vec::new();
    for entry in left.iter().chain(right) {
        if !out.contains(entry) {
            out.push(entry.clone());
        }
    }
    out
}

fn add_commands(base: Option<&Rules>, inline: Option<&Rules>) -> Option<Rules> {
    let Some(inline) = inline else {
        return base.cloned();
    };
    let Some(base) = base else {
        return Some(inline.clone());
    };
    Some(Rules {
        allow: base.allow.clone(),
        ask: base.ask.iter().chain(&inline.ask).cloned().collect(),
        deny: base.deny.iter().chain(&inline.deny).cloned().collect(),
    })
}

fn add_paths(base: Option<&Paths>, inline: Option<&Paths>) -> Option<Paths> {
    if base.is_none() && inline.is_none() {
        return None;
    }
    Some(Paths {
        hide: union(
            base.map_or(&[], |paths| paths.hide.as_slice()),
            inline.map_or(&[], |paths| paths.hide.as_slice()),
        ),
        show: base.map_or_else(Vec::new, |paths| paths.show.clone()),
        reasons: base
            .into_iter()
            .chain(inline)
            .flat_map(|paths| paths.reasons.iter().cloned())
            .collect(),
    })
}

fn add_mount(base: Option<&Mount>, inline: Option<&Mount>) -> Mount {
    let Some(base) = base else {
        return inline.cloned().unwrap_or_default();
    };
    let Some(inline) = inline else {
        return base.clone();
    };
    let mode = match (base.mode, inline.mode) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    };
    let commands = add_commands(base.commands.as_ref(), inline.commands.as_ref())
        .filter(|commands| !commands.ask.is_empty() || !commands.deny.is_empty());
    let paths = add_paths(base.paths.as_ref(), inline.paths.as_ref()).filter(|paths| {
        !paths.hide.is_empty() || !paths.show.is_empty() || !paths.reasons.is_empty()
    });
    Mount {
        prefix: base.prefix.clone(),
        mode,
        commands,
        paths,
    }
}

pub fn restrict_profile(
    base: Option<&Profile>,
    inline: Option<&Profile>,
) -> Result<Option<Profile>, &'static str> {
    let Some(inline) = inline else {
        return Ok(base.cloned());
    };
    if inline
        .commands
        .as_ref()
        .is_some_and(|commands| commands.allow.is_some())
    {
        return Err("inline permissions may add ask and deny rules, not an allow list");
    }
    if inline
        .paths
        .as_ref()
        .is_some_and(|paths| !paths.show.is_empty())
        || inline
            .mounts
            .as_deref()
            .unwrap_or_default()
            .iter()
            .any(|mount| {
                mount
                    .paths
                    .as_ref()
                    .is_some_and(|paths| !paths.show.is_empty())
            })
    {
        return Err("inline permissions may add ask and deny rules and hides, not show entries");
    }
    let Some(base) = base else {
        return Ok(Some(inline.clone()));
    };
    let mounts = if base.mounts.is_some() || inline.mounts.is_some() {
        let mut merged = Vec::new();
        let base_mounts = base.mounts.as_deref().unwrap_or_default();
        let inline_mounts = inline.mounts.as_deref().unwrap_or_default();
        for mount in base_mounts {
            merged.push(add_mount(
                Some(mount),
                inline_mounts
                    .iter()
                    .find(|entry| entry.prefix == mount.prefix),
            ));
        }
        for mount in inline_mounts {
            if !base_mounts.iter().any(|entry| entry.prefix == mount.prefix) {
                merged.push(mount.clone());
            }
        }
        Some(merged)
    } else {
        None
    };
    Ok(Some(Profile {
        commands: add_commands(base.commands.as_ref(), inline.commands.as_ref()),
        paths: add_paths(base.paths.as_ref(), inline.paths.as_ref()),
        vars: if base.vars.is_some() || inline.vars.is_some() {
            Some(union(
                base.vars.as_deref().unwrap_or_default(),
                inline.vars.as_deref().unwrap_or_default(),
            ))
        } else {
            None
        },
        mounts,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::{Mode, PathScope, Show, VarScope};

    fn text(value: &str) -> Text {
        value.chars().map(u32::from).collect()
    }
    fn rule(reason: &str, paths: &[&str]) -> Rule {
        Rule {
            reason: text(reason),
            paths: paths.iter().map(|path| text(path)).collect(),
            ..Rule::default()
        }
    }

    #[test]
    fn compiler_retains_mount_scopes_shows_modes_and_reasons() {
        let profile = Profile {
            commands: Some(Rules {
                allow: Some(vec![]),
                deny: vec![rule("top", &["/top"])],
                ..Rules::default()
            }),
            paths: Some(Paths {
                hide: vec![text("/global")],
                reasons: vec![HideReason {
                    patterns: vec![text("/global")],
                    reason: text("global"),
                }],
                ..Paths::default()
            }),
            vars: Some(vec![text("SECRET"), text("AWS_*")]),
            mounts: Some(vec![Mount {
                prefix: text("/repo/"),
                mode: Some(Mode::Read),
                commands: Some(Rules {
                    ask: vec![rule("ask", &["*.key"])],
                    deny: vec![rule("mount", &["/repo/private"])],
                    ..Rules::default()
                }),
                paths: Some(Paths {
                    hide: vec![text("*.pem")],
                    show: vec![Show {
                        path: text("/repo/public"),
                        mode: Some(Mode::Write),
                    }],
                    reasons: vec![HideReason {
                        patterns: vec![text("*.pem")],
                        reason: text("keys"),
                    }],
                }),
            }]),
        };
        let plan = compile_profile(&profile);
        let rules = plan.commands.unwrap();
        assert_eq!(rules.allow, Some(vec![]));
        assert_eq!(
            rules
                .deny
                .iter()
                .map(|rule| &rule.reason)
                .collect::<Vec<_>>(),
            vec![&text("mount"), &text("top")]
        );
        assert_eq!(rules.ask[0].paths, vec![text("/repo/*.key")]);
        assert_eq!(rules.ask[0].mount, Some(text("/repo")));
        assert_eq!(
            plan.visibility.hidden,
            PathScope {
                paths: vec![text("/global")],
                patterns: vec![text("/repo/*.pem")]
            }
        );
        assert_eq!(
            plan.visibility.shown,
            vec![Show {
                path: text("/repo/public"),
                mode: Some(Mode::Write)
            }]
        );
        assert_eq!(
            plan.visibility.vars,
            VarScope {
                names: vec![text("SECRET")],
                patterns: vec![text("AWS_*")]
            }
        );
        assert_eq!(plan.mount_modes, vec![(text("/repo/"), Mode::Read)]);
        assert_eq!(plan.hide_reasons[1].patterns, vec![text("/repo/*.pem")]);
        assert_eq!(plan.hide_reasons[1].reason, text("keys"));
    }

    #[test]
    fn root_mount_anchors_names_and_empty_rules_remain_unrestricted() {
        let profile = Profile {
            mounts: Some(vec![Mount {
                prefix: text("/"),
                paths: Some(Paths {
                    hide: vec![text("*.pem")],
                    ..Paths::default()
                }),
                ..Mount::default()
            }]),
            ..Profile::default()
        };
        assert_eq!(
            compile_profile(&profile).visibility.hidden.patterns,
            vec![text("/*.pem")]
        );
        assert_eq!(
            compile_profile(&Profile {
                commands: Some(Rules::default()),
                ..Profile::default()
            })
            .commands,
            None
        );
        assert_eq!(
            compile_profile(&Profile {
                commands: Some(Rules {
                    allow: Some(vec![]),
                    ..Rules::default()
                }),
                ..Profile::default()
            })
            .commands
            .unwrap()
            .allow,
            Some(vec![])
        );
    }

    #[test]
    fn restriction_merge_keeps_order_and_weakens_mount_caps() {
        let base = Profile {
            commands: Some(Rules {
                allow: Some(vec![text("ls")]),
                ask: vec![rule("base", &[])],
                ..Rules::default()
            }),
            paths: Some(Paths {
                hide: vec![text("/a"), text("/b")],
                show: vec![Show {
                    path: text("/a/public"),
                    mode: None,
                }],
                reasons: vec![HideReason {
                    patterns: vec![text("/a")],
                    reason: text("base"),
                }],
            }),
            vars: Some(vec![text("A")]),
            mounts: Some(vec![Mount {
                prefix: text("/repo"),
                mode: Some(Mode::Exec),
                commands: Some(Rules {
                    deny: vec![rule("base", &["*.key"])],
                    ..Rules::default()
                }),
                ..Mount::default()
            }]),
        };
        let inline = Profile {
            commands: Some(Rules {
                ask: vec![rule("inline", &[])],
                ..Rules::default()
            }),
            paths: Some(Paths {
                hide: vec![text("/b"), text("/c")],
                reasons: vec![HideReason {
                    patterns: vec![text("/c")],
                    reason: text("inline"),
                }],
                ..Paths::default()
            }),
            vars: Some(vec![text("A"), text("B")]),
            mounts: Some(vec![
                Mount {
                    prefix: text("/repo"),
                    mode: Some(Mode::Read),
                    commands: Some(Rules {
                        deny: vec![rule("inline", &["*.pem"])],
                        ..Rules::default()
                    }),
                    ..Mount::default()
                },
                Mount {
                    prefix: text("/other"),
                    ..Mount::default()
                },
            ]),
        };
        let merged = restrict_profile(Some(&base), Some(&inline))
            .unwrap()
            .unwrap();
        assert_eq!(
            merged.commands.as_ref().unwrap().allow,
            base.commands.as_ref().unwrap().allow
        );
        assert_eq!(
            merged
                .commands
                .as_ref()
                .unwrap()
                .ask
                .iter()
                .map(|rule| &rule.reason)
                .collect::<Vec<_>>(),
            vec![&text("base"), &text("inline")]
        );
        assert_eq!(
            merged.paths.as_ref().unwrap().hide,
            vec![text("/a"), text("/b"), text("/c")]
        );
        assert_eq!(
            merged.paths.as_ref().unwrap().show,
            base.paths.as_ref().unwrap().show
        );
        assert_eq!(merged.paths.as_ref().unwrap().reasons.len(), 2);
        assert_eq!(merged.vars, Some(vec![text("A"), text("B")]));
        let mounts = merged.mounts.unwrap();
        assert_eq!(
            mounts.iter().map(|mount| &mount.prefix).collect::<Vec<_>>(),
            vec![&text("/repo"), &text("/other")]
        );
        assert_eq!(mounts[0].mode, Some(Mode::Read));
        assert_eq!(mounts[0].commands.as_ref().unwrap().deny.len(), 2);
        assert_eq!(base.mounts.as_ref().unwrap()[0].mode, Some(Mode::Exec));
    }

    #[test]
    fn restrictions_preserve_omission_and_normalize_only_merged_mounts() {
        assert_eq!(restrict_profile(None, None).unwrap(), None);
        let stated = Profile {
            commands: Some(Rules::default()),
            paths: Some(Paths::default()),
            vars: Some(vec![]),
            mounts: Some(vec![Mount {
                prefix: text("/repo"),
                commands: Some(Rules::default()),
                paths: Some(Paths::default()),
                ..Mount::default()
            }]),
        };
        assert_eq!(
            restrict_profile(None, Some(&stated)).unwrap(),
            Some(stated.clone())
        );
        let merged = restrict_profile(Some(&stated), Some(&stated))
            .unwrap()
            .unwrap();
        assert!(merged.commands.is_some());
        assert!(merged.paths.is_some());
        assert_eq!(merged.vars, Some(vec![]));
        let mount = &merged.mounts.unwrap()[0];
        assert_eq!(mount.commands, None);
        assert_eq!(mount.paths, None);
    }

    #[test]
    fn inline_allow_and_show_fail_even_without_a_base() {
        let inline = Profile {
            commands: Some(Rules {
                allow: Some(vec![]),
                ..Rules::default()
            }),
            ..Profile::default()
        };
        assert_eq!(
            restrict_profile(None, Some(&inline)),
            Err("inline permissions may add ask and deny rules, not an allow list")
        );
        let inline = Profile {
            mounts: Some(vec![Mount {
                paths: Some(Paths {
                    show: vec![Show {
                        path: text("/x"),
                        mode: Some(Mode::Read),
                    }],
                    ..Paths::default()
                }),
                ..Mount::default()
            }]),
            ..Profile::default()
        };
        assert_eq!(
            restrict_profile(None, Some(&inline)),
            Err("inline permissions may add ask and deny rules and hides, not show entries")
        );
    }
}
