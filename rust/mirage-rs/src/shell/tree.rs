// Node kinds and field names from tree-sitter-bash 0.25.1, src/node-types.json.
// https://github.com/tree-sitter/tree-sitter-bash
// Licensed under MIT. See licenses/third_party/tree-sitter-bash-parser.txt.
/// Every node kind, named ones first, then the anonymous tokens by their
/// text: tree-sitter-bash 0.25.1's node types (its `node-types.json`)
/// plus `ERROR`. A kind's id is its index here.
pub const KINDS: &[(&str, bool)] = &[
    ("ERROR", true),
    ("ansi_c_string", true),
    ("arithmetic_expansion", true),
    ("array", true),
    ("binary_expression", true),
    ("brace_expression", true),
    ("c_style_for_statement", true),
    ("case_item", true),
    ("case_statement", true),
    ("command", true),
    ("command_name", true),
    ("command_substitution", true),
    ("comment", true),
    ("compound_statement", true),
    ("concatenation", true),
    ("declaration_command", true),
    ("do_group", true),
    ("elif_clause", true),
    ("else_clause", true),
    ("expansion", true),
    ("extglob_pattern", true),
    ("file_descriptor", true),
    ("file_redirect", true),
    ("for_statement", true),
    ("function_definition", true),
    ("heredoc_body", true),
    ("heredoc_content", true),
    ("heredoc_end", true),
    ("heredoc_redirect", true),
    ("heredoc_start", true),
    ("herestring_redirect", true),
    ("if_statement", true),
    ("list", true),
    ("negated_command", true),
    ("number", true),
    ("parenthesized_expression", true),
    ("pipeline", true),
    ("postfix_expression", true),
    ("process_substitution", true),
    ("program", true),
    ("raw_string", true),
    ("redirected_statement", true),
    ("regex", true),
    ("simple_expansion", true),
    ("special_variable_name", true),
    ("string", true),
    ("string_content", true),
    ("subscript", true),
    ("subshell", true),
    ("ternary_expression", true),
    ("test_command", true),
    ("test_operator", true),
    ("timed_statement", true),
    ("translated_string", true),
    ("unary_expression", true),
    ("unset_command", true),
    ("variable_assignment", true),
    ("variable_assignments", true),
    ("variable_name", true),
    ("while_statement", true),
    ("word", true),
    ("!", false),
    ("!=", false),
    ("\"", false),
    ("#", false),
    ("##", false),
    ("$", false),
    ("$(", false),
    ("$((", false),
    ("$[", false),
    ("$`", false),
    ("${", false),
    ("%", false),
    ("%%", false),
    ("%=", false),
    ("&", false),
    ("&&", false),
    ("&=", false),
    ("&>", false),
    ("&>>", false),
    ("(", false),
    ("((", false),
    (")", false),
    ("))", false),
    ("*", false),
    ("**", false),
    ("**=", false),
    ("*=", false),
    ("+", false),
    ("++", false),
    ("+=", false),
    (",", false),
    (",,", false),
    ("-", false),
    ("--", false),
    ("-=", false),
    ("-a", false),
    ("-o", false),
    ("-p", false),
    ("..", false),
    ("/", false),
    ("/#", false),
    ("/%", false),
    ("//", false),
    ("/=", false),
    (":", false),
    (":+", false),
    (":-", false),
    (":=", false),
    (":?", false),
    (";", false),
    (";&", false),
    (";;", false),
    (";;&", false),
    ("<", false),
    ("<&", false),
    ("<&-", false),
    ("<(", false),
    ("<<", false),
    ("<<-", false),
    ("<<<", false),
    ("<<=", false),
    ("<=", false),
    ("<>", false),
    ("=", false),
    ("==", false),
    ("=~", false),
    (">", false),
    (">&", false),
    (">&-", false),
    (">(", false),
    (">=", false),
    (">>", false),
    (">>=", false),
    (">|", false),
    ("?", false),
    ("@", false),
    ("A", false),
    ("E", false),
    ("K", false),
    ("L", false),
    ("P", false),
    ("Q", false),
    ("U", false),
    ("[", false),
    ("[[", false),
    ("]", false),
    ("]]", false),
    ("^", false),
    ("^=", false),
    ("^^", false),
    ("`", false),
    ("``", false),
    ("a", false),
    ("case", false),
    ("declare", false),
    ("do", false),
    ("done", false),
    ("elif", false),
    ("else", false),
    ("esac", false),
    ("export", false),
    ("fi", false),
    ("for", false),
    ("function", false),
    ("if", false),
    ("in", false),
    ("k", false),
    ("local", false),
    ("readonly", false),
    ("select", false),
    ("then", false),
    ("time", false),
    ("typeset", false),
    ("u", false),
    ("unset", false),
    ("unsetenv", false),
    ("until", false),
    ("while", false),
    ("{", false),
    ("|", false),
    ("|&", false),
    ("|=", false),
    ("||", false),
    ("}", false),
    ("~", false),
];

