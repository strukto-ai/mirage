use std::collections::HashMap;

use super::pattern::{expanded, prefix_matches};
use super::{
    AllowEntry, CommandFacts, Matched, Outcome, PathFact, PatternRead, Reading, Rule, Rules,
    Ruling, Subject, Text, Visibility, VisibilityMatcher, Whitespace, anchor_depth, classify_paths,
    split_pattern,
};

const DASH: u32 = 45;
const SPACE: u32 = 32;

/// A line as the matcher reads it: its tokens, and when its grammar read
/// it, that read and each pattern's read with the same grammar, by pattern.
pub struct Line<'a> {
    pub tokens: &'a [Text],
    pub read: Option<&'a Reading>,
    reads: HashMap<&'a [u32], Option<&'a Reading>>,
}

impl<'a> Line<'a> {
    pub fn new(tokens: &'a [Text], read: Option<&'a Reading>, reads: &'a [PatternRead]) -> Self {
        Self {
            tokens,
            read,
            reads: reads
                .iter()
                .map(|r| (r.pattern.as_slice(), r.read.as_ref()))
                .collect(),
        }
    }

    pub fn of(facts: &'a CommandFacts) -> Self {
        Self::new(&facts.tokens, facts.line.as_ref(), &facts.reads)
    }

    #[cfg(test)]
    pub fn words(tokens: &'a [Text]) -> Self {
        Self::new(tokens, None, &[])
    }

    /// The line's read and a pattern's, when both were read; the
    /// pattern's is None when it cannot match this line at all.
    fn read_of(&self, pattern: &[u32]) -> Option<(&'a Reading, Option<&'a Reading>)> {
        let have = self.read?;
        let want = self.reads.get(pattern)?;
        Some((have, *want))
    }

    fn path(&self) -> Vec<Text> {
        self.read
            .map(|read| read.path.clone())
            .unwrap_or_else(|| self.tokens.iter().take(1).cloned().collect())
    }
}

fn dashed(word: &[u32]) -> bool {
    word.len() > 1 && word[0] == DASH
}

/// Whether a pattern's read covers the line's: its subcommand path is a
/// prefix of the line's, the line carries each of its options (with
/// each value it gives, in whatever spelling), and its operands are a
/// prefix of the line's, `*` standing for any one word.
fn covers(want: &Reading, have: &Reading) -> bool {
    want.path.len() <= have.path.len()
        && prefix_matches(&want.path, &have.path)
        && want.flags.iter().all(|flag| {
            have.flags.iter().any(|carried| {
                carried.name == flag.name && flag.values.iter().all(|v| carried.values.contains(v))
            })
        })
        && want.operands.len() <= have.operands.len()
        && prefix_matches(&want.operands, &have.operands)
}

/// One pattern as a group expanded it: its text, which keys its read,
/// and its words, which a line no grammar read is matched on.
struct Pattern {
    text: Text,
    words: Vec<Text>,
}

impl Pattern {
    fn compile(written: &[u32], whitespace: Whitespace) -> Vec<Self> {
        expanded(written, whitespace)
            .into_iter()
            .map(|text| Self {
                words: split_pattern(&text, whitespace),
                text,
            })
            .collect()
    }

    fn fits(&self, line: &Line) -> bool {
        match line.read_of(&self.text) {
            Some((have, Some(want))) => covers(want, have),
            Some((_, None)) => false,
            None => {
                self.words.len() <= line.tokens.len() && prefix_matches(&self.words, line.tokens)
            }
        }
    }

    fn matched(&self, line: &Line) -> Matched {
        if let Some((_, Some(want))) = line.read_of(&self.text) {
            return Matched {
                command: want.path.clone(),
                flags: want.flags.iter().map(|flag| flag.name.clone()).collect(),
            };
        }
        let at = self
            .words
            .iter()
            .position(|word| dashed(word))
            .unwrap_or(self.words.len());
        Matched {
            command: self.words[..at].to_vec(),
            flags: self.words[at..]
                .iter()
                .filter(|w| dashed(w))
                .cloned()
                .collect(),
        }
    }
}

/// One allow entry, compiled.
enum Entry {
    Pattern(Pattern),
    Only {
        key: Text,
        words: Vec<Text>,
        flags: Vec<Text>,
    },
}

