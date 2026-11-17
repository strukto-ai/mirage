use serde::{Deserialize, Serialize};

pub type Text = Vec<u32>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(u32)]
pub enum LinkState {
    #[default]
    Unfollowed = 0,
    Followed = 1,
    Hidden = 2,
    HopLimit = 3,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LinkStep {
    Follow(Text),
    Enter { path: Text, next_is_parent: bool },
    Landing(Text),
    HopLimit,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct LinkCandidate {
    pub path: Text,
    pub trace: Vec<LinkStep>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Whitespace {
    #[default]
    Python,
    EcmaScript,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Read = 0,
    Write = 1,
    Exec = 2,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct Rule {
    pub reason: Text,
    pub commands: Vec<Text>,
    pub paths: Vec<Text>,
    pub mount: Option<Text>,
}

/// One `commands.allow` entry: a pattern, or a command that runs only
/// with options from a set (`{command: rm, flags: [-f, -v]}`; an empty
/// set admits no option at all).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum AllowEntry {
    Pattern(Text),
    Only { command: Text, flags: Vec<Text> },
}

impl From<Text> for AllowEntry {
    fn from(pattern: Text) -> Self {
        Self::Pattern(pattern)
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct Rules {
    pub allow: Option<Vec<AllowEntry>>,
    pub deny: Vec<Rule>,
    pub ask: Vec<Rule>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct PathScope {
    pub paths: Vec<Text>,
    pub patterns: Vec<Text>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct VarScope {
    pub names: Vec<Text>,
    pub patterns: Vec<Text>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize)]
pub struct Show {
    pub path: Text,
    pub mode: Option<Mode>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct Visibility {
    pub hidden: PathScope,
    pub shown: Vec<Show>,
    pub vars: VarScope,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct Paths {
    pub hide: Vec<Text>,
    pub show: Vec<Show>,
    pub reasons: Vec<HideReason>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct HideReason {
    pub patterns: Vec<Text>,
    pub reason: Text,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct Mount {
    pub prefix: Text,
    pub mode: Option<Mode>,
    pub commands: Option<Rules>,
    pub paths: Option<Paths>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default)]
pub struct Profile {
    pub commands: Option<Rules>,
    pub paths: Option<Paths>,
    pub vars: Option<Vec<Text>>,
    pub mounts: Option<Vec<Mount>>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct RestrictionPlan {
    pub commands: Option<Rules>,
    pub visibility: Visibility,
    pub mount_modes: Vec<(Text, Mode)>,
    pub hide_reasons: Vec<HideReason>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize)]
pub struct PathFact {
    pub virtual_path: Text,
    pub display_path: Text,
}

/// One option a line or a pattern carries, by its canonical spelling.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct FlagFact {
    pub name: Text,
    #[serde(default)]
    pub values: Vec<Text>,
}

/// A line or a pattern as its command's grammar reads it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
pub struct Reading {
    pub path: Vec<Text>,
    #[serde(default)]
    pub flags: Vec<FlagFact>,
    #[serde(default)]
    pub operands: Vec<Text>,
}

/// A pattern read with the line's grammar, keyed by the pattern as its
/// group expanded. `read` is None for a pattern that reads but cannot
/// match this line (its subcommand `*` names a node without the option).
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct PatternRead {
    pub pattern: Text,
    pub read: Option<Reading>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct CommandFacts {
    pub tokens: Vec<Text>,
    #[serde(default)]
    pub line: Option<Reading>,
    #[serde(default)]
    pub reads: Vec<PatternRead>,
    pub tool: bool,
    pub cwd: Text,
    pub paths: Vec<PathFact>,
    pub operands: Vec<PathFact>,
    pub walks: bool,
    pub subtree: bool,
    pub moves: bool,
    pub move_target: Option<Text>,
}

impl Default for CommandFacts {
    fn default() -> Self {
        Self {
            tokens: Vec::new(),
            line: None,
            reads: Vec::new(),
            tool: true,
            cwd: vec![47],
            paths: Vec::new(),
            operands: Vec::new(),
            walks: false,
            subtree: false,
            moves: false,
            move_target: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Subject {
    pub path: Option<PathFact>,
    pub holds: bool,
    pub ancestors: bool,
}

impl Default for Subject {
    fn default() -> Self {
        Self {
            path: None,
            holds: false,
            ancestors: true,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
#[repr(u32)]
pub enum Outcome {
    #[default]
    Allow = 0,
    Deny = 1,
    Ask = 2,
}

/// What fired: the subcommand path and the options of the pattern that
/// matched, or the line's own path when the allow list refused it.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Matched {
    pub command: Vec<Text>,
    pub flags: Vec<Text>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Ruling {
    pub outcome: Outcome,
    pub rule: Option<usize>,
    pub matched_path: Option<Text>,
    pub allow_list: bool,
    pub asks: Vec<usize>,
    pub matched: Option<Matched>,
}
