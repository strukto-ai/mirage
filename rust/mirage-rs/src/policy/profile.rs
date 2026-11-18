use super::visibility::norm_abs;
use super::{
    HideReason, Mount, Paths, Profile, RestrictionPlan, Text, Visibility, classify_paths,
    classify_vars,
};

pub(crate) fn anchored(entries: &[Text], root: &[u32]) -> Vec<Text> {
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

pub fn compile_profile(profile: &Profile) -> RestrictionPlan {
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
    RestrictionPlan {
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
    let paths = add_paths(base.paths.as_ref(), inline.paths.as_ref()).filter(|paths| {
        !paths.hide.is_empty() || !paths.show.is_empty() || !paths.reasons.is_empty()
    });
    Mount {
        prefix: base.prefix.clone(),
        mode,
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
        return Err("inline permissions may add command rules and hides, not show entries");
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

    #[test]
    fn compiler_retains_mount_scopes_shows_modes_and_reasons() {
        let profile = Profile {
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
    fn root_mount_anchors_names() {
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
    }

    #[test]
    fn restriction_merge_keeps_order_and_weakens_mount_caps() {
        let base = Profile {
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
                ..Mount::default()
            }]),
        };
        let inline = Profile {
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
        assert_eq!(base.mounts.as_ref().unwrap()[0].mode, Some(Mode::Exec));
    }

    #[test]
    fn restrictions_preserve_omission_and_normalize_only_merged_mounts() {
        assert_eq!(restrict_profile(None, None).unwrap(), None);
        let stated = Profile {
            paths: Some(Paths::default()),
            vars: Some(vec![]),
            mounts: Some(vec![Mount {
                prefix: text("/repo"),
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
        assert!(merged.paths.is_some());
        assert_eq!(merged.vars, Some(vec![]));
        let mount = &merged.mounts.unwrap()[0];
        assert_eq!(mount.paths, None);
    }

    #[test]
    fn inline_show_fails_even_without_a_base() {
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
            Err("inline permissions may add command rules and hides, not show entries")
        );
    }
}
