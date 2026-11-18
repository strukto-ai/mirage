use serde::{Deserialize, Serialize};

use super::admission::{subjects, touches, under};
use super::profile::anchored;
use super::tree::{Branch, CompiledTree, Line, Node, Placed, Verdict, rank, resolve};
use super::visibility::norm_abs;
use super::{
    CommandFacts, FlagFact, Matched, Outcome, Reading, Subject, Text, Visibility,
    VisibilityMatcher, classify_paths,
};

/// One command tree of a session and where it applies: everywhere, or,
/// for a mount's tree, on a line working inside that mount.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct ScopedTree {
    pub mount: Option<Text>,
    pub root: Node,
}

/// A session's command trees: the profile's top-level tree, each mount's
/// tree and the inline permissions' trees, each judged on its own.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct Trees {
    pub trees: Vec<ScopedTree>,
}

/// A leaf as a host names it: its decision, why, the paths it covers,
/// its place in its tree and the mount that tree belongs to. Its index
/// in `TreeMatcher::rules` is the id a ruling gives.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RuleLeaf {
    pub decision: Outcome,
    pub reason: Text,
    pub paths: Vec<Text>,
    pub at: Text,
    pub mount: Option<Text>,
}

/// A line's walk through one tree, kept by the host for the files the
/// line reaches.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct Walked {
    pub tree: usize,
    pub branches: Vec<Branch>,
}

/// The answer for one line: the strictest decision over every tree that
/// applies and every path the line names.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct TreeRuling {
    pub outcome: Outcome,
    pub rule: Option<usize>,
    pub matched_path: Option<Text>,
    pub asks: Vec<usize>,
    pub matched: Option<Matched>,
}

/// A line's words as the trees read them. A command with no grammar
/// gives its name as the path and every later word as an operand.
pub struct Read {
    path: Vec<Text>,
    flags: Vec<FlagFact>,
    operands: Vec<Text>,
}

impl Read {
    pub fn new(tokens: &[Text], reading: Option<&Reading>) -> Self {
        match reading {
            Some(reading) => Self {
                path: reading.path.clone(),
                flags: reading.flags.clone(),
                operands: reading.operands.clone(),
            },
            None => Self {
                path: tokens.first().cloned().into_iter().collect(),
                flags: Vec::new(),
                operands: tokens.iter().skip(1).cloned().collect(),
            },
        }
    }

    pub fn line(&self, tool: bool) -> Line<'_> {
        Line {
            path: &self.path,
            flags: &self.flags,
            operands: &self.operands,
            tool,
        }
    }
}

struct Scoped {
    mount: Option<Text>,
    tree: CompiledTree,
}

pub struct TreeMatcher {
    trees: Vec<Scoped>,
    table: Vec<Placed>,
    rules: Vec<RuleLeaf>,
    scopes: Vec<Option<VisibilityMatcher>>,
}

impl TreeMatcher {
    /// Compile a session's trees into one leaf table. A mount tree's
    /// paths are anchored to the mount, as a mount section's paths are.
    pub fn new(trees: Trees) -> Self {
        let mut table = Vec::new();
        let mut rules = Vec::new();
        let mut scopes = Vec::new();
        let mut compiled = Vec::new();
        for scoped in trees.trees {
            let start = table.len();
            let tree = CompiledTree::new(&scoped.root, &mut table);
            let mount = scoped.mount.as_deref().map(norm_abs);
            for placed in &mut table[start..] {
                if let Some(root) = &mount {
                    placed.leaf.paths = anchored(&placed.leaf.paths, root);
                }
                let leaf = &placed.leaf;
                scopes.push((!leaf.paths.is_empty()).then(|| {
                    VisibilityMatcher::new(Visibility {
                        hidden: classify_paths(&leaf.paths),
                        ..Visibility::default()
                    })
                }));
                rules.push(RuleLeaf {
                    decision: leaf.decision,
                    reason: leaf.reason.clone(),
                    paths: leaf.paths.clone(),
                    at: placed.at.clone(),
                    mount: mount.clone(),
                });
            }
            compiled.push(Scoped { mount, tree });
        }
        Self {
            trees: compiled,
            table,
            rules,
            scopes,
        }
    }

