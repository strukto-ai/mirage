use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use streams::policy::*;

type RuleValue = (Text, Vec<Text>, Vec<Text>, Option<Text>);
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
type LinkStepValue = (u32, Text, bool);

fn link_step(value: LinkStepValue) -> PyResult<LinkStep> {
    let path = text(value.1)?;
    match value.0 {
        0 if !value.2 => Ok(LinkStep::Follow(path)),
        1 => Ok(LinkStep::Enter {
            path,
            next_is_parent: value.2,
        }),
        2 if !value.2 => Ok(LinkStep::Landing(path)),
        3 if path.is_empty() && !value.2 => Ok(LinkStep::HopLimit),
        _ => Err(PyValueError::new_err("invalid policy link step")),
    }
}

fn link_trace(value: Vec<LinkStepValue>) -> PyResult<Vec<LinkStep>> {
    value.into_iter().map(link_step).collect()
}

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
        mount: value.3.map(text).transpose()?,
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
    fn new(py: Python<'_>, value: RulesValue, ecma: bool) -> PyResult<Self> {
        let rules = rules(value)?;
        let count = rules.deny.len() + rules.ask.len();
        Ok(Self {
            inner: py.detach(|| {
                AdmissionMatcher::new(
                    rules,
                    if ecma {
                        Whitespace::EcmaScript
                    } else {
                        Whitespace::Python
                    },
                )
            }),
            count,
        })
    }

    fn head_allowed(&self, py: Python<'_>, name: Text) -> PyResult<bool> {
        let name = text(name)?;
        Ok(py.detach(|| self.inner.head_allowed(&name)))
    }
    fn line_allowed(&self, py: Python<'_>, tokens: Vec<Text>, tool: bool) -> PyResult<bool> {
        let tokens = texts(tokens)?;
        Ok(py.detach(|| self.inner.line_allowed(&tokens, tool)))
    }
    fn has_rules(&self) -> bool {
        self.inner.has_rules()
    }
    fn reads_args(&self, py: Python<'_>, name: Text) -> PyResult<bool> {
        let name = text(name)?;
        Ok(py.detach(|| self.inner.reads_args(&name)))
    }
    fn scopes_paths(&self, py: Python<'_>, name: Text) -> PyResult<bool> {
        let name = text(name)?;
        Ok(py.detach(|| self.inner.scopes_paths(&name)))
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
    fn rule_applies(&self, py: Python<'_>, id: usize, value: FactsValue) -> PyResult<bool> {
        let id = self.id(id)?;
        let facts = facts(value)?;
        Ok(py.detach(|| self.inner.rule_applies(id, &facts)))
    }
    fn rule_reach(
        &self,
        py: Python<'_>,
        id: usize,
        value: SubjectValue,
    ) -> PyResult<Option<usize>> {
        let id = self.id(id)?;
        let subject = Subject {
            path: value.0.map(path).transpose()?,
            holds: value.1,
            ancestors: value.2,
        };
        Ok(py.detach(|| self.inner.rule_reach(id, &subject)))
    }
    fn hidden_depth(&self, py: Python<'_>, id: usize, value: Text) -> PyResult<usize> {
        let id = self.id(id)?;
        let value = text(value)?;
        Ok(py.detach(|| self.inner.hidden_depth(id, &value)))
    }
    fn covers_depth(
        &self,
        py: Python<'_>,
        id: usize,
        value: Text,
        ancestors: bool,
    ) -> PyResult<usize> {
        let id = self.id(id)?;
        let value = text(value)?;
        Ok(py.detach(|| self.inner.covers_depth(id, &value, ancestors)))
    }
    fn match_io(
        &self,
        py: Python<'_>,
        id: usize,
        tokens: Vec<Text>,
        value: Text,
        subtree: bool,
    ) -> PyResult<bool> {
        let id = self.id(id)?;
        let tokens = texts(tokens)?;
        let value = text(value)?;
        Ok(py.detach(|| self.inner.match_io(id, &tokens, &value, subtree)))
    }
    fn io_reach(&self, py: Python<'_>, tokens: Vec<Text>, value: Text) -> PyResult<bool> {
        let tokens = texts(tokens)?;
        let value = text(value)?;
        Ok(py.detach(|| self.inner.io_reach(&tokens, &value)))
    }
    fn io_refusal(
        &self,
        py: Python<'_>,
        tokens: Vec<Text>,
        value: Text,
        granted: Vec<usize>,
    ) -> PyResult<Option<usize>> {
        let tokens = texts(tokens)?;
        let value = text(value)?;
        let granted = self.granted(granted)?;
        Ok(py.detach(|| self.inner.io_refusal(&tokens, &value, &granted)))
    }
    fn posix_level(&self, id: usize) -> PyResult<bool> {
        Ok(self.inner.posix_level(self.id(id)?))
    }
    fn op_reach(
        &self,
        py: Python<'_>,
        id: usize,
        op: Text,
        value: Text,
    ) -> PyResult<Option<usize>> {
        let id = self.id(id)?;
        let op = text(op)?;
        let value = text(value)?;
        Ok(py.detach(|| self.inner.op_reach(id, &op, &value)))
    }
    fn op_ruling(
        &self,
        py: Python<'_>,
        op: Text,
        value: Text,
        granted: Vec<usize>,
    ) -> PyResult<Option<(usize, bool)>> {
        let op = text(op)?;
        let value = text(value)?;
        let granted = self.granted(granted)?;
        Ok(py.detach(|| self.inner.op_ruling(&op, &value, &granted)))
    }
}

