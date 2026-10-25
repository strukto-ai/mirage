use std::cell::RefCell;
use std::collections::HashMap;

use mirage_rs::policy::{
    self, AdmissionMatcher, CommandFacts, HideReason, LinkCandidate, LinkState, LinkStep, Mode,
    Mount, PathFact, PathScope, Paths, Profile, RestrictionPlan, Rule, Rules, Show, Subject, Text,
    VarScope, Visibility, VisibilityMatcher, Whitespace,
};

const MAX_UNITS: usize = 16 * 1024 * 1024;

enum Matcher {
    Admission {
        inner: AdmissionMatcher,
        rules: usize,
    },
    Visibility(VisibilityMatcher),
}

#[derive(Default)]
struct State {
    input: Vec<u32>,
    output: Vec<u32>,
    error: Vec<u8>,
    handles: HashMap<u32, Matcher>,
    next: u32,
    upload: Option<RequestUpload>,
}

struct RequestUpload {
    total: usize,
    units: Vec<u32>,
}

impl RequestUpload {
    fn append(&mut self, offset: usize, total: usize, input: &[u32]) -> Result<()> {
        if total > isize::MAX as usize / std::mem::size_of::<u32>() {
            return Err("policy request exceeds addressable memory");
        }
        if total != self.total || offset != self.units.len() || input.is_empty() {
            return Err("invalid policy upload chunk");
        }
        let end = offset
            .checked_add(input.len())
            .ok_or("invalid policy upload length")?;
        if end > total {
            return Err("invalid policy upload length");
        }
        self.units
            .try_reserve(input.len())
            .map_err(|_| "policy upload allocation failed")?;
        self.units.extend_from_slice(input);
        Ok(())
    }
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());
}

struct Reader<'a> {
    input: &'a [u32],
    offset: usize,
}

type Result<T> = std::result::Result<T, &'static str>;