impl Entry {
    fn compile(entry: &AllowEntry, whitespace: Whitespace) -> Vec<Self> {
        match entry {
            AllowEntry::Pattern(written) => Pattern::compile(written, whitespace)
                .into_iter()
                .map(Self::Pattern)
                .collect(),
            AllowEntry::Only { command, flags } => {
                let mut key = command.clone();
                for flag in flags {
                    key.push(SPACE);
                    key.extend_from_slice(flag);
                }
                vec![Self::Only {
                    key,
                    words: split_pattern(command, whitespace),
                    flags: flags.clone(),
                }]
            }
        }
    }

    fn words(&self) -> &[Text] {
        match self {
            Self::Pattern(pattern) => &pattern.words,
            Self::Only { words, .. } => words,
        }
    }

    /// Whether this entry names the command a line runs, which closes
    /// that command to the entries naming it.
    fn names(&self, head: Option<&Text>) -> bool {
        self.words()
            .first()
            .is_some_and(|word| word != &[42] && Some(word) == head)
    }

    fn admits(&self, line: &Line) -> bool {
        match self {
            Self::Pattern(pattern) => pattern.fits(line),
            Self::Only { key, words, flags } => match line.read_of(key) {
                Some((have, Some(want))) => {
                    want.path.len() <= have.path.len()
                        && prefix_matches(&want.path, &have.path)
                        && want.operands.len() <= have.operands.len()
                        && prefix_matches(&want.operands, &have.operands)
                        && have
                            .flags
                            .iter()
                            .all(|carried| want.flags.iter().any(|f| f.name == carried.name))
                }
                Some((_, None)) => false,
                None => {
                    words.len() <= line.tokens.len()
                        && prefix_matches(words, line.tokens)
                        && line.tokens[words.len()..]
                            .iter()
                            .all(|token| !dashed(token) || flags.contains(token))
                }
            },
        }
    }
}

struct CompiledRule {
    value: Rule,
    patterns: Vec<Pattern>,
    scope: VisibilityMatcher,
    entries: Vec<(usize, VisibilityMatcher)>,
}

impl CompiledRule {
    fn new(value: Rule, whitespace: Whitespace) -> Self {
        let patterns = value
            .commands
            .iter()
            .flat_map(|p| Pattern::compile(p, whitespace))
            .collect();
        let compiled_scope = scope(&value.paths);
        let entries = value
            .paths
            .iter()
            .map(|p| (anchor_depth(p), scope(std::slice::from_ref(p))))
            .collect();
        Self {
            value,
            patterns,
            scope: compiled_scope,
            entries,
        }
    }

    fn names(&self, line: &Line) -> bool {
        self.patterns.is_empty() || self.patterns.iter().any(|p| p.fits(line))
    }

    fn heads(&self, head: &[Text]) -> bool {
        self.patterns.is_empty() || self.patterns.iter().any(|p| prefix_matches(&p.words, head))
    }
}

fn scope(entries: &[Text]) -> VisibilityMatcher {
    VisibilityMatcher::new(Visibility {
        hidden: classify_paths(entries),
        ..Visibility::default()
    })
}

pub struct AdmissionMatcher {
    allow: Option<Vec<Entry>>,
    rules: Vec<CompiledRule>,
    denies: usize,
}

impl AdmissionMatcher {
    pub fn new(rules: Rules, whitespace: Whitespace) -> Self {
        let allow = rules.allow.map(|entries| {
            entries
                .iter()
                .flat_map(|entry| Entry::compile(entry, whitespace))
                .collect()
        });
        let denies = rules.deny.len();
        let rules = rules
            .deny
            .into_iter()
            .chain(rules.ask)
            .map(|rule| CompiledRule::new(rule, whitespace))
            .collect();
        Self {
            allow,
            rules,
            denies,
        }
    }

    fn outcome(&self, id: usize) -> Outcome {
        if id < self.denies {
            Outcome::Deny
        } else {
            Outcome::Ask
        }
    }

    pub fn head_allowed(&self, name: &[u32]) -> bool {
        self.allow.as_ref().is_none_or(|entries| {
            entries
                .iter()
                .any(|e| prefix_matches(e.words(), &[name.to_vec()]))
        })
    }