/// Field names; a child's field id is its index here plus one, 0 for none.
pub const FIELDS: &[&str] = &[
    "alternative",
    "argument",
    "body",
    "condition",
    "consequence",
    "descriptor",
    "destination",
    "fallthrough",
    "index",
    "initializer",
    "left",
    "name",
    "operator",
    "redirect",
    "right",
    "termination",
    "update",
    "value",
    "variable",
];

/// A node as the parser builds it, before comments are placed and the
/// tree is laid out.
#[derive(Debug)]
pub(crate) struct Syn {
    pub kind: &'static str,
    pub named: bool,
    pub field: Option<&'static str>,
    pub start: usize,
    pub end: usize,
    pub children: Vec<Syn>,
    /// A token the grammar matches by pattern rather than by its text,
    /// such as a newline ending a statement: it takes up its bytes, so it
    /// widens the nodes around it, but it is no node of the tree.
    pub hidden: bool,
}

/// A long `&&` chain nests as deep as it is long: dropping a node takes
/// its descendants apart one at a time, not by recursion.
impl Drop for Syn {
    fn drop(&mut self) {
        let mut stack = std::mem::take(&mut self.children);
        while let Some(mut node) = stack.pop() {
            stack.append(&mut node.children);
        }
    }
}

impl Syn {
    /// A named leaf.
    pub fn leaf(kind: &'static str, start: usize, end: usize) -> Self {
        Self {
            kind,
            named: true,
            field: None,
            start,
            end,
            children: Vec::new(),
            hidden: false,
        }
    }

    /// An anonymous token, its kind its text.
    pub fn token(kind: &'static str, start: usize, end: usize) -> Self {
        let mut node = Self::leaf(kind, start, end);
        node.named = false;
        node
    }

    /// A token that widens its parent and is no node.
    pub fn hidden(start: usize, end: usize) -> Self {
        let mut node = Self::token("", start, end);
        node.hidden = true;
        node
    }

    /// A named node over its children, spanning them.
    pub fn node(kind: &'static str, children: Vec<Syn>) -> Self {
        let start = children.first().map_or(0, |child| child.start);
        let end = children.last().map_or(0, |child| child.end);
        let mut node = Self::leaf(kind, start, end);
        node.children = children;
        node
    }

    /// A word of `pieces`: none, the one piece, or a concatenation.
    pub fn concat(mut pieces: Vec<Syn>) -> Option<Self> {
        match pieces.len() {
            0 => None,
            1 => pieces.pop(),
            _ => Some(Self::node("concatenation", pieces)),
        }
    }

    /// A named node with no children at `at`.
    pub fn empty(kind: &'static str, at: usize) -> Self {
        Self::leaf(kind, at, at)
    }

    pub fn with_field(mut self, field: &'static str) -> Self {
        self.field = Some(field);
        self
    }

