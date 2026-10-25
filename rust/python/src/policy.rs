use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use streams::policy::*;

type RuleValue = (Text, Vec<Text>, Vec<Text>, Text);
type RulesValue = (Option<Vec<Text>>, Vec<RuleValue>, Vec<RuleValue>);
type ScopeValue = (Vec<Text>, Vec<Text>);
type ShowValue = (Text, Option<u32>);
type ReasonValue = (Vec<Text>, Text);
type VisibilityValue = (ScopeValue, Vec<ShowValue>, ScopeValue);
type PathsValue = (Vec<Text>, Vec<ShowValue>, Vec<ReasonValue>);
type MountValue = (Text, Option<u32>, Option<RulesValue>, Option<PathsValue>);
type ProfileValue = (
    Option<RulesValue>,
    Option<PathsValue>,
    Option<Vec<Text>>,
    Option<Vec<MountValue>>,
);
type PlanValue = (
    Option<RulesValue>,
    VisibilityValue,
    Vec<(Text, u32)>,
    Vec<ReasonValue>,
);
type PathValue = (Text, Text);
type FactsValue = (
    Text,
    Vec<Text>,
    bool,
    Text,
    Vec<PathValue>,
    Vec<PathValue>,
    bool,
    Option<Text>,
);
type RulingValue = (u32, Option<usize>, Option<Text>, bool, Vec<usize>);
type SubjectValue = (Option<PathValue>, bool, bool);

fn text(value: Text) -> PyResult<Text> {
    if value.iter().any(|&unit| unit > 0x10ffff) {
        return Err(PyValueError::new_err("policy unit is past U+10FFFF"));
    }
    Ok(value)
}

fn texts(value: Vec<Text>) -> PyResult<Vec<Text>> {
    value.into_iter().map(text).collect()
}

fn mode(value: u32) -> PyResult<Mode> {
    match value {
        0 => Ok(Mode::Read),
        1 => Ok(Mode::Write),
        2 => Ok(Mode::Exec),
        _ => Err(PyValueError::new_err("invalid policy mode")),
    }
}

fn rule(value: RuleValue) -> PyResult<Rule> {
    Ok(Rule {
        reason: text(value.0)?,
        commands: texts(value.1)?,
        paths: texts(value.2)?,
        mount: text(value.3)?,
    })
}

fn rules(value: RulesValue) -> PyResult<Rules> {
    Ok(Rules {
        allow: value.0.map(texts).transpose()?,
        deny: value.1.into_iter().map(rule).collect::<PyResult<_>>()?,
        ask: value.2.into_iter().map(rule).collect::<PyResult<_>>()?,
    })
}

fn shows(value: Vec<ShowValue>) -> PyResult<Vec<Show>> {
    value
        .into_iter()
        .map(|(path, cap)| {
            Ok(Show {
                path: text(path)?,
                mode: cap.map(mode).transpose()?,
            })
        })
        .collect()
}

fn reasons(value: Vec<ReasonValue>) -> PyResult<Vec<HideReason>> {
    value
        .into_iter()
        .map(|(patterns, reason)| {
            Ok(HideReason {
                patterns: texts(patterns)?,
                reason: text(reason)?,
            })
        })
        .collect()
}

fn visibility(value: VisibilityValue) -> PyResult<Visibility> {
    Ok(Visibility {
        hidden: PathScope {
            paths: texts(value.0.0)?,
            patterns: texts(value.0.1)?,
        },
        shown: shows(value.1)?,
        vars: VarScope {
            names: texts(value.2.0)?,
            patterns: texts(value.2.1)?,
        },
    })
}

fn paths(value: PathsValue) -> PyResult<Paths> {
    Ok(Paths {
        hide: texts(value.0)?,
        show: shows(value.1)?,
        reasons: reasons(value.2)?,
    })
}

fn profile(value: ProfileValue) -> PyResult<Profile> {
    Ok(Profile {
        commands: value.0.map(rules).transpose()?,
        paths: value.1.map(paths).transpose()?,
        vars: value.2.map(texts).transpose()?,
        mounts: value
            .3
            .map(|mounts| {
                mounts
                    .into_iter()
                    .map(|(prefix, cap, commands, entries)| {
                        Ok(Mount {
                            prefix: text(prefix)?,
                            mode: cap.map(mode).transpose()?,
                            commands: commands.map(rules).transpose()?,
                            paths: entries.map(paths).transpose()?,
                        })
                    })
                    .collect::<PyResult<_>>()
            })
            .transpose()?,
    })
}