    /// Whether the allow list lets a line run. An entry naming the
    /// line's command closes that command to the entries naming it, so
    /// `["*", "gh pr view"]` runs every command and `gh` only as `gh pr
    /// view`; a command no entry names is admitted by any entry that
    /// matches it, a `*` among them.
    pub fn line_allowed(&self, line: &Line, tool: bool) -> bool {
        if !tool {
            return true;
        }
        let Some(entries) = self.allow.as_ref() else {
            return true;
        };
        let head = line.tokens.first();
        let named: Vec<&Entry> = entries.iter().filter(|e| e.names(head)).collect();
        if named.is_empty() {
            entries.iter().any(|e| e.admits(line))
        } else {
            named.iter().any(|e| e.admits(line))
        }
    }

    pub fn has_rules(&self) -> bool {
        self.allow.is_some() || !self.rules.is_empty()
    }

    pub fn reads_args(&self, name: &[u32]) -> bool {
        let head = [name.to_vec()];
        self.allow.as_ref().is_some_and(|entries| {
            entries.iter().any(|e| {
                prefix_matches(e.words(), &head)
                    && (e.words().len() > 1 || matches!(e, Entry::Only { .. }))
            })
        }) || self.rules.iter().any(|rule| {
            let mount = rule.value.mount.as_deref().unwrap_or_default();
            rule.heads(&head)
                && (!rule.value.paths.is_empty()
                    || !mount.is_empty()
                    || rule
                        .patterns
                        .iter()
                        .any(|p| p.words.len() > 1 && prefix_matches(&p.words, &head)))
        })
    }

    pub fn scopes_paths(&self, name: &[u32]) -> bool {
        let head = [name.to_vec()];
        self.rules.iter().any(|rule| {
            let mount = rule.value.mount.as_deref().unwrap_or_default();
            (!rule.value.paths.is_empty() || !mount.is_empty()) && rule.heads(&head)
        })
    }

    fn rule_applies(&self, id: usize, line: &Line, facts: &CommandFacts) -> bool {
        let rule = &self.rules[id];
        let mount = rule.value.mount.as_deref().unwrap_or_default();
        rule.names(line) && (mount.is_empty() || touches(mount, facts))
    }

    /// The rules that name the line, by id, ascending: what every entry
    /// the line's command reaches is judged under, so a host asks once
    /// per line and hands the ids to `io_reach` and `io_refusal`.
    pub fn naming(&self, line: &Line) -> Vec<usize> {
        (0..self.rules.len())
            .filter(|&id| self.rules[id].names(line))
            .collect()
    }

    fn named(&self, ids: &[usize]) -> Vec<bool> {
        let mut named = vec![false; self.rules.len()];
        for &id in ids {
            named[id] = true;
        }
        named
    }

    pub fn hidden_depth(&self, id: usize, path: &[u32]) -> usize {
        self.rules[id].scope.hide_depth(path).unwrap_or(0)
    }

    pub fn covers_depth(&self, id: usize, path: &[u32], ancestors: bool) -> usize {
        self.rules[id]
            .entries
            .iter()
            .filter_map(|(depth, scope)| scope.path_covers(path, ancestors).then_some(*depth))
            .max()
            .unwrap_or(0)
    }

    pub fn rule_reach(&self, id: usize, subject: &Subject) -> Option<usize> {
        let rule = &self.rules[id];
        if rule.value.paths.is_empty() {
            return Some(0);
        }
        let path = &subject.path.as_ref()?.virtual_path;
        if let Some(depth) = rule.scope.hide_depth(path) {
            return Some(depth);
        }
        (subject.holds && rule.scope.path_covers(path, subject.ancestors))
            .then(|| self.covers_depth(id, path, subject.ancestors))
    }

    fn winner(&self, mut reach: impl FnMut(usize) -> Option<usize>) -> Option<(usize, usize)> {
        let mut chosen: Option<(usize, usize)> = None;
        for id in 0..self.rules.len() {
            let Some(depth) = reach(id) else {
                continue;
            };
            if chosen.is_none_or(|(_, best)| depth > best) {
                chosen = Some((id, depth));
            }
        }
        chosen
    }

