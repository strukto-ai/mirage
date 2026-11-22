use serde::{Deserialize, Serialize};

use super::tree::{Branch, CompiledTree, Line, Node, Placed, Verdict, rank, resolve};
use super::visibility::norm_abs;
use super::{CommandFacts, FlagFact, Matched, Outcome, PathFact, Reading, Text};

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

/// A leaf as a host names it: its decision, why, its place in its tree
/// and the mount that tree belongs to. Its index in
/// `AdmissionMatcher::rules` is the id a ruling gives.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RuleLeaf {
    pub decision: Outcome,
    pub reason: Text,
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
/// applies. `matched_path` names the file a redirect was refused for.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Ruling {
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

pub struct AdmissionMatcher {
    trees: Vec<Scoped>,
    table: Vec<Placed>,
    rules: Vec<RuleLeaf>,
}

impl AdmissionMatcher {
    /// Compile a session's trees into one leaf table.
    pub fn new(trees: Trees) -> Self {
        let mut table = Vec::new();
        let mut rules = Vec::new();
        let mut compiled = Vec::new();
        for scoped in trees.trees {
            let start = table.len();
            let tree = CompiledTree::new(&scoped.root, &mut table);
            let mount = scoped.mount.as_deref().map(norm_abs);
            rules.extend(table[start..].iter().map(|placed| RuleLeaf {
                decision: placed.leaf.decision,
                reason: placed.leaf.reason.clone(),
                at: placed.at.clone(),
                mount: mount.clone(),
            }));
            compiled.push(Scoped { mount, tree });
        }
        Self {
            trees: compiled,
            table,
            rules,
        }
    }

    pub fn rules(&self) -> &[RuleLeaf] {
        &self.rules
    }

    pub fn tree_count(&self) -> usize {
        self.trees.len()
    }

    pub fn has_rules(&self) -> bool {
        !self.trees.is_empty()
    }

    /// Judge a line: every tree that applies to it, the strictest
    /// result winning. Every ask behind an ask result is reported, since
    /// the host needs each one answered.
    pub fn decide(&self, facts: &CommandFacts) -> Ruling {
        let read = Read::new(&facts.tokens, facts.line.as_ref());
        let line = read.line(facts.tool);
        let mut best: Option<Verdict> = None;
        let mut asks: Vec<usize> = Vec::new();
        for scoped in &self.trees {
            if scoped
                .mount
                .as_ref()
                .is_some_and(|mount| !touches(mount, facts))
            {
                continue;
            }
            let verdict = resolve(&scoped.tree.walk(&line), &self.table);
            for &id in &verdict.asks {
                if !asks.contains(&id) {
                    asks.push(id);
                }
            }
            if best
                .as_ref()
                .is_none_or(|held| rank(verdict.outcome) > rank(held.outcome))
            {
                best = Some(verdict);
            }
        }
        let Some(verdict) = best else {
            return Ruling::default();
        };
        Ruling {
            outcome: verdict.outcome,
            rule: verdict.leaf.filter(|_| verdict.outcome != Outcome::Allow),
            matched_path: None,
            asks: if verdict.outcome == Outcome::Ask {
                asks
            } else {
                Vec::new()
            },
            matched: verdict.matched,
        }
    }

    /// Judge the files a redirect opens that no command owns: a compound
    /// statement's (`{ cat; } < f`, a loop, a subshell) or a bare one
    /// (`> f`). There is no command to walk, so only the root leaves of
    /// a folder entry's tree speak, for a path in that folder. The
    /// top-level tree is about commands and says nothing here. Each tree
    /// that applies is judged on its own and the strictest wins, as in
    /// `decide`.
    pub fn redirect(&self, paths: &[Text]) -> Ruling {
        let read = Read::new(&[], None);
        let line = read.line(true);
        let mut best: Option<(Verdict, &Text)> = None;
        let mut asks: Vec<usize> = Vec::new();
        for scoped in &self.trees {
            let Some(mount) = &scoped.mount else {
                continue;
            };
            let Some(path) = paths.iter().find(|path| under(path, mount)) else {
                continue;
            };
            let verdict = resolve(&scoped.tree.walk(&line), &self.table);
            for &id in &verdict.asks {
                if !asks.contains(&id) {
                    asks.push(id);
                }
            }
            if best
                .as_ref()
                .is_none_or(|(held, _)| rank(verdict.outcome) > rank(held.outcome))
            {
                best = Some((verdict, path));
            }
        }
        let Some((verdict, path)) = best else {
            return Ruling::default();
        };
        let refuses = verdict.outcome != Outcome::Allow;
        Ruling {
            outcome: verdict.outcome,
            rule: verdict.leaf.filter(|_| refuses),
            matched_path: refuses.then(|| path.clone()),
            asks: if verdict.outcome == Outcome::Ask {
                asks
            } else {
                Vec::new()
            },
            matched: None,
        }
    }

