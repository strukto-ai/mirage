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
    pub decision: Vec<Leaf>,
    pub options: Vec<(Text, OptionRule)>,
}

/// An option entry, by the option's canonical name.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct OptionRule {
    pub decision: Vec<Leaf>,
    pub values: Words<ValueRule>,
    pub options: Vec<(Text, OptionRule)>,
}

/// A command or subcommand, by canonical name; the root holds commands.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct Node {
    pub decision: Vec<Leaf>,
    pub subcommands: Vec<(Text, Node)>,
    pub options: Vec<(Text, OptionRule)>,
    pub other_options: Vec<Leaf>,
    pub operands: Words<Node>,
}

/// A leaf as compiled: the leaf and its place in the commands block, a
/// JSON Pointer over the canonical tree (`/gh/pr/merge/--admin`, a
/// node's own decision at `/rm/*`, an index after a list's place), and
/// the operand and value keys on the way to it (`secret*` for
/// `/echo/operands/secret*/*`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Placed {
    pub leaf: Leaf,
    pub at: Text,
    pub keys: Vec<Text>,
}

/// What the tree reads a line by: its command and canonical subcommand
/// path, its options by canonical name, and its operands. A command with
/// no grammar gives its name as the path and every later word as an
/// operand. `tool` is false for a function the agent defined, which the
/// root default does not judge.
pub struct Line<'a> {
    pub path: &'a [Text],
    pub flags: &'a [FlagFact],
    pub operands: &'a [Text],
    pub tool: bool,
}

/// Decisions that may speak for a line, before any path is known, with
/// what fires them. `first` speaks when any of it applies, else `then`:
/// a value's decisions before its option's own.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct Group {
    pub first: Vec<usize>,
    pub then: Vec<usize>,
    pub command: Vec<Text>,
    pub flags: Vec<Text>,
}

/// One way the line's words walk the tree: the nodes it reached, the
/// deepest one with a decision that applies giving the base, and the
/// option groups that tighten it. Several globs over an operand make
/// several branches.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct Branch {
    pub steps: Vec<Group>,
    pub groups: Vec<Group>,
}

/// The tree's answer for one line, or for one path of it.
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

fn pointer(segments: &[Text]) -> Text {
    let mut out = Vec::new();
    for segment in segments {
        out.push(u32::from(b'/'));
        for &unit in segment {
            match unit {
                126 => out.extend([126, u32::from(b'0')]),
                47 => out.extend([126, u32::from(b'1')]),
                _ => out.push(unit),
            }
        }
    }
    out
}

fn word(value: &str) -> Text {
    value.chars().map(u32::from).collect()
}

struct WordMap<T> {
    exact: HashMap<Text, usize>,
    globs: Vec<(CompiledGlob, usize)>,
    fallback: Option<usize>,
    targets: Vec<T>,
}