#[pyclass(module = "mirage._rs")]
struct PolicyVisibility {
    inner: VisibilityMatcher,
}

#[pymethods]
impl PolicyVisibility {
    #[new]
    fn new(py: Python<'_>, value: VisibilityValue) -> PyResult<Self> {
        let value = visibility(value)?;
        Ok(Self {
            inner: py.detach(|| VisibilityMatcher::new(value)),
        })
    }
    fn hide_depth(&self, py: Python<'_>, value: Text) -> PyResult<Option<usize>> {
        let value = text(value)?;
        Ok(py.detach(|| self.inner.hide_depth(&value)))
    }
    fn show_depth(&self, py: Python<'_>, value: Text) -> PyResult<Option<usize>> {
        let value = text(value)?;
        Ok(py.detach(|| self.inner.show_depth(&value)))
    }
    fn path_visible(&self, py: Python<'_>, value: Text) -> PyResult<bool> {
        let value = text(value)?;
        Ok(py.detach(|| self.inner.path_visible(&value)))
    }
    fn shown_mode(&self, py: Python<'_>, value: Text) -> PyResult<Option<(usize, u32)>> {
        let value = text(value)?;
        Ok(py.detach(|| {
            self.inner
                .shown_mode(&value)
                .map(|(depth, mode)| (depth, mode as u32))
        }))
    }
    fn path_covers(&self, py: Python<'_>, value: Text, ancestors: bool) -> PyResult<bool> {
        let value = text(value)?;
        Ok(py.detach(|| self.inner.path_covers(&value, ancestors)))
    }
    fn hides_intersect(&self, py: Python<'_>, value: Text) -> PyResult<bool> {
        let value = text(value)?;
        Ok(py.detach(|| self.inner.hides_intersect(&value)))
    }
    fn move_reveals(&self, py: Python<'_>, src: Text, dst: Text) -> PyResult<bool> {
        let src = text(src)?;
        let dst = text(dst)?;
        Ok(py.detach(|| self.inner.move_reveals(&src, &dst)))
    }
    fn link_trace_hidden(&self, py: Python<'_>, value: Vec<LinkStepValue>) -> PyResult<bool> {
        let value = link_trace(value)?;
        Ok(py.detach(|| self.inner.link_trace_hidden(&value)))
    }
    fn visible_links(
        &self,
        py: Python<'_>,
        value: Vec<(Text, Vec<LinkStepValue>)>,
    ) -> PyResult<Vec<bool>> {
        let value = value
            .into_iter()
            .map(|(path, trace)| {
                Ok(LinkCandidate {
                    path: text(path)?,
                    trace: link_trace(trace)?,
                })
            })
            .collect::<PyResult<Vec<_>>>()?;
        Ok(py.detach(|| self.inner.visible_links(&value)))
    }
    fn var_hidden(&self, py: Python<'_>, value: Text) -> PyResult<bool> {
        let value = text(value)?;
        Ok(py.detach(|| self.inner.var_hidden(&value)))
    }
    fn effective_mode(
        &self,
        py: Python<'_>,
        value: Text,
        prefix: Text,
        configured: u32,
        cap: Option<u32>,
    ) -> PyResult<u32> {
        let value = text(value)?;
        let prefix = text(prefix)?;
        let configured = mode(configured)?;
        let cap = cap.map(mode).transpose()?;
        Ok(py.detach(|| self.inner.effective_mode(&value, &prefix, configured, cap)) as u32)
    }
    fn strongest_mode(
        &self,
        py: Python<'_>,
        prefix: Text,
        configured: u32,
        cap: Option<u32>,
    ) -> PyResult<u32> {
        let prefix = text(prefix)?;
        let configured = mode(configured)?;
        let cap = cap.map(mode).transpose()?;
        Ok(py.detach(|| self.inner.strongest_mode(&prefix, configured, cap)) as u32)
    }
    fn readonly_below(
        &self,
        py: Python<'_>,
        value: Text,
        prefix: Text,
        configured: u32,
        cap: Option<u32>,
    ) -> PyResult<Option<Text>> {
        let value = text(value)?;
        let prefix = text(prefix)?;
        let configured = mode(configured)?;
        let cap = cap.map(mode).transpose()?;
        Ok(py.detach(|| self.inner.readonly_below(&value, &prefix, configured, cap)))
    }
}