    pub fn decide(&self, facts: &CommandFacts) -> Ruling {
        let line = Line::of(facts);
        if !self.line_allowed(&line, facts.tool) {
            return Ruling {
                outcome: Outcome::Deny,
                allow_list: true,
                matched: Some(Matched {
                    command: line.path(),
                    flags: Vec::new(),
                }),
                ..Ruling::default()
            };
        }
        let live: Vec<bool> = (0..self.rules.len())
            .map(|id| self.rule_applies(id, &line, facts))
            .collect();
        let mut chosen = Ruling::default();
        let mut best: Option<(Outcome, usize)> = None;
        let mut asks = Vec::new();
        for subject in subjects(facts) {
            let Some((id, depth)) =
                self.winner(|id| live[id].then(|| self.rule_reach(id, &subject)).flatten())
            else {
                continue;
            };
            let outcome = self.outcome(id);
            if outcome == Outcome::Ask && !asks.contains(&id) {
                asks.push(id);
            }
            if best.is_some_and(|(verb, best_depth)| {
                (verb as u32) < outcome as u32 || (verb == outcome && best_depth >= depth)
            }) {
                continue;
            }
            best = Some((outcome, depth));
            chosen = Ruling {
                outcome,
                rule: Some(id),
                matched_path: if self.rules[id].value.paths.is_empty() {
                    None
                } else {
                    subject.path.map(|p| p.display_path)
                },
                ..Ruling::default()
            };
        }
        if chosen.outcome == Outcome::Ask {
            chosen.asks = asks;
        }
        if let Some(id) = chosen.rule {
            chosen.matched = self.rules[id]
                .patterns
                .iter()
                .find(|p| p.fits(&line))
                .map(|p| p.matched(&line));
        }
        chosen
    }

    fn match_io(&self, id: usize, path: &[u32], subtree: bool) -> bool {
        let rule = &self.rules[id];
        if rule.value.paths.is_empty() {
            let mount = rule.value.mount.as_deref().unwrap_or_default();
            return !mount.is_empty() && (under(path, mount) || (subtree && under(mount, path)));
        }
        if subtree {
            rule.scope.hides_intersect(path)
        } else {
            rule.scope.hide_depth(path).is_some()
        }
    }

    /// Whether a rule naming the line (`naming`) could reach an entry at
    /// or under this path. `named` holds rule ids under `rule_count`.
    pub fn io_reach(&self, named: &[usize], path: &[u32]) -> bool {
        named.iter().any(|&id| self.match_io(id, path, true))
    }

    fn ungranted(
        &self,
        winner: Option<(usize, usize)>,
        granted: &[usize],
    ) -> Option<(usize, bool)> {
        let (id, _) = winner?;
        let asks = self.outcome(id) == Outcome::Ask;
        (!asks || !granted.contains(&id)).then_some((id, asks))
    }

    /// The rule that refuses an entry for a line, among those naming it
    /// (`naming`). `named` holds rule ids under `rule_count`.
    pub fn io_refusal(&self, named: &[usize], path: &[u32], granted: &[usize]) -> Option<usize> {
        let named = self.named(named);
        self.ungranted(
            self.winner(|id| {
                (named[id] && self.match_io(id, path, false)).then(|| self.hidden_depth(id, path))
            }),
            granted,
        )
        .map(|(id, _)| id)
    }

    pub fn posix_level(&self, id: usize) -> bool {
        let rule = &self.rules[id].value;
        rule.commands.is_empty() && !rule.paths.is_empty()
    }

    pub fn op_reach(&self, id: usize, subtree: bool, path: &[u32]) -> Option<usize> {
        if !self.posix_level(id) {
            return None;
        }
        let rule = &self.rules[id];
        if let Some(depth) = rule.scope.hide_depth(path) {
            return Some(depth);
        }
        if subtree && rule.scope.path_covers(path, true) {
            return Some(self.covers_depth(id, path, true));
        }
        None
    }

    pub fn op_ruling(
        &self,
        subtree: bool,
        path: &[u32],
        granted: &[usize],
    ) -> Option<(usize, bool)> {
        self.ungranted(self.winner(|id| self.op_reach(id, subtree, path)), granted)
    }

    pub fn rule_count(&self) -> usize {
        self.rules.len()
    }
}

fn destination(facts: &CommandFacts) -> Option<&PathFact> {
    (facts.moves && facts.operands.len() >= 2 && facts.move_target.is_none())
        .then(|| facts.operands.last())
        .flatten()
}

