use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::{FlagFact, Matched, Outcome, Text};
use crate::glob::CompiledGlob;

const STAR: u32 = 42;

/// One decision a profile writes at a node, an option or a value.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct Leaf {
    pub decision: Outcome,
    pub reason: Text,
    pub paths: Vec<Text>,
}

/// A word map as the host sends it: each word or glob with its target,
/// `*` among them as the fallback for a word nothing else names.
pub type Words<T> = Vec<(Text, T)>;

/// A value of an option: its decisions, and the options that must also
/// be on the line for the decisions under them.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct ValueRule {
    pub decision: Vec<usize>,
    pub options: Vec<(Text, OptionRule)>,
}

/// An option entry, by the option's canonical name.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct OptionRule {
    pub decision: Vec<usize>,
    pub values: Words<ValueRule>,
    pub options: Vec<(Text, OptionRule)>,
}

/// A command or subcommand, by canonical name; the root holds commands.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct Node {
    pub decision: Vec<usize>,
    pub subcommands: Vec<(Text, Node)>,
    pub options: Vec<(Text, OptionRule)>,
    pub other_options: Vec<usize>,
    pub operands: Words<Node>,
}

/// A profile's command tree with its decisions in one table, which a
/// ruling names by index.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct Tree {
    pub root: Node,
    pub leaves: Vec<Leaf>,
}

/// What the tree reads a line by: its command and canonical subcommand
/// path, its options by canonical name, and its operands. A command with
/// no grammar gives its name as the path and every later word as an
/// operand.
pub struct Line<'a> {
    pub path: &'a [Text],
    pub flags: &'a [FlagFact],
    pub operands: &'a [Text],
}

/// The tree's answer for one line.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Verdict {
    pub outcome: Outcome,
    pub leaf: Option<usize>,
    pub asks: Vec<usize>,
    pub matched: Option<Matched>,
}

pub fn rank(outcome: Outcome) -> u8 {
    match outcome {
        Outcome::Allow => 0,
        Outcome::Ask => 1,
        Outcome::Deny => 2,
    }
}

struct WordMap<T> {
    exact: HashMap<Text, usize>,
    globs: Vec<(CompiledGlob, usize)>,
    fallback: Option<usize>,
    targets: Vec<T>,
}

impl<T> WordMap<T> {
    fn new<W>(words: &[(Text, W)], compile: impl Fn(&W) -> T) -> Option<Self> {
        if words.is_empty() {
            return None;
        }
        let mut map = Self {
            exact: HashMap::new(),
            globs: Vec::new(),
            fallback: None,
            targets: Vec::new(),
        };
        for (word, target) in words {
            let at = map.targets.len();
            map.targets.push(compile(target));
            if word.as_slice() == [STAR] {
                map.fallback = Some(at);
                continue;
            }
            map.exact.insert(word.clone(), at);
            if word
                .iter()
                .any(|&unit| matches!(char::from_u32(unit), Some('*' | '?' | '[')))
            {
                map.globs.push((CompiledGlob::new(word.clone()), at));
            }
        }
        Some(map)
    }

    /// The targets a word reaches: its exact key, else every other glob
    /// that matches it, else the bare `*`.
    fn find(&self, word: &[u32]) -> Vec<&T> {
        if let Some(&at) = self.exact.get(word) {
            return vec![&self.targets[at]];
        }
        let globs: Vec<&T> = self
            .globs
            .iter()
            .filter(|(glob, _)| glob.matches(word))
            .map(|&(_, at)| &self.targets[at])
            .collect();
        if !globs.is_empty() {
            return globs;
        }
        self.fallback
            .map(|at| &self.targets[at])
            .into_iter()
            .collect()
    }
}

struct CompiledValue {
    decision: Vec<usize>,
    options: Vec<(Text, CompiledOption)>,
}

struct CompiledOption {
    decision: Vec<usize>,
    values: Option<WordMap<CompiledValue>>,
    options: Vec<(Text, CompiledOption)>,
}

struct CompiledNode {
    decision: Vec<usize>,
    subcommands: HashMap<Text, CompiledNode>,
    options: Vec<(Text, CompiledOption)>,
    other_options: Vec<usize>,
    operands: Option<WordMap<CompiledNode>>,
}