fn rule_value(value: Rule) -> RuleValue {
    (value.reason, value.commands, value.paths, value.mount)
}

fn rules_value(value: Rules) -> RulesValue {
    (
        value.allow,
        value.deny.into_iter().map(rule_value).collect(),
        value.ask.into_iter().map(rule_value).collect(),
    )
}

fn show_values(value: Vec<Show>) -> Vec<ShowValue> {
    value
        .into_iter()
        .map(|show| (show.path, show.mode.map(|cap| cap as u32)))
        .collect()
}

fn reason_values(value: Vec<HideReason>) -> Vec<ReasonValue> {
    value
        .into_iter()
        .map(|group| (group.patterns, group.reason))
        .collect()
}

fn paths_value(value: Paths) -> PathsValue {
    (
        value.hide,
        show_values(value.show),
        reason_values(value.reasons),
    )
}

fn visibility_value(value: Visibility) -> VisibilityValue {
    (
        (value.hidden.paths, value.hidden.patterns),
        show_values(value.shown),
        (value.vars.names, value.vars.patterns),
    )
}

fn profile_value(value: Profile) -> ProfileValue {
    (
        value.commands.map(rules_value),
        value.paths.map(paths_value),
        value.vars,
        value.mounts.map(|mounts| {
            mounts
                .into_iter()
                .map(|mount| {
                    (
                        mount.prefix,
                        mount.mode.map(|cap| cap as u32),
                        mount.commands.map(rules_value),
                        mount.paths.map(paths_value),
                    )
                })
                .collect()
        }),
    )
}

fn path(value: PathValue) -> PyResult<PathFact> {
    Ok(PathFact {
        virtual_path: text(value.0)?,
        display_path: text(value.1)?,
    })
}

fn facts(value: FactsValue) -> PyResult<CommandFacts> {
    Ok(CommandFacts {
        command: text(value.0)?,
        tokens: texts(value.1)?,
        tool: value.2,
        cwd: text(value.3)?,
        paths: value.4.into_iter().map(path).collect::<PyResult<_>>()?,
        operands: value.5.into_iter().map(path).collect::<PyResult<_>>()?,
        walks: value.6,
        move_target: value.7.map(text).transpose()?,
    })
}

#[pyclass(module = "mirage._rs")]
struct PolicyAdmission {
    inner: AdmissionMatcher,
    count: usize,
}

impl PolicyAdmission {
    fn id(&self, id: usize) -> PyResult<usize> {
        if id >= self.count {
            return Err(PyValueError::new_err("invalid policy rule index"));
        }
        Ok(id)
    }

    fn granted(&self, ids: Vec<usize>) -> PyResult<Vec<usize>> {
        ids.into_iter().map(|id| self.id(id)).collect()
    }
}

#[pymethods]
impl PolicyAdmission {
    #[new]
    fn new(value: RulesValue, ecma: bool) -> PyResult<Self> {
        let rules = rules(value)?;
        let count = rules.deny.len() + rules.ask.len();
        Ok(Self {
            inner: AdmissionMatcher::new(
                rules,
                if ecma {
                    Whitespace::EcmaScript
                } else {
                    Whitespace::Python
                },
            ),
            count,
        })
    }