    /// Give every child without a field this one, as a field over a
    /// sequence of the grammar names each node the sequence holds.
    pub fn fielded(children: Vec<Syn>, field: &'static str) -> Vec<Syn> {
        children
            .into_iter()
            .map(|child| {
                if child.field.is_none() && !child.hidden {
                    child.with_field(field)
                } else {
                    child
                }
            })
            .collect()
    }

    pub fn is(&self, kind: &str) -> bool {
        self.kind == kind
    }
}

/// Place each comment in the node whose children it falls between: a
/// node keeps the extras between its children, and those before its
/// first child or after its last belong to its parent. `comments` are in
/// source order.
pub(crate) fn place_comments(root: &mut Syn, comments: &[(usize, usize)]) {
    let comments = comments
        .iter()
        .map(|&(start, end)| Syn::leaf("comment", start, end))
        .collect();
    let mut stack: Vec<(&mut Syn, Vec<Syn>)> = vec![(root, comments)];
    while let Some((node, comments)) = stack.pop() {
        let mut here = Vec::new();
        let mut down: Vec<(usize, Syn)> = Vec::new();
        for comment in comments {
            let at = comment.start;
            let index = node.children.partition_point(|child| child.start < at);
            let inside = index > 0 && {
                let before = &node.children[index - 1];
                before.end > at
                    && before
                        .children
                        .first()
                        .is_some_and(|child| child.start < at)
                    && before.children.last().is_some_and(|child| child.end > at)
            };
            if inside {
                down.push((index - 1, comment));
            } else {
                here.push(comment);
            }
        }
        // Where each old child lands once this node's comments are in.
        let old = std::mem::take(&mut node.children);
        let mut moved = Vec::with_capacity(old.len());
        let mut here = here.into_iter().peekable();
        for child in old {
            while here
                .peek()
                .is_some_and(|comment| comment.start < child.start)
            {
                node.children.extend(here.next());
            }
            moved.push(node.children.len());
            node.children.push(child);
        }
        node.children.extend(here);
        let mut groups: Vec<(usize, Vec<Syn>)> = Vec::new();
        for (index, comment) in down {
            match groups.last_mut() {
                Some((last, group)) if *last == moved[index] => group.push(comment),
                _ => groups.push((moved[index], vec![comment])),
            }
        }
        let mut children: Vec<Option<&mut Syn>> = node.children.iter_mut().map(Some).collect();
        for (index, group) in groups {
            if let Some(child) = children[index].take() {
                stack.push((child, group));
            }
        }
    }
}

/// A laid-out node: the tree holds its nodes level by level, so a node's
/// children sit next to each other.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Node {
    pub kind: u16,
    /// Field id in its parent, 0 for none.
    pub field: u8,
    pub named: bool,
    pub start: u32,
    pub end: u32,
    pub start_row: u32,
    pub start_column: u32,
    pub end_row: u32,
    pub end_column: u32,
    /// `u32::MAX` for the root.
    pub parent: u32,
    pub first_child: u32,
    pub child_count: u32,
}

/// One line of a refusal: the row of the input bash reports it on, 0 for
/// the first, and its text; `quoted` for the input line bash quotes back
/// after a `syntax error near`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Said {
    pub row: usize,
    pub text: Vec<u8>,
    pub quoted: bool,
}

/// What bash reports of a line it refuses.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    /// Where its first refusal stands in the line as typed.
    pub at: usize,
    /// Its diagnostic lines, the line's own bytes in them as typed.
    pub lines: Vec<Said>,
    /// The status the line is refused with.
    pub status: u8,
}

const UNEXPECTED: &[u8] = b"syntax error near unexpected token `";

