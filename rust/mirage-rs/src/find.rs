//! find's expression grammar (findutils 4.10.0), read once before any
//! operand is resolved. The host sends every word typed after `find` as an
//! operand; the start points are the words before the first expression
//! token, and the rest is parsed here into a tree of tests, connectives and
//! actions, with every argument typed and checked where it was written, so
//! the first bad one names the refusal and its exit status. `-printf` is
//! compiled once into literal runs and directives the host renders per
//! entry, its warnings kept in the order the reference prints them, and a `-regex`
//! is compiled once to be refused where it was typed. A time test comes
//! back as its operands (`-mtime +N` as a sign and a count, `-newermt` as
//! the date text, `-newer` as an index into the reference list) with the
//! way it folds into the expression's flat window, since only the host has
//! a clock, a date library and the dispatcher that stats a reference.
//!
//! `layout` answers the same words without parsing the expression: where it
//! begins and which words an `-exec` owns, for a host classifying a line
//! before it can be parsed.

use serde_json::{Value as Json, json};

use crate::regex::parse::{Dialect, parse as compile_regex};
use crate::scan::{OPERAND, Typed, Values, unknown};
use crate::sort::number::strtod_prefix;
use crate::{StreamError, byte_text};

const VALUE_PREDICATES: &[&[u8]] = &[
    b"-name",
    b"-iname",
    b"-path",
    b"-ipath",
    b"-wholename",
    b"-iwholename",
    b"-regex",
    b"-iregex",
    b"-regextype",
    b"-lname",
    b"-ilname",
    b"-type",
    b"-xtype",
    b"-size",
    b"-perm",
    b"-links",
    b"-mtime",
    b"-atime",
    b"-ctime",
    b"-mmin",
    b"-amin",
    b"-cmin",
    b"-user",
    b"-group",
    b"-uid",
    b"-gid",
    b"-maxdepth",
    b"-mindepth",
    b"-printf",
    b"-fprint",
    b"-fprint0",
    b"-fprintf",
    b"-newer",
    b"-newermt",
    b"-files0-from",
];
const BARE_PREDICATES: &[&[u8]] = &[
    b"-empty",
    b"-print",
    b"-print0",
    b"-delete",
    b"-ls",
    b"-depth",
    b"-xdev",
    b"-mount",
    b"-prune",
    b"-quit",
    b"-true",
    b"-false",
    b"-readable",
    b"-writable",
    b"-executable",
    b"-nouser",
    b"-nogroup",
    b"-daystart",
    b"-follow",
];
/// The words that test an entry, which a top-level `-a` chain may not
/// hold after an action: the host applies every action to the rows the
/// tests kept, so a later test could not undo one.
const TESTS: &[&[u8]] = &[
    b"-name",
    b"-iname",
    b"-path",
    b"-ipath",
    b"-wholename",
    b"-iwholename",
    b"-regex",
    b"-iregex",
    b"-lname",
    b"-ilname",
    b"-type",
    b"-xtype",
    b"-size",
    b"-perm",
    b"-links",
    b"-mtime",
    b"-atime",
    b"-ctime",
    b"-mmin",
    b"-amin",
    b"-cmin",
    b"-user",
    b"-group",
    b"-uid",
    b"-gid",
    b"-newer",
    b"-newermt",
    b"-empty",
    b"-prune",
    b"-true",
    b"-false",
    b"-readable",
    b"-writable",
    b"-executable",
    b"-nouser",
    b"-nogroup",
];
const OPERATORS: &[&[u8]] = &[b"-not", b"!", b"-o", b"-or", b"-a", b"-and", b"(", b")"];
const EXEC: &[u8] = b"-exec";
const EXECDIR: &[u8] = b"-execdir";
const LINK_OPTIONS: &[&[u8]] = &[b"-P", b"-H", b"-L"];
const ROW_ACTIONS: &[(&[u8], &str)] = &[
    (b"-print", "print"),
    (b"-print0", "print0"),
    (b"-ls", "ls"),
    (b"-delete", "delete"),
];
const ACCESS: &[(&[u8], u8)] = &[
    (b"-readable", b'r'),
    (b"-writable", b'w'),
    (b"-executable", b'x'),
];
const TYPES: &[u8] = b"bcdpfls";
const TIME_LETTERS: &[u8] = b"@+aAbBcCdDeFgGhHIjklmMnpPrRsStTuUVwWxXyYzZ";
const DIRECTIVES: &[u8] = b"pPfhdsyYuUgGmM";
const PLACEHOLDER: &[u8] = b"{}";
const MAX_NESTING: usize = 100;
const POSITIONAL: &str = "under -o, ! or parentheses";
const DELETE_PRUNE: &str = "find: The -delete action automatically turns on -depth, but -prune \
     does nothing when -depth is in effect.  If you want to carry on anyway, just explicitly \
     use the -depth option.";
/// `-regextype`'s names in the order the reference lists them, each with the
/// syntax mirage-rs reads it in: the default is Emacs's, the rest a basic
/// or an extended POSIX expression.
const REGEX_TYPES: &[(&[u8], Dialect, bool)] = &[
    (b"findutils-default", Dialect::Emacs, false),
    (b"ed", Dialect::Posix, false),
    (b"emacs", Dialect::Emacs, false),
    (b"gnu-awk", Dialect::Posix, true),
    (b"grep", Dialect::Posix, false),
    (b"posix-awk", Dialect::Posix, true),
    (b"awk", Dialect::Posix, true),
    (b"posix-basic", Dialect::Posix, false),
    (b"posix-egrep", Dialect::Posix, true),
    (b"egrep", Dialect::Posix, true),
    (b"posix-extended", Dialect::Posix, true),
    (b"posix-minimal-basic", Dialect::Posix, false),
    (b"sed", Dialect::Posix, false),
];

type Fail = Vec<u8>;

fn say(parts: &[&[u8]]) -> Fail {
    parts.concat()
}

fn text(message: &str) -> Fail {
    message.as_bytes().to_vec()
}

fn is_exec(word: &[u8]) -> bool {
    word == EXEC || word == EXECDIR
}

fn is_expression_token(word: &[u8]) -> bool {
    (word.starts_with(b"-") && word.len() > 1)
        || [VALUE_PREDICATES, BARE_PREDICATES, OPERATORS]
            .iter()
            .any(|list| list.contains(&word))
}

fn start_of(argv: &[Vec<u8>]) -> usize {
    let skipped = argv
        .iter()
        .take_while(|word| LINK_OPTIONS.contains(&word.as_slice()))
        .count();
    argv[skipped..]
        .iter()
        .position(|word| is_expression_token(word))
        .map_or(argv.len(), |at| skipped + at)
}

fn exec_spans(argv: &[Vec<u8>]) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut at = 0;
    while at < argv.len() {
        if !is_exec(&argv[at]) {
            at += 1;
            continue;
        }
        let start = at;
        at += 1;
        while at < argv.len() {
            let word = &argv[at];
            if word == b";"
                || (word == b"+" && at > start + 1 && contains(&argv[at - 1], PLACEHOLDER))
            {
                break;
            }
            at += 1;
        }
        spans.push((start, at.min(argv.len() - 1)));
        at += 1;
    }
    spans
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

fn words(options: &[Typed]) -> Result<Vec<Vec<u8>>, StreamError> {
    options
        .iter()
        .map(|(name, raw)| {
            if name == OPERAND {
                Ok(raw.clone())
            } else {
                Err(unknown("find", name))
            }
        })
        .collect()
}

pub(crate) fn layout(options: &[Typed]) -> Result<Values, StreamError> {
    let argv = words(options)?;
    let mut values = Values::new();
    values.insert("start".to_owned(), json!(start_of(&argv)));
    values.insert("spans".to_owned(), json!(exec_spans(&argv)));
    Ok(values)
}

pub(crate) fn scan(options: &[Typed]) -> Result<Values, StreamError> {
    let argv = words(options)?;
    let start = start_of(&argv);
    let parsed = Parser::new(&argv[start..]).run()?;
    let mut values = parsed.values();
    values.insert("start".to_owned(), json!(start));
    Ok(values)
}

#[derive(PartialEq)]
enum Part {
    Lit(Vec<u8>),
    Dir(u8),
    Time(u8),
}

#[derive(PartialEq)]
enum Action {
    Exec {
        argv: Vec<Vec<u8>>,
        batch: bool,
        dir: bool,
    },
    Row {
        kind: &'static str,
        file: Option<Vec<u8>>,
    },
    Printf {
        format: Vec<u8>,
        parts: Vec<Part>,
        file: Option<Vec<u8>>,
    },
}

impl Action {
    fn word(&self) -> String {
        match self {
            Action::Exec { dir: false, .. } => "-exec".to_owned(),
            Action::Exec { dir: true, .. } => "-execdir".to_owned(),
            Action::Printf { file: None, .. } => "-printf".to_owned(),
            Action::Printf { file: Some(_), .. } => "-fprintf".to_owned(),
            Action::Row { kind, file: None } => format!("-{kind}"),
            Action::Row {
                kind,
                file: Some(_),
            } => format!("-f{kind}"),
        }
    }

    fn json(&self) -> Json {
        let file = |file: &Option<Vec<u8>>| file.as_deref().map(byte_text);
        match self {
            Action::Exec { argv, batch, dir } => json!({
                "kind": "exec",
                "argv": argv.iter().map(|w| byte_text(w)).collect::<Vec<_>>(),
                "batch": batch,
                "dir": dir,
            }),
            Action::Row { kind, file: path } => json!({"kind": kind, "file": file(path)}),
            Action::Printf {
                format,
                parts,
                file: path,
            } => json!({
                "kind": "printf",
                "format": byte_text(format),
                "parts": parts.iter().map(part_json).collect::<Vec<_>>(),
                "stat": parts.iter().any(|part| match part {
                    Part::Dir(code) => b"syYmMuUgG".contains(code),
                    Part::Time(_) => true,
                    Part::Lit(_) => false,
                }),
                "file": file(path),
            }),
        }
    }
}

/// A count as JSON: a number, or JavaScript's spelling of an infinity,
/// which JSON has no number for and both hosts read back.
fn number(amount: f64) -> Json {
    if amount.is_finite() {
        json!(amount)
    } else if amount > 0.0 {
        json!("Infinity")
    } else {
        json!("-Infinity")
    }
}

fn part_json(part: &Part) -> Json {
    match part {
        Part::Lit(bytes) => json!({"lit": byte_text(bytes)}),
        Part::Dir(code) => json!({"dir": char::from(*code).to_string()}),
        Part::Time(letter) => json!({"time": char::from(*letter).to_string()}),
    }
}