impl<'a> Reader<'a> {
    fn new(input: &'a [u32]) -> Self {
        Self { input, offset: 0 }
    }
    fn number(&mut self) -> Result<u32> {
        let value = self
            .input
            .get(self.offset)
            .copied()
            .ok_or("truncated policy packet")?;
        self.offset += 1;
        Ok(value)
    }
    fn boolean(&mut self) -> Result<bool> {
        match self.number()? {
            0 => Ok(false),
            1 => Ok(true),
            _ => Err("invalid policy boolean"),
        }
    }
    fn text(&mut self) -> Result<Text> {
        let length = self.number()? as usize;
        let end = self
            .offset
            .checked_add(length)
            .ok_or("invalid policy text length")?;
        let text = self
            .input
            .get(self.offset..end)
            .ok_or("truncated policy text")?;
        if text.iter().any(|&unit| unit > 0x10ffff) {
            return Err("policy character is past U+10FFFF");
        }
        self.offset = end;
        Ok(text.to_vec())
    }
    fn list<T>(&mut self, mut read: impl FnMut(&mut Self) -> Result<T>) -> Result<Vec<T>> {
        let length = self.number()? as usize;
        if length > self.input.len() - self.offset {
            return Err("invalid policy list length");
        }
        (0..length).map(|_| read(self)).collect()
    }
    fn optional<T>(&mut self, read: impl FnOnce(&mut Self) -> Result<T>) -> Result<Option<T>> {
        if self.boolean()? {
            Ok(Some(read(self)?))
        } else {
            Ok(None)
        }
    }
    fn mode(&mut self) -> Result<Mode> {
        match self.number()? {
            0 => Ok(Mode::Read),
            1 => Ok(Mode::Write),
            2 => Ok(Mode::Exec),
            _ => Err("invalid policy mode"),
        }
    }
    fn rule(&mut self) -> Result<Rule> {
        Ok(Rule {
            reason: self.text()?,
            commands: self.list(Self::text)?,
            paths: self.list(Self::text)?,
            mount: self.optional(Self::text)?,
        })
    }
    fn rules(&mut self) -> Result<Rules> {
        Ok(Rules {
            allow: self.optional(|r| r.list(Self::text))?,
            deny: self.list(Self::rule)?,
            ask: self.list(Self::rule)?,
        })
    }
    fn scope(&mut self) -> Result<PathScope> {
        Ok(PathScope {
            paths: self.list(Self::text)?,
            patterns: self.list(Self::text)?,
        })
    }
    fn show(&mut self) -> Result<Show> {
        Ok(Show {
            path: self.text()?,
            mode: self.optional(Self::mode)?,
        })
    }
    fn reason(&mut self) -> Result<HideReason> {
        Ok(HideReason {
            patterns: self.list(Self::text)?,
            reason: self.text()?,
        })
    }
    fn visibility(&mut self) -> Result<Visibility> {
        Ok(Visibility {
            hidden: self.scope()?,
            shown: self.list(Self::show)?,
            vars: VarScope {
                names: self.list(Self::text)?,
                patterns: self.list(Self::text)?,
            },
        })
    }
    fn paths(&mut self) -> Result<Paths> {
        Ok(Paths {
            hide: self.list(Self::text)?,
            show: self.list(Self::show)?,
            reasons: self.list(Self::reason)?,
        })
    }
    fn mount(&mut self) -> Result<Mount> {
        Ok(Mount {
            prefix: self.text()?,
            mode: self.optional(Self::mode)?,
            commands: self.optional(Self::rules)?,
            paths: self.optional(Self::paths)?,
        })
    }
    fn profile(&mut self) -> Result<Profile> {
        Ok(Profile {
            commands: self.optional(Self::rules)?,
            paths: self.optional(Self::paths)?,
            vars: self.optional(|r| r.list(Self::text))?,
            mounts: self.optional(|r| r.list(Self::mount))?,
        })
    }
    fn path(&mut self) -> Result<PathFact> {
        Ok(PathFact {
            virtual_path: self.text()?,
            display_path: self.text()?,
        })
    }
    fn facts(&mut self) -> Result<CommandFacts> {
        let texts = self.list(Self::text)?;
        let text = |r: &mut Self| {
            texts
                .get(r.number()? as usize)
                .cloned()
                .ok_or("invalid policy facts text reference")
        };
        let path = |r: &mut Self| {
            Ok(PathFact {
                virtual_path: text(r)?,
                display_path: text(r)?,
            })
        };
        Ok(CommandFacts {
            command: text(self)?,
            tokens: self.list(text)?,
            tool: self.boolean()?,
            cwd: text(self)?,
            paths: self.list(path)?,
            operands: self.list(path)?,
            walks: self.boolean()?,
            move_target: self.optional(text)?,
        })
    }
    fn subject(&mut self) -> Result<Subject> {
        Ok(Subject {
            path: self.optional(Self::path)?,
            holds: self.boolean()?,
            ancestors: self.boolean()?,
        })
    }
    fn indices(&mut self) -> Result<Vec<usize>> {
        self.list(|r| Ok(r.number()? as usize))
    }
    fn link_step(&mut self) -> Result<LinkStep> {
        match self.number()? {
            0 => Ok(LinkStep::Follow(self.text()?)),
            1 => Ok(LinkStep::Enter {
                path: self.text()?,
                next_is_parent: self.boolean()?,
            }),
            2 => Ok(LinkStep::Landing(self.text()?)),
            3 => Ok(LinkStep::HopLimit),
            _ => Err("invalid policy link step"),
        }
    }
    fn link_state(&mut self) -> Result<LinkState> {
        match self.number()? {
            0 => Ok(LinkState::Unfollowed),
            1 => Ok(LinkState::Followed),
            2 => Ok(LinkState::Hidden),
            3 => Ok(LinkState::HopLimit),
            _ => Err("invalid policy link state"),
        }
    }
    fn link_candidate(&mut self) -> Result<LinkCandidate> {
        Ok(LinkCandidate {
            path: self.text()?,
            trace: self.list(Self::link_step)?,
        })
    }
    fn end(&self) -> Result<()> {
        if self.offset == self.input.len() {
            Ok(())
        } else {
            Err("trailing policy packet data")
        }
    }
}