impl Refusal {
    /// The refusal as bash prints it: each line led by `head` (`bash: -c: `,
    /// `bash: eval: `, a sourced file's `name: `) and the line it stands
    /// on, the input's first row being line `first`; an unexpected token
    /// named as bash names it under a UTF-8 locale or not (`utf8`).
    pub fn worded(&self, head: &[u8], first: usize, utf8: bool) -> Vec<u8> {
        let mut out = Vec::new();
        for said in &self.lines {
            out.extend_from_slice(head);
            out.extend_from_slice(format!("line {}: ", first + said.row).as_bytes());
            let token = said
                .text
                .strip_prefix(UNEXPECTED)
                .and_then(|rest| rest.strip_suffix(b"'"))
                .filter(|_| !said.quoted);
            if said.quoted {
                out.push(b'`');
                out.extend_from_slice(&said.text);
                out.push(b'\'');
            } else if let Some(token) = token {
                out.extend_from_slice(UNEXPECTED);
                out.extend_from_slice(&named(token, utf8));
                out.push(b'\'');
            } else {
                out.extend_from_slice(&said.text);
            }
            out.push(b'\n');
        }
        out
    }
}

/// A token as bash's reader hands it to a syntax error: each `$'...'` it
/// reads as a word (outside quotes, or in `$( )`, `<( )` or `${ }`) as its
/// value in single quotes, bare in double quotes within a `${ }` that takes
/// no pattern or a `$[ ]`, and as typed in double quotes and backticks;
/// each `$"..."` as `"..."`, and a `\001` before each `\001` and `\177` no
/// backslash escapes. The whole in `$'...'` when it does not show as it is.
fn named(token: &[u8], utf8: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(token.len());
    let mut scopes = vec![Scope::Words {
        pair: None,
        dq: false,
        quoted: true,
        depth: 0,
    }];
    let mut ends = None;
    let mut at = 0;
    while let (Some(&scope), Some(&byte)) = (scopes.last(), token.get(at)) {
        let next = token.get(at + 1).copied();
        if byte == b'\\' && next.is_some() && !matches!(scope, Scope::Verbatim(b'\'')) {
            out.extend_from_slice(&token[at..at + 2]);
            at += 2;
            continue;
        }
        let dq = match scope {
            Scope::Words { dq, .. } => Some(dq),
            Scope::Double => Some(true),
            Scope::Verbatim(_) => None,
        };
        if let Some(inner) = dq.and_then(|dq| opened(token, at, dq, &mut ends)) {
            out.extend_from_slice(&token[at..at + 2]);
            at += 2;
            scopes.push(inner);
            continue;
        }
        if let Scope::Words { quoted, .. } = scope {
            if byte == b'$' && next == Some(b'\'') {
                if let Some(end) = super::lex::ansi_c_end(token, at) {
                    let value = marked(&crate::interp::escapes::decode_ansi_c(
                        &token[at + 2..end - 1],
                        utf8,
                    ));
                    if quoted {
                        single_quoted(&value, &mut out);
                    } else {
                        out.extend_from_slice(&value);
                    }
                    at = end;
                    continue;
                }
            }
            if byte == b'$' && next == Some(b'"') {
                at += 1;
                continue;
            }
        }
        if matches!(byte, 0x01 | 0x7F) {
            out.push(0x01);
        }
        out.push(byte);
        at += 1;
        match scope {
            Scope::Verbatim(close) if byte == close => {
                scopes.pop();
            }
            Scope::Double if byte == b'"' => {
                scopes.pop();
            }
            Scope::Double | Scope::Words { .. } if byte == b'`' => {
                scopes.push(Scope::Verbatim(byte))
            }
            Scope::Words { .. } if byte == b'\'' => scopes.push(Scope::Verbatim(byte)),
            Scope::Words { .. } if byte == b'"' => scopes.push(Scope::Double),
            Scope::Words {
                pair: Some((open, close)),
                depth,
                ..
            } if byte == open || byte == close => {
                if byte == close && depth == 0 {
                    scopes.pop();
                } else if let Some(Scope::Words { depth, .. }) = scopes.last_mut() {
                    *depth = if byte == open { *depth + 1 } else { *depth - 1 };
                }
            }
            _ => {}
        }
    }
    if crate::interp::quote::printable(&out, utf8) {
        out
    } else {
        crate::interp::quote::ansi_c(&out, utf8)
    }
}