#[derive(Clone, Copy)]
enum Fold {
    All,
    Any,
}

enum Time {
    /// `-mtime`, `-atime`, `-ctime` and their `-Xmin` twins: which stamp
    /// (`m`, `a`, `c`), counted in days or minutes, measured from the
    /// next midnight under `-daystart`.
    Age {
        field: u8,
        minutes: bool,
        cmp: u8,
        amount: f64,
        daystart: bool,
    },
    Newermt(Vec<u8>),
    Newer(usize),
}

/// How `-perm` compares: the mode exactly, every bit of it, or any.
#[derive(Clone, Copy)]
enum Bits {
    Exact,
    All,
    Any,
}

enum Node {
    Name {
        pattern: Vec<u8>,
        icase: bool,
    },
    Path {
        pattern: Vec<u8>,
        icase: bool,
    },
    Regex {
        pattern: Vec<u8>,
        icase: bool,
        dialect: &'static str,
        extended: bool,
    },
    Lname {
        pattern: Vec<u8>,
        icase: bool,
    },
    Type(u8),
    XType(u8),
    Perm {
        mode: u32,
        bits: Bits,
    },
    Count {
        field: &'static str,
        cmp: u8,
        count: u64,
    },
    Owner {
        group: bool,
        name: Vec<u8>,
    },
    /// `-nouser` and `-nogroup`: an owner known only by number.
    NoOwner {
        group: bool,
    },
    Access(u8),
    Empty,
    True,
    Prune,
    Quit,
    Not(Box<Node>),
    And(Vec<Node>),
    Or(Vec<Node>),
    Act {
        kind: &'static str,
        batch: bool,
    },
    Time(Time, Fold),
}

fn is_quit(node: &Node) -> bool {
    matches!(node, Node::Quit)
}

impl Node {
    fn has_action(&self) -> bool {
        match self {
            Node::Act { .. } => true,
            Node::Not(kid) => kid.has_action(),
            Node::And(kids) | Node::Or(kids) => kids.iter().any(Node::has_action),
            _ => false,
        }
    }

    fn has_prune(&self) -> bool {
        match self {
            Node::Prune => true,
            Node::Not(kid) => kid.has_prune(),
            Node::And(kids) | Node::Or(kids) => kids.iter().any(Node::has_prune),
            _ => false,
        }
    }

    fn without_prune(self) -> Node {
        match self {
            Node::Prune => Node::True,
            Node::Not(kid) => Node::Not(Box::new(kid.without_prune())),
            Node::And(kids) => Node::And(kids.into_iter().map(Node::without_prune).collect()),
            Node::Or(kids) => Node::Or(kids.into_iter().map(Node::without_prune).collect()),
            other => other,
        }
    }

    fn first_action(&self) -> String {
        match self {
            Node::Act { kind, .. } => format!("-{kind}"),
            Node::Not(kid) => kid.first_action(),
            Node::And(kids) | Node::Or(kids) => kids
                .iter()
                .find(|kid| kid.has_action())
                .map_or_else(String::new, Node::first_action),
            _ => String::new(),
        }
    }

    fn holds_exec_result(&self) -> bool {
        match self {
            Node::Act { kind, batch } => *kind == "exec" && !batch,
            Node::Not(kid) => kid.holds_exec_result(),
            Node::And(kids) | Node::Or(kids) => kids.iter().any(Node::holds_exec_result),
            _ => false,
        }
    }

    fn json(&self) -> Json {
        match self {
            Node::Name { pattern, icase } => {
                json!({"op": "name", "pattern": byte_text(pattern), "icase": icase})
            }
            Node::Path { pattern, icase } => {
                json!({"op": "path", "pattern": byte_text(pattern), "icase": icase})
            }
            Node::Regex {
                pattern,
                icase,
                dialect,
                extended,
            } => json!({
                "op": "regex",
                "pattern": byte_text(pattern),
                "icase": icase,
                "dialect": dialect,
                "extended": extended,
            }),
            Node::Lname { pattern, icase } => {
                json!({"op": "lname", "pattern": byte_text(pattern), "icase": icase})
            }
            Node::Type(kind) => json!({"op": "type", "kind": char::from(*kind).to_string()}),
            Node::XType(kind) => json!({"op": "xtype", "kind": char::from(*kind).to_string()}),
            Node::Perm { mode, bits } => json!({
                "op": "perm",
                "mode": mode,
                "bits": match bits {
                    Bits::Exact => "exact",
                    Bits::All => "all",
                    Bits::Any => "any",
                },
            }),
            Node::Count { field, cmp, count } => json!({
                "op": "count",
                "field": field,
                "cmp": char::from(*cmp).to_string(),
                "count": count,
            }),
            Node::Owner { group, name } => {
                json!({"op": "owner", "group": group, "name": byte_text(name)})
            }
            Node::NoOwner { group } => json!({"op": "nouser", "group": group}),
            Node::Access(mode) => json!({"op": "access", "mode": char::from(*mode).to_string()}),
            Node::Empty => json!({"op": "empty"}),
            Node::True => json!({"op": "true"}),
            Node::Prune => json!({"op": "prune"}),
            Node::Quit => json!({"op": "quit"}),
            Node::Not(kid) => json!({"op": "not", "kid": kid.json()}),
            Node::And(kids) => {
                json!({"op": "and", "kids": kids.iter().map(Node::json).collect::<Vec<_>>()})
            }
            Node::Or(kids) => {
                json!({"op": "or", "kids": kids.iter().map(Node::json).collect::<Vec<_>>()})
            }
            Node::Act { kind, batch } => json!({"op": "action", "kind": kind, "batch": batch}),
            Node::Time(test, fold) => {
                let fold = match fold {
                    Fold::All => "all",
                    Fold::Any => "any",
                };
                match test {
                    Time::Age {
                        field,
                        minutes,
                        cmp,
                        amount,
                        daystart,
                    } => json!({
                        "op": "age",
                        "field": char::from(*field).to_string(),
                        "minutes": minutes,
                        "cmp": char::from(*cmp).to_string(),
                        "amount": number(*amount),
                        "daystart": daystart,
                        "fold": fold,
                    }),
                    Time::Newermt(date) => {
                        json!({"op": "newermt", "date": byte_text(date), "fold": fold})
                    }
                    Time::Newer(index) => json!({"op": "newer", "index": index, "fold": fold}),
                }
            }
        }
    }
}

struct Parsed {
    tree: Node,
    maxdepth: Option<u64>,
    mindepth: Option<u64>,
    size: (Option<i128>, Option<i128>),
    uses_empty: bool,
    actions: Vec<Action>,
    newer: Vec<Vec<u8>>,
    dates: Vec<(Vec<u8>, usize)>,
    depth_first: bool,
    follow: bool,
    files0_from: Option<Vec<u8>>,
    predicates: Vec<Vec<u8>>,
    warnings: Vec<Vec<u8>>,
}

impl Parsed {
    fn values(&self) -> Values {
        let mut values = Values::new();
        values.insert("tree".to_owned(), self.tree.json());
        values.insert("maxdepth".to_owned(), json!(self.maxdepth));
        values.insert("mindepth".to_owned(), json!(self.mindepth));
        values.insert(
            "min_size".to_owned(),
            self.size
                .0
                .map_or(Json::Null, |n| Json::from(n.to_string())),
        );
        values.insert(
            "max_size".to_owned(),
            self.size
                .1
                .map_or(Json::Null, |n| Json::from(n.to_string())),
        );
        values.insert("uses_empty".to_owned(), json!(self.uses_empty));
        values.insert(
            "actions".to_owned(),
            Json::Array(self.actions.iter().map(Action::json).collect()),
        );
        values.insert(
            "newer".to_owned(),
            Json::Array(self.newer.iter().map(|w| json!(byte_text(w))).collect()),
        );
        values.insert(
            "dates".to_owned(),
            Json::Array(
                self.dates
                    .iter()
                    .map(|(date, after)| json!([byte_text(date), after]))
                    .collect(),
            ),
        );
        values.insert("depth_first".to_owned(), json!(self.depth_first));
        values.insert("follow".to_owned(), json!(self.follow));
        values.insert(
            "files0_from".to_owned(),
            json!(self.files0_from.as_deref().map(byte_text)),
        );
        values.insert(
            "predicates".to_owned(),
            Json::Array(
                self.predicates
                    .iter()
                    .map(|w| json!(byte_text(w)))
                    .collect(),
            ),
        );
        values.insert(
            "warnings".to_owned(),
            Json::Array(self.warnings.iter().map(|w| json!(byte_text(w))).collect()),
        );
        values
    }
}

struct Parser<'a> {
    tokens: &'a [Vec<u8>],
    pos: usize,
    depth: usize,
    nested: usize,
    chain_action: bool,
    in_or: bool,
    positional: bool,
    depth_option: bool,
    newer_token: Option<&'a [u8]>,
    regex_type: (Dialect, bool),
    daystart: bool,
    maxdepth: Option<u64>,
    mindepth: Option<u64>,
    size: (Option<i128>, Option<i128>),
    uses_empty: bool,
    actions: Vec<Action>,
    newer: Vec<Vec<u8>>,
    dates: Vec<(Vec<u8>, usize)>,
    depth_first: bool,
    follow: bool,
    files0_from: Option<Vec<u8>>,
    predicates: Vec<Vec<u8>>,
    warnings: Vec<Vec<u8>>,
}

impl<'a> Parser<'a> {
    fn new(tokens: &'a [Vec<u8>]) -> Self {
        Parser {
            tokens,
            pos: 0,
            depth: 0,
            nested: 0,
            chain_action: false,
            in_or: false,
            positional: false,
            depth_option: false,
            newer_token: None,
            regex_type: (Dialect::Emacs, false),
            daystart: false,
            maxdepth: None,
            mindepth: None,
            size: (None, None),
            uses_empty: false,
            actions: Vec::new(),
            newer: Vec::new(),
            dates: Vec::new(),
            depth_first: false,
            follow: false,
            files0_from: None,
            predicates: Vec::new(),
            warnings: Vec::new(),
        }
    }

    fn run(mut self) -> Result<Parsed, StreamError> {
        match self.parse() {
            Ok(tree) => Ok(Parsed {
                tree,
                maxdepth: self.maxdepth,
                mindepth: self.mindepth,
                size: self.size,
                uses_empty: self.uses_empty,
                actions: self.actions,
                newer: self.newer,
                dates: self.dates,
                depth_first: self.depth_first,
                follow: self.follow,
                files0_from: self.files0_from,
                predicates: self.predicates,
                warnings: self.warnings,
            }),
            Err(message) => {
                let mut shown: Vec<u8> = Vec::new();
                for warning in &self.warnings {
                    shown.extend_from_slice(warning);
                    shown.push(b'\n');
                }
                shown.extend_from_slice(&message);
                Err(StreamError::refusal(&shown, 1))
            }
        }
    }