fn compile_options(options: &[(Text, OptionRule)]) -> Vec<(Text, CompiledOption)> {
    options
        .iter()
        .map(|(name, rule)| (name.clone(), compile_option(rule)))
        .collect()
}

fn compile_value(rule: &ValueRule) -> CompiledValue {
    CompiledValue {
        decision: rule.decision.clone(),
        options: compile_options(&rule.options),
    }
}

fn compile_option(rule: &OptionRule) -> CompiledOption {
    CompiledOption {
        decision: rule.decision.clone(),
        values: WordMap::new(&rule.values, compile_value),
        options: compile_options(&rule.options),
    }
}

fn compile_node(node: &Node) -> CompiledNode {
    CompiledNode {
        decision: node.decision.clone(),
        subcommands: node
            .subcommands
            .iter()
            .map(|(name, child)| (name.clone(), compile_node(child)))
            .collect(),
        options: compile_options(&node.options),
        other_options: node.other_options.clone(),
        operands: WordMap::new(&node.operands, compile_node),
    }
}

/// One decision that speaks for a line, with what fired it.
struct Voice {
    leaf: usize,
    matched: Matched,
}

/// A node the walk reached and how many path words led to it.
struct Step<'n> {
    node: &'n CompiledNode,
    depth: usize,
}

pub struct CompiledTree {
    root: CompiledNode,
    leaves: Vec<Leaf>,
}

impl CompiledTree {
    pub fn new(tree: &Tree) -> Self {
        Self {
            root: compile_node(&tree.root),
            leaves: tree.leaves.clone(),
        }
    }

    pub fn leaf(&self, id: usize) -> &Leaf {
        &self.leaves[id]
    }

    pub fn leaf_count(&self) -> usize {
        self.leaves.len()
    }

    /// Whether the tree names a command, so a line of it is read by its
    /// node rather than by the root alone.
    pub fn names(&self, name: &[u32]) -> bool {
        self.root.subcommands.contains_key(name)
    }

    /// Judge one line: its words pick the node, options only tighten,
    /// and the strictest decision wins. Where several globs send an
    /// operand down different branches, each branch is judged and the
    /// strictest result wins.
    pub fn judge(&self, line: &Line, applies: &dyn Fn(usize) -> bool) -> Verdict {
        let mut steps = vec![Step {
            node: &self.root,
            depth: 0,
        }];
        let mut node = &self.root;
        for (at, word) in line.path.iter().enumerate() {
            let Some(child) = node.subcommands.get(word) else {
                break;
            };
            node = child;
            steps.push(Step {
                node,
                depth: at + 1,
            });
        }
        let mut voices = Vec::new();
        if steps.len() - 1 == line.path.len() {
            self.operands(line, 0, &mut steps, applies, &mut voices);
        } else {
            voices.push(self.voices(line, &steps, applies));
        }
        self.verdict(voices.into_iter().flatten().collect())
    }