    fn head_allowed(&self, name: Text) -> PyResult<bool> {
        Ok(self.inner.head_allowed(&text(name)?))
    }
    fn line_allowed(&self, tokens: Vec<Text>, tool: bool) -> PyResult<bool> {
        Ok(self.inner.line_allowed(&texts(tokens)?, tool))
    }
    fn has_rules(&self) -> bool {
        self.inner.has_rules()
    }
    fn reads_args(&self, name: Text) -> PyResult<bool> {
        Ok(self.inner.reads_args(&text(name)?))
    }
    fn scopes_paths(&self, name: Text) -> PyResult<bool> {
        Ok(self.inner.scopes_paths(&text(name)?))
    }
    fn decide(&self, py: Python<'_>, value: FactsValue) -> PyResult<RulingValue> {
        let facts = facts(value)?;
        let ruling = py.detach(|| self.inner.decide(&facts));
        Ok((
            ruling.outcome as u32,
            ruling.rule,
            ruling.matched_path,
            ruling.allow_list,
            ruling.asks,
        ))
    }
    fn rule_applies(&self, id: usize, value: FactsValue) -> PyResult<bool> {
        Ok(self.inner.rule_applies(self.id(id)?, &facts(value)?))
    }
    fn rule_reach(&self, id: usize, value: SubjectValue) -> PyResult<Option<usize>> {
        Ok(self.inner.rule_reach(
            self.id(id)?,
            &Subject {
                path: value.0.map(path).transpose()?,
                holds: value.1,
                ancestors: value.2,
            },
        ))
    }
    fn hidden_depth(&self, id: usize, value: Text) -> PyResult<usize> {
        Ok(self.inner.hidden_depth(self.id(id)?, &text(value)?))
    }
    fn covers_depth(&self, id: usize, value: Text, ancestors: bool) -> PyResult<usize> {
        Ok(self
            .inner
            .covers_depth(self.id(id)?, &text(value)?, ancestors))
    }
    fn match_io(&self, id: usize, tokens: Vec<Text>, value: Text, subtree: bool) -> PyResult<bool> {
        Ok(self
            .inner
            .match_io(self.id(id)?, &texts(tokens)?, &text(value)?, subtree))
    }
    fn io_reach(&self, tokens: Vec<Text>, value: Text) -> PyResult<bool> {
        Ok(self.inner.io_reach(&texts(tokens)?, &text(value)?))
    }
    fn io_refusal(
        &self,
        tokens: Vec<Text>,
        value: Text,
        granted: Vec<usize>,
    ) -> PyResult<Option<usize>> {
        Ok(self
            .inner
            .io_refusal(&texts(tokens)?, &text(value)?, &self.granted(granted)?))
    }
    fn posix_level(&self, id: usize) -> PyResult<bool> {
        Ok(self.inner.posix_level(self.id(id)?))
    }
    fn op_reach(&self, id: usize, op: Text, value: Text) -> PyResult<Option<usize>> {
        Ok(self.inner.op_reach(self.id(id)?, &text(op)?, &text(value)?))
    }
    fn op_ruling(
        &self,
        op: Text,
        value: Text,
        granted: Vec<usize>,
    ) -> PyResult<Option<(usize, bool)>> {
        Ok(self
            .inner
            .op_ruling(&text(op)?, &text(value)?, &self.granted(granted)?))
    }
}

#[pyclass(module = "mirage._rs")]
struct PolicyVisibility {
    inner: VisibilityMatcher,
}

#[pymethods]
impl PolicyVisibility {
    #[new]
    fn new(value: VisibilityValue) -> PyResult<Self> {
        Ok(Self {
            inner: VisibilityMatcher::new(visibility(value)?),
        })
    }
    fn hide_depth(&self, value: Text) -> PyResult<Option<usize>> {
        Ok(self.inner.hide_depth(&text(value)?))
    }
    fn show_depth(&self, value: Text) -> PyResult<Option<usize>> {
        Ok(self.inner.show_depth(&text(value)?))
    }
    fn path_visible(&self, value: Text) -> PyResult<bool> {
        Ok(self.inner.path_visible(&text(value)?))
    }
    fn shown_mode(&self, value: Text) -> PyResult<Option<(usize, u32)>> {
        Ok(self
            .inner
            .shown_mode(&text(value)?)
            .map(|(depth, mode)| (depth, mode as u32)))
    }
    fn path_covers(&self, value: Text, ancestors: bool) -> PyResult<bool> {
        Ok(self.inner.path_covers(&text(value)?, ancestors))
    }
    fn hides_intersect(&self, value: Text) -> PyResult<bool> {
        Ok(self.inner.hides_intersect(&text(value)?))
    }
    fn move_reveals(&self, src: Text, dst: Text) -> PyResult<bool> {
        Ok(self.inner.move_reveals(&text(src)?, &text(dst)?))
    }
    fn leads_hidden(
        &self,
        value: Text,
        links: Vec<(Text, Text)>,
        max_hops: usize,
    ) -> PyResult<bool> {
        let links = links
            .into_iter()
            .map(|(name, target)| Ok((text(name)?, text(target)?)))
            .collect::<PyResult<Vec<_>>>()?;
        Ok(self.inner.leads_hidden(&text(value)?, &links, max_hops))
    }
    fn var_hidden(&self, value: Text) -> PyResult<bool> {
        Ok(self.inner.var_hidden(&text(value)?))
    }
    fn effective_mode(
        &self,
        value: Text,
        prefix: Text,
        configured: u32,
        cap: Option<u32>,
    ) -> PyResult<u32> {
        Ok(self.inner.effective_mode(
            &text(value)?,
            &text(prefix)?,
            mode(configured)?,
            cap.map(mode).transpose()?,
        ) as u32)
    }
    fn strongest_mode(&self, prefix: Text, configured: u32, cap: Option<u32>) -> PyResult<u32> {
        Ok(self.inner.strongest_mode(
            &text(prefix)?,
            mode(configured)?,
            cap.map(mode).transpose()?,
        ) as u32)
    }
    fn readonly_below(
        &self,
        value: Text,
        prefix: Text,
        configured: u32,
        cap: Option<u32>,
    ) -> PyResult<Option<Text>> {
        Ok(self.inner.readonly_below(
            &text(value)?,
            &text(prefix)?,
            mode(configured)?,
            cap.map(mode).transpose()?,
        ))
    }
}