    fn parse(&mut self) -> Result<Node, Fail> {
        if self.tokens.is_empty() {
            return Ok(Node::True);
        }
        let tree = self.or_expr()?;
        if self.peek().is_some() {
            return Err(text("find: you have too many ')'"));
        }
        if self.positional {
            self.settle_actions(&tree)?;
        }
        if tree.has_prune() && self.depth_first {
            if !self.depth_option {
                return Err(text(DELETE_PRUNE));
            }
            return Ok(tree.without_prune());
        }
        Ok(tree)
    }

    fn peek(&self) -> Option<&'a [u8]> {
        self.tokens.get(self.pos).map(Vec::as_slice)
    }

    fn advance(&mut self) -> Option<&'a [u8]> {
        let word = self.peek();
        if word.is_some() {
            self.pos += 1;
        }
        word
    }

    fn after_operator(&self, op: &[u8]) -> Result<(), Fail> {
        match self.peek() {
            None => Err(say(&[b"find: expected an expression after '", op, b"'"])),
            Some(b")") => Err(say(&[
                b"find: expected an expression between '",
                op,
                b"' and ')'",
            ])),
            Some(_) => Ok(()),
        }
    }

    fn action_node(&mut self, kind: &'static str, batch: bool) -> Node {
        if self.nested > 0 {
            self.positional = true;
        } else {
            self.chain_action = true;
        }
        Node::Act { kind, batch }
    }

    fn fold(&self) -> Fold {
        if self.nested == 0 && !self.in_or {
            Fold::All
        } else {
            Fold::Any
        }
    }

    fn check_window_placement(&self, token: &[u8]) -> Result<(), Fail> {
        if self.nested > 0 || self.in_or {
            return Err(say(&[
                b"find: ",
                token,
                b" is supported only in a top-level -a chain, not under -o, ! or parentheses",
            ]));
        }
        Ok(())
    }

    fn or_expr(&mut self) -> Result<Node, Fail> {
        let mut terms = vec![self.and_expr()?];
        while let Some(op) = self.peek().filter(|w| *w == b"-o" || *w == b"-or") {
            self.advance();
            self.after_operator(op)?;
            if self.nested == 0 {
                self.in_or = true;
                if let Some(token) = self.newer_token {
                    self.check_window_placement(token)?;
                }
            }
            terms.push(self.and_expr()?);
        }
        if terms.len() == 1 {
            return Ok(terms.remove(0));
        }
        let node = Node::Or(terms);
        if node.has_action() {
            self.positional = true;
        }
        Ok(node)
    }

    fn and_expr(&mut self) -> Result<Node, Fail> {
        let mut factors = vec![self.factor()?];
        loop {
            match self.peek() {
                Some(op) if op == b"-a" || op == b"-and" => {
                    self.advance();
                    self.after_operator(op)?;
                    factors.push(self.factor()?);
                }
                None => break,
                Some(w) if w == b"-o" || w == b"-or" || w == b")" => break,
                Some(_) => factors.push(self.factor()?),
            }
        }
        if factors.len() == 1 {
            return Ok(factors.remove(0));
        }
        Ok(Node::And(factors))
    }

    fn factor(&mut self) -> Result<Node, Fail> {
        self.depth += 1;
        if self.depth > MAX_NESTING {
            return Err(text("find: expression too deeply nested"));
        }
        let node = self.factor_inner();
        self.depth -= 1;
        node
    }

    fn factor_inner(&mut self) -> Result<Node, Fail> {
        match self.peek() {
            Some(op) if op == b"-not" || op == b"!" => {
                self.advance();
                self.after_operator(op)?;
                self.nested += 1;
                let kid = self.factor();
                self.nested -= 1;
                Ok(Node::Not(Box::new(kid?)))
            }
            Some(b"(") => {
                self.advance();
                match self.peek() {
                    None => {
                        return Err(text(
                            "find: invalid expression; expected to find a ')' but didn't see one. \
                             Perhaps you need an extra predicate after '('",
                        ));
                    }
                    Some(b")") => {
                        return Err(text(
                            "find: invalid expression; empty parentheses are not allowed.",
                        ));
                    }
                    Some(_) => {}
                }
                self.nested += 1;
                let node = self.or_expr();
                self.nested -= 1;
                let node = node?;
                if self.peek() != Some(b")") {
                    return Err(text(
                        "find: invalid expression; I was expecting to find a ')' somewhere but \
                         did not see one.",
                    ));
                }
                self.advance();
                Ok(node)
            }
            _ => self.primary(),
        }
    }

    fn is_test_after_action(&self, tok: &[u8]) -> bool {
        TESTS.contains(&tok)
    }

    fn primary(&mut self) -> Result<Node, Fail> {
        let Some(tok) = self.advance() else {
            return Err(text("find: invalid expression"));
        };
        if !self.actions.is_empty()
            && (self.nested == 0 || self.chain_action)
            && !self.in_or
            && self.is_test_after_action(tok)
        {
            return Err(say(&[
                b"find: ",
                tok,
                b": tests after actions are not supported",
            ]));
        }
        if VALUE_PREDICATES.contains(&tok) {
            self.predicates.push(tok.to_vec());
            let Some(value) = self.advance() else {
                if tok == b"-newermt" {
                    return Err(text("find: The '-newermt' test needs an argument"));
                }
                return Err(say(&[b"find: missing argument to `", tok, b"'"]));
            };
            return self.value_predicate(tok, value);
        }
        if is_exec(tok) {
            self.predicates.push(tok.to_vec());
            let action = self.exec(tok)?;
            let batch = matches!(action, Action::Exec { batch: true, .. });
            self.actions.push(action);
            return Ok(self.action_node("exec", batch));
        }
        if tok == b"-empty" {
            self.predicates.push(tok.to_vec());
            self.uses_empty = true;
            return Ok(Node::Empty);
        }
        if let Some((_, kind)) = ROW_ACTIONS.iter().find(|(word, _)| *word == tok) {
            self.predicates.push(tok.to_vec());
            self.actions.push(Action::Row { kind, file: None });
            if tok == b"-delete" {
                self.depth_first = true;
            }
            return Ok(self.action_node(kind, false));
        }
        if let Some((_, mode)) = ACCESS.iter().find(|(word, _)| *word == tok) {
            self.predicates.push(tok.to_vec());
            return Ok(Node::Access(*mode));
        }
        if BARE_PREDICATES.contains(&tok) {
            self.predicates.push(tok.to_vec());
            return Ok(self.bare_predicate(tok));
        }
        if [&b"-a"[..], b"-and", b"-o", b"-or"].contains(&tok) {
            return Err(say(&[
                b"find: invalid expression; you have used a binary operator '",
                tok,
                b"' with nothing before it.",
            ]));
        }
        if tok == b")" {
            return Err(text("find: you have too many ')'"));
        }
        if tok.starts_with(b"-") || tok == b"," {
            return Err(say(&[b"find: unknown predicate `", tok, b"'"]));
        }
        Err(say(&[b"find: paths must precede expression: `", tok, b"'"]))
    }

    /// A word that takes no argument and is neither an action nor an
    /// access test: a constant, `-prune`, `-quit`, or an option the walk
    /// reads (`-depth`, `-daystart`, `-follow`, `-xdev`).
    fn bare_predicate(&mut self, tok: &[u8]) -> Node {
        match tok {
            b"-prune" => Node::Prune,
            b"-quit" => Node::Quit,
            b"-false" => Node::Not(Box::new(Node::True)),
            b"-nouser" | b"-nogroup" => Node::NoOwner {
                group: tok == b"-nogroup",
            },
            b"-depth" => {
                self.depth_first = true;
                self.depth_option = true;
                Node::True
            }
            b"-daystart" => {
                self.daystart = true;
                Node::True
            }
            b"-follow" => {
                self.follow = true;
                Node::True
            }
            _ => Node::True,
        }
    }

    fn value_predicate(&mut self, tok: &'a [u8], value: &'a [u8]) -> Result<Node, Fail> {
        match tok {
            b"-name" | b"-iname" => Ok(Node::Name {
                pattern: value.to_vec(),
                icase: tok == b"-iname",
            }),
            b"-path" | b"-wholename" | b"-ipath" | b"-iwholename" => Ok(Node::Path {
                pattern: value.to_vec(),
                icase: tok.starts_with(b"-i"),
            }),
            b"-lname" | b"-ilname" => Ok(Node::Lname {
                pattern: value.to_vec(),
                icase: tok == b"-ilname",
            }),
            b"-regex" | b"-iregex" => self.regex(value, tok == b"-iregex"),
            b"-regextype" => {
                let Some((_, dialect, extended)) =
                    REGEX_TYPES.iter().find(|(name, _, _)| *name == value)
                else {
                    let listed: Vec<String> = REGEX_TYPES
                        .iter()
                        .map(|(name, _, _)| format!("'{}'", byte_text(name)))
                        .collect();
                    return Err(say(&[
                        b"find: Unknown regular expression type '",
                        value,
                        b"'; valid types are ",
                        listed.join(", ").as_bytes(),
                        b".",
                    ]));
                };
                self.regex_type = (*dialect, *extended);
                Ok(Node::True)
            }
            b"-type" => type_node(tok, value, Node::Type),
            b"-xtype" => type_node(tok, value, Node::XType),
            b"-perm" => {
                let (mode, bits) = perm(value, &mut self.warnings)?;
                Ok(Node::Perm { mode, bits })
            }
            b"-links" | b"-uid" | b"-gid" => {
                let (cmp, count) = count(tok, value)?;
                Ok(Node::Count {
                    field: match tok {
                        b"-links" => "links",
                        b"-uid" => "uid",
                        _ => "gid",
                    },
                    cmp,
                    count,
                })
            }
            b"-user" | b"-group" => {
                let group = tok == b"-group";
                if value.is_empty() {
                    let (what, id) = if group {
                        (&b"group"[..], &b"GID"[..])
                    } else {
                        (&b"user"[..], &b"UID"[..])
                    };
                    return Err(say(&[
                        b"find: invalid ",
                        what,
                        b" name or ",
                        id,
                        b" argument to ",
                        tok,
                        b": ''",
                    ]));
                }
                Ok(Node::Owner {
                    group,
                    name: value.to_vec(),
                })
            }
            b"-printf" => self.printf(value, None),
            b"-fprintf" => {
                let Some(format) = self.advance() else {
                    return Err(say(&[
                        b"find: invalid argument `",
                        value,
                        b"' to `",
                        tok,
                        b"'",
                    ]));
                };
                self.printf(format, Some(value.to_vec()))
            }
            b"-fprint" | b"-fprint0" => {
                let kind = if tok == b"-fprint" { "print" } else { "print0" };
                self.actions.push(Action::Row {
                    kind,
                    file: Some(value.to_vec()),
                });
                Ok(self.action_node(kind, false))
            }
            b"-files0-from" => {
                self.files0_from = Some(value.to_vec());
                Ok(Node::True)
            }
            b"-maxdepth" => {
                self.maxdepth = Some(depth(tok, value)?);
                Ok(Node::True)
            }
            b"-mindepth" => {
                self.mindepth = Some(depth(tok, value)?);
                Ok(Node::True)
            }
            b"-size" => {
                self.size = size(value)?;
                Ok(Node::True)
            }
            b"-newer" => {
                self.check_window_placement(tok)?;
                self.newer_token = Some(tok);
                self.newer.push(value.to_vec());
                Ok(Node::Time(Time::Newer(self.newer.len() - 1), self.fold()))
            }
            b"-newermt" => {
                self.check_window_placement(tok)?;
                self.newer_token = Some(tok);
                self.dates.push((value.to_vec(), self.newer.len()));
                Ok(Node::Time(Time::Newermt(value.to_vec()), self.fold()))
            }
            _ => {
                let (cmp, amount) = age(tok, value)?;
                Ok(Node::Time(
                    Time::Age {
                        field: tok[1],
                        minutes: tok.ends_with(b"min"),
                        cmp,
                        amount,
                        daystart: self.daystart,
                    },
                    self.fold(),
                ))
            }
        }
    }

    /// `-regex`: compiled here in the syntax the last `-regextype` before
    /// it named, so a pattern that cannot compile is refused where it
    /// was typed.
    fn regex(&mut self, pattern: &[u8], icase: bool) -> Result<Node, Fail> {
        let (dialect, extended) = self.regex_type;
        if let Err(why) = compile_regex(pattern, extended, false, dialect) {
            return Err(say(&[
                b"find: failed to compile regular expression '",
                pattern,
                b"': ",
                why.as_bytes(),
            ]));
        }
        Ok(Node::Regex {
            pattern: pattern.to_vec(),
            icase,
            dialect: if dialect == Dialect::Emacs {
                "emacs"
            } else {
                "posix"
            },
            extended,
        })
    }

    fn printf(&mut self, format: &[u8], file: Option<Vec<u8>>) -> Result<Node, Fail> {
        let parts = compile(format, &mut self.warnings)?;
        self.actions.push(Action::Printf {
            format: format.to_vec(),
            parts,
            file,
        });
        Ok(self.action_node("printf", false))
    }

    fn exec(&mut self, word: &[u8]) -> Result<Action, Fail> {
        let missing = || say(&[b"find: missing argument to `", word, b"'"]);
        let mut argv: Vec<Vec<u8>> = Vec::new();
        let mut batch = false;
        loop {
            let tok = self.advance().ok_or_else(missing)?;
            if tok == b";" {
                if argv.is_empty() {
                    return Err(say(&[b"find: invalid argument `;' to `", word, b"'"]));
                }
                break;
            }
            if tok == b"+" && argv.last().is_some_and(|last| contains(last, PLACEHOLDER)) {
                batch = true;
                break;
            }
            argv.push(tok.to_vec());
        }
        if batch {
            for arg in &argv {
                if contains(arg, PLACEHOLDER) && arg != PLACEHOLDER {
                    return Err(say(&[
                        b"find: In '",
                        word,
                        b" ... {} +' the '{}' must appear by itself, but you specified '",
                        arg,
                        b"'",
                    ]));
                }
            }
            if argv.iter().filter(|arg| *arg == PLACEHOLDER).count() > 1 {
                return Err(say(&[
                    b"find: Only one instance of {} is supported with ",
                    word,
                    b" ... +",
                ]));
            }
        }
        Ok(Action::Exec {
            argv,
            batch,
            dir: word == EXECDIR,
        })
    }

    fn settle_actions(&mut self, tree: &Node) -> Result<(), Fail> {
        check_positional(tree)?;
        let mut distinct: Vec<Action> = Vec::new();
        for action in self.actions.drain(..) {
            if !distinct.contains(&action) {
                distinct.push(action);
            }
        }
        if let [first, second, ..] = distinct.as_slice() {
            let message = match (first, second) {
                (Action::Exec { .. }, Action::Exec { .. }) => {
                    format!("find: -exec may run only one command {POSITIONAL}")
                }
                (Action::Printf { .. }, Action::Printf { .. }) => {
                    format!("find: -printf may print only one format {POSITIONAL}")
                }
                _ => format!(
                    "find: {} and {} cannot be combined {POSITIONAL}",
                    first.word(),
                    second.word()
                ),
            };
            return Err(text(&message));
        }
        check_exec_result(tree)?;
        self.actions = distinct;
        Ok(())
    }
}