    pub fn rules(&self) -> &[RuleLeaf] {
        &self.rules
    }

    pub fn has_rules(&self) -> bool {
        !self.trees.is_empty()
    }

    fn reaches(&self, id: usize, subject: &Subject) -> bool {
        let Some(scope) = &self.scopes[id] else {
            return true;
        };
        subject.path.as_ref().is_some_and(|path| {
            let path = &path.virtual_path;
            scope.hide_depth(path).is_some()
                || (subject.holds && scope.path_covers(path, subject.ancestors))
        })
    }

    fn covers(&self, id: usize, path: &[u32]) -> bool {
        self.scopes[id]
            .as_ref()
            .is_none_or(|scope| scope.hide_depth(path).is_some())
    }

    /// Judge a line: every tree that applies to it, once for each path it
    /// names (once when it names none), the strictest result winning.
    /// Every ask behind an ask result is reported, since the host needs
    /// each one answered.
    pub fn decide(&self, facts: &CommandFacts) -> TreeRuling {
        let read = Read::new(&facts.tokens, facts.line.as_ref());
        let line = read.line(facts.tool);
        let subjects = subjects(facts);
        let mut best: Option<(Verdict, &Subject)> = None;
        let mut asks: Vec<usize> = Vec::new();
        for scoped in &self.trees {
            if scoped
                .mount
                .as_ref()
                .is_some_and(|mount| !touches(mount, facts))
            {
                continue;
            }
            let branches = scoped.tree.walk(&line);
            for subject in &subjects {
                let verdict = resolve(&branches, &self.table, &|id| self.reaches(id, subject));
                for &id in &verdict.asks {
                    if !asks.contains(&id) {
                        asks.push(id);
                    }
                }
                if best
                    .as_ref()
                    .is_none_or(|(held, _)| rank(verdict.outcome) > rank(held.outcome))
                {
                    best = Some((verdict, subject));
                }
            }
        }
        let Some((verdict, subject)) = best else {
            return TreeRuling::default();
        };
        TreeRuling {
            outcome: verdict.outcome,
            rule: verdict.leaf.filter(|_| verdict.outcome != Outcome::Allow),
            matched_path: verdict
                .leaf
                .filter(|&id| !self.rules[id].paths.is_empty())
                .and(subject.path.as_ref())
                .map(|path| path.display_path.clone()),
            asks: if verdict.outcome == Outcome::Ask {
                asks
            } else {
                Vec::new()
            },
            matched: verdict.matched,
        }
    }

    /// A line's walk through every tree, which the host keeps for the
    /// files the line reaches (`io_reach`, `io_refusal`).
    pub fn naming(&self, tokens: &[Text], reading: Option<&Reading>, tool: bool) -> Vec<Walked> {
        let read = Read::new(tokens, reading);
        let line = read.line(tool);
        self.trees
            .iter()
            .enumerate()
            .map(|(tree, scoped)| Walked {
                tree,
                branches: scoped.tree.walk(&line),
            })
            .collect()
    }