#[pyfunction]
fn policy_compile(value: ProfileValue) -> PyResult<PlanValue> {
    let plan = compile_profile(&profile(value)?);
    Ok((
        plan.commands.map(rules_value),
        visibility_value(plan.visibility),
        plan.mount_modes
            .into_iter()
            .map(|(prefix, mode)| (prefix, mode as u32))
            .collect(),
        reason_values(plan.hide_reasons),
    ))
}

#[pyfunction]
fn policy_restrict(
    base: Option<ProfileValue>,
    inline: Option<ProfileValue>,
) -> PyResult<Option<ProfileValue>> {
    let base = base.map(profile).transpose()?;
    let inline = inline.map(profile).transpose()?;
    restrict_profile(base.as_ref(), inline.as_ref())
        .map(|value| value.map(profile_value))
        .map_err(PyValueError::new_err)
}

#[pyfunction]
fn policy_pattern(value: Text, tokens: Vec<Text>, ecma: bool) -> PyResult<(Vec<Text>, bool, bool)> {
    let value = text(value)?;
    let tokens = texts(tokens)?;
    let dialect = if ecma {
        Whitespace::EcmaScript
    } else {
        Whitespace::Python
    };
    Ok((
        split_pattern(&value, dialect),
        pattern_matches(&value, &tokens, dialect),
        pattern_reaches(&value, &tokens, dialect),
    ))
}

#[pyfunction]
fn policy_paths(value: Vec<Text>) -> PyResult<ScopeValue> {
    let scope = classify_paths(&texts(value)?);
    Ok((scope.paths, scope.patterns))
}

#[pyfunction]
fn policy_vars(value: Vec<Text>) -> PyResult<ScopeValue> {
    let scope = classify_vars(&texts(value)?);
    Ok((scope.names, scope.patterns))
}

#[pyfunction]
fn policy_is_glob(value: Text) -> PyResult<bool> {
    Ok(is_glob(&text(value)?))
}

#[pyfunction]
fn policy_anchor_depth(value: Text) -> PyResult<usize> {
    Ok(anchor_depth(&text(value)?))
}

#[pyfunction]
fn policy_show_head(value: Text) -> PyResult<Text> {
    Ok(show_head(&text(value)?))
}

#[pyfunction]
fn policy_subjects(value: FactsValue) -> PyResult<Vec<SubjectValue>> {
    Ok(subjects(&facts(value)?)
        .into_iter()
        .map(|subject| {
            (
                subject
                    .path
                    .map(|path| (path.virtual_path, path.display_path)),
                subject.holds,
                subject.ancestors,
            )
        })
        .collect())
}

pub(crate) fn register(module: &Bound<'_, PyModule>) -> PyResult<()> {
    module.add_class::<PolicyAdmission>()?;
    module.add_class::<PolicyVisibility>()?;
    module.add_function(wrap_pyfunction!(policy_compile, module)?)?;
    module.add_function(wrap_pyfunction!(policy_restrict, module)?)?;
    module.add_function(wrap_pyfunction!(policy_pattern, module)?)?;
    module.add_function(wrap_pyfunction!(policy_paths, module)?)?;
    module.add_function(wrap_pyfunction!(policy_vars, module)?)?;
    module.add_function(wrap_pyfunction!(policy_is_glob, module)?)?;
    module.add_function(wrap_pyfunction!(policy_anchor_depth, module)?)?;
    module.add_function(wrap_pyfunction!(policy_show_head, module)?)?;
    module.add_function(wrap_pyfunction!(policy_subjects, module)?)?;
    Ok(())
}