fn check_positional(node: &Node) -> Result<(), Fail> {
    match node {
        Node::Not(kid) => {
            if kid.has_action() {
                return Err(text(&format!(
                    "find: {} is not supported under !",
                    kid.first_action()
                )));
            }
            check_positional(kid)
        }
        Node::And(kids) => {
            // An action may end its chain, or be followed by -quit alone.
            for (at, kid) in kids.iter().enumerate() {
                if kid.has_action() && !kids[at + 1..].iter().all(is_quit) {
                    return Err(text(&format!(
                        "find: {} must end its -a chain {POSITIONAL}",
                        kid.first_action()
                    )));
                }
            }
            kids.iter().try_for_each(check_positional)
        }
        Node::Or(kids) => kids.iter().try_for_each(check_positional),
        _ => Ok(()),
    }
}

fn check_exec_result(node: &Node) -> Result<(), Fail> {
    match node {
        Node::Or(kids) => {
            for kid in &kids[..kids.len() - 1] {
                if kid.holds_exec_result() {
                    return Err(text(&format!(
                        "find: -exec must end the expression {POSITIONAL}"
                    )));
                }
            }
            kids.iter().try_for_each(check_exec_result)
        }
        Node::Not(kid) => check_exec_result(kid),
        Node::And(kids) => kids.iter().try_for_each(check_exec_result),
        _ => Ok(()),
    }
}

/// `-type` and `-xtype` as the reference reads them: one or more letters from
/// `bcdpfls` separated by commas, a list holding any of them.
fn type_node(flag: &[u8], value: &[u8], node: fn(u8) -> Node) -> Result<Node, Fail> {
    if value.is_empty() {
        return Err(say(&[
            b"find: Arguments to ",
            flag,
            b" should contain at least one letter",
        ]));
    }
    let ending = || {
        say(&[
            b"find: Last file type in list argument to ",
            flag,
            b" is missing, i.e., list is ending on: ','",
        ])
    };
    let mut kinds = Vec::new();
    let mut at = 0;
    loop {
        let kind = *value.get(at).ok_or_else(ending)?;
        if !TYPES.contains(&kind) {
            return Err(say(&[b"find: Unknown argument to ", flag, b": ", &[kind]]));
        }
        kinds.push(node(kind));
        at += 1;
        if at == value.len() {
            break;
        }
        if value[at] != b',' {
            return Err(say(&[
                b"find: Must separate multiple arguments to ",
                flag,
                b" using: ','",
            ]));
        }
        at += 1;
    }
    if kinds.len() == 1 {
        return Ok(kinds.remove(0));
    }
    Ok(Node::Or(kinds))
}

/// `-maxdepth` and `-mindepth`: a word of ASCII digits no larger than
/// `INT_MAX`.
fn depth(flag: &[u8], value: &[u8]) -> Result<u64, Fail> {
    if value.is_empty() || !value.iter().all(u8::is_ascii_digit) {
        let mut quoted: Vec<u8> = Vec::new();
        for &byte in value {
            if byte == b'\'' {
                quoted.push(b'\\');
            }
            quoted.push(byte);
        }
        return Err(say(&[
            b"find: Expected a positive decimal integer argument to ",
            flag,
            b", but got '",
            &quoted,
            b"'",
        ]));
    }
    let digits = byte_text(value);
    match digits.parse::<u64>() {
        Ok(n) if n <= i32::MAX as u64 => Ok(n),
        _ => Err(say(&[
            b"find: ",
            value,
            b": ",
            crate::number::ERANGE.as_bytes(),
        ])),
    }
}

/// `-size`: the last character names the unit (`b`, `c`, `w`, `k`, `M`,
/// `G`), a bare number counting 512-byte blocks. The file size rounds up to
/// whole units before comparing, so `+N`, `-N` and `N` come back as
/// inclusive byte bounds.
fn size(spec: &[u8]) -> Result<(Option<i128>, Option<i128>), Fail> {
    let Some(&last) = spec.last() else {
        return Err(text("find: invalid null argument to -size"));
    };
    let (unit, body): (i128, &[u8]) = match last {
        b'0'..=b'9' => (512, spec),
        b'b' => (512, &spec[..spec.len() - 1]),
        b'c' => (1, &spec[..spec.len() - 1]),
        b'w' => (2, &spec[..spec.len() - 1]),
        b'k' => (1024, &spec[..spec.len() - 1]),
        b'M' => (1024 * 1024, &spec[..spec.len() - 1]),
        b'G' => (1024 * 1024 * 1024, &spec[..spec.len() - 1]),
        _ => return Err(say(&[b"find: invalid -size type `", &[last], b"'"])),
    };
    let invalid = || say(&[b"find: Invalid argument `", spec, b"' to -size"]);
    let sign = body.first().copied().filter(|b| *b == b'+' || *b == b'-');
    let number = &body[usize::from(sign.is_some())..];
    let blanks = number
        .iter()
        .take_while(|b| crate::number::BLANKS.contains(b))
        .count();
    let number = &number[blanks..];
    let number = number.strip_prefix(b"+").unwrap_or(number);
    if number.is_empty() || !number.iter().all(u8::is_ascii_digit) {
        return Err(invalid());
    }
    let n = byte_text(number).parse::<u64>().map_err(|_| invalid())? as i128;
    Ok(match sign {
        Some(b'+') => (Some(n * unit + 1), None),
        Some(_) => (None, Some((n - 1) * unit)),
        None => (Some((n - 1) * unit + 1), Some(n * unit)),
    })
}