    fn walked_ids<'w>(walked: &'w [Walked]) -> impl Iterator<Item = usize> + 'w {
        walked.iter().flat_map(|w| {
            w.branches.iter().flat_map(|branch| {
                branch
                    .steps
                    .iter()
                    .chain(&branch.groups)
                    .flat_map(|group| group.first.iter().chain(&group.then).copied())
            })
        })
    }

    /// Whether a decision the line's walk holds is scoped to a path at or
    /// under this one, so a walk below it has entries to judge.
    pub fn io_reach(&self, walked: &[Walked], path: &[u32]) -> bool {
        Self::walked_ids(walked).any(|id| {
            self.scopes
                .get(id)
                .and_then(Option::as_ref)
                .is_some_and(|scope| scope.hides_intersect(path))
        })
    }

    /// The leaf that refuses a file the line reaches, judged as one more
    /// path of the line: a deny, or an ask the line was not granted.
    pub fn io_refusal(&self, walked: &[Walked], path: &[u32], granted: &[usize]) -> Option<usize> {
        let mut best: Option<Verdict> = None;
        for w in walked {
            let Some(scoped) = self.trees.get(w.tree) else {
                continue;
            };
            if scoped
                .mount
                .as_ref()
                .is_some_and(|mount| !under(path, mount))
            {
                continue;
            }
            let verdict = resolve(&w.branches, &self.table, &|id| self.covers(id, path));
            if best
                .as_ref()
                .is_none_or(|held| rank(verdict.outcome) > rank(held.outcome))
            {
                best = Some(verdict);
            }
        }
        let verdict = best?;
        match verdict.outcome {
            Outcome::Deny => verdict.leaf,
            Outcome::Ask => verdict.asks.into_iter().find(|id| !granted.contains(id)),
            Outcome::Allow => None,
        }
    }

    /// Whether a session can run a command at all: no tree that applies
    /// everywhere denies every line of it.
    pub fn runs(&self, name: &[u32]) -> bool {
        self.trees
            .iter()
            .filter(|scoped| scoped.mount.as_ref().is_none_or(|mount| mount == &[47]))
            .all(|scoped| scoped.tree.may_run(name, &self.table))
    }

    /// Whether a ruling on the command depends on more than its name: its
    /// words, its options, its paths, or the mount the line works in.
    pub fn reads_args(&self, name: &[u32]) -> bool {
        self.trees.iter().any(|scoped| {
            scoped.tree.reads_args(name, &self.table)
                || (scoped.mount.is_some() && scoped.tree.speaks_for(name))
        })
    }

    /// Whether a ruling on the command depends on the paths it names.
    pub fn scopes_paths(&self, name: &[u32]) -> bool {
        self.trees.iter().any(|scoped| {
            scoped.tree.scopes_paths(name, &self.table)
                || (scoped.mount.is_some() && scoped.tree.speaks_for(name))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::policy::PathFact;
    use serde_json::{Value, json};

    fn text(value: &str) -> Text {
        value.chars().map(u32::from).collect()
    }

    fn matcher(top: Value, mounts: &[(&str, Value)]) -> TreeMatcher {
        let mut trees = vec![ScopedTree {
            mount: None,
            root: crate::document::tree_of(&top).unwrap(),
        }];
        for (prefix, tree) in mounts {
            trees.push(ScopedTree {
                mount: Some(text(prefix)),
                root: crate::document::tree_of(tree).unwrap(),
            });
        }
        TreeMatcher::new(Trees { trees })
    }

    fn path(value: &str) -> PathFact {
        PathFact {
            virtual_path: text(value),
            display_path: text(value),
        }
    }

    fn facts(cwd: &str, words: &[&str], paths: &[&str]) -> CommandFacts {
        CommandFacts {
            tokens: words.iter().map(|w| text(w)).collect(),
            cwd: text(cwd),
            paths: paths.iter().map(|p| path(p)).collect(),
            operands: paths.iter().map(|p| path(p)).collect(),
            ..CommandFacts::default()
        }
    }

    fn outcome(m: &TreeMatcher, cwd: &str, words: &[&str], paths: &[&str]) -> Outcome {
        m.decide(&facts(cwd, words, paths)).outcome
    }

    use Outcome::{Allow, Ask, Deny};

    #[test]
    fn a_mount_tree_is_judged_beside_the_top_level_and_only_tightens() {
        let m = matcher(
            json!({"*": "allow", "gh": "deny"}),
            &[(
                "/data",
                json!({"rm": "ask", "gh": {"pr": {"view": "allow"}}}),
            )],
        );
        let rows = [
            (
                "/",
                vec!["rm", "/data/report.md"],
                vec!["/data/report.md"],
                Ask,
            ),
            (
                "/data",
                vec!["rm", "report.md"],
                vec!["/data/report.md"],
                Ask,
            ),
            (
                "/",
                vec!["rm", "/tmp/scratch.md"],
                vec!["/tmp/scratch.md"],
                Allow,
            ),
            ("/data", vec!["gh", "pr", "view", "5"], vec![], Deny),
            ("/", vec!["gh", "pr", "view", "5"], vec![], Deny),
        ];
        for (cwd, words, paths, want) in rows {
            assert_eq!(outcome(&m, cwd, &words, &paths), want, "{cwd} {words:?}");
        }
    }

    #[test]
    fn each_path_is_judged_and_one_covered_path_carries_no_other() {
        let m = matcher(
            json!({"*": "deny", "rm": {"decision": "allow", "paths": ["/data/tmp/*"]}}),
            &[],
        );
        let rm = |paths: &[&str]| {
            let mut words = vec!["rm"];
            words.extend_from_slice(paths);
            outcome(&m, "/", &words, paths)
        };
        assert_eq!(rm(&["/data/tmp/a.log"]), Allow);
        assert_eq!(rm(&["/etc/passwd"]), Deny);
        assert_eq!(rm(&["/data/tmp/a.log", "/etc/passwd"]), Deny);
        assert_eq!(rm(&[]), Deny);
    }

    #[test]
    fn a_ruling_names_its_leaf_path_and_every_ask() {
        let m = matcher(
            json!({"cp": [
                {"decision": "ask", "reason": "a", "paths": ["/a/*"]},
                {"decision": "ask", "reason": "b", "paths": ["/b/*"]},
            ]}),
            &[],
        );
        let ruling = m.decide(&facts("/", &["cp", "/a/x", "/b/y"], &["/a/x", "/b/y"]));
        assert_eq!(ruling.outcome, Ask);
        assert_eq!(ruling.asks.len(), 2);
        assert_eq!(ruling.matched_path, Some(text("/a/x")));
        assert_eq!(m.rules()[ruling.rule.unwrap()].at, text("/cp/*/0"));
    }

    #[test]
    fn a_walked_file_is_judged_as_one_more_path() {
        let m = matcher(
            json!({"*": "allow", "grep": {"decision": "deny", "paths": ["/data/src/secret/*"]}}),
            &[],
        );
        let line = facts("/", &["grep", "-r", "x", "/data/src"], &["/data/src"]);
        assert_eq!(m.decide(&line).outcome, Allow);
        let walked = m.naming(&line.tokens, None, true);
        assert!(m.io_reach(&walked, &text("/data/src")));
        assert!(!m.io_reach(&walked, &text("/data/out")));
        assert_eq!(
            m.io_refusal(&walked, &text("/data/src/readme.md"), &[]),
            None
        );
        let refused = m.io_refusal(&walked, &text("/data/src/secret/key.pem"), &[]);
        assert_eq!(m.rules()[refused.unwrap()].decision, Deny);
    }

    #[test]
    fn a_walked_ask_needs_its_grant() {
        let m = matcher(
            json!({"cp": {"decision": "ask", "paths": ["/data/review/*"]}}),
            &[],
        );
        let walked = m.naming(&[text("cp")], None, true);
        let entry = text("/data/review/x");
        let ask = m.io_refusal(&walked, &entry, &[]).unwrap();
        assert_eq!(m.io_refusal(&walked, &entry, &[ask]), None);
    }

    #[test]
    fn runs_reads_and_scopes_answer_across_trees() {
        let m = matcher(
            json!({"*": "deny", "ls": "allow", "gh": {"pr": {"view": "allow"}}}),
            &[("/data", json!({"cat": "ask"}))],
        );
        assert!(m.runs(&text("ls")) && m.runs(&text("gh")));
        assert!(!m.runs(&text("rm")) && !m.runs(&text("cat")));
        assert!(m.scopes_paths(&text("cat")) && !m.scopes_paths(&text("ls")));
        assert!(m.reads_args(&text("gh")) && !m.reads_args(&text("ls")));
        assert!(m.has_rules() && !TreeMatcher::new(Trees::default()).has_rules());
    }
}