/// Where `named` stands in a token: its words, or those of a `$( )`,
/// `${ }` or `$[ ]` whose `pair` opened them and closes at `depth` 0, with
/// each `$'...'` read as its value, in single quotes when `quoted`, and
/// `dq` when they stand in double quotes; double-quoted text; or text kept
/// as typed through the `'` or backtick that closes it.
#[derive(Clone, Copy)]
enum Scope {
    Words {
        pair: Option<(u8, u8)>,
        dq: bool,
        quoted: bool,
        depth: usize,
    },
    Double,
    Verbatim(u8),
}

/// The scope a `$( )`, `<( )`, `${ }` or `$[ ]` opening at `at` reads,
/// inside double quotes or not (`dq`), if one opens there. `ends` holds
/// each `[`'s matching `]`, found once for the token when first asked.
fn opened(token: &[u8], at: usize, dq: bool, ends: &mut Option<Vec<usize>>) -> Option<Scope> {
    let (pair, dq, quoted) = match (token[at], token.get(at + 1).copied()) {
        (b'$', Some(b'(')) => ((b'(', b')'), false, true),
        (b'<' | b'>', Some(b'(')) if !dq => ((b'(', b')'), false, true),
        (b'$', Some(b'{')) => {
            let ends = ends.get_or_insert_with(|| bracket_ends(token));
            ((b'{', b'}'), dq, !dq || takes_pattern(token, at + 2, ends))
        }
        (b'$', Some(b'[')) => ((b'[', b']'), dq, !dq),
        _ => return None,
    };
    Some(Scope::Words {
        pair: Some(pair),
        dq,
        quoted,
        depth: 0,
    })
}

/// Past each `[` in `token`, the offset past the `]` that matches it,
/// brackets counted bare; the token's length for one left open.
fn bracket_ends(token: &[u8]) -> Vec<usize> {
    let mut ends = vec![token.len(); token.len()];
    let mut open = Vec::new();
    for (at, &byte) in token.iter().enumerate() {
        match byte {
            b'[' => open.push(at),
            b']' => {
                if let Some(start) = open.pop() {
                    ends[start] = at + 1;
                }
            }
            _ => {}
        }
    }
    ends
}

/// Whether the `${ }` whose parameter starts at `at` takes a pattern: its
/// operator, past the name and any subscript (`ends` from
/// `bracket_ends`), is `/`, `#`, `%`, `^` or `,`.
fn takes_pattern(token: &[u8], mut at: usize, ends: &[usize]) -> bool {
    let byte = |at: usize| token.get(at).copied();
    if matches!(byte(at), Some(b'!' | b'#')) && byte(at + 1).is_some_and(|b| b != b'}') {
        at += 1;
    }
    let name = token
        .get(at..)
        .unwrap_or_default()
        .iter()
        .take_while(|b| b.is_ascii_alphanumeric() || **b == b'_')
        .count();
    at += name.max(usize::from(
        byte(at).is_some_and(|b| b"@*#?-$!".contains(&b)),
    ));
    if byte(at) == Some(b'[') {
        at = ends[at];
    }
    matches!(byte(at), Some(b'/' | b'#' | b'%' | b'^' | b','))
}

/// `text` with the `\001` bash's reader puts before each `\001` and
/// `\177`.
fn marked(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    for &byte in text {
        if matches!(byte, 0x01 | 0x7F) {
            out.push(0x01);
        }
        out.push(byte);
    }
    out
}

/// `value` in single quotes, `'` as `'\''`; a lone `'` as `\'`.
fn single_quoted(value: &[u8], out: &mut Vec<u8>) {
    if value == b"'" {
        out.extend_from_slice(b"\\'");
        return;
    }
    out.push(b'\'');
    for &byte in value {
        if byte == b'\'' {
            out.extend_from_slice(b"'\\''");
        } else {
            out.push(byte);
        }
    }
    out.push(b'\'');
}