/// A comparison's sign: `+N` is more than N, `-N` less, and a bare N
/// exactly N.
fn signed(spec: &[u8]) -> (u8, &[u8]) {
    match spec.first() {
        Some(b'+') => (b'+', &spec[1..]),
        Some(b'-') => (b'-', &spec[1..]),
        _ => (b'=', spec),
    }
}

/// `-mtime` and the other age tests: a sign, then what C's strtod reads
/// to the end of the word, so a fraction, an exponent or a hex float
/// counts, leading blanks are skipped and nothing may trail. NaN is
/// refused in words of its own, as is a count too large for a double.
fn age(flag: &[u8], spec: &[u8]) -> Result<(u8, f64), Fail> {
    let invalid = || say(&[b"find: invalid argument `", spec, b"' to `", flag, b"'"]);
    let (cmp, body) = signed(spec);
    let Some((amount, end)) = strtod_prefix(body) else {
        return Err(invalid());
    };
    if end != body.len() {
        return Err(invalid());
    }
    if amount.is_nan() {
        return Err(say(&[
            b"find: invalid not-a-number argument: `",
            body,
            b"'",
        ]));
    }
    let digits = body.trim_ascii_start();
    let digits = digits
        .strip_prefix(b"+")
        .or_else(|| digits.strip_prefix(b"-"))
        .unwrap_or(digits);
    let spelled = digits.len() >= 3 && digits[..3].eq_ignore_ascii_case(b"inf");
    if amount.is_infinite() && !spelled {
        return Err(invalid());
    }
    Ok((cmp, amount))
}

/// `-links`, `-uid` and `-gid`: a sign, then a whole number C's
/// strtoumax reads to the end of the word, blanks before it allowed but
/// a second sign that is a minus refused.
fn count(flag: &[u8], spec: &[u8]) -> Result<(u8, u64), Fail> {
    let refused = || say(&[b"find: non-numeric argument to ", flag, b": '", spec, b"'"]);
    let (cmp, body) = signed(spec);
    let digits = body.trim_ascii_start();
    let digits = digits.strip_prefix(b"+").unwrap_or(digits);
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        return Err(refused());
    }
    let count = byte_text(digits).parse::<u64>().map_err(|_| refused())?;
    Ok((cmp, count))
}

const SPECIAL_SETUID: u32 = 0o4000;
const SPECIAL_SETGID: u32 = 0o2000;
const SPECIAL_STICKY: u32 = 0o1000;

/// The permission bits a class letter names in the low nine bits.
fn class_bits(who: u8) -> u32 {
    match who {
        b'u' => 0o700,
        b'g' => 0o070,
        b'o' => 0o007,
        _ => 0o777,
    }
}

/// `-perm`: an octal mode up to 07777 or a symbolic one applied to no
/// bits at all, either after a `-` (every bit set) or a `/` (any bit
/// set), or alone (exactly these bits). A symbolic mode is chmod's
/// grammar: clauses joined by commas, each a run of `ugoa` and one or
/// more operations, each `+`, `-` or `=` with letters from `rwxXst` or
/// one class to copy. Nothing is masked: no umask applies to a mode
/// that only compares.
fn perm(spec: &[u8], warnings: &mut Vec<Vec<u8>>) -> Result<(u32, Bits), Fail> {
    let invalid = || say(&[b"find: invalid mode '", spec, b"'"]);
    let (bits, body) = match spec.first() {
        Some(b'-') => (Bits::All, &spec[1..]),
        Some(b'/') => (Bits::Any, &spec[1..]),
        _ => (Bits::Exact, spec),
    };
    if body.is_empty() {
        return Err(invalid());
    }
    let mode = if body.iter().all(|b| (b'0'..=b'7').contains(b)) {
        u32::from_str_radix(&byte_text(body), 8)
            .ok()
            .filter(|mode| *mode <= 0o7777)
            .ok_or_else(invalid)?
    } else {
        symbolic(body).ok_or_else(invalid)?
    };
    if matches!(bits, Bits::Any) && mode == 0 {
        warn_line(
            warnings,
            &[
                b"you have specified a mode pattern ",
                spec,
                b" (which is equivalent to /000). The meaning of -perm /000 has now been \
                  changed to be consistent with -perm -000; that is, while it used to match no \
                  files, it now matches all files.",
            ],
        );
    }
    Ok((mode, bits))
}

fn symbolic(body: &[u8]) -> Option<u32> {
    let mut mode = 0u32;
    for clause in body.split(|b| *b == b',') {
        let who_end = clause
            .iter()
            .position(|b| !b"ugoa".contains(b))
            .unwrap_or(clause.len());
        let who = &clause[..who_end];
        let mask = if who.is_empty() {
            0o777
        } else {
            who.iter().fold(0, |mask, w| mask | class_bits(*w))
        };
        let special = |letters: &[u8]| -> u32 {
            let mut bits = 0;
            if letters.contains(&b's') {
                if who.is_empty() || who.iter().any(|w| b"ua".contains(w)) {
                    bits |= SPECIAL_SETUID;
                }
                if who.is_empty() || who.iter().any(|w| b"ga".contains(w)) {
                    bits |= SPECIAL_SETGID;
                }
            }
            if letters.contains(&b't') && (who.is_empty() || who.iter().any(|w| b"oa".contains(w)))
            {
                bits |= SPECIAL_STICKY;
            }
            bits
        };
        let mut at = who_end;
        if at == clause.len() {
            return None;
        }
        while at < clause.len() {
            let op = clause[at];
            if !b"+-=".contains(&op) {
                return None;
            }
            at += 1;
            let start = at;
            let add = if clause.get(at).is_some_and(|b| b"ugo".contains(b)) {
                let shift = match clause[at] {
                    b'u' => 6,
                    b'g' => 3,
                    _ => 0,
                };
                at += 1;
                let rwx = (mode >> shift) & 0o7;
                (rwx * 0o111) & mask
            } else {
                while clause.get(at).is_some_and(|b| b"rwxXst".contains(b)) {
                    at += 1;
                }
                let letters = &clause[start..at];
                let mut rwx = 0;
                for (letter, bit) in [(b'r', 0o4), (b'w', 0o2), (b'x', 0o1)] {
                    if letters.contains(&letter) {
                        rwx |= bit;
                    }
                }
                if letters.contains(&b'X') && mode & 0o111 != 0 {
                    rwx |= 0o1;
                }
                ((rwx * 0o111) & mask) | special(letters)
            };
            match op {
                b'+' => mode |= add,
                b'-' => mode &= !add,
                _ => mode = (mode & !(mask | special(b"st"))) | add,
            }
        }
    }
    Some(mode)
}

fn warn_line(warnings: &mut Vec<Vec<u8>>, parts: &[&[u8]]) {
    let mut line = b"find: warning: ".to_vec();
    for part in parts {
        line.extend_from_slice(part);
    }
    warnings.push(line);
}

fn push_literal(parts: &mut Vec<Part>, bytes: &[u8]) {
    if let Some(Part::Lit(run)) = parts.last_mut() {
        run.extend_from_slice(bytes);
    } else {
        parts.push(Part::Lit(bytes.to_vec()));
    }
}

/// `-printf` compiled once: escapes become literal bytes, a directive the
/// host renders per entry keeps its letter, and an escape or directive GNU
/// does not know stays literal after its warning. A `%` ending the format
/// is an error.
fn compile(format: &[u8], warnings: &mut Vec<Vec<u8>>) -> Result<Vec<Part>, Fail> {
    let mut parts: Vec<Part> = Vec::new();
    let mut at = 0;
    while at < format.len() {
        let byte = format[at];
        if byte == b'\\' {
            let Some(&next) = format.get(at + 1) else {
                warn_line(warnings, &[b"escape `\\' followed by nothing at all"]);
                push_literal(&mut parts, b"\\");
                at += 1;
                continue;
            };
            let literal = match next {
                b'n' => Some(b'\n'),
                b't' => Some(b'\t'),
                b'r' => Some(b'\r'),
                b'0' => Some(0),
                b'\\' => Some(b'\\'),
                b'a' => Some(7),
                b'b' => Some(8),
                b'f' => Some(12),
                b'v' => Some(11),
                _ => None,
            };
            match literal {
                Some(byte) => push_literal(&mut parts, &[byte]),
                None => {
                    warn_line(warnings, &[b"unrecognized escape `\\", &[next], b"'"]);
                    push_literal(&mut parts, &[b'\\', next]);
                }
            }
            at += 2;
            continue;
        }
        if byte != b'%' {
            push_literal(&mut parts, &[byte]);
            at += 1;
            continue;
        }
        let Some(&code) = format.get(at + 1) else {
            return Err(text("find: error: % at end of format string"));
        };
        at += 2;
        if code == b'%' {
            push_literal(&mut parts, b"%");
        } else if DIRECTIVES.contains(&code) {
            parts.push(Part::Dir(code));
        } else if code == b'T' {
            match format.get(at) {
                Some(&letter) => {
                    at += 1;
                    if TIME_LETTERS.contains(&letter) {
                        parts.push(Part::Time(letter));
                    } else if letter.is_ascii_alphanumeric() {
                        push_literal(&mut parts, &[b'%', letter]);
                    } else {
                        warn_line(
                            warnings,
                            &[b"unrecognized format directive `%T", &[letter], b"'"],
                        );
                        push_literal(&mut parts, &[b'%', b'T', letter]);
                    }
                }
                None => {
                    warn_line(
                        warnings,
                        &[b"format directive `%T' should be followed by another character"],
                    );
                    push_literal(&mut parts, b"%T");
                }
            }
        } else {
            warn_line(
                warnings,
                &[b"unrecognized format directive `%", &[code], b"'"],
            );
            push_literal(&mut parts, &[b'%', code]);
        }
    }
    Ok(parts)
}

#[cfg(test)]
mod tests {
    use serde_json::{Value as Json, json};

    use crate::scan::tests::{refusal, scan};

    fn tape(tokens: &[&str]) -> Vec<(&'static str, Vec<u8>)> {
        tokens
            .iter()
            .map(|token| (crate::scan::OPERAND, token.as_bytes().to_vec()))
            .collect()
    }

    fn run(command: &str, tokens: &[&str]) -> Result<Json, (Vec<u8>, i32)> {
        let owned = tape(tokens);
        let options: Vec<(&str, &[u8])> = owned.iter().map(|(n, b)| (*n, b.as_slice())).collect();
        scan(command, &options)
    }

    fn parse(tokens: &[&str]) -> Json {
        run("find", tokens).expect("parsed")
    }

    fn refuse(tokens: &[&str]) -> String {
        let owned = tape(tokens);
        let options: Vec<(&str, &[u8])> = owned.iter().map(|(n, b)| (*n, b.as_slice())).collect();
        let (shown, status) = refusal("find", &options);
        assert_eq!(status, 1, "{tokens:?}");
        shown
    }