#[derive(Default)]
struct Writer(Vec<u32>);

impl Writer {
    fn number(&mut self, value: usize) {
        self.0.push(value as u32);
    }
    fn boolean(&mut self, value: bool) {
        self.number(usize::from(value));
    }
    fn text(&mut self, value: &[u32]) {
        self.number(value.len());
        self.0.extend_from_slice(value);
    }
    fn list<T>(&mut self, values: &[T], mut write: impl FnMut(&mut Self, &T)) {
        self.number(values.len());
        for value in values {
            write(self, value);
        }
    }
    fn optional<T>(&mut self, value: Option<T>, write: impl FnOnce(&mut Self, T)) {
        self.boolean(value.is_some());
        if let Some(value) = value {
            write(self, value);
        }
    }
    fn mode(&mut self, mode: Mode) {
        self.number(mode as usize);
    }
    fn rule(&mut self, rule: &Rule) {
        self.text(&rule.reason);
        self.list(&rule.commands, |w, t| w.text(t));
        self.list(&rule.paths, |w, t| w.text(t));
        self.optional(rule.mount.as_ref(), |w, value| w.text(value));
    }
    fn rules(&mut self, rules: &Rules) {
        self.optional(rules.allow.as_ref(), |w, v| w.list(v, |w, t| w.text(t)));
        self.list(&rules.deny, Self::rule);
        self.list(&rules.ask, Self::rule);
    }
    fn scope(&mut self, scope: &PathScope) {
        self.list(&scope.paths, |w, t| w.text(t));
        self.list(&scope.patterns, |w, t| w.text(t));
    }
    fn show(&mut self, show: &Show) {
        self.text(&show.path);
        self.optional(show.mode, Self::mode);
    }
    fn reason(&mut self, reason: &HideReason) {
        self.list(&reason.patterns, |w, t| w.text(t));
        self.text(&reason.reason);
    }
    fn visibility(&mut self, vis: &Visibility) {
        self.scope(&vis.hidden);
        self.list(&vis.shown, Self::show);
        self.list(&vis.vars.names, |w, t| w.text(t));
        self.list(&vis.vars.patterns, |w, t| w.text(t));
    }
    fn paths(&mut self, paths: &Paths) {
        self.list(&paths.hide, |w, t| w.text(t));
        self.list(&paths.show, Self::show);
        self.list(&paths.reasons, Self::reason);
    }
    fn mount(&mut self, mount: &Mount) {
        self.text(&mount.prefix);
        self.optional(mount.mode, Self::mode);
        self.optional(mount.commands.as_ref(), Self::rules);
        self.optional(mount.paths.as_ref(), Self::paths);
    }
    fn profile(&mut self, profile: &Profile) {
        self.optional(profile.commands.as_ref(), Self::rules);
        self.optional(profile.paths.as_ref(), Self::paths);
        self.optional(profile.vars.as_ref(), |w, v| w.list(v, |w, t| w.text(t)));
        self.optional(profile.mounts.as_ref(), |w, v| w.list(v, Self::mount));
    }
    fn plan(&mut self, plan: &RestrictionPlan) {
        self.optional(plan.commands.as_ref(), Self::rules);
        self.visibility(&plan.visibility);
        self.list(&plan.mount_modes, |w, (t, m)| {
            w.text(t);
            w.mode(*m);
        });
        self.list(&plan.hide_reasons, Self::reason);
    }
    fn path(&mut self, path: &PathFact) {
        self.text(&path.virtual_path);
        self.text(&path.display_path);
    }
    fn subject(&mut self, subject: &Subject) {
        self.optional(subject.path.as_ref(), Self::path);
        self.boolean(subject.holds);
        self.boolean(subject.ancestors);
    }
}