    /// A line's walk through every folder entry's tree, which the host
    /// keeps for the files the line reaches (`io_reach`, `io_refusal`).
    /// The top-level tree is left out: it judged the line as a whole, so
    /// it has nothing more to say about one file. A tree whose walk
    /// holds no deny and no ask is left out too, since it can refuse no
    /// file: a line every folder allows walks nothing, and the host asks
    /// nothing for the files it reaches.
    pub fn naming(&self, tokens: &[Text], reading: Option<&Reading>, tool: bool) -> Vec<Walked> {
        let read = Read::new(tokens, reading);
        let line = read.line(tool);
        self.trees
            .iter()
            .enumerate()
            .filter(|(_, scoped)| scoped.mount.is_some())
            .map(|(tree, scoped)| Walked {
                tree,
                branches: scoped.tree.walk(&line),
            })
            .filter(|walked| {
                Self::walked_ids(std::slice::from_ref(walked))
                    .any(|id| self.rules[id].decision != Outcome::Allow)
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

    /// Whether a deny or an ask the line's walk holds belongs to a folder
    /// at or under this path, or above it, so a walk from here has
    /// entries to judge. An ask the line holds a grant for refuses
    /// nothing (`io_refusal`), so it reaches nothing.
    pub fn io_reach(&self, walked: &[Walked], path: &[u32], granted: &[usize]) -> bool {
        walked.iter().any(|w| {
            let Some(mount) = self.trees.get(w.tree).and_then(|s| s.mount.as_ref()) else {
                return false;
            };
            (under(path, mount) || under(mount, path))
                && Self::walked_ids(std::slice::from_ref(w)).any(|id| {
                    match self.rules[id].decision {
                        Outcome::Allow => false,
                        Outcome::Ask => !granted.contains(&id),
                        Outcome::Deny => true,
                    }
                })
        })
    }

    /// The leaf that refuses a file the line reaches: the verdict of each
    /// walked folder that holds the file, a deny, or an ask the line was
    /// not granted. Every tree's asks count, as in `decide`, so a grant
    /// one tree asked for never answers another's.
    pub fn io_refusal(&self, walked: &[Walked], path: &[u32], granted: &[usize]) -> Option<usize> {
        let mut best: Option<Verdict> = None;
        let mut asks: Vec<usize> = Vec::new();
        for w in walked {
            if !self
                .trees
                .get(w.tree)
                .and_then(|scoped| scoped.mount.as_ref())
                .is_some_and(|mount| under(path, mount))
            {
                continue;
            }
            let verdict = resolve(&w.branches, &self.table);
            for &id in &verdict.asks {
                if !asks.contains(&id) {
                    asks.push(id);
                }
            }
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
            Outcome::Ask => asks.into_iter().find(|id| !granted.contains(id)),
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

    /// Whether a ruling on the command depends on more than its name:
    /// its words, its options, or the folder the line works in.
    pub fn reads_args(&self, name: &[u32]) -> bool {
        self.trees.iter().any(|scoped| {
            scoped.tree.reads_args(name) || (scoped.mount.is_some() && scoped.tree.speaks_for(name))
        })
    }

    /// Whether a ruling on the command depends on the paths it names: a
    /// folder entry's tree speaks for it.
    pub fn scopes_paths(&self, name: &[u32]) -> bool {
        self.trees
            .iter()
            .any(|scoped| scoped.mount.is_some() && scoped.tree.speaks_for(name))
    }
}

fn destination(facts: &CommandFacts) -> Option<&PathFact> {
    (facts.moves && facts.operands.len() >= 2 && facts.move_target.is_none())
        .then(|| facts.operands.last())
        .flatten()
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

/// Whether a mount entry's tree judges the line: one working inside
/// it, or a walk into the mount root it lies at or under
/// (`walks_into`), whose fan-out admits nothing again. A walk over a
/// folder in the same mount reaches it entry by entry (`io_refusal`),
/// as a path rule's scope is reached, and moving or removing an
/// ancestor takes the folder whole.
pub(crate) fn touches(mount: &[u32], facts: &CommandFacts) -> bool {
    if under(&facts.cwd, mount) || facts.paths.iter().any(|p| under(&p.virtual_path, mount)) {
        return true;
    }
    if facts.walks {
        return facts.walks_into.iter().any(|root| under(mount, root));
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
    use serde_json::{Value, json};

    fn text(value: &str) -> Text {
        value.chars().map(u32::from).collect()
    }

    fn matcher(top: Value, mounts: &[(&str, Value)]) -> AdmissionMatcher {
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
        AdmissionMatcher::new(Trees { trees })
    }

    fn path(value: &str) -> PathFact {
        PathFact {
            virtual_path: text(value),
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

    fn strings(value: &Value) -> Vec<Text> {
        value
            .as_array()
            .map(|items| items.iter().map(|v| text(v.as_str().unwrap())).collect())
            .unwrap_or_default()
    }

    #[test]
    fn frozen_admission_corpus() {
        let corpus: Value =
            serde_json::from_str(include_str!("../../../../integ/policy/matching.json")).unwrap();
        for case in corpus["admissions"].as_array().unwrap() {
            let name = &case["name"];
            let trees = case["trees"]
                .as_array()
                .unwrap()
                .iter()
                .map(|tree| ScopedTree {
                    mount: tree["mount"].as_str().map(text),
                    root: crate::document::tree_of(&tree["commands"]).unwrap(),
                })
                .collect();
            let m = AdmissionMatcher::new(Trees { trees });
            let facts = &case["facts"];
            let ruling = m.decide(&CommandFacts {
                tokens: strings(&facts["tokens"]),
                tool: facts["tool"].as_bool().unwrap(),
                cwd: text(facts["cwd"].as_str().unwrap()),
                paths: strings(&facts["paths"])
                    .iter()
                    .map(|p| path_of(p))
                    .collect(),
                operands: strings(&facts["operands"])
                    .iter()
                    .map(|p| path_of(p))
                    .collect(),
                walks: facts["walks"].as_bool().unwrap(),
                walks_into: strings(&facts["walks_into"]),
                subtree: facts["subtree"].as_bool().unwrap(),
                moves: facts["command"] == "mv",
                ..CommandFacts::default()
            });
            let expected = &case["expected"];
            let at = |id: usize| m.rules()[id].at.clone();
            assert_eq!(
                ruling.outcome,
                serde_json::from_value::<Outcome>(expected["outcome"].clone()).unwrap(),
                "{name}"
            );
            assert_eq!(
                ruling.rule.map(at),
                expected["at"].as_str().map(text),
                "{name}"
            );
            assert_eq!(
                ruling.asks.into_iter().map(at).collect::<Vec<_>>(),
                strings(&expected["asks"]),
                "{name}"
            );
        }
    }

    fn path_of(value: &[u32]) -> PathFact {
        PathFact {
            virtual_path: value.to_vec(),
        }
    }

    fn outcome(m: &AdmissionMatcher, cwd: &str, words: &[&str], paths: &[&str]) -> Outcome {
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
    fn a_walk_over_a_folder_leaves_it_to_its_entries_and_a_walk_into_a_mount_does_not() {
        let walk = |into: &[&str]| CommandFacts {
            walks: true,
            walks_into: into.iter().map(|root| text(root)).collect(),
            ..facts("/", &["grep", "-r", "x", "/d"], &["/d"])
        };
        let folder = text("/d/w/keep");
        assert!(!touches(&folder, &walk(&[])));
        assert!(!touches(&folder, &walk(&["/d/other"])));
        assert!(touches(&folder, &walk(&["/d/w"])));
        assert!(touches(&text("/d/w"), &walk(&["/d/w"])));
        assert!(touches(
            &folder,
            &facts("/d/w/keep", &["grep", "-r", "x", "."], &["/d/w/keep"])
        ));
        let removal = CommandFacts {
            subtree: true,
            ..facts("/", &["rm", "-r", "/d"], &["/d"])
        };
        assert!(touches(&folder, &removal));
        let m = matcher(
            json!({"*": "allow"}),
            &[("/d/w/keep", json!({"*": "deny"}))],
        );
        assert_eq!(m.decide(&walk(&[])).outcome, Allow);
        assert_eq!(m.decide(&walk(&["/d/w"])).outcome, Deny);
    }

    #[test]
    fn a_walked_file_is_judged_by_the_folder_that_holds_it() {
        let m = matcher(
            json!({"*": "allow"}),
            &[("/data/src/secret", json!({"grep": "deny"}))],
        );
        let line = facts("/", &["grep", "-r", "x", "/data/src"], &["/data/src"]);
        assert_eq!(m.decide(&line).outcome, Allow);
        let walked = m.naming(&line.tokens, None, true);
        assert!(m.io_reach(&walked, &text("/data/src"), &[]));
        assert!(!m.io_reach(&walked, &text("/data/out"), &[]));
        assert_eq!(
            m.io_refusal(&walked, &text("/data/src/readme.md"), &[]),
            None
        );
        let refused = m.io_refusal(&walked, &text("/data/src/secret/key.pem"), &[]);
        assert_eq!(m.rules()[refused.unwrap()].decision, Deny);
    }

    #[test]
    fn a_walk_that_can_refuse_no_file_is_left_out() {
        let m = matcher(
            json!({"*": "allow", "rm": "deny"}),
            &[
                ("/repo", json!({"git": "deny"})),
                ("/data", json!({"cp": "allow"})),
            ],
        );
        assert!(m.naming(&[text("echo"), text("hi")], None, true).is_empty());
        let cp = m.naming(&[text("cp")], None, true);
        assert!(cp.is_empty());
        assert!(!m.io_reach(&cp, &text("/data"), &[]));
        assert_eq!(m.io_refusal(&cp, &text("/data/x"), &[]), None);
        let git = m.naming(&[text("git"), text("status")], None, true);
        assert_eq!(git.iter().map(|w| w.tree).collect::<Vec<_>>(), [1]);
        assert!(m.naming(&[text("rm")], None, true).is_empty());
    }

    #[test]
    fn a_walked_ask_needs_its_grant() {
        let m = matcher(json!({}), &[("/data/review", json!({"cp": "ask"}))]);
        let walked = m.naming(&[text("cp")], None, true);
        let entry = text("/data/review/x");
        let ask = m.io_refusal(&walked, &entry, &[]).unwrap();
        assert_eq!(m.io_refusal(&walked, &entry, &[ask]), None);
    }

    #[test]
    fn a_granted_ask_reaches_nothing() {
        let m = matcher(json!({}), &[("/data/review", json!({"rm": "ask"}))]);
        let walked = m.naming(&[text("rm"), text("-rf"), text("/data")], None, true);
        let ask = m.io_refusal(&walked, &text("/data/review/x"), &[]).unwrap();
        assert!(m.io_reach(&walked, &text("/data"), &[]));
        assert!(m.io_reach(&walked, &text("/data/review"), &[]));
        assert!(!m.io_reach(&walked, &text("/data"), &[ask]));
        assert!(!m.io_reach(&walked, &text("/data/review"), &[ask]));
    }

    #[test]
    fn a_granted_ask_leaves_a_deny_below_it_reaching() {
        let m = matcher(
            json!({}),
            &[
                ("/data", json!({"rm": "ask"})),
                ("/data/keep", json!({"rm": "deny"})),
            ],
        );
        let walked = m.naming(&[text("rm"), text("-rf"), text("/data")], None, true);
        let ask = m.io_refusal(&walked, &text("/data/x"), &[]).unwrap();
        assert_eq!(m.rules()[ask].decision, Ask);
        assert!(m.io_reach(&walked, &text("/data"), &[ask]));
        assert!(m.io_reach(&walked, &text("/data/keep"), &[ask]));
        let deny = m
            .io_refusal(&walked, &text("/data/keep/y"), &[ask])
            .unwrap();
        assert_eq!(m.rules()[deny].decision, Deny);
    }

    #[test]
    fn a_folder_trees_leaf_reaches_its_folder() {
        let m = matcher(
            json!({"grep": "ask"}),
            &[
                ("/repo/private", json!({"git": "deny"})),
                ("/repo/open", json!({"git": "allow"})),
            ],
        );
        let walked = m.naming(
            &[text("git"), text("cat-file"), text("-p"), text("x")],
            None,
            true,
        );
        assert!(m.io_reach(&walked, &text("/repo"), &[]));
        assert!(m.io_reach(&walked, &text("/repo/private/s.txt"), &[]));
        assert!(!m.io_reach(&walked, &text("/repo/open"), &[]));
        assert!(!m.io_reach(&walked, &text("/other"), &[]));
        let refused = m.io_refusal(&walked, &text("/repo/private/s.txt"), &[]);
        assert_eq!(m.rules()[refused.unwrap()].decision, Deny);
        assert_eq!(m.io_refusal(&walked, &text("/repo/pub.txt"), &[]), None);
        let grep = m.naming(&[text("grep"), text("-r"), text("x")], None, true);
        assert!(!m.io_reach(&grep, &text("/repo"), &[]));
    }

    #[test]
    fn a_walked_file_needs_every_trees_grant() {
        let m = matcher(
            json!({"grep": "ask"}),
            &[
                ("/data", json!({"grep": "ask"})),
                ("/data/secret", json!({"*": "ask"})),
            ],
        );
        let line = facts("/", &["grep", "-r", "x", "/data"], &["/data"]);
        let walked = m.naming(&line.tokens, None, true);
        let entry = text("/data/secret");
        let first = m.io_refusal(&walked, &entry, &[]).unwrap();
        let second = m.io_refusal(&walked, &entry, &[first]).unwrap();
        assert_ne!(first, second);
        assert_eq!(m.io_refusal(&walked, &entry, &[first, second]), None);
        assert_eq!(m.io_refusal(&walked, &text("/data/x"), &[first]), None);
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
        assert!(m.has_rules() && !AdmissionMatcher::new(Trees::default()).has_rules());
    }

    #[test]
    fn a_redirect_meets_no_top_level_leaf() {
        let closed = matcher(json!({"*": "deny", "ls": "allow"}), &[]);
        assert_eq!(closed.redirect(&[text("/d/out")]).outcome, Allow);
        let asks = matcher(
            json!({"*": "ask"}),
            &[
                ("/d", json!({"*": "ask"})),
                ("/d/keep", json!({"*": "ask"})),
            ],
        );
        let ruling = asks.redirect(&[text("/d/keep/f.txt")]);
        assert_eq!((ruling.outcome, ruling.asks.len()), (Ask, 2));
        assert_eq!(asks.redirect(&[text("/e/x")]).outcome, Allow);
    }

    #[test]
    fn a_redirect_inside_a_folder_meets_the_folders_root_leaf() {
        let sealed = matcher(json!({"*": "allow"}), &[("/d/keep", json!({"*": "deny"}))]);
        let ruling = sealed.redirect(&[text("/d/out"), text("/d/keep/f.txt")]);
        assert_eq!(ruling.outcome, Deny);
        assert_eq!(ruling.matched_path, Some(text("/d/keep/f.txt")));
        assert_eq!(
            sealed.rules()[ruling.rule.unwrap()].mount,
            Some(text("/d/keep"))
        );
        assert_eq!(sealed.redirect(&[text("/d/out")]).outcome, Allow);
        assert_eq!(sealed.redirect(&[text("/d/keeper")]).outcome, Allow);
        let asks = matcher(json!({}), &[("/d/keep", json!({"*": "ask"}))]);
        let ruling = asks.redirect(&[text("/d/keep/f.txt")]);
        assert_eq!((ruling.outcome, ruling.asks.len()), (Ask, 1));
        let named = matcher(
            json!({}),
            &[("/d/keep", json!({"cat": "deny", "echo": "deny"}))],
        );
        assert_eq!(named.redirect(&[text("/d/keep/f.txt")]).outcome, Allow);
    }
}