pub fn subjects(facts: &CommandFacts) -> Vec<Subject> {
    if facts.paths.is_empty() {
        return vec![Subject::default()];
    }
    let mut subjects: Vec<Subject> = facts
        .paths
        .iter()
        .cloned()
        .map(|path| Subject {
            path: Some(path),
            ..Subject::default()
        })
        .collect();
    if facts.subtree {
        let dst = destination(facts);
        let count = facts.operands.len() - usize::from(dst.is_some());
        subjects.extend(facts.operands[..count].iter().cloned().map(|path| Subject {
            path: Some(path),
            holds: true,
            ancestors: true,
        }));
        if let Some(path) = dst {
            subjects.push(Subject {
                path: Some(path.clone()),
                holds: true,
                ancestors: false,
            });
        }
    }
    subjects
}

pub(crate) fn under(path: &[u32], root: &[u32]) -> bool {
    root == [47] || path == root || (path.starts_with(root) && path.get(root.len()) == Some(&47))
}

fn basename(path: &[u32]) -> &[u32] {
    let end = path
        .iter()
        .rposition(|&unit| unit != 47)
        .map_or(0, |at| at + 1);
    let value = &path[..end];
    value.rsplit(|&unit| unit == 47).next().unwrap_or_default()
}

pub(crate) fn touches(mount: &[u32], facts: &CommandFacts) -> bool {
    if under(&facts.cwd, mount) || facts.paths.iter().any(|p| under(&p.virtual_path, mount)) {
        return true;
    }
    if facts.walks {
        return facts.paths.iter().any(|p| under(mount, &p.virtual_path));
    }
    if !facts.subtree {
        return false;
    }
    let mut targets: Vec<&[u32]> = facts.move_target.as_deref().into_iter().collect();
    if let Some(dst) = destination(facts) {
        let name = basename(&dst.virtual_path);
        if facts.operands[..facts.operands.len() - 1]
            .iter()
            .all(|p| basename(&p.virtual_path) != name)
        {
            targets.extend(
                facts
                    .paths
                    .iter()
                    .filter(|p| basename(&p.virtual_path) == name)
                    .map(|p| p.virtual_path.as_slice()),
            );
        }
        targets.push(&dst.virtual_path);
    }
    facts
        .paths
        .iter()
        .any(|p| !targets.contains(&p.virtual_path.as_slice()) && under(mount, &p.virtual_path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::FlagFact;
    use serde_json::Value;

    fn text(value: &str) -> Text {
        value.chars().map(u32::from).collect()
    }
    fn strings(value: &Value) -> Vec<Text> {
        value
            .as_array()
            .map(|values| {
                values
                    .iter()
                    .map(|value| text(value.as_str().unwrap()))
                    .collect()
            })
            .unwrap_or_default()
    }
    fn rule(value: &Value) -> Rule {
        Rule {
            reason: text(value["reason"].as_str().unwrap()),
            commands: strings(&value["commands"]),
            paths: strings(&value["paths"]),
            mount: value["mount"].as_str().map(text),
        }
    }
    fn reading(value: &Value) -> Option<Reading> {
        if value.is_null() {
            return None;
        }
        Some(Reading {
            path: strings(&value["path"]),
            flags: value["flags"]
                .as_array()
                .map(|flags| {
                    flags
                        .iter()
                        .map(|flag| FlagFact {
                            name: text(flag["name"].as_str().unwrap()),
                            values: strings(&flag["values"]),
                        })
                        .collect()
                })
                .unwrap_or_default(),
            operands: strings(&value["operands"]),
        })
    }
    fn reads(value: &Value) -> Vec<PatternRead> {
        value
            .as_array()
            .map(|reads| {
                reads
                    .iter()
                    .map(|entry| PatternRead {
                        pattern: text(entry["pattern"].as_str().unwrap()),
                        read: reading(&entry["read"]),
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
    fn allow(value: &Value) -> AllowEntry {
        match value.as_str() {
            Some(pattern) => AllowEntry::Pattern(text(pattern)),
            None => AllowEntry::Only {
                command: text(value["command"].as_str().unwrap()),
                flags: strings(&value["flags"]),
            },
        }
    }
    fn path(value: Text) -> PathFact {
        PathFact {
            virtual_path: value.clone(),
            display_path: value,
        }
    }

    #[test]
    fn frozen_admission_corpus() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../../../integ/policy/matching.json")).unwrap();
        for case in corpus["admissions"].as_array().unwrap() {
            let rules = &case["rules"];
            let matcher = AdmissionMatcher::new(
                Rules {
                    allow: rules["allow"]
                        .as_array()
                        .map(|values| values.iter().map(allow).collect()),
                    deny: rules["deny"].as_array().unwrap().iter().map(rule).collect(),
                    ask: rules["ask"].as_array().unwrap().iter().map(rule).collect(),
                },
                Whitespace::Python,
            );
            let facts = &case["facts"];
            let command = facts["command"].as_str().unwrap();
            let result = matcher.decide(&CommandFacts {
                tokens: strings(&facts["tokens"]),
                line: reading(&facts["line"]),
                reads: reads(&facts["reads"]),
                tool: facts["tool"].as_bool().unwrap(),
                cwd: text(facts["cwd"].as_str().unwrap()),
                paths: strings(&facts["paths"]).into_iter().map(path).collect(),
                operands: strings(&facts["operands"]).into_iter().map(path).collect(),
                walks: facts["walks"].as_bool().unwrap(),
                subtree: facts["subtree"].as_bool().unwrap(),
                moves: command == "mv",
                move_target: None,
            });
            let expected = &case["expected"];
            let outcome = match expected["outcome"].as_str().unwrap() {
                "deny" => Outcome::Deny,
                "ask" => Outcome::Ask,
                _ => Outcome::Allow,
            };
            assert_eq!(result.outcome, outcome, "{}", case["name"]);
            assert_eq!(
                result.rule,
                expected["rule"].as_u64().map(|id| id as usize),
                "{}",
                case["name"]
            );
            assert_eq!(
                result.matched_path,
                expected["matched_path"].as_str().map(text),
                "{}",
                case["name"]
            );
            assert_eq!(
                result.asks,
                expected["asks"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|id| id.as_u64().unwrap() as usize)
                    .collect::<Vec<_>>(),
                "{}",
                case["name"]
            );
        }
    }

    fn flag(name: &str, values: &[&str]) -> FlagFact {
        FlagFact {
            name: text(name),
            values: values.iter().map(|v| text(v)).collect(),
        }
    }
    fn read(path: &[&str], flags: Vec<FlagFact>, operands: &[&str]) -> Reading {
        Reading {
            path: path.iter().map(|w| text(w)).collect(),
            flags,
            operands: operands.iter().map(|w| text(w)).collect(),
        }
    }
    fn facts(tokens: &[&str], line: Reading, reads: Vec<(&str, Option<Reading>)>) -> CommandFacts {
        CommandFacts {
            tokens: tokens.iter().map(|w| text(w)).collect(),
            line: Some(line),
            reads: reads
                .into_iter()
                .map(|(pattern, read)| PatternRead {
                    pattern: text(pattern),
                    read,
                })
                .collect(),
            ..CommandFacts::default()
        }
    }
    fn deny(patterns: &[&str]) -> AdmissionMatcher {
        AdmissionMatcher::new(
            Rules {
                deny: vec![Rule {
                    commands: patterns.iter().map(|p| text(p)).collect(),
                    ..Rule::default()
                }],
                ..Rules::default()
            },
            Whitespace::Python,
        )
    }

    #[test]
    fn a_read_pattern_matches_its_flags_in_any_spelling_and_order() {
        let matcher = deny(&["rm -rf"]);
        let rf = read(
            &["rm"],
            vec![flag("--recursive", &[]), flag("--force", &[])],
            &[],
        );
        let line = |flags: Vec<FlagFact>| {
            facts(
                &["rm", "-fr", "/a"],
                read(&["rm"], flags, &["/a"]),
                vec![("rm -rf", Some(rf.clone()))],
            )
        };
        let both = line(vec![flag("--force", &[]), flag("--recursive", &[])]);
        let ruling = matcher.decide(&both);
        assert_eq!(ruling.outcome, Outcome::Deny);
        assert_eq!(
            ruling.matched,
            Some(Matched {
                command: vec![text("rm")],
                flags: vec![text("--recursive"), text("--force")],
            })
        );
        assert_eq!(
            matcher
                .decide(&line(vec![flag("--recursive", &[])]))
                .outcome,
            Outcome::Allow
        );
    }

    #[test]
    fn a_value_matches_exactly_and_a_bare_option_any_value() {
        let matcher = deny(&["head -n 1", "gh pr list --state"]);
        let head = |value: &str| {
            facts(
                &["head"],
                read(&["head"], vec![flag("--lines", &[value])], &[]),
                vec![(
                    "head -n 1",
                    Some(read(&["head"], vec![flag("--lines", &["1"])], &[])),
                )],
            )
        };
        assert_eq!(matcher.decide(&head("1")).outcome, Outcome::Deny);
        assert_eq!(matcher.decide(&head("2")).outcome, Outcome::Allow);
        let gh = facts(
            &["gh", "pr", "list"],
            read(&["gh", "pr", "list"], vec![flag("--state", &["open"])], &[]),
            vec![(
                "gh pr list --state",
                Some(read(&["gh", "pr", "list"], vec![flag("--state", &[])], &[])),
            )],
        );
        assert_eq!(matcher.decide(&gh).outcome, Outcome::Deny);
    }

    #[test]
    fn an_unreadable_pattern_never_matches_and_an_unread_one_is_literal() {
        let matcher = deny(&["git * --force"]);
        let log = facts(
            &["git", "log"],
            read(&["git", "log"], vec![], &[]),
            vec![("git * --force", None)],
        );
        assert_eq!(matcher.decide(&log).outcome, Outcome::Allow);
        let literal = CommandFacts {
            tokens: vec![text("git"), text("x"), text("--force")],
            ..CommandFacts::default()
        };
        assert_eq!(matcher.decide(&literal).outcome, Outcome::Deny);
    }

    #[test]
    fn an_entry_naming_a_command_closes_it_and_star_admits_the_rest() {
        let matcher = AdmissionMatcher::new(
            Rules {
                allow: Some(vec![
                    text("*").into(),
                    text("gh pr {view,diff}").into(),
                    AllowEntry::Only {
                        command: text("rm"),
                        flags: vec![text("-f"), text("-v")],
                    },
                ]),
                ..Rules::default()
            },
            Whitespace::Python,
        );
        let words = |line: &[&str]| line.iter().map(|w| text(w)).collect::<Vec<_>>();
        assert!(matcher.line_allowed(&Line::words(&words(&["cat", "/a"])), true));
        assert!(matcher.line_allowed(&Line::words(&words(&["gh", "pr", "diff", "5"])), true));
        assert!(!matcher.line_allowed(&Line::words(&words(&["gh", "pr", "merge", "5"])), true));
        let rm = |flags: Vec<FlagFact>| {
            facts(
                &["rm"],
                read(&["rm"], flags, &["/a"]),
                vec![(
                    "rm -f -v",
                    Some(read(
                        &["rm"],
                        vec![flag("--force", &[]), flag("--verbose", &[])],
                        &[],
                    )),
                )],
            )
        };
        let forced = rm(vec![flag("--force", &[])]);
        assert!(matcher.line_allowed(&Line::of(&forced), true));
        let recursive = rm(vec![flag("--force", &[]), flag("--recursive", &[])]);
        assert!(!matcher.line_allowed(&Line::of(&recursive), true));
        assert_eq!(
            matcher.decide(&recursive).matched,
            Some(Matched {
                command: vec![text("rm")],
                flags: vec![],
            })
        );
        assert!(matcher.line_allowed(&Line::words(&words(&["rm", "-f", "/a"])), true));
        assert!(!matcher.line_allowed(&Line::words(&words(&["rm", "-r", "/a"])), true));
    }

    #[test]
    fn grant_only_satisfies_the_winning_ask() {
        let matcher = AdmissionMatcher::new(
            Rules {
                deny: vec![Rule {
                    paths: vec![text("/repo/*")],
                    ..Rule::default()
                }],
                ask: vec![Rule {
                    paths: vec![text("/repo/outbox/*")],
                    ..Rule::default()
                }],
                ..Rules::default()
            },
            Whitespace::Python,
        );
        assert_eq!(
            matcher.op_ruling(false, &text("/repo/outbox/x"), &[]),
            Some((1, true))
        );
        assert_eq!(
            matcher.op_ruling(false, &text("/repo/outbox/x"), &[1]),
            None
        );
        assert_eq!(
            matcher.op_ruling(false, &text("/repo/sealed"), &[1]),
            Some((0, false))
        );
        assert_eq!(matcher.op_ruling(false, &text("/repo"), &[]), None);
        assert_eq!(
            matcher.op_ruling(true, &text("/repo"), &[]),
            Some((1, true))
        );
        assert_eq!(
            matcher.io_refusal(
                &matcher.naming(&Line::words(&[text("cp")])),
                &text("/repo/outbox/x"),
                &[1]
            ),
            None
        );
    }
}