    fn operands<'n>(
        &'n self,
        line: &Line,
        at: usize,
        steps: &mut Vec<Step<'n>>,
        applies: &dyn Fn(usize) -> bool,
        out: &mut Vec<Vec<Voice>>,
    ) {
        let last = steps.last().expect("the walk holds the root");
        let depth = last.depth;
        let hits = match (&last.node.operands, line.operands.get(at)) {
            (Some(map), Some(word)) => map.find(word),
            _ => Vec::new(),
        };
        if hits.is_empty() {
            out.push(self.voices(line, steps, applies));
            return;
        }
        for hit in hits {
            steps.push(Step { node: hit, depth });
            self.operands(line, at + 1, steps, applies, out);
            steps.pop();
        }
    }

    fn command(line: &Line, depth: usize) -> Vec<Text> {
        if depth == 0 {
            line.path.to_vec()
        } else {
            line.path[..depth].to_vec()
        }
    }

    fn voices(&self, line: &Line, steps: &[Step], applies: &dyn Fn(usize) -> bool) -> Vec<Voice> {
        let speaking = |ids: &[usize]| -> Vec<usize> {
            ids.iter().copied().filter(|&id| applies(id)).collect()
        };
        let mut voices = Vec::new();
        if let Some((step, ids)) = steps
            .iter()
            .rev()
            .map(|step| (step, speaking(&step.node.decision)))
            .find(|(_, ids)| !ids.is_empty())
        {
            for leaf in ids {
                voices.push(Voice {
                    leaf,
                    matched: Matched {
                        command: Self::command(line, step.depth),
                        flags: Vec::new(),
                    },
                });
            }
        }
        let mut entries: Vec<(&Text, &CompiledOption, usize)> = Vec::new();
        for step in steps {
            for (name, rule) in &step.node.options {
                if !carries(line, name) {
                    continue;
                }
                match entries.iter_mut().find(|(seen, _, _)| *seen == name) {
                    Some(entry) => *entry = (name, rule, step.depth),
                    None => entries.push((name, rule, step.depth)),
                }
            }
        }
        for (name, rule, depth) in entries {
            self.option(
                line,
                rule,
                vec![name.clone()],
                depth,
                &speaking,
                &mut voices,
            );
        }
        let named: Vec<&Text> = steps
            .iter()
            .flat_map(|step| step.node.options.iter().map(|(name, _)| name))
            .collect();
        let unnamed: Vec<Text> = line
            .flags
            .iter()
            .map(|flag| &flag.name)
            .filter(|name| !named.contains(name))
            .fold(Vec::new(), |mut out, name| {
                if !out.contains(name) {
                    out.push(name.clone());
                }
                out
            });
        if !unnamed.is_empty() {
            for step in steps {
                for leaf in speaking(&step.node.other_options) {
                    voices.push(Voice {
                        leaf,
                        matched: Matched {
                            command: Self::command(line, step.depth),
                            flags: unnamed.clone(),
                        },
                    });
                }
            }
        }
        voices
    }

    fn option(
        &self,
        line: &Line,
        rule: &CompiledOption,
        chain: Vec<Text>,
        depth: usize,
        speaking: &dyn Fn(&[usize]) -> Vec<usize>,
        voices: &mut Vec<Voice>,
    ) {
        let name = chain.last().expect("an option entry names its option");
        let mut decided = Vec::new();
        let mut nested: Vec<(&Text, &CompiledOption)> = Vec::new();
        if let Some(values) = &rule.values {
            for value in values_of(line, name) {
                for hit in values.find(value) {
                    decided.extend(speaking(&hit.decision));
                    nested.extend(hit.options.iter().map(|(n, o)| (n, o)));
                }
            }
        }
        if decided.is_empty() {
            decided = speaking(&rule.decision);
        }
        for leaf in decided {
            voices.push(Voice {
                leaf,
                matched: Matched {
                    command: Self::command(line, depth),
                    flags: chain.clone(),
                },
            });
        }
        nested.extend(rule.options.iter().map(|(n, o)| (n, o)));
        for (inner, rule) in nested {
            if carries(line, inner) {
                let mut chain = chain.clone();
                chain.push(inner.clone());
                self.option(line, rule, chain, depth, speaking, voices);
            }
        }
    }

    fn verdict(&self, voices: Vec<Voice>) -> Verdict {
        let mut best: Option<&Voice> = None;
        for voice in &voices {
            let outcome = self.leaves[voice.leaf].decision;
            if best.is_none_or(|b| rank(outcome) > rank(self.leaves[b.leaf].decision)) {
                best = Some(voice);
            }
        }
        let Some(best) = best else {
            return Verdict::default();
        };
        let outcome = self.leaves[best.leaf].decision;
        let mut asks = Vec::new();
        if outcome == Outcome::Ask {
            for voice in &voices {
                if self.leaves[voice.leaf].decision == Outcome::Ask && !asks.contains(&voice.leaf) {
                    asks.push(voice.leaf);
                }
            }
        }
        Verdict {
            outcome,
            leaf: Some(best.leaf),
            asks,
            matched: (outcome != Outcome::Allow).then(|| best.matched.clone()),
        }
    }
}

fn carries(line: &Line, name: &[u32]) -> bool {
    line.flags.iter().any(|flag| flag.name == name)
}