impl<T> WordMap<T> {
    fn new<W>(words: &[(Text, W)], mut compile: impl FnMut(&Text, &W) -> T) -> Option<Self> {
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
            map.targets.push(compile(word, target));
            if word.as_slice() == [STAR] {
                map.fallback = Some(at);
                continue;
            }
            if word
                .iter()
                .any(|&unit| matches!(char::from_u32(unit), Some('*' | '?' | '[')))
            {
                map.globs.push((CompiledGlob::new(word.clone()), at));
            } else {
                map.exact.insert(word.clone(), at);
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

/// Flattens a tree's leaves into one table, each with its place.
struct Placing<'t> {
    table: &'t mut Vec<Placed>,
    at: Vec<Text>,
    keys: Vec<Text>,
}

impl Placing<'_> {
    fn within<T>(&mut self, key: &[u32], inner: impl FnOnce(&mut Self) -> T) -> T {
        self.at.push(key.to_vec());
        let out = inner(self);
        self.at.pop();
        out
    }

    fn keyed<T>(&mut self, key: &[u32], inner: impl FnOnce(&mut Self) -> T) -> T {
        self.keys.push(key.to_vec());
        let out = self.within(key, inner);
        self.keys.pop();
        out
    }

    fn leaves(&mut self, leaves: &[Leaf], key: &str) -> Vec<usize> {
        self.within(&word(key), |this| {
            leaves
                .iter()
                .enumerate()
                .map(|(i, leaf)| {
                    let mut at = this.at.clone();
                    if leaves.len() > 1 {
                        at.push(word(&i.to_string()));
                    }
                    this.table.push(Placed {
                        leaf: leaf.clone(),
                        at: pointer(&at),
                        keys: this.keys.clone(),
                    });
                    this.table.len() - 1
                })
                .collect()
        })
    }

    fn options(&mut self, options: &[(Text, OptionRule)]) -> Vec<(Text, CompiledOption)> {
        options
            .iter()
            .map(|(name, rule)| {
                let compiled = self.within(name, |this| this.option(rule));
                (name.clone(), compiled)
            })
            .collect()
    }

    fn option(&mut self, rule: &OptionRule) -> CompiledOption {
        let decision = self.leaves(&rule.decision, "*");
        let values = self.within(&word("values"), |this| {
            WordMap::new(&rule.values, |value, target| {
                this.keyed(value, |this| CompiledValue {
                    decision: this.leaves(&target.decision, "*"),
                    options: this.options(&target.options),
                })
            })
        });
        CompiledOption {
            decision,
            values,
            options: self.options(&rule.options),
        }
    }

    fn node(&mut self, node: &Node) -> CompiledNode {
        let decision = self.leaves(&node.decision, "*");
        let other_options = self.leaves(&node.other_options, "-*");
        let options = self.options(&node.options);
        let subcommands = node
            .subcommands
            .iter()
            .map(|(name, child)| {
                let compiled = self.within(name, |this| this.node(child));
                (name.clone(), compiled)
            })
            .collect();
        let operands = self.within(&word("operands"), |this| {
            WordMap::new(&node.operands, |operand, child| {
                this.keyed(operand, |this| this.node(child))
            })
        });
        CompiledNode {
            decision,
            subcommands,
            options,
            other_options,
            operands,
        }
    }
}

/// A node the walk reached and how many path words led to it.
struct Step<'n> {
    node: &'n CompiledNode,
    depth: usize,
}

pub struct CompiledTree {
    root: CompiledNode,
}

impl CompiledTree {
    /// Compile a tree, placing its leaves at the end of `table`, so the
    /// trees of one profile share one table and a leaf's index names it.
    pub fn new(root: &Node, table: &mut Vec<Placed>) -> Self {
        let mut placing = Placing {
            table,
            at: Vec::new(),
            keys: Vec::new(),
        };
        Self {
            root: placing.node(root),
        }
    }

    /// The node a command's name reaches, if the tree names it.
    fn named(&self, name: &[u32]) -> Option<&CompiledNode> {
        self.root.subcommands.get(name)
    }

    /// Whether the tree says anything about a command: it names it, or
    /// its root default does.
    pub fn speaks_for(&self, name: &[u32]) -> bool {
        self.named(name).is_some() || !self.root.decision.is_empty()
    }

    /// The leaves that decide for a command's bare line: its node's own,
    /// else the root default.
    fn base(&self, name: &[u32]) -> &[usize] {
        match self.named(name) {
            Some(node) if !node.decision.is_empty() => &node.decision,
            _ => &self.root.decision,
        }
    }

    /// Walk a line through the tree once, before any path is known.
    pub fn walk(&self, line: &Line) -> Vec<Branch> {
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
        let mut out = Vec::new();
        if steps.len() - 1 == line.path.len() {
            Self::operands(line, 0, &mut steps, &mut out);
        } else {
            out.push(Self::branch(line, &steps));
        }
        out
    }