    fn name(pattern: &str) -> Json {
        json!({"op": "name", "pattern": pattern, "icase": false})
    }

    fn age(cmp: &str, amount: f64, fold: &str) -> Json {
        json!({
            "op": "age",
            "field": "m",
            "minutes": false,
            "cmp": cmp,
            "amount": amount,
            "daystart": false,
            "fold": fold,
        })
    }

    #[test]
    fn an_expression_is_a_tree_of_tests_and_connectives() {
        assert_eq!(parse(&[])["tree"], json!({"op": "true"}));
        assert_eq!(
            parse(&["!", "-name", "*.txt"])["tree"],
            json!({"op": "not", "kid": name("*.txt")})
        );
        assert_eq!(
            parse(&["-name", "a", "-o", "-name", "b", "-name", "c"])["tree"],
            json!({"op": "or", "kids": [
                name("a"),
                {"op": "and", "kids": [name("b"), name("c")]},
            ]})
        );
        assert_eq!(
            parse(&["(", "-name", "a", "-o", "-name", "b", ")", "-type", "f"])["tree"],
            json!({"op": "and", "kids": [
                {"op": "or", "kids": [name("a"), name("b")]},
                {"op": "type", "kind": "f"},
            ]})
        );
    }

    #[test]
    fn the_start_points_are_the_words_before_the_expression() {
        assert_eq!(parse(&["a", "b", "-name", "x"])["start"], json!(2));
        assert_eq!(parse(&["-L", "a", "-print"])["start"], json!(2));
        assert_eq!(parse(&["a", "!", "-name", "x"])["start"], json!(1));
        let laid = run(
            "find_layout",
            &[
                "/d", "-exec", "echo", "{}", ";", "-name", "x", "-exec", "a", "{}", "+",
            ],
        )
        .expect("laid");
        assert_eq!(laid["start"], json!(1));
        assert_eq!(laid["spans"], json!([[1, 4], [7, 10]]));
        assert_eq!(
            run("find_layout", &["-exec", "a", "b"]).expect("laid")["spans"],
            json!([[0, 2]])
        );
    }

    #[test]
    fn depth_limits_are_ascii_digits_up_to_int_max() {
        let read = parse(&["-maxdepth", "00", "-mindepth", "2147483647"]);
        assert_eq!(
            (read["maxdepth"].clone(), read["mindepth"].clone()),
            (json!(0), json!(2147483647))
        );
        for bad in ["abc", "-1", "1_0", "", "1.5", " 1", "+1", "1x", "0x1", "1 "] {
            assert_eq!(
                refuse(&["-maxdepth", bad]),
                format!(
                    "find: Expected a positive decimal integer argument to -maxdepth, but got '{bad}'"
                )
            );
        }
        assert_eq!(
            refuse(&["-mindepth", "a'b"]),
            "find: Expected a positive decimal integer argument to -mindepth, but got 'a\\'b'"
        );
        for big in ["2147483648", "99999999999999999999"] {
            assert_eq!(
                refuse(&["-maxdepth", big]),
                format!("find: {big}: Numerical result out of range")
            );
        }
    }

    #[test]
    fn a_size_is_inclusive_byte_bounds_in_its_unit() {
        for (spec, bounds) in [
            ("+50c", (json!("51"), Json::Null)),
            ("-2c", (Json::Null, json!("1"))),
            ("2c", (json!("2"), json!("2"))),
            ("1k", (json!("1"), json!("1024"))),
            ("+1", (json!("513"), Json::Null)),
            ("-1", (Json::Null, json!("0"))),
            ("0", (json!("-511"), json!("0"))),
            ("+ 1c", (json!("2"), Json::Null)),
        ] {
            let read = parse(&["-size", spec]);
            assert_eq!(
                (read["min_size"].clone(), read["max_size"].clone()),
                bounds,
                "{spec}"
            );
        }
        let top = parse(&["-size", "18446744073709551615G"]);
        assert_eq!(
            top["max_size"],
            json!((i128::from(u64::MAX) << 30).to_string())
        );
    }

    #[test]
    fn a_size_refusal_is_gnus() {
        for (spec, shown) in [
            ("", "find: invalid null argument to -size"),
            ("abc", "find: Invalid argument `abc' to -size"),
            ("5x", "find: invalid -size type `x'"),
            ("1.5", "find: Invalid argument `1.5' to -size"),
            ("+-1", "find: Invalid argument `+-1' to -size"),
            ("+1_0c", "find: Invalid argument `+1_0c' to -size"),
            (
                "18446744073709551616c",
                "find: Invalid argument `18446744073709551616c' to -size",
            ),
            ("+", "find: invalid -size type `+'"),
        ] {
            assert_eq!(refuse(&["-size", spec]), shown, "{spec:?}");
        }
    }

    #[test]
    fn a_time_test_keeps_its_operands_and_how_it_folds() {
        let read = parse(&["-mtime", "+3", "-mtime", "-1", "-o", "-mtime", "2"]);
        assert_eq!(
            read["tree"],
            json!({"op": "or", "kids": [
                {"op": "and", "kids": [age("+", 3.0, "all"), age("-", 1.0, "all")]},
                age("=", 2.0, "any"),
            ]})
        );
        let read = parse(&["-newermt", "2020-01-01", "-newer", "r"]);
        assert_eq!(
            read["tree"],
            json!({"op": "and", "kids": [
                {"op": "newermt", "date": "2020-01-01", "fold": "all"},
                {"op": "newer", "index": 0, "fold": "all"},
            ]})
        );
        assert_eq!(read["newer"], json!(["r"]));
        assert_eq!(read["dates"], json!([["2020-01-01", 0]]));
        let read = parse(&["-newer", "r", "-newermt", "nope"]);
        assert_eq!(read["dates"], json!([["nope", 1]]));
        assert_eq!(parse(&["-mtime", "2"])["tree"]["cmp"], json!("="));
        assert_eq!(parse(&["-mtime", " 2"])["tree"]["amount"], json!(2.0));
        assert_eq!(
            parse(&["(", "-mtime", "1", ")"])["tree"]["fold"],
            json!("any")
        );
    }

    #[test]
    fn a_time_refusal_is_gnus() {
        let past_a_double = "9".repeat(400);
        for spec in ["abc", "", "+", "1_0", "2x", "1,5", "2 ", &past_a_double] {
            assert_eq!(
                refuse(&["-mtime", spec]),
                format!("find: invalid argument `{spec}' to `-mtime'")
            );
        }
        assert_eq!(
            parse(&["-mtime", "99999999999999999999"])["tree"]["amount"],
            json!(1e20)
        );
        assert_eq!(
            refuse(&["-newer", "a", "-o", "-name", "b"]),
            "find: -newer is supported only in a top-level -a chain, not under -o, ! or parentheses"
        );
        assert_eq!(
            refuse(&["!", "-newermt", "x"]),
            "find: -newermt is supported only in a top-level -a chain, not under -o, ! or parentheses"
        );
    }

    #[test]
    fn a_type_is_a_comma_list_of_letters() {
        assert_eq!(
            parse(&["-type", "l"])["tree"],
            json!({"op": "type", "kind": "l"})
        );
        assert_eq!(
            parse(&["-type", "f,d"])["tree"],
            json!({"op": "or", "kids": [{"op": "type", "kind": "f"}, {"op": "type", "kind": "d"}]})
        );
        for (value, shown) in [
            (
                "",
                "find: Arguments to -type should contain at least one letter",
            ),
            ("zz", "find: Unknown argument to -type: z"),
            ("f,x", "find: Unknown argument to -type: x"),
            (",f", "find: Unknown argument to -type: ,"),
            (
                "ff",
                "find: Must separate multiple arguments to -type using: ','",
            ),
            (
                "file",
                "find: Must separate multiple arguments to -type using: ','",
            ),
            (
                "f,",
                "find: Last file type in list argument to -type is missing, i.e., list is ending on: ','",
            ),
        ] {
            assert_eq!(refuse(&["-type", value]), shown, "{value:?}");
        }
    }

    #[test]
    fn a_word_the_grammar_lacks_is_refused_in_gnus_words() {
        assert_eq!(refuse(&["-bogus"]), "find: unknown predicate `-bogus'");
        assert_eq!(refuse(&["-ok", "x"]), "find: unknown predicate `-ok'");
        assert_eq!(
            refuse(&["-name", "a", "b"]),
            "find: paths must precede expression: `b'"
        );
        assert_eq!(
            refuse(&["-print", "x"]),
            "find: paths must precede expression: `x'"
        );
        assert_eq!(refuse(&["-name"]), "find: missing argument to `-name'");
        assert_eq!(
            refuse(&["-newermt"]),
            "find: The '-newermt' test needs an argument"
        );
        assert_eq!(refuse(&["-newer"]), "find: missing argument to `-newer'");
        assert_eq!(refuse(&["-printf"]), "find: missing argument to `-printf'");
    }

    #[test]
    fn parentheses_and_operators_refuse_in_gnus_words() {
        let open = "find: invalid expression; I was expecting to find a ')' somewhere but did not see one.";
        let bare = "find: invalid expression; expected to find a ')' but didn't see one. Perhaps you need an extra predicate after '('";
        assert_eq!(refuse(&["(", "-name", "a"]), open);
        assert_eq!(refuse(&["("]), bare);
        assert_eq!(refuse(&["-name", "a", "("]), bare);
        assert_eq!(refuse(&["-name", "a", ")"]), "find: you have too many ')'");
        assert_eq!(
            refuse(&["(", ")", "-name", "a"]),
            "find: invalid expression; empty parentheses are not allowed."
        );
        for op in ["-o", "-a", "-or", "-and"] {
            assert_eq!(
                refuse(&[op, "-name", "a"]),
                format!(
                    "find: invalid expression; you have used a binary operator '{op}' with nothing before it."
                )
            );
        }
        assert_eq!(
            refuse(&["-name", "a", "-o"]),
            "find: expected an expression after '-o'"
        );
        assert_eq!(refuse(&["!"]), "find: expected an expression after '!'");
        assert_eq!(
            refuse(&["(", "!", ")"]),
            "find: expected an expression between '!' and ')'"
        );
        let deep: Vec<&str> = std::iter::repeat_n("(", 500)
            .chain(["-name", "x"])
            .chain(std::iter::repeat_n(")", 500))
            .collect();
        assert_eq!(refuse(&deep), "find: expression too deeply nested");
    }