fn values_of<'a>(line: &'a Line, name: &[u32]) -> impl Iterator<Item = &'a Text> {
    line.flags
        .iter()
        .filter(move |flag| flag.name == name)
        .flat_map(|flag| flag.values.iter())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text(value: &str) -> Text {
        value.chars().map(u32::from).collect()
    }

    /// A line as its grammar reads it: the path, then options by canonical
    /// name (`--lines=5` for a value), then operands.
    fn read(
        path: &str,
        flags: &[&str],
        operands: &[&str],
    ) -> (Vec<Text>, Vec<FlagFact>, Vec<Text>) {
        let flags = flags
            .iter()
            .map(|flag| match flag.split_once('=') {
                Some((name, value)) => FlagFact {
                    name: text(name),
                    values: vec![text(value)],
                },
                None => FlagFact {
                    name: text(flag),
                    values: Vec::new(),
                },
            })
            .collect();
        (
            path.split(' ').map(text).collect(),
            flags,
            operands.iter().map(|w| text(w)).collect(),
        )
    }

    fn judge(tree: &serde_json::Value, path: &str, flags: &[&str], operands: &[&str]) -> Verdict {
        let tree = CompiledTree::new(&crate::document::tree_of(tree).unwrap());
        let (path, flags, operands) = read(path, flags, operands);
        tree.judge(
            &Line {
                path: &path,
                flags: &flags,
                operands: &operands,
            },
            &|id| tree.leaf(id).paths.is_empty(),
        )
    }

    fn outcome(tree: &serde_json::Value, path: &str, flags: &[&str], operands: &[&str]) -> Outcome {
        judge(tree, path, flags, operands).outcome
    }

    use Outcome::{Allow, Ask, Deny};

    #[test]
    fn words_pick_the_node_and_a_deeper_node_wins() {
        let tree = json!({"gh": {"*": "deny", "pr": {"view": "allow"}}});
        assert_eq!(outcome(&tree, "gh pr view", &[], &["5"]), Allow);
        assert_eq!(outcome(&tree, "gh pr list", &[], &[]), Deny);
        assert_eq!(outcome(&tree, "gh", &[], &[]), Deny);
        assert_eq!(outcome(&tree, "gh issue list", &[], &[]), Deny);
        assert_eq!(outcome(&tree, "ls", &[], &["/data"]), Allow);
        let closed = json!({"*": "deny", "ls": "allow", "cat": "allow"});
        assert_eq!(outcome(&closed, "ls", &[], &["/data"]), Allow);
        assert_eq!(outcome(&closed, "rm", &[], &["x"]), Deny);
    }

    #[test]
    fn options_only_tighten() {
        let merge = json!({"gh": {"pr": {"merge": {"*": "allow", "--admin": "deny"}}}});
        assert_eq!(outcome(&merge, "gh pr merge", &["--admin"], &["5"]), Deny);
        assert_eq!(outcome(&merge, "gh pr merge", &[], &["5"]), Allow);
        let force = json!({"git": {"--force": "deny", "add": {"--force": "allow"}}});
        assert_eq!(outcome(&force, "git rm", &["--force"], &["x"]), Deny);
        assert_eq!(outcome(&force, "git add", &["--force"], &["x"]), Allow);
        assert_eq!(outcome(&force, "git rm", &[], &["x"]), Allow);
        let closed = json!({"git": {"rm": {"*": "deny", "--cached": "allow"}}});
        assert_eq!(outcome(&closed, "git rm", &["--cached"], &["x"]), Deny);
        let status = json!({"git": {"status": "deny"}});
        assert_eq!(outcome(&status, "git status", &["-C=/data"], &[]), Deny);
        assert_eq!(outcome(&status, "git log", &[], &[]), Allow);
    }

    #[test]
    fn combinations_values_and_other_options() {
        let rf = json!({"rm": {"--recursive": {"--force": "deny"}}});
        assert_eq!(
            outcome(&rf, "rm", &["--recursive", "--force"], &["x"]),
            Deny
        );
        assert_eq!(
            outcome(&rf, "rm", &["--force", "--recursive"], &["x"]),
            Deny
        );
        assert_eq!(outcome(&rf, "rm", &["--recursive"], &["x"]), Allow);
        assert_eq!(outcome(&rf, "rm", &["--force"], &["x"]), Allow);
        let only = json!({"rm": {"-*": "deny", "--force": "allow", "--verbose": "allow"}});
        assert_eq!(
            outcome(&only, "rm", &["--force", "--verbose"], &["x"]),
            Allow
        );
        assert_eq!(
            outcome(&only, "rm", &["--recursive", "--force"], &["x"]),
            Deny
        );
        assert_eq!(outcome(&only, "rm", &[], &["x"]), Allow);
        let request = json!({"curl": {"--request": {"values": {"DELETE": "deny", "*": "ask"}}}});
        assert_eq!(
            outcome(&request, "curl", &["--request=DELETE"], &["http://h"]),
            Deny
        );
        assert_eq!(
            outcome(&request, "curl", &["--request=PUT"], &["http://h"]),
            Ask
        );
        assert_eq!(outcome(&request, "curl", &[], &["http://h"]), Allow);
        let post = json!({"curl": {"--request": {"values": {"POST": {"--insecure": "deny"}}}}});
        assert_eq!(
            outcome(
                &post,
                "curl",
                &["--request=POST", "--insecure"],
                &["http://h"]
            ),
            Deny
        );
        assert_eq!(
            outcome(&post, "curl", &["--request=POST"], &["http://h"]),
            Allow
        );
        assert_eq!(
            outcome(&post, "curl", &["--insecure"], &["http://h"]),
            Allow
        );
        let lines = json!({"head": {"--lines": {"values": {"-5": "deny"}}}});
        assert_eq!(outcome(&lines, "head", &["--lines=-5"], &["f"]), Deny);
        assert_eq!(outcome(&lines, "head", &["--lines=5"], &["f"]), Allow);
    }

    #[test]
    fn operands_walk_their_own_map() {
        let checkout =
            json!({"git": {"checkout": {"operands": {"main": "deny", "release/*": "ask"}}}});
        assert_eq!(outcome(&checkout, "git checkout", &[], &["main"]), Deny);
        assert_eq!(
            outcome(&checkout, "git checkout", &[], &["release/2.1"]),
            Ask
        );
        assert_eq!(outcome(&checkout, "git checkout", &[], &["dev"]), Allow);
        let second =
            json!({"gh": {"pr": {"comment": {"operands": {"*": {"operands": {"draft": "ask"}}}}}}});
        assert_eq!(outcome(&second, "gh pr comment", &[], &["9", "draft"]), Ask);
        assert_eq!(
            outcome(&second, "gh pr comment", &[], &["9", "final"]),
            Allow
        );
        let admin = json!({"gh": {"pr": {"merge": {"operands": {"5": {"--admin": "deny"}}}}}});
        assert_eq!(outcome(&admin, "gh pr merge", &["--admin"], &["5"]), Deny);
        assert_eq!(outcome(&admin, "gh pr merge", &[], &["5"]), Allow);
        assert_eq!(outcome(&admin, "gh pr merge", &["--admin"], &["6"]), Allow);
        let opens = json!({"git": {"checkout": {"*": "deny", "operands": {"main": "allow"}}}});
        assert_eq!(outcome(&opens, "git checkout", &[], &["main"]), Allow);
        assert_eq!(outcome(&opens, "git checkout", &[], &["dev"]), Deny);
        let words = json!({
            "rm": {"operands": {"-rf": "deny"}},
            "git": {"add": {"operands": {"[*]": "deny"}}},
            "gh": {"pr": {"view": {"operands": {"decision": "deny"}}}},
        });
        assert_eq!(outcome(&words, "rm", &[], &["-rf"]), Deny);
        assert_eq!(
            outcome(&words, "rm", &["--recursive", "--force"], &["x"]),
            Allow
        );
        assert_eq!(outcome(&words, "git add", &[], &["*"]), Deny);
        assert_eq!(outcome(&words, "git add", &[], &["x"]), Allow);
        assert_eq!(outcome(&words, "gh pr view", &[], &["decision"]), Deny);
        assert_eq!(outcome(&words, "gh pr view", &[], &["5"]), Allow);
        let kubectl = json!({"kubectl": {"operands": {"delete": "deny"}}});
        assert_eq!(
            outcome(&kubectl, "kubectl", &[], &["delete", "pod", "x"]),
            Deny
        );
        assert_eq!(outcome(&kubectl, "kubectl", &[], &["get", "pod"]), Allow);
    }

    #[test]
    fn a_word_takes_its_exact_key_then_globs_then_the_bare_star() {
        let tree = json!({"git": {"checkout": {"operands": {
            "main": "allow", "release/*": "ask", "rel*": "deny", "hotfix/*": "allow", "*": "deny",
        }}}});
        assert_eq!(outcome(&tree, "git checkout", &[], &["main"]), Allow);
        assert_eq!(outcome(&tree, "git checkout", &[], &["release/2.1"]), Deny);
        assert_eq!(outcome(&tree, "git checkout", &[], &["hotfix/9"]), Allow);
        assert_eq!(outcome(&tree, "git checkout", &[], &["dev"]), Deny);
        let exception =
            json!({"git": {"checkout": {"operands": {"release/*": "allow", "*": "deny"}}}});
        assert_eq!(
            outcome(&exception, "git checkout", &[], &["release/2.1"]),
            Allow
        );
        assert_eq!(outcome(&exception, "git checkout", &[], &["dev"]), Deny);
        let star = json!({"git": {"add": {"operands": {"[*]": "allow", "*": "deny"}}}});
        assert_eq!(outcome(&star, "git add", &[], &["*"]), Allow);
        let values =
            json!({"curl": {"--request": {"values": {"GET": "allow", "G*": "ask", "*": "deny"}}}});
        assert_eq!(outcome(&values, "curl", &["--request=GET"], &[]), Allow);
        assert_eq!(outcome(&values, "curl", &["--request=GETX"], &[]), Ask);
        assert_eq!(outcome(&values, "curl", &["--request=PUT"], &[]), Deny);
    }

    #[test]
    fn matching_globs_that_lead_to_subtrees_are_each_judged() {
        let tree = json!({"cp": {"operands": {
            "/data/*": {"operands": {"/tmp/*": "allow"}},
            "/data/keep*": {"operands": {"*": "deny"}},
        }}});
        assert_eq!(outcome(&tree, "cp", &[], &["/data/keep/a", "/tmp/b"]), Deny);
        assert_eq!(outcome(&tree, "cp", &[], &["/data/x", "/tmp/b"]), Allow);
    }

    #[test]
    fn matched_names_the_rule_that_fired_and_asks_collect() {
        let tree = json!({
            "*": "allow",
            "gh": {"*": "deny", "pr": {"merge": {"*": "allow", "--admin": "deny"}}},
            "rm": {"--recursive": {"--force": "deny"}, "-*": "ask"},
            "curl": {"--request": "ask", "--insecure": "ask"},
        });
        let verdict = judge(&tree, "gh pr merge", &["--admin"], &["5"]);
        assert_eq!(verdict.matched.unwrap().flags, [text("--admin")]);
        let verdict = judge(&tree, "gh pr list", &[], &[]);
        assert_eq!(
            verdict.matched,
            Some(Matched {
                command: vec![text("gh")],
                flags: Vec::new()
            })
        );
        let verdict = judge(&tree, "rm", &["--force", "--recursive"], &["x"]);
        assert_eq!(verdict.outcome, Deny);
        assert_eq!(
            verdict.matched.unwrap().flags,
            [text("--recursive"), text("--force")]
        );
        let verdict = judge(&tree, "rm", &["--verbose"], &["x"]);
        assert_eq!(verdict.outcome, Ask);
        assert_eq!(verdict.matched.unwrap().flags, [text("--verbose")]);
        let verdict = judge(&tree, "curl", &["--request=PUT", "--insecure"], &[]);
        assert_eq!(verdict.outcome, Ask);
        assert_eq!(verdict.asks.len(), 2);
        let verdict = judge(&tree, "ls", &[], &[]);
        assert_eq!((verdict.outcome, verdict.matched), (Allow, None));
        let closed = json!({"*": "deny"});
        let verdict = judge(&closed, "gh pr list", &[], &[]);
        assert_eq!(
            verdict.matched.unwrap().command,
            [text("gh"), text("pr"), text("list")]
        );
    }
}