/// A parsed program.
#[derive(Debug, Clone)]
pub struct Tree {
    /// What the nodes read: the line with its heredoc bodies folded in
    /// and its line continuations dropped.
    pub source: Vec<u8>,
    pub nodes: Vec<Node>,
    /// What bash reports of the line when it refuses it.
    pub error: Option<Refusal>,
    /// The line as typed.
    pub original: Vec<u8>,
    /// Where each byte of `source` came from in `original`, then the end.
    pub offsets: Vec<usize>,
    /// The heredocs folded into `source`, in its order.
    pub heredocs: Vec<super::lower::Heredoc>,
    /// Each substitution that closes with heredocs opened inside still to
    /// read: its `)` and their `<<`s, in the line as typed.
    pub closes: Vec<(usize, Vec<usize>)>,
}

/// `KINDS`' names sorted, with their ids.
fn kind_index() -> &'static [(&'static str, u16)] {
    static INDEX: std::sync::OnceLock<Vec<(&'static str, u16)>> = std::sync::OnceLock::new();
    INDEX.get_or_init(|| {
        let mut index: Vec<(&'static str, u16)> = KINDS
            .iter()
            .enumerate()
            .map(|(id, (name, _))| (*name, u16::try_from(id).expect("fewer kinds than u16")))
            .collect();
        index.sort_unstable();
        index
    })
}

fn kind_id(kind: &str) -> u16 {
    let index = kind_index();
    match index.binary_search_by(|(name, _)| (*name).cmp(kind)) {
        Ok(at) => index[at].1,
        Err(_) => panic!("unknown node kind {kind:?}"),
    }
}

/// A field's id: its place in `FIELDS` plus one, as 0 is no field.
pub fn field_id(name: &str) -> Option<u8> {
    FIELDS
        .iter()
        .position(|known| *known == name)
        .and_then(|index| u8::try_from(index + 1).ok())
}

fn drop_hidden(root: &mut Syn) {
    let mut stack = vec![root];
    while let Some(node) = stack.pop() {
        node.children.retain(|child| !child.hidden);
        stack.extend(node.children.iter_mut());
    }
}

/// Lay a built tree out level by level, with its points.
pub(crate) fn lay_out(source: Vec<u8>, mut root: Syn, error: Option<Refusal>) -> Tree {
    drop_hidden(&mut root);
    let lines: Vec<usize> = std::iter::once(0)
        .chain(memchr::memchr_iter(b'\n', &source).map(|at| at + 1))
        .collect();
    let point = |offset: usize| {
        let row = lines.partition_point(|&start| start <= offset) - 1;
        (to_u32(row), to_u32(offset - lines[row]))
    };
    let mut nodes: Vec<Node> = Vec::new();
    let mut queue = std::collections::VecDeque::new();
    queue.push_back((&root, u32::MAX));
    while let Some((syn, parent)) = queue.pop_front() {
        let index = to_u32(nodes.len());
        if parent != u32::MAX {
            let slot = &mut nodes[parent as usize];
            if slot.child_count == 0 {
                slot.first_child = index;
            }
            slot.child_count += 1;
        }
        let (start_row, start_column) = point(syn.start);
        let (end_row, end_column) = point(syn.end);
        let kind = kind_id(syn.kind);
        nodes.push(Node {
            kind,
            field: syn.field.map_or(0, |name| {
                field_id(name).unwrap_or_else(|| panic!("unknown field {name:?}"))
            }),
            named: syn.named,
            start: to_u32(syn.start),
            end: to_u32(syn.end),
            start_row,
            start_column,
            end_row,
            end_column,
            parent,
            first_child: 0,
            child_count: 0,
        });
        for child in &syn.children {
            queue.push_back((child, index));
        }
    }
    Tree {
        source,
        nodes,
        error,
        original: Vec::new(),
        offsets: Vec::new(),
        heredocs: Vec::new(),
        closes: Vec::new(),
    }
}

pub(super) fn to_u32(value: usize) -> u32 {
    u32::try_from(value).unwrap_or(u32::MAX)
}
