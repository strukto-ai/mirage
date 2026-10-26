use super::pattern::prefix_matches;
use super::{
    CommandFacts, Outcome, PathFact, Rule, Rules, Ruling, Subject, Text, Visibility,
    VisibilityMatcher, Whitespace, anchor_depth, classify_paths, split_pattern,
};

struct CompiledRule {
    value: Rule,
    patterns: Vec<Vec<Text>>,
    scope: VisibilityMatcher,
    entries: Vec<(usize, VisibilityMatcher)>,
}

impl CompiledRule {
    fn new(value: Rule, whitespace: Whitespace) -> Self {
        let patterns = value
            .commands
            .iter()
            .map(|p| split_pattern(p, whitespace))
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

    fn names(&self, tokens: &[Text]) -> bool {
        self.patterns.is_empty()
            || self
                .patterns
                .iter()
                .any(|p| p.len() <= tokens.len() && prefix_matches(p, tokens))
    }
}

fn scope(entries: &[Text]) -> VisibilityMatcher {
    VisibilityMatcher::new(Visibility {
        hidden: classify_paths(entries),
        ..Visibility::default()
    })
}

pub struct AdmissionMatcher {
    allow: Option<Vec<Vec<Text>>>,
    rules: Vec<CompiledRule>,
    denies: usize,
}

impl AdmissionMatcher {
    pub fn new(rules: Rules, whitespace: Whitespace) -> Self {
        let allow = rules.allow.map(|patterns| {
            patterns
                .iter()
                .map(|p| split_pattern(p, whitespace))
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
        self.allow
            .as_ref()
            .is_none_or(|patterns| patterns.iter().any(|p| prefix_matches(p, &[name.to_vec()])))
    }

    pub fn line_allowed(&self, tokens: &[Text], tool: bool) -> bool {
        !tool
            || self.allow.as_ref().is_none_or(|patterns| {
                patterns
                    .iter()
                    .any(|p| p.len() <= tokens.len() && prefix_matches(p, tokens))
            })
    }

    pub fn has_rules(&self) -> bool {
        self.allow.is_some() || !self.rules.is_empty()
    }

    pub fn reads_args(&self, name: &[u32]) -> bool {
        let head = [name.to_vec()];
        self.allow.as_ref().is_some_and(|patterns| {
            patterns
                .iter()
                .any(|p| p.len() > 1 && prefix_matches(p, &head))
        }) || self.rules.iter().any(|rule| {
            let mount = rule.value.mount.as_deref().unwrap_or_default();
            let names =
                rule.patterns.is_empty() || rule.patterns.iter().any(|p| prefix_matches(p, &head));
            names
                && (!rule.value.paths.is_empty()
                    || !mount.is_empty()
                    || rule
                        .patterns
                        .iter()
                        .any(|p| p.len() > 1 && prefix_matches(p, &head)))
        })
    }

    pub fn scopes_paths(&self, name: &[u32]) -> bool {
        let head = [name.to_vec()];
        self.rules.iter().any(|rule| {
            let mount = rule.value.mount.as_deref().unwrap_or_default();
            (!rule.value.paths.is_empty() || !mount.is_empty())
                && (rule.patterns.is_empty()
                    || rule.patterns.iter().any(|p| prefix_matches(p, &head)))
        })
    }

    pub fn rule_applies(&self, id: usize, facts: &CommandFacts) -> bool {
        let rule = &self.rules[id];
        let mount = rule.value.mount.as_deref().unwrap_or_default();
        rule.names(&facts.tokens) && (mount.is_empty() || touches(mount, facts))
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
        if !self.line_allowed(&facts.tokens, facts.tool) {
            return Ruling {
                outcome: Outcome::Deny,
                allow_list: true,
                ..Ruling::default()
            };
        }
        let live: Vec<bool> = (0..self.rules.len())
            .map(|id| self.rule_applies(id, facts))
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
        chosen
    }

    pub fn match_io(&self, id: usize, tokens: &[Text], path: &[u32], subtree: bool) -> bool {
        let rule = &self.rules[id];
        if !rule.names(tokens) {
            return false;
        }
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

    pub fn io_reach(&self, tokens: &[Text], path: &[u32]) -> bool {
        (0..self.rules.len()).any(|id| self.match_io(id, tokens, path, true))
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

    pub fn io_refusal(&self, tokens: &[Text], path: &[u32], granted: &[usize]) -> Option<usize> {
        self.ungranted(
            self.winner(|id| {
                self.match_io(id, tokens, path, false)
                    .then(|| self.hidden_depth(id, path))
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

fn under(path: &[u32], root: &[u32]) -> bool {
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

fn touches(mount: &[u32], facts: &CommandFacts) -> bool {
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
                    allow: rules["allow"].as_array().map(|_| strings(&rules["allow"])),
                    deny: rules["deny"].as_array().unwrap().iter().map(rule).collect(),
                    ask: rules["ask"].as_array().unwrap().iter().map(rule).collect(),
                },
                Whitespace::Python,
            );
            let facts = &case["facts"];
            let command = facts["command"].as_str().unwrap();
            let result = matcher.decide(&CommandFacts {
                tokens: strings(&facts["tokens"]),
                tool: facts["tool"].as_bool().unwrap(),
                cwd: text(facts["cwd"].as_str().unwrap()),
                paths: strings(&facts["paths"]).into_iter().map(path).collect(),
                operands: strings(&facts["operands"]).into_iter().map(path).collect(),
                walks: facts["walks"].as_bool().unwrap(),
                subtree: matches!(command, "rm" | "rmdir" | "mv"),
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
            matcher.io_refusal(&[text("cp")], &text("/repo/outbox/x"), &[1]),
            None
        );
    }
}