    #[test]
    fn an_exec_owns_its_words_to_the_terminator() {
        let read = parse(&["-name", "*.txt", "-exec", "echo", "got", "{}", ";"]);
        assert_eq!(
            read["actions"],
            json!([{"kind": "exec", "argv": ["echo", "got", "{}"], "batch": false, "dir": false}])
        );
        assert_eq!(
            read["tree"],
            json!({"op": "and", "kids": [name("*.txt"), {"op": "action", "kind": "exec", "batch": false}]})
        );
        assert_eq!(
            parse(&["-exec", "echo", "{}", "+"])["actions"][0]["batch"],
            json!(true)
        );
        for (tokens, shown) in [
            (vec!["-exec"], "find: missing argument to `-exec'"),
            (vec!["-exec", ";"], "find: invalid argument `;' to `-exec'"),
            (vec!["-exec", "+"], "find: missing argument to `-exec'"),
            (
                vec!["-exec", "echo", "{}"],
                "find: missing argument to `-exec'",
            ),
            (
                vec!["-exec", "echo", "x{}y", "+"],
                "find: In '-exec ... {} +' the '{}' must appear by itself, but you specified 'x{}y'",
            ),
            (
                vec!["-exec", "echo", "{}", "{}", "+"],
                "find: Only one instance of {} is supported with -exec ... +",
            ),
        ] {
            assert_eq!(refuse(&tokens), shown, "{tokens:?}");
        }
    }

    #[test]
    fn actions_keep_the_order_written_and_flag_depth_first() {
        let read = parse(&[
            "-delete", "-exec", "echo", "{}", ";", "-print0", "-ls", "-print",
        ]);
        let kinds: Vec<Json> = read["actions"]
            .as_array()
            .expect("actions")
            .iter()
            .map(|a| a["kind"].clone())
            .collect();
        assert_eq!(
            kinds,
            [
                json!("delete"),
                json!("exec"),
                json!("print0"),
                json!("ls"),
                json!("print")
            ]
        );
        assert_eq!(read["depth_first"], json!(true));
        assert_eq!(parse(&["-depth"])["depth_first"], json!(true));
        assert_eq!(parse(&["-print"])["depth_first"], json!(false));
        assert_eq!(
            parse(&["-xdev", "-prune", "-empty"])["predicates"],
            json!(["-xdev", "-prune", "-empty"])
        );
        assert_eq!(parse(&["-empty"])["uses_empty"], json!(true));
    }

    #[test]
    fn a_prune_beside_delete_needs_depth_spelled_out() {
        let shown = "find: The -delete action automatically turns on -depth, but -prune does nothing when -depth is in effect.  If you want to carry on anyway, just explicitly use the -depth option.";
        assert_eq!(
            refuse(&["-delete", "-prune"]),
            "find: -prune: tests after actions are not supported"
        );
        assert_eq!(refuse(&["-prune", "-delete"]), shown);
        assert_eq!(
            parse(&["-depth", "-prune", "-delete"])["tree"]["kids"][1],
            json!({"op": "true"})
        );
    }

    #[test]
    fn a_test_after_an_action_is_refused() {
        assert_eq!(
            refuse(&["-print", "-name", "a"]),
            "find: -name: tests after actions are not supported"
        );
        assert!(run("find", &["-print", "-maxdepth", "1"]).is_ok());
    }

    #[test]
    fn an_action_under_a_connective_must_be_the_one_the_tree_reaches() {
        let one = parse(&["-name", "a", "-print", "-o", "-name", "b", "-print"]);
        assert_eq!(one["actions"], json!([{"kind": "print", "file": null}]));
        for (tokens, shown) in [
            (
                vec!["-name", "a", "-print", "-o", "-name", "b", "-print0"],
                "find: -print and -print0 cannot be combined under -o, ! or parentheses",
            ),
            (
                vec!["(", "-name", "a", "-print", ")", "-print"],
                "find: -print must end its -a chain under -o, ! or parentheses",
            ),
            (vec!["!", "-print"], "find: -print is not supported under !"),
            (
                vec![
                    "-name", "a", "-printf", "A", "-o", "-name", "b", "-printf", "B",
                ],
                "find: -printf may print only one format under -o, ! or parentheses",
            ),
            (
                vec![
                    "-name", "a", "-exec", "true", ";", "-o", "-exec", "false", ";",
                ],
                "find: -exec may run only one command under -o, ! or parentheses",
            ),
            (
                vec!["-type", "d", "-exec", "false", "{}", ";", "-o", "-prune"],
                "find: -exec must end the expression under -o, ! or parentheses",
            ),
        ] {
            assert_eq!(refuse(&tokens), shown, "{tokens:?}");
        }
        assert_eq!(
            parse(&["-type", "d", "-exec", "echo", "{}", "+", "-o", "-prune"])["tree"]["kind"],
            Json::Null
        );
    }

    #[test]
    fn printf_compiles_to_literals_and_directives() {
        let read = parse(&["-printf", "%p\\t%Y-%Tm|%%\\n"]);
        assert_eq!(
            read["actions"][0]["parts"],
            json!([
                {"dir": "p"},
                {"lit": "\t"},
                {"dir": "Y"},
                {"lit": "-"},
                {"time": "m"},
                {"lit": "|%\n"},
            ])
        );
        assert_eq!(read["actions"][0]["stat"], json!(true));
        assert_eq!(
            parse(&["-printf", "%p\\n"])["actions"][0]["stat"],
            json!(false)
        );
        assert_eq!(read["warnings"], json!([]));
    }

    #[test]
    fn printf_warns_per_occurrence_in_gnus_words_and_keeps_the_text() {
        let read = parse(&["-printf", "\\q%z%z\\"]);
        assert_eq!(
            read["warnings"],
            json!([
                "find: warning: unrecognized escape `\\q'",
                "find: warning: unrecognized format directive `%z'",
                "find: warning: unrecognized format directive `%z'",
                "find: warning: escape `\\' followed by nothing at all",
            ])
        );
        assert_eq!(read["actions"][0]["parts"], json!([{"lit": "\\q%z%z\\"}]));
        assert_eq!(
            parse(&["-printf", "%T"])["warnings"],
            json!(["find: warning: format directive `%T' should be followed by another character"])
        );
        assert_eq!(
            parse(&["-printf", "%Tq"])["actions"][0]["parts"],
            json!([{"lit": "%q"}])
        );
    }

    #[test]
    fn printf_refuses_a_percent_that_ends_the_format_after_the_warnings_before_it() {
        assert_eq!(
            refuse(&["-printf", "abc%"]),
            "find: error: % at end of format string"
        );
        assert_eq!(
            refuse(&["-printf", "\\q%"]),
            "find: warning: unrecognized escape `\\q'\nfind: error: % at end of format string"
        );
        assert_eq!(
            refuse(&["-printf", "\\q", "-bogus"]),
            "find: warning: unrecognized escape `\\q'\nfind: unknown predicate `-bogus'"
        );
    }

    #[test]
    fn the_first_bad_word_in_the_order_written_names_the_refusal() {
        assert_eq!(
            refuse(&["-mtime", "abc", "-size", "abc"]),
            "find: invalid argument `abc' to `-mtime'"
        );
        assert_eq!(
            refuse(&["-size", "abc", "-mtime", "abc"]),
            "find: Invalid argument `abc' to -size"
        );
        assert_eq!(
            refuse(&["-bogus", "-mtime", "abc"]),
            "find: unknown predicate `-bogus'"
        );
        assert_eq!(
            refuse(&["-maxdepth", "2147483648", "-mindepth", "abc"]),
            "find: 2147483648: Numerical result out of range"
        );
    }

    #[test]
    fn a_word_that_is_not_an_option_of_the_grammar_is_the_hosts_mistake() {
        let (shown, status) = refusal("find", &[("name", b"x")]);
        assert_eq!(
            (shown.as_str(), status),
            ("scan: find reads no option name", 1)
        );
    }

    #[test]
    fn an_age_reads_a_sign_then_what_strtod_reads() {
        for (spec, cmp, amount) in [
            ("1.5", "=", 1.5),
            (".5", "=", 0.5),
            ("1e1", "=", 10.0),
            ("0x10", "=", 16.0),
            (" 1", "=", 1.0),
            ("+-1", "+", -1.0),
            ("-1.5", "-", 1.5),
        ] {
            let read = parse(&["-mmin", spec]);
            assert_eq!(read["tree"]["cmp"], json!(cmp), "{spec}");
            assert_eq!(read["tree"]["amount"], json!(amount), "{spec}");
            assert_eq!(read["tree"]["minutes"], json!(true), "{spec}");
        }
        assert_eq!(
            parse(&["-mmin", "inf"])["tree"]["amount"],
            json!("Infinity")
        );
        assert_eq!(
            parse(&["-mmin", "--inf"])["tree"]["amount"],
            json!("-Infinity")
        );
        for (flag, field, minutes) in [
            ("-atime", "a", false),
            ("-ctime", "c", false),
            ("-amin", "a", true),
            ("-cmin", "c", true),
        ] {
            let read = parse(&[flag, "1"]);
            assert_eq!(read["tree"]["field"], json!(field), "{flag}");
            assert_eq!(read["tree"]["minutes"], json!(minutes), "{flag}");
        }
        for (spec, shown) in [
            ("1 ", "find: invalid argument `1 ' to `-mmin'"),
            ("1e400", "find: invalid argument `1e400' to `-mmin'"),
            ("x", "find: invalid argument `x' to `-mmin'"),
            ("nan", "find: invalid not-a-number argument: `nan'"),
            ("+nan", "find: invalid not-a-number argument: `nan'"),
        ] {
            assert_eq!(refuse(&["-mmin", spec]), shown, "{spec:?}");
        }
        assert_eq!(
            refuse(&["-ctime", ""]),
            "find: invalid argument `' to `-ctime'"
        );
    }

    #[test]
    fn daystart_marks_the_time_tests_after_it() {
        let read = parse(&["-mtime", "0", "-daystart", "-mmin", "-5"]);
        assert_eq!(read["tree"]["kids"][0]["daystart"], json!(false));
        assert_eq!(read["tree"]["kids"][1], json!({"op": "true"}));
        assert_eq!(read["tree"]["kids"][2]["daystart"], json!(true));
    }

    #[test]
    fn a_count_is_a_sign_and_a_whole_number() {
        assert_eq!(
            parse(&["-links", "+1"])["tree"],
            json!({"op": "count", "field": "links", "cmp": "+", "count": 1})
        );
        assert_eq!(parse(&["-uid", " 0"])["tree"]["count"], json!(0));
        assert_eq!(parse(&["-gid", "-1"])["tree"]["cmp"], json!("-"));
        for (flag, spec) in [
            ("-links", "x"),
            ("-links", "1 "),
            ("-links", "+-1"),
            ("-links", ""),
            ("-uid", "99999999999999999999"),
            ("-gid", "x"),
        ] {
            assert_eq!(
                refuse(&[flag, spec]),
                format!("find: non-numeric argument to {flag}: '{spec}'")
            );
        }
    }