    fn operands<'n>(line: &Line, at: usize, steps: &mut Vec<Step<'n>>, out: &mut Vec<Branch>) {
        let last = steps.last().expect("the walk holds the root");
        let depth = last.depth;
        let hits = match (&last.node.operands, line.operands.get(at)) {
            (Some(map), Some(word)) => map.find(word),
            _ => Vec::new(),
        };
        if hits.is_empty() {
            out.push(Self::branch(line, steps));
            return;
        }
        for hit in hits {
            steps.push(Step { node: hit, depth });
            Self::operands(line, at + 1, steps, out);
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

    fn branch(line: &Line, steps: &[Step]) -> Branch {
        let mut branch = Branch::default();
        for (i, step) in steps.iter().enumerate() {
            let exempt = i == 0 && !line.tool;
            branch.steps.push(Group {
                first: if exempt {
                    Vec::new()
                } else {
                    step.node.decision.clone()
                },
                command: Self::command(line, step.depth),
                ..Group::default()
            });
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
            Self::option(line, rule, vec![name.clone()], depth, &mut branch.groups);
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
                if !step.node.other_options.is_empty() {
                    branch.groups.push(Group {
                        first: step.node.other_options.clone(),
                        command: Self::command(line, step.depth),
                        flags: unnamed.clone(),
                        ..Group::default()
                    });
                }
            }
        }
        branch
    }

    fn option(
        line: &Line,
        rule: &CompiledOption,
        chain: Vec<Text>,
        depth: usize,
        groups: &mut Vec<Group>,
    ) {
        let name = chain.last().expect("an option entry names its option");
        let mut first = Vec::new();
        let mut nested: Vec<(&Text, &CompiledOption)> = Vec::new();
        if let Some(values) = &rule.values {
            for value in values_of(line, name) {
                for hit in values.find(value) {
                    first.extend_from_slice(&hit.decision);
                    nested.extend(hit.options.iter().map(|(n, o)| (n, o)));
                }
            }
        }
        groups.push(Group {
            first,
            then: rule.decision.clone(),
            command: Self::command(line, depth),
            flags: chain.clone(),
        });
        nested.extend(rule.options.iter().map(|(n, o)| (n, o)));
        for (inner, rule) in nested {
            if carries(line, inner) {
                let mut chain = chain.clone();
                chain.push(inner.clone());
                Self::option(line, rule, chain, depth, groups);
            }
        }
    }

    /// Whether some line of a command may run under this tree: its node,
    /// or a node below it, holds a decision that is not a deny for every
    /// path. Options only tighten, so they are not asked.
    pub fn may_run(&self, name: &[u32], table: &[Placed]) -> bool {
        fn open(ids: &[usize], table: &[Placed], inherited: bool) -> bool {
            if ids.is_empty() {
                return inherited;
            }
            !ids.iter().any(|&id| {
                let leaf = &table[id].leaf;
                leaf.decision == Outcome::Deny && leaf.paths.is_empty()
            })
        }
        fn below(node: &CompiledNode, table: &[Placed], inherited: bool) -> bool {
            let here = open(&node.decision, table, inherited);
            here || node
                .subcommands
                .values()
                .chain(node.operands.iter().flat_map(|map| map.targets.iter()))
                .any(|child| below(child, table, here))
        }
        let root = open(&self.root.decision, table, true);
        match self.named(name) {
            Some(node) => below(node, table, root),
            None => root,
        }
    }

    /// Whether the tree reads more of a command's line than its name:
    /// its node has subcommands, options or operands, or a decision for
    /// it is scoped to paths.
    pub fn reads_args(&self, name: &[u32], table: &[Placed]) -> bool {
        self.named(name).is_some_and(|node| {
            !node.subcommands.is_empty()
                || !node.options.is_empty()
                || !node.other_options.is_empty()
                || node.operands.is_some()
        }) || self.scopes_paths(name, table)
    }

    /// Whether a decision the tree holds for a command is scoped to
    /// paths, at its node, below it, or in the root default.
    pub fn scopes_paths(&self, name: &[u32], table: &[Placed]) -> bool {
        fn scoped(ids: &[usize], table: &[Placed]) -> bool {
            ids.iter().any(|&id| !table[id].leaf.paths.is_empty())
        }
        fn option(rule: &CompiledOption, table: &[Placed]) -> bool {
            scoped(&rule.decision, table)
                || rule
                    .values
                    .iter()
                    .flat_map(|map| map.targets.iter())
                    .any(|value| {
                        scoped(&value.decision, table)
                            || value.options.iter().any(|(_, o)| option(o, table))
                    })
                || rule.options.iter().any(|(_, o)| option(o, table))
        }
        fn subtree(node: &CompiledNode, table: &[Placed]) -> bool {
            scoped(&node.decision, table)
                || scoped(&node.other_options, table)
                || node.options.iter().any(|(_, o)| option(o, table))
                || node
                    .subcommands
                    .values()
                    .chain(node.operands.iter().flat_map(|map| map.targets.iter()))
                    .any(|child| subtree(child, table))
        }
        scoped(self.base(name), table) || self.named(name).is_some_and(|n| subtree(n, table))
    }
}

