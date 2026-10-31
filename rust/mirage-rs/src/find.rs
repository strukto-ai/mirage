//! find's expression grammar (findutils 4.10.0), read once before any
//! operand is resolved. The host sends every word typed after `find` as an
//! operand; the start points are the words before the first expression
//! token, and the rest is parsed here into a tree of tests, connectives and
//! actions, with every argument typed and checked where it was written, so
//! the first bad one names the refusal and its exit status. `-printf` is
//! compiled once into literal runs and directives the host renders per
//! entry, its warnings kept in the order GNU prints them. A time test comes
//! back as its operands (`-mtime +N` as a sign and a day count, `-newermt`
//! as the date text, `-newer` as an index into the reference list) with the
//! way it folds into the expression's flat window, since only the host has
//! a clock, a date library and the dispatcher that stats a reference.
//!
//! `layout` answers the same words without parsing the expression: where it
//! begins and which words an `-exec` owns, for a host classifying a line
//! before it can be parsed.

use serde_json::{Value as Json, json};

use crate::scan::{OPERAND, Typed, Values, unknown};
use crate::{StreamError, byte_text};

const VALUE_PREDICATES: &[&[u8]] = &[
    b"-name",
    b"-iname",
    b"-path",
    b"-type",
    b"-size",
    b"-mtime",
    b"-maxdepth",
    b"-mindepth",
    b"-printf",
    b"-newer",
    b"-newermt",
];
const BARE_PREDICATES: &[&[u8]] = &[
    b"-empty", b"-print", b"-print0", b"-delete", b"-ls", b"-depth", b"-xdev", b"-mount", b"-prune",
];
const OPERATORS: &[&[u8]] = &[b"-not", b"!", b"-o", b"-or", b"-a", b"-and", b"(", b")"];
const EXEC: &[u8] = b"-exec";
const LINK_OPTIONS: &[&[u8]] = &[b"-P", b"-H", b"-L"];
const ROW_ACTIONS: &[(&[u8], &str)] = &[
    (b"-print", "print"),
    (b"-print0", "print0"),
    (b"-ls", "ls"),
    (b"-delete", "delete"),
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

type Fail = Vec<u8>;

fn say(parts: &[&[u8]]) -> Fail {
    parts.concat()
}

fn text(message: &str) -> Fail {
    message.as_bytes().to_vec()
}

fn is_expression_token(word: &[u8]) -> bool {
    (word.starts_with(b"-") && word.len() > 1)
        || [VALUE_PREDICATES, BARE_PREDICATES, OPERATORS]
            .iter()
            .any(|list| list.contains(&word))
        || word == EXEC
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
        if argv[at] != EXEC {
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
    Exec { argv: Vec<Vec<u8>>, batch: bool },
    Row(&'static str),
    Printf { format: Vec<u8>, parts: Vec<Part> },
}

impl Action {
    fn word(&self) -> String {
        match self {
            Action::Exec { .. } => "-exec".to_owned(),
            Action::Printf { .. } => "-printf".to_owned(),
            Action::Row(kind) => format!("-{kind}"),
        }
    }

    fn json(&self) -> Json {
        match self {
            Action::Exec { argv, batch } => json!({
                "kind": "exec",
                "argv": argv.iter().map(|w| byte_text(w)).collect::<Vec<_>>(),
                "batch": batch,
            }),
            Action::Row(kind) => json!({"kind": kind}),
            Action::Printf { format, parts } => json!({
                "kind": "printf",
                "format": byte_text(format),
                "parts": parts.iter().map(part_json).collect::<Vec<_>>(),
                "stat": parts.iter().any(|part| match part {
                    Part::Dir(code) => b"syYmMuUgG".contains(code),
                    Part::Time(_) => true,
                    Part::Lit(_) => false,
                }),
            }),
        }
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
    Mtime { cmp: u8, days: f64 },
    Newermt(Vec<u8>),
    Newer(usize),
}

enum Node {
    Name { pattern: Vec<u8>, icase: bool },
    Path(Vec<u8>),
    Type(u8),
    Empty,
    True,
    Prune,
    Not(Box<Node>),
    And(Vec<Node>),
    Or(Vec<Node>),
    Act { kind: &'static str, batch: bool },
    Time(Time, Fold),
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
            Node::Path(pattern) => json!({"op": "path", "pattern": byte_text(pattern)}),
            Node::Type(kind) => json!({"op": "type", "kind": char::from(*kind).to_string()}),
            Node::Empty => json!({"op": "empty"}),
            Node::True => json!({"op": "true"}),
            Node::Prune => json!({"op": "prune"}),
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
                    Time::Mtime { cmp, days } => json!({
                        "op": "mtime",
                        "cmp": char::from(*cmp).to_string(),
                        "days": days,
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
    depth_first: bool,
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
        values.insert("depth_first".to_owned(), json!(self.depth_first));
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
    maxdepth: Option<u64>,
    mindepth: Option<u64>,
    size: (Option<i128>, Option<i128>),
    uses_empty: bool,
    actions: Vec<Action>,
    newer: Vec<Vec<u8>>,
    depth_first: bool,
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
            maxdepth: None,
            mindepth: None,
            size: (None, None),
            uses_empty: false,
            actions: Vec::new(),
            newer: Vec::new(),
            depth_first: false,
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
                depth_first: self.depth_first,
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
        tok == b"-empty"
            || tok == b"-prune"
            || (VALUE_PREDICATES.contains(&tok)
                && tok != b"-printf"
                && tok != b"-maxdepth"
                && tok != b"-mindepth")
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
        if tok == EXEC {
            self.predicates.push(tok.to_vec());
            let action = self.exec()?;
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
            self.actions.push(Action::Row(kind));
            if tok == b"-delete" {
                self.depth_first = true;
            }
            return Ok(self.action_node(kind, false));
        }
        if tok == b"-prune" {
            self.predicates.push(tok.to_vec());
            return Ok(Node::Prune);
        }
        if tok == b"-depth" {
            self.predicates.push(tok.to_vec());
            self.depth_first = true;
            self.depth_option = true;
            return Ok(Node::True);
        }
        if BARE_PREDICATES.contains(&tok) {
            self.predicates.push(tok.to_vec());
            return Ok(Node::True);
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

    fn value_predicate(&mut self, tok: &'a [u8], value: &'a [u8]) -> Result<Node, Fail> {
        match tok {
            b"-name" => Ok(Node::Name {
                pattern: value.to_vec(),
                icase: false,
            }),
            b"-iname" => Ok(Node::Name {
                pattern: value.to_vec(),
                icase: true,
            }),
            b"-path" => Ok(Node::Path(value.to_vec())),
            b"-type" => type_node(value),
            b"-printf" => {
                let parts = compile(value, &mut self.warnings)?;
                self.actions.push(Action::Printf {
                    format: value.to_vec(),
                    parts,
                });
                Ok(self.action_node("printf", false))
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
                Ok(Node::Time(Time::Newermt(value.to_vec()), self.fold()))
            }
            _ => {
                let (cmp, days) = mtime(value)?;
                Ok(Node::Time(Time::Mtime { cmp, days }, self.fold()))
            }
        }
    }

    fn exec(&mut self) -> Result<Action, Fail> {
        let missing = || text("find: missing argument to `-exec'");
        let mut argv: Vec<Vec<u8>> = Vec::new();
        let mut batch = false;
        loop {
            let tok = self.advance().ok_or_else(missing)?;
            if tok == b";" {
                if argv.is_empty() {
                    return Err(text("find: invalid argument `;' to `-exec'"));
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
            for word in &argv {
                if contains(word, PLACEHOLDER) && word != PLACEHOLDER {
                    return Err(say(&[
                        b"find: In '-exec ... {} +' the '{}' must appear by itself, but you \
                          specified '",
                        word,
                        b"'",
                    ]));
                }
            }
            if argv.iter().filter(|word| *word == PLACEHOLDER).count() > 1 {
                return Err(text(
                    "find: Only one instance of {} is supported with -exec ... +",
                ));
            }
        }
        Ok(Action::Exec { argv, batch })
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
            for kid in &kids[..kids.len() - 1] {
                if kid.has_action() {
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

/// `-type` as GNU reads it: one or more letters from `bcdpfls` separated
/// by commas, a list holding any of them.
fn type_node(value: &[u8]) -> Result<Node, Fail> {
    if value.is_empty() {
        return Err(text(
            "find: Arguments to -type should contain at least one letter",
        ));
    }
    let ending = || {
        text(
            "find: Last file type in list argument to -type is missing, i.e., list is ending on: ','",
        )
    };
    let mut kinds = Vec::new();
    let mut at = 0;
    loop {
        let kind = *value.get(at).ok_or_else(ending)?;
        if !TYPES.contains(&kind) {
            return Err(say(&[b"find: Unknown argument to -type: ", &[kind]]));
        }
        kinds.push(Node::Type(kind));
        at += 1;
        if at == value.len() {
            break;
        }
        if value[at] != b',' {
            return Err(text(
                "find: Must separate multiple arguments to -type using: ','",
            ));
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

/// `-mtime`: an optional sign and a count of days. The sign is `+`, `-` or
/// none; every leading sign is dropped before the digits are read, as the
/// hosts always did.
fn mtime(spec: &[u8]) -> Result<(u8, f64), Fail> {
    let cmp = match spec.first() {
        Some(b'+') => b'+',
        Some(b'-') => b'-',
        _ => b'=',
    };
    let start = spec
        .iter()
        .take_while(|b| **b == b'+' || **b == b'-')
        .count();
    let body = &spec[start..];
    let is_blank = |b: &u8| crate::number::BLANKS.contains(b);
    let from = body.iter().position(|b| !is_blank(b)).unwrap_or(body.len());
    let to = body
        .iter()
        .rposition(|b| !is_blank(b))
        .map_or(from, |at| at + 1);
    let digits = &body[from..to];
    if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
        return Err(say(&[b"find: invalid argument `", spec, b"' to `-mtime'"]));
    }
    let days = byte_text(digits).parse::<f64>().unwrap_or(f64::MAX);
    Ok((cmp, days))
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
                {"op": "and", "kids": [
                    {"op": "mtime", "cmp": "+", "days": 3.0, "fold": "all"},
                    {"op": "mtime", "cmp": "-", "days": 1.0, "fold": "all"},
                ]},
                {"op": "mtime", "cmp": "=", "days": 2.0, "fold": "any"},
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
        assert_eq!(parse(&["-mtime", "2"])["tree"]["cmp"], json!("="));
        assert_eq!(parse(&["-mtime", " 2 "])["tree"]["days"], json!(2.0));
        assert_eq!(
            parse(&["(", "-mtime", "1", ")"])["tree"]["fold"],
            json!("any")
        );
    }

    #[test]
    fn a_time_refusal_is_gnus() {
        for spec in ["abc", "", "+", "1_0", "2x", "1,5"] {
            assert_eq!(
                refuse(&["-mtime", spec]),
                format!("find: invalid argument `{spec}' to `-mtime'")
            );
        }
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
        assert_eq!(refuse(&["-regex", "x"]), "find: unknown predicate `-regex'");
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
            json!([{"kind": "exec", "argv": ["echo", "got", "{}"], "batch": false}])
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
        assert_eq!(one["actions"], json!([{"kind": "print"}]));
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
}