fn insert(state: &mut State, matcher: Matcher, out: &mut Writer) -> Result<()> {
    state.next = state
        .next
        .checked_add(1)
        .ok_or("policy handles exhausted")?;
    state.handles.insert(state.next, matcher);
    out.number(state.next as usize);
    Ok(())
}

fn admission(state: &State, handle: u32) -> Result<(&AdmissionMatcher, usize)> {
    match state.handles.get(&handle) {
        Some(Matcher::Admission { inner, rules }) => Ok((inner, *rules)),
        _ => Err("invalid admission policy handle"),
    }
}
fn visibility(state: &State, handle: u32) -> Result<&VisibilityMatcher> {
    match state.handles.get(&handle) {
        Some(Matcher::Visibility(inner)) => Ok(inner),
        _ => Err("invalid visibility policy handle"),
    }
}
fn rule_id(reader: &mut Reader<'_>, count: usize) -> Result<usize> {
    let id = reader.number()? as usize;
    if id < count {
        Ok(id)
    } else {
        Err("invalid policy rule index")
    }
}

fn dispatch(state: &mut State, operation: u32, handle: u32, input: &[u32]) -> Result<Vec<u32>> {
    let mut r = Reader::new(input);
    let mut w = Writer::default();
    match operation {
        1 => {
            let rules = r.rules()?;
            r.end()?;
            let count = rules.deny.len() + rules.ask.len();
            insert(
                state,
                Matcher::Admission {
                    inner: AdmissionMatcher::new(rules, Whitespace::EcmaScript),
                    rules: count,
                },
                &mut w,
            )?;
        }
        2 => {
            let vis = r.visibility()?;
            r.end()?;
            insert(
                state,
                Matcher::Visibility(VisibilityMatcher::new(vis)),
                &mut w,
            )?;
        }
        3 => w.plan(&policy::compile_profile(&r.profile()?)),
        4 => {
            let base = r.optional(Reader::profile)?;
            let inline = r.optional(Reader::profile)?;
            let result = policy::restrict_profile(base.as_ref(), inline.as_ref())?;
            w.optional(result.as_ref(), Writer::profile);
        }
        5 => w.list(
            &policy::split_pattern(&r.text()?, Whitespace::EcmaScript),
            |w, t| w.text(t),
        ),
        6 | 7 => {
            let pattern = r.text()?;
            let tokens = r.list(Reader::text)?;
            w.boolean(if operation == 6 {
                policy::pattern_matches(&pattern, &tokens, Whitespace::EcmaScript)
            } else {
                policy::pattern_reaches(&pattern, &tokens, Whitespace::EcmaScript)
            });
        }
        8 => w.boolean(policy::is_glob(&r.text()?)),
        9 => w.number(policy::anchor_depth(&r.text()?)),
        10 => w.text(&policy::show_head(&r.text()?)),
        11 => w.scope(&policy::classify_paths(&r.list(Reader::text)?)),
        12 => {
            let vars = policy::classify_vars(&r.list(Reader::text)?);
            w.list(&vars.names, |w, t| w.text(t));
            w.list(&vars.patterns, |w, t| w.text(t));
        }
        13 => w.list(&policy::subjects(&r.facts()?), Writer::subject),
        20..=35 => {
            let (matcher, count) = admission(state, handle)?;
            match operation {
                20 => w.boolean(matcher.head_allowed(&r.text()?)),
                21 => {
                    let tokens = r.list(Reader::text)?;
                    w.boolean(matcher.line_allowed(&tokens, r.boolean()?));
                }
                22 => w.boolean(matcher.has_rules()),
                23 => w.boolean(matcher.reads_args(&r.text()?)),
                24 => w.boolean(matcher.scopes_paths(&r.text()?)),
                25 => {
                    let ruling = matcher.decide(&r.facts()?);
                    w.number(ruling.outcome as usize);
                    w.optional(ruling.rule, Writer::number);
                    w.optional(ruling.matched_path.as_ref(), |w, t| w.text(t));
                    w.boolean(ruling.allow_list);
                    w.list(&ruling.asks, |w, n| w.number(*n));
                }
                26 => {
                    let tokens = r.list(Reader::text)?;
                    w.boolean(matcher.io_reach(&tokens, &r.text()?));
                }
                27 => {
                    let tokens = r.list(Reader::text)?;
                    let path = r.text()?;
                    w.optional(
                        matcher.io_refusal(&tokens, &path, &r.indices()?),
                        Writer::number,
                    );
                }
                28 => {
                    let op = r.text()?;
                    let path = r.text()?;
                    w.optional(
                        matcher.op_ruling(&op, &path, &r.indices()?),
                        |w, (id, ask)| {
                            w.number(id);
                            w.boolean(ask);
                        },
                    );
                }
                29 => {
                    let id = rule_id(&mut r, count)?;
                    w.boolean(matcher.rule_applies(id, &r.facts()?));
                }
                30 => {
                    let id = rule_id(&mut r, count)?;
                    w.optional(matcher.rule_reach(id, &r.subject()?), Writer::number);
                }
                31 => {
                    let id = rule_id(&mut r, count)?;
                    w.number(matcher.hidden_depth(id, &r.text()?));
                }
                32 => {
                    let id = rule_id(&mut r, count)?;
                    let path = r.text()?;
                    w.number(matcher.covers_depth(id, &path, r.boolean()?));
                }
                33 => {
                    let id = rule_id(&mut r, count)?;
                    let tokens = r.list(Reader::text)?;
                    let path = r.text()?;
                    w.boolean(matcher.match_io(id, &tokens, &path, r.boolean()?));
                }
                34 => {
                    let id = rule_id(&mut r, count)?;
                    let op = r.text()?;
                    w.optional(matcher.op_reach(id, &op, &r.text()?), Writer::number);
                }
                35 => {
                    let id = rule_id(&mut r, count)?;
                    w.boolean(matcher.posix_level(id));
                }
                _ => unreachable!(),
            }
        }
        40..=52 => {
            let matcher = visibility(state, handle)?;
            match operation {
                40 => w.optional(matcher.hide_depth(&r.text()?), Writer::number),
                41 => w.optional(matcher.show_depth(&r.text()?), Writer::number),
                42 => w.boolean(matcher.path_visible(&r.text()?)),
                43 => w.optional(matcher.shown_mode(&r.text()?), |w, (depth, mode)| {
                    w.number(depth);
                    w.mode(mode);
                }),
                44 => {
                    let path = r.text()?;
                    w.boolean(matcher.path_covers(&path, r.boolean()?));
                }
                45 => w.boolean(matcher.hides_intersect(&r.text()?)),
                46 => {
                    let src = r.text()?;
                    w.boolean(matcher.move_reveals(&src, &r.text()?));
                }
                47 => {
                    let state = r.link_state()?;
                    let trace = r.list(Reader::link_step)?;
                    w.number(matcher.fold_link_trace(state, &trace) as usize);
                }
                48 => w.boolean(matcher.var_hidden(&r.text()?)),
                52 => w.list(
                    &matcher.visible_links(&r.list(Reader::link_candidate)?),
                    |w, visible| w.boolean(*visible),
                ),
                49 => {
                    let path = r.text()?;
                    let prefix = r.text()?;
                    let configured = r.mode()?;
                    w.mode(matcher.effective_mode(
                        &path,
                        &prefix,
                        configured,
                        r.optional(Reader::mode)?,
                    ));
                }
                50 => {
                    let prefix = r.text()?;
                    let configured = r.mode()?;
                    w.mode(matcher.strongest_mode(&prefix, configured, r.optional(Reader::mode)?));
                }
                51 => {
                    let path = r.text()?;
                    let prefix = r.text()?;
                    let configured = r.mode()?;
                    w.optional(
                        matcher
                            .readonly_below(&path, &prefix, configured, r.optional(Reader::mode)?)
                            .as_ref(),
                        |w, t| w.text(t),
                    );
                }
                _ => unreachable!(),
            }
        }
        60 => {
            r.end()?;
            if state.handles.remove(&handle).is_none() {
                return Err("invalid policy handle");
            }
        }
        _ => return Err("unknown policy operation"),
    }
    r.end()?;
    Ok(w.0)
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_policy_input(length: usize) -> *mut u32 {
    STATE.with_borrow_mut(|state| {
        state.input.clear();
        if length > MAX_UNITS {
            state.upload = None;
            state.error = b"policy packet is too large".to_vec();
            return std::ptr::null_mut();
        }
        state.input.resize(length, 0);
        state.input.as_mut_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_policy_call(operation: u32, handle: u32) -> i32 {
    STATE.with_borrow_mut(|state| {
        state.upload = None;
        state.output.clear();
        state.error.clear();
        let input = std::mem::take(&mut state.input);
        let result = dispatch(state, operation, handle, &input);
        state.input = input;
        finish_call(state, result)
    })
}

fn finish_call(state: &mut State, result: Result<Vec<u32>>) -> i32 {
    match result {
        Ok(output) => {
            state.output = output;
            0
        }
        Err(error) => {
            state.error = error.as_bytes().to_vec();
            1
        }
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_policy_upload_chunk(offset: usize, total: usize) -> i32 {
    STATE.with_borrow_mut(|state| {
        state.output.clear();
        state.error.clear();
        let mut facts = if offset == 0 {
            state.upload = None;
            RequestUpload {
                total,
                units: Vec::new(),
            }
        } else if let Some(facts) = state.upload.take() {
            facts
        } else {
            return finish_call(state, Err("missing policy upload"));
        };
        let result = facts.append(offset, total, &state.input);
        if result.is_ok() {
            state.upload = Some(facts);
        } else {
            state.upload = None;
        }
        finish_call(state, result.map(|_| Vec::new()))
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_policy_upload_call(operation: u32, handle: u32) -> i32 {
    STATE.with_borrow_mut(|state| {
        state.output.clear();
        state.error.clear();
        let result = match state.upload.take() {
            Some(facts) if facts.total == facts.units.len() => {
                dispatch(state, operation, handle, &facts.units)
            }
            Some(_) => Err("incomplete policy upload"),
            None => Err("missing policy upload"),
        };
        finish_call(state, result)
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_policy_upload_clear() {
    STATE.with_borrow_mut(|state| state.upload = None);
}

#[unsafe(no_mangle)]
pub extern "C" fn mirage_policy_output() -> *const u32 {
    STATE.with_borrow(|state| state.output.as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn mirage_policy_output_len() -> usize {
    STATE.with_borrow(|state| state.output.len())
}
#[unsafe(no_mangle)]
pub extern "C" fn mirage_policy_error() -> *const u8 {
    STATE.with_borrow(|state| state.error.as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn mirage_policy_error_len() -> usize {
    STATE.with_borrow(|state| state.error.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packets_refuse_truncation_and_invalid_characters() {
        let mut state = State::default();
        assert_eq!(
            dispatch(&mut state, 8, 0, &[2, 42]).unwrap_err(),
            "truncated policy text"
        );
        assert_eq!(
            dispatch(&mut state, 8, 0, &[1, 0x110000]).unwrap_err(),
            "policy character is past U+10FFFF"
        );
        assert!(dispatch(&mut state, 8, 0, &[1, 0xd800]).is_ok());
        assert!(dispatch(&mut state, 8, 0, &[0, 1]).is_err());
        let mut packet = Writer::default();
        packet.visibility(&Visibility::default());
        let handle = dispatch(&mut state, 2, 0, &packet.0).unwrap()[0];
        assert_eq!(
            dispatch(&mut state, 47, handle, &[0, 1, 4]).unwrap_err(),
            "invalid policy link step"
        );
        assert!(dispatch(&mut state, 47, handle, &[0, 1, 1, 0]).is_err());
        assert_eq!(
            dispatch(&mut state, 47, handle, &[4, 0]).unwrap_err(),
            "invalid policy link state"
        );
        for packet in [
            &[2, 1, 4][..],
            &[3, 1, 0, 2, 47],
            &[2, 1, 1, 0, 2],
            &[3, 1, 2, 1, 0x110000],
        ] {
            assert!(dispatch(&mut state, 47, handle, packet).is_err());
        }
        assert_eq!(dispatch(&mut state, 47, handle, &[2, 0]).unwrap(), vec![2]);
        assert_eq!(dispatch(&mut state, 47, handle, &[3, 0]).unwrap(), vec![3]);
    }
    #[test]
    fn facts_preserve_interned_text_and_reject_malformed_references() {
        let mut packet = Writer::default();
        packet.list(
            &[vec![99, 97, 116], vec![47], vec![47, 0x1f600, 0xd800]],
            |w, text| w.text(text),
        );
        packet.number(0);
        packet.list(&[0, 2], |w, id| w.number(*id));
        packet.boolean(true);
        packet.number(1);
        for _ in 0..2 {
            packet.number(1);
            packet.number(2);
            packet.number(2);
        }
        packet.boolean(false);
        packet.boolean(true);
        packet.number(2);
        let facts = Reader::new(&packet.0).facts().unwrap();
        assert_eq!(facts.command, vec![99, 97, 116]);
        assert_eq!(facts.tokens[1], vec![47, 0x1f600, 0xd800]);
        assert_eq!(facts.paths[0].virtual_path, facts.tokens[1]);
        assert_eq!(facts.operands, facts.paths);
        assert_eq!(facts.move_target.as_ref(), Some(&facts.tokens[1]));
        for end in 0..packet.0.len() {
            assert!(Reader::new(&packet.0[..end]).facts().is_err());
        }
        let mut invalid = packet.0.clone();
        invalid[11] = 3;
        assert_eq!(
            Reader::new(&invalid).facts().unwrap_err(),
            "invalid policy facts text reference"
        );
        assert!(Reader::new(&[u32::MAX]).facts().is_err());
        assert!(Reader::new(&[1, u32::MAX]).facts().is_err());
    }

    #[test]
    fn facts_upload_checks_offsets_totals_and_addressable_lengths() {
        let mut upload = RequestUpload {
            total: 4,
            units: Vec::new(),
        };
        assert!(upload.append(0, 4, &[1, 2]).is_ok());
        assert!(upload.append(1, 4, &[3]).is_err());
        assert!(upload.append(2, 5, &[3]).is_err());
        assert!(upload.append(2, 4, &[]).is_err());
        assert!(upload.append(2, 4, &[3, 4, 5]).is_err());
        assert_eq!(upload.units, vec![1, 2]);
        assert!(upload.append(2, 4, &[3, 4]).is_ok());
        assert_eq!(upload.units, vec![1, 2, 3, 4]);
        let total = isize::MAX as usize / std::mem::size_of::<u32>() + 1;
        let mut oversized = RequestUpload {
            total,
            units: Vec::new(),
        };
        assert_eq!(
            oversized.append(0, total, &[0]),
            Err("policy request exceeds addressable memory")
        );
    }

    #[test]
    fn handles_reject_wrong_kind_and_do_not_reuse_after_drop() {
        let mut state = State::default();
        let mut packet = Writer::default();
        packet.visibility(&Visibility::default());
        let handle = dispatch(&mut state, 2, 0, &packet.0).unwrap()[0];
        assert!(dispatch(&mut state, 20, handle, &[0]).is_err());
        assert!(dispatch(&mut state, 60, handle, &[]).is_ok());
        assert!(dispatch(&mut state, 42, handle, &[0]).is_err());
        let next = dispatch(&mut state, 2, 0, &packet.0).unwrap()[0];
        assert_ne!(handle, next);
    }
}