    #[test]
    fn an_owner_is_any_name_but_the_empty_one() {
        assert_eq!(
            parse(&["-user", "alice"])["tree"],
            json!({"op": "owner", "group": false, "name": "alice"})
        );
        assert_eq!(
            refuse(&["-user", ""]),
            "find: invalid user name or UID argument to -user: ''"
        );
        assert_eq!(
            refuse(&["-group", ""]),
            "find: invalid group name or GID argument to -group: ''"
        );
        assert_eq!(
            parse(&["-false"])["tree"],
            json!({"op": "not", "kid": {"op": "true"}})
        );
        assert_eq!(
            parse(&["-nouser"])["tree"],
            json!({"op": "nouser", "group": false})
        );
        assert_eq!(
            parse(&["-nogroup"])["tree"],
            json!({"op": "nouser", "group": true})
        );
    }

    #[test]
    fn a_perm_is_octal_or_symbolic_over_no_bits() {
        for (spec, mode, bits) in [
            ("644", 0o644, "exact"),
            ("-644", 0o644, "all"),
            ("/111", 0o111, "any"),
            ("07777", 0o7777, "exact"),
            ("u=rwx,go=rx", 0o755, "exact"),
            ("-u=x", 0o100, "all"),
            ("/u=x,g=w", 0o120, "any"),
            ("a+x", 0o111, "exact"),
            ("+x", 0o111, "exact"),
            ("=w", 0o222, "exact"),
            ("u+", 0, "exact"),
            ("g=u", 0, "exact"),
            ("u=rwx,g=u-w,o=g", 0o755, "exact"),
            ("a=rX", 0o444, "exact"),
            ("u+x,a+X", 0o111, "exact"),
            ("-u=s", 0o4000, "all"),
            ("+t", 0o1000, "exact"),
            ("u=rw,u+x-w", 0o500, "exact"),
        ] {
            let read = parse(&["-perm", spec]);
            assert_eq!(
                read["tree"],
                json!({"op": "perm", "mode": mode, "bits": bits}),
                "{spec}"
            );
        }
        for spec in [
            "bogus", "9", "+111", "17777", "", "-", "/", "x=r", "u=rq", "u", "u+x,",
        ] {
            assert_eq!(
                refuse(&["-perm", spec]),
                format!("find: invalid mode '{spec}'")
            );
        }
        assert_eq!(
            parse(&["-perm", "/0"])["warnings"],
            json!([
                "find: warning: you have specified a mode pattern /0 (which is equivalent \
                    to /000). The meaning of -perm /000 has now been changed to be consistent \
                    with -perm -000; that is, while it used to match no files, it now matches \
                    all files."
            ])
        );
    }

    #[test]
    fn an_xtype_is_a_type_list_in_its_own_words() {
        assert_eq!(
            parse(&["-xtype", "f,d"])["tree"],
            json!({"op": "or", "kids": [{"op": "xtype", "kind": "f"}, {"op": "xtype", "kind": "d"}]})
        );
        for (value, shown) in [
            ("q", "find: Unknown argument to -xtype: q"),
            (
                "",
                "find: Arguments to -xtype should contain at least one letter",
            ),
            (
                "ff",
                "find: Must separate multiple arguments to -xtype using: ','",
            ),
            (
                "f,",
                "find: Last file type in list argument to -xtype is missing, i.e., list is ending on: ','",
            ),
        ] {
            assert_eq!(refuse(&["-xtype", value]), shown, "{value:?}");
        }
    }

    #[test]
    fn a_path_a_link_name_and_a_regex_carry_their_case() {
        assert_eq!(
            parse(&["-iwholename", "D/*"])["tree"],
            json!({"op": "path", "pattern": "D/*", "icase": true})
        );
        assert_eq!(parse(&["-wholename", "d"])["tree"]["icase"], json!(false));
        assert_eq!(parse(&["-ipath", "d"])["tree"]["icase"], json!(true));
        assert_eq!(
            parse(&["-ilname", "A*"])["tree"],
            json!({"op": "lname", "pattern": "A*", "icase": true})
        );
        assert_eq!(
            parse(&["-regex", ".*\\.txt"])["tree"],
            json!({
                "op": "regex",
                "pattern": ".*\\.txt",
                "icase": false,
                "dialect": "emacs",
                "extended": false,
            })
        );
    }

    #[test]
    fn regextype_sets_the_syntax_of_the_regexes_after_it() {
        let read = parse(&[
            "-regex",
            "a",
            "-regextype",
            "posix-extended",
            "-iregex",
            "(a|b)",
            "-regextype",
            "sed",
            "-regex",
            "a\\{1\\}",
        ]);
        let kids = &read["tree"]["kids"];
        assert_eq!(
            (kids[0]["dialect"].clone(), kids[0]["extended"].clone()),
            (json!("emacs"), json!(false))
        );
        assert_eq!(
            (kids[2]["dialect"].clone(), kids[2]["extended"].clone()),
            (json!("posix"), json!(true))
        );
        assert_eq!(kids[2]["icase"], json!(true));
        assert_eq!(
            (kids[4]["dialect"].clone(), kids[4]["extended"].clone()),
            (json!("posix"), json!(false))
        );
        assert_eq!(
            refuse(&["-regextype", "bogus"]),
            "find: Unknown regular expression type 'bogus'; valid types are 'findutils-default', \
             'ed', 'emacs', 'gnu-awk', 'grep', 'posix-awk', 'awk', 'posix-basic', 'posix-egrep', \
             'egrep', 'posix-extended', 'posix-minimal-basic', 'sed'."
        );
        assert_eq!(
            refuse(&["-regex", "\\("]),
            "find: failed to compile regular expression '\\(': Unmatched ( or \\("
        );
        assert_eq!(
            refuse(&["-regextype", "egrep", "-regex", "("]),
            "find: failed to compile regular expression '(': Unmatched ( or \\("
        );
        assert!(run("find", &["-regex", "("]).is_ok());
        assert_eq!(refuse(&["-regex"]), "find: missing argument to `-regex'");
        assert_eq!(
            refuse(&["-regextype"]),
            "find: missing argument to `-regextype'"
        );
    }

    #[test]
    fn the_new_tests_are_refused_after_an_action() {
        for tokens in [
            vec!["-print", "-regex", "x"],
            vec!["-print", "-perm", "644"],
            vec!["-print", "-true"],
            vec!["-print", "-readable"],
        ] {
            assert_eq!(
                refuse(&tokens),
                format!("find: {}: tests after actions are not supported", tokens[1])
            );
        }
        assert!(run("find", &["-print", "-quit"]).is_ok());
        assert!(run("find", &["-print", "-regextype", "sed"]).is_ok());
    }

    #[test]
    fn quit_is_a_node_and_may_follow_an_action_under_a_connective() {
        assert_eq!(
            parse(&["-print", "-quit"])["tree"],
            json!({"op": "and", "kids": [{"op": "action", "kind": "print", "batch": false}, {"op": "quit"}]})
        );
        assert_eq!(parse(&["-quit"])["actions"], json!([]));
        assert!(run("find", &["-name", "a", "-print", "-quit", "-o", "-print"]).is_ok());
        assert_eq!(
            refuse(&["(", "-print", "-name", "a", ")", "-o", "-print"]),
            "find: -print must end its -a chain under -o, ! or parentheses"
        );
        let access = parse(&["-readable", "-writable", "-executable"]);
        assert_eq!(
            access["tree"]["kids"],
            json!([
                {"op": "access", "mode": "r"},
                {"op": "access", "mode": "w"},
                {"op": "access", "mode": "x"},
            ])
        );
    }

    #[test]
    fn execdir_runs_like_exec_and_words_its_refusals_as_its_own() {
        let read = parse(&["-execdir", "echo", "{}", "+"]);
        assert_eq!(
            read["actions"],
            json!([{"kind": "exec", "argv": ["echo", "{}"], "batch": true, "dir": true}])
        );
        for (tokens, shown) in [
            (vec!["-execdir"], "find: missing argument to `-execdir'"),
            (
                vec!["-execdir", ";"],
                "find: invalid argument `;' to `-execdir'",
            ),
            (
                vec!["-execdir", "echo", "{}", "{}", "+"],
                "find: Only one instance of {} is supported with -execdir ... +",
            ),
            (
                vec!["-execdir", "echo", "x{}", "+"],
                "find: In '-execdir ... {} +' the '{}' must appear by itself, but you specified 'x{}'",
            ),
        ] {
            assert_eq!(refuse(&tokens), shown, "{tokens:?}");
        }
        let laid = run(
            "find_layout",
            &["d", "-execdir", "echo", "{}", ";", "-print"],
        )
        .expect("laid");
        assert_eq!(laid["spans"], json!([[1, 4]]));
    }

    #[test]
    fn an_fprint_writes_its_rows_to_a_file() {
        let read = parse(&[
            "-fprint", "out", "-fprint0", "zero", "-fprintf", "f", "%p\\n",
        ]);
        assert_eq!(read["actions"][0], json!({"kind": "print", "file": "out"}));
        assert_eq!(
            read["actions"][1],
            json!({"kind": "print0", "file": "zero"})
        );
        assert_eq!(read["actions"][2]["file"], json!("f"));
        assert_eq!(
            read["actions"][2]["parts"],
            json!([{"dir": "p"}, {"lit": "\n"}])
        );
        assert_eq!(refuse(&["-fprint"]), "find: missing argument to `-fprint'");
        assert_eq!(
            refuse(&["-fprintf", "x"]),
            "find: invalid argument `x' to `-fprintf'"
        );
        assert_eq!(
            refuse(&["-name", "a", "-fprint", "x", "-o", "-print"]),
            "find: -fprint and -print cannot be combined under -o, ! or parentheses"
        );
    }

    #[test]
    fn follow_and_files0_from_are_options_the_host_reads() {
        let read = parse(&["-follow", "-files0-from", "list", "-name", "a"]);
        assert_eq!(read["follow"], json!(true));
        assert_eq!(read["files0_from"], json!("list"));
        assert_eq!(parse(&["-print"])["follow"], json!(false));
        assert_eq!(parse(&["-print"])["files0_from"], Json::Null);
        assert_eq!(
            refuse(&["-files0-from"]),
            "find: missing argument to `-files0-from'"
        );
    }
}