#[pyfunction]
fn policy_compile(py: Python<'_>, value: ProfileValue) -> PyResult<PlanValue> {
    let value = profile(value)?;
    let plan = py.detach(|| compile_profile(&value));
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
    py: Python<'_>,
    base: Option<ProfileValue>,
    inline: Option<ProfileValue>,
) -> PyResult<Option<ProfileValue>> {
    let base = base.map(profile).transpose()?;
    let inline = inline.map(profile).transpose()?;
    py.detach(|| restrict_profile(base.as_ref(), inline.as_ref()))
        .map(|value| value.map(profile_value))
        .map_err(PyValueError::new_err)
}

#[pyfunction]
fn policy_pattern(
    py: Python<'_>,
    value: Text,
    tokens: Vec<Text>,
    ecma: bool,
) -> PyResult<(Vec<Text>, bool, bool)> {
    let value = text(value)?;
    let tokens = texts(tokens)?;
    let dialect = if ecma {
        Whitespace::EcmaScript
    } else {
        Whitespace::Python
    };
    Ok(py.detach(|| {
        (
            split_pattern(&value, dialect),
            pattern_matches(&value, &tokens, dialect),
            pattern_reaches(&value, &tokens, dialect),
        )
    }))
}

#[pyfunction]
fn policy_paths(py: Python<'_>, value: Vec<Text>) -> PyResult<ScopeValue> {
    let value = texts(value)?;
    let scope = py.detach(|| classify_paths(&value));
    Ok((scope.paths, scope.patterns))
}

#[pyfunction]
fn policy_vars(py: Python<'_>, value: Vec<Text>) -> PyResult<ScopeValue> {
    let value = texts(value)?;
    let scope = py.detach(|| classify_vars(&value));
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