/// Judge walked branches with the leaves that apply: in each branch the
/// deepest step holding an applying leaf gives the base, each option
/// group speaks its applying `first`, else its applying `then`, and the
/// strictest voice over every branch wins.
pub fn resolve(branches: &[Branch], table: &[Placed], applies: &dyn Fn(usize) -> bool) -> Verdict {
    let speaking =
        |ids: &[usize]| -> Vec<usize> { ids.iter().copied().filter(|&id| applies(id)).collect() };
    let mut voices: Vec<(usize, &Group)> = Vec::new();
    for branch in branches {
        if let Some((step, ids)) = branch
            .steps
            .iter()
            .rev()
            .map(|step| (step, speaking(&step.first)))
            .find(|(_, ids)| !ids.is_empty())
        {
            voices.extend(ids.into_iter().map(|id| (id, step)));
        }
        for group in &branch.groups {
            let mut ids = speaking(&group.first);
            if ids.is_empty() {
                ids = speaking(&group.then);
            }
            voices.extend(ids.into_iter().map(|id| (id, group)));
        }
    }
    let decision = |id: usize| table[id].leaf.decision;
    let mut best: Option<(usize, &Group)> = None;
    for &(id, group) in &voices {
        if best.is_none_or(|(b, _)| rank(decision(id)) > rank(decision(b))) {
            best = Some((id, group));
        }
    }
    let Some((leaf, group)) = best else {
        return Verdict::default();
    };
    let outcome = decision(leaf);
    let mut asks = Vec::new();
    if outcome == Outcome::Ask {
        for &(id, _) in &voices {
            if decision(id) == Outcome::Ask && !asks.contains(&id) {
                asks.push(id);
            }
        }
    }
    Verdict {
        outcome,
        leaf: Some(leaf),
        asks,
        matched: (outcome != Outcome::Allow).then(|| Matched {
            command: group.command.clone(),
            flags: group.flags.clone(),
            keys: table[leaf].keys.clone(),
        }),
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
        judged(tree, path, flags, operands, true).0
    }

    fn judged(
        tree: &serde_json::Value,
        path: &str,
        flags: &[&str],
        operands: &[&str],
        tool: bool,
    ) -> (Verdict, Vec<Placed>) {
        let mut table = Vec::new();
        let tree = CompiledTree::new(&crate::document::tree_of(tree).unwrap(), &mut table);
        let (path, flags, operands) = read(path, flags, operands);
        let line = Line {
            path: &path,
            flags: &flags,
            operands: &operands,
            tool,
        };
        let verdict = resolve(&tree.walk(&line), &table, &|id| {
            table[id].leaf.paths.is_empty()
        });
        (verdict, table)
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
        assert_eq!(outcome(&star, "git add", &[], &["[*]"]), Deny);
        let tags = json!({"git": {"checkout": {"operands": {"v[0-9]*": "allow", "*": "deny"}}}});
        assert_eq!(outcome(&tags, "git checkout", &[], &["v2.1"]), Allow);
        assert_eq!(outcome(&tags, "git checkout", &[], &["v[0-9]*"]), Deny);
        let bracket = json!({"echo": {"operands": {"[": "deny"}}});
        assert_eq!(outcome(&bracket, "echo", &[], &["["]), Deny);
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
                ..Matched::default()
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

    #[test]
    fn matched_names_the_operand_and_value_keys_that_fired() {
        let tree = json!({
            "echo": {"operands": {"secret*": "deny"}},
            "head": {"--lines": {"values": {"1*": "deny"}}},
            "gh": {"pr": {"comment": {"operands": {"*": {"operands": {"draft": "deny"}}}}}},
            "cp": {"operands": {"/data/*": {"--force": "deny"}}},
        });
        let keys = |line: &str, flags: &[&str], operands: &[&str]| {
            let matched = judge(&tree, line, flags, operands).matched.unwrap();
            (matched.command, matched.flags, matched.keys)
        };
        assert_eq!(
            keys("echo", &[], &["secret1"]),
            (vec![text("echo")], Vec::new(), vec![text("secret*")])
        );
        assert_eq!(
            keys("head", &["--lines=10"], &["/data/x"]),
            (vec![text("head")], vec![text("--lines")], vec![text("1*")])
        );
        assert_eq!(
            keys("gh pr comment", &[], &["9", "draft"]).2,
            [text("*"), text("draft")]
        );
        assert_eq!(
            keys("cp", &["--force"], &["/data/a", "/tmp/b"]),
            (
                vec![text("cp")],
                vec![text("--force")],
                vec![text("/data/*")]
            )
        );
    }

    #[test]
    fn each_leaf_is_placed_by_its_key_path() {
        let tree = json!({
            "*": "allow",
            "rm": {"*": {"decision": "ask", "reason": "deletes"}, "--recursive": "deny"},
            "cp": {"*": ["ask", {"decision": "deny", "paths": ["/k/*"]}]},
            "curl": {"--request": {"values": {"DELETE": "deny"}}},
            "git": {"checkout": {"operands": {"release/*": "ask"}}},
        });
        let (verdict, table) = judged(&tree, "rm", &["--recursive"], &["x"], true);
        let at = |id: usize| -> String {
            table[id]
                .at
                .iter()
                .map(|&u| char::from_u32(u).unwrap())
                .collect()
        };
        assert_eq!(at(verdict.leaf.unwrap()), "/rm/--recursive/*");
        let mut places: Vec<String> = (0..table.len()).map(at).collect();
        places.sort();
        assert_eq!(
            places,
            [
                "/*",
                "/cp/*/0",
                "/cp/*/1",
                "/curl/--request/values/DELETE/*",
                "/git/checkout/operands/release~1*/*",
                "/rm/*",
                "/rm/--recursive/*",
            ]
        );
    }

    #[test]
    fn a_function_call_skips_the_root_default_but_not_its_own_node() {
        let tree = json!({"*": "deny", "ls": "allow", "cleanup": {"--force": "deny"}});
        assert_eq!(judged(&tree, "deploy", &[], &[], false).0.outcome, Allow);
        assert_eq!(judged(&tree, "deploy", &[], &[], true).0.outcome, Deny);
        assert_eq!(
            judged(&tree, "cleanup", &["--force"], &[], false).0.outcome,
            Deny
        );
    }

    #[test]
    fn may_run_scopes_and_reads_answer_by_the_command_node() {
        let mut table = Vec::new();
        let tree = CompiledTree::new(
            &crate::document::tree_of(&json!({
                "*": "deny",
                "gh": {"pr": {"view": "allow"}},
                "ls": "allow",
                "cp": {"decision": "allow", "paths": ["/tmp/*"]},
                "rm": {"--force": "ask"},
            }))
            .unwrap(),
            &mut table,
        );
        let runs = |name: &str| tree.may_run(&text(name), &table);
        assert!(runs("gh") && runs("ls") && runs("cp"));
        assert!(!runs("rm") && !runs("cat"));
        assert!(tree.scopes_paths(&text("cp"), &table));
        assert!(!tree.scopes_paths(&text("ls"), &table));
        assert!(tree.reads_args(&text("rm"), &table));
        assert!(tree.reads_args(&text("gh"), &table));
        assert!(!tree.reads_args(&text("ls"), &table));
    }
}
