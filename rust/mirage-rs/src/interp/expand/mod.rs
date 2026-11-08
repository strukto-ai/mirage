//! Word expansion over the parsed tree: a word's pieces, each carrying its
//! quoting, then fields split on IFS. Quoting rides on the piece instead of
//! a mark inside the text, so a quoted glob character stays literal (`'*'`)
//! however the pieces are joined. What the shell cannot answer itself, a
//! command substitution's output, the host does.

mod arithmetic;
mod arrays;
mod braces;
mod fields;
mod lookup;
mod operators;
mod patterns;
mod substitution;
mod substring;
#[cfg(test)]
mod tests;
mod tilde;

pub use fields::{Field, ifs_joiner, join, marked, splat, split_fields};

use std::future::Future;

use super::brace::{self, Tok, expand_template};
use super::escapes::{decode_ansi_c, unescape_dquoted, unquoted_runs};
use super::parameter::scan_parameter;
use super::pattern::{Pattern, Replacement};
use super::shell::Shell;
pub(super) use super::voiced;
use super::write::{Fault, Gate, Writer};
use super::{Diagnostic, Signal};
use crate::shell::Tree;

/// One stretch of an expanded word: its text, whether quoting made its
/// glob characters literal, and whether field splitting reads it, which
/// only an unquoted expansion's value is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Piece {
    pub text: Vec<u8>,
    pub quoted: bool,
    pub split: bool,
}

/// A word's pieces, and the boundary between two elements of a splat
/// (`$@`, `${a[@]}`), which reads as its joiner where nothing splits.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Chunk {
    Piece(Piece),
    Break(Vec<u8>),
}

impl Chunk {
    /// Text as typed outside quotes: live, never split.
    pub fn literal(text: impl Into<Vec<u8>>) -> Self {
        Chunk::Piece(Piece {
            text: text.into(),
            quoted: false,
            split: false,
        })
    }

    /// Text quoting protects: literal, never split.
    pub fn quoted(text: impl Into<Vec<u8>>) -> Self {
        Chunk::Piece(Piece {
            text: text.into(),
            quoted: true,
            split: false,
        })
    }

    /// An expansion's value: literal inside double quotes, otherwise
    /// split and globbed.
    pub fn value(text: impl Into<Vec<u8>>, quoted: bool) -> Self {
        Chunk::Piece(Piece {
            text: text.into(),
            quoted,
            split: !quoted,
        })
    }
}

/// A command substitution's run: its output, its stderr, which joins the
/// statement's, and its status, which `$?` reads next.
pub struct Substitution {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub status: i32,
}

/// The host as expansion sees it: the session gate its writes clear, and
/// the shell that runs a command substitution's body.
pub trait Host: Gate {
    /// Run `body` in a child shell of `shell`, its output captured: the
    /// substitution `node` holds, or with `span` one backtick pair of it,
    /// its bytes within the node's text. `read` is the file of bash's
    /// `$(< file)` as the fields this shell expanded its name to, which
    /// the host reads, or refuses as an ambiguous redirect when they are
    /// not one, instead of expanding the body's name a second time.
    fn substitute(
        &mut self,
        shell: &mut Shell,
        body: &[u8],
        node: usize,
        span: Option<(usize, usize)>,
        read: Option<&[Field]>,
    ) -> impl Future<Output = Result<Substitution, Fault>>;

    /// Start the process substitution `node` holds (`<(...)`, `>(...)`)
    /// in a child shell of `shell` and give back the path that names its
    /// pipe.
    fn process_substitution(
        &mut self,
        shell: &mut Shell,
        node: usize,
    ) -> impl Future<Output = Result<Vec<u8>, Fault>>;

    /// Let the host run others, or stop the operation, between slices of
    /// a long piece of work on `shell`; a host that runs nothing else goes
    /// straight on.
    fn pause(&mut self, _shell: &Shell) -> impl Future<Output = Result<(), Fault>> {
        async { Ok(()) }
    }
}

/// Name the word a bad substitution was found in, unless a boundary
/// already fixed it: each level the error leaves renames it until a
/// double-quoted part, an operator's word or an expression fixes it.
fn within(fault: Fault, word: &[u8], fix: bool) -> Fault {
    match fault {
        Fault::Bad { fixed: false, .. } => Fault::Bad {
            text: word.to_vec(),
            fixed: fix,
        },
        other => other,
    }
}

fn trim_start(text: &[u8]) -> &[u8] {
    let blank = text.iter().take_while(|b| b.is_ascii_whitespace()).count();
    &text[blank..]
}

/// A part of a node: a child, or source text between children, which the
/// parser reads without giving it a node (whitespace in a string, the
/// opening of an operator's word).
#[derive(Debug, Clone, Copy)]
enum Part {
    Text(usize, usize),
    Node(usize),
}

/// The pieces of one `${...}`.
#[derive(Debug, Default)]
struct Braces {
    name: Option<Vec<u8>>,
    /// The raw text between the brackets, for the `@`/`*` checks and the
    /// arithmetic path; its parsed nodes, for an associative key.
    subscript: Option<Vec<u8>>,
    subscript_nodes: Vec<usize>,
    /// Where the subscript's text sits in the source, between its
    /// brackets.
    subscript_span: (usize, usize),
    length: bool,
    indirect: bool,
    /// `${!prefix@}` or `${!prefix*}`: the names starting with it; `star`
    /// for the `*` spelling, which joins.
    prefix: bool,
    star: bool,
    op: Option<&'static str>,
    groups: Vec<Vec<Part>>,
    /// The expansion node, for a substring's bounds.
    node: usize,
}

/// What a value operator applies: its pattern, its replacement, and a
/// transformation's letter.
#[derive(Debug, Default)]
struct Operands {
    pattern: Pattern,
    replacement: Replacement,
    letter: Option<u8>,
}

/// The brace words made between two pauses.
const BRACE_SLICE: usize = 1024;

const PATTERN_OPS: [&str; 14] = [
    "#", "##", "%", "%%", "/", "//", "/#", "/%", "^", "^^", ",", ",,", "~", "~~",
];

/// One word's expansion against a shell and its host.
pub struct Expander<'a, H: Host> {
    pub shell: &'a mut Shell,
    pub host: &'a mut H,
    pub tree: &'a Tree,
    pub diagnostics: &'a mut Vec<Diagnostic>,
    /// The bytes left to build the expansion in, the shell's
    /// `memory_room` as it starts; None for no bound.
    pub room: Option<usize>,
}

/// The bytes a word's pieces hold.
fn chunk_bytes(chunks: &[Chunk]) -> usize {
    chunks
        .iter()
        .map(|chunk| match chunk {
            Chunk::Piece(piece) => piece.text.len(),
            Chunk::Break(joiner) => joiner.len(),
        })
        .sum()
}

impl<H: Host> Expander<'_, H> {
    /// Take `bytes` out of what the expansion has left, refusing once
    /// they do not fit in the workspace's `max_memory`.
    fn spend(&mut self, bytes: usize) -> Result<(), Fault> {
        brace::spend(&mut self.room, bytes).map_err(|_| Fault::Memory)
    }

    fn writer(&mut self) -> Writer<'_, H> {
        Writer::of(self.shell, self.host, Some(self.diagnostics))
    }

    fn text(&self, node: usize) -> &[u8] {
        self.tree.text(node)
    }

    fn kind(&self, node: usize) -> &'static str {
        self.tree.kind(node)
    }

    /// A node's children with the source text between them.
    fn parts(&self, node: usize) -> Vec<Part> {
        let mut parts = Vec::new();
        let mut end = self.tree.nodes[node].start as usize;
        for child in self.tree.children(node) {
            let start = self.tree.nodes[child].start as usize;
            if start > end {
                parts.push(Part::Text(end, start));
            }
            end = self.tree.nodes[child].end as usize;
            parts.push(Part::Node(child));
        }
        parts
    }

    fn part_text(&self, part: Part) -> &[u8] {
        match part {
            Part::Text(start, end) => &self.tree.source[start..end],
            Part::Node(node) => self.text(node),
        }
    }

    /// The whitespace the parser folds into an expansion's extent inside
    /// a double-quoted string (`"$a $(b)"` gives the substitution the text
    /// ` $(b)`), which the expansion re-emits ahead of its value.
    fn fold(&self, node: usize) -> Vec<u8> {
        let text = self.text(node);
        text[..text.len() - trim_start(text).len()].to_vec()
    }

    /// A word where no field splitting happens (a `case` word, a `[[`
    /// operand, a here-string), quoting removed. A `name=value` argument
    /// (`export a=~/x`) expands its value as an assignment does, and an
    /// element's subscript as a word's text (`declare d[$i]=w` names
    /// `d[2]`).
    pub async fn word_text(&mut self, node: usize) -> Result<Vec<u8>, Fault> {
        if self.kind(node) == "variable_assignment" {
            let raw = self.text(node).to_vec();
            let start = self.tree.nodes[node].start as usize;
            let Some(target) = self.tree.field(node, "name") else {
                return Ok(raw);
            };
            let value = self.tree.field(node, "value");
            let lead = self.tree.nodes[target].end as usize - start;
            let mut out = if self.kind(target) == "subscript" {
                self.element_word(target).await?
            } else {
                raw[..lead].to_vec()
            };
            match value {
                Some(value) => {
                    let from = self.tree.nodes[value].start as usize - start;
                    out.extend_from_slice(&raw[lead..from]);
                    out.extend(self.assignment(value).await?);
                }
                None => out.extend_from_slice(&raw[lead..]),
            }
            return Ok(out);
        }
        let mut chunks = self.chunks(node, false).await?;
        self.tilde(&mut chunks);
        Ok(join(&chunks))
    }

    /// An assignment word's `NAME[SUB]`, the subscript expanded where it
    /// stands and the text between its parts kept.
    async fn element_word(&mut self, target: usize) -> Result<Vec<u8>, Fault> {
        let mut parts = self.tree.named_children(target);
        let Some(name) = parts.next() else {
            return Ok(self.text(target).to_vec());
        };
        let inner: Vec<usize> = parts.collect();
        let start = self.tree.nodes[name].end as usize + 1;
        let stop = self.tree.nodes[target].end as usize - 1;
        let mut out = self.text(name).to_vec();
        out.push(b'[');
        out.extend(self.substituted(start, stop, inner).await?);
        out.push(b']');
        Ok(out)
    }

    /// An assignment's value: no field splitting, and a tilde prefix at
    /// its start and after each unquoted `:` (`PATH=/a:~/b`).
    pub async fn assignment(&mut self, node: usize) -> Result<Vec<u8>, Fault> {
        let chunks = self.chunks(node, false).await?;
        let mut bytes: Vec<(u8, bool)> = Vec::new();
        for chunk in &chunks {
            match chunk {
                Chunk::Piece(piece) => {
                    let literal = !piece.quoted && !piece.split;
                    bytes.extend(piece.text.iter().map(|&b| (b, literal)));
                }
                Chunk::Break(joiner) => bytes.extend(joiner.iter().map(|&b| (b, false))),
            }
        }
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        let mut start = true;
        while i < bytes.len() {
            let (byte, literal) = bytes[i];
            if start && literal && byte == b'~' {
                let end = (i + 1..bytes.len())
                    .find(|&j| !bytes[j].1 || bytes[j].0 == b'/' || bytes[j].0 == b':')
                    .unwrap_or(bytes.len());
                let boundary =
                    end == bytes.len() || (bytes[end].1 && matches!(bytes[end].0, b'/' | b':'));
                let prefix: Vec<u8> = bytes[i..end].iter().map(|(b, _)| *b).collect();
                if boundary {
                    if let Some(named) = self.tilde_prefix(&prefix) {
                        out.extend(named);
                        i = end;
                        start = false;
                        continue;
                    }
                }
            }
            start = literal && byte == b':';
            out.push(byte);
            i += 1;
        }
        Ok(out)
    }

    /// A brace word's words: its literal tokens form the template, every
    /// other child an inert atom that brings no brace syntax, so `{a,$v}`
    /// alternates on the atom and `{1..$n}` stays literal. Each word then
    /// expands on its own, as bash expands every word brace expansion
    /// makes: an atom expands afresh in each (`{a,b}$((i++))` is `a0 b1`),
    /// an unquoted value still splits (`{a,b}$x` is `a$x b$x`), and a bare
    /// `$name` the word's text runs on reads that text as part of its name
    /// (`$v{1,2}` reads `$v1` and `$v2`). None when nothing in the word
    /// brace-expands.
    async fn brace_words(&mut self, node: usize) -> Result<Option<Vec<Vec<Chunk>>>, Fault> {
        let mut template = Vec::new();
        let mut atoms = Vec::new();
        for child in self.tree.children(node) {
            let literal = !self.tree.nodes[child].named
                || matches!(self.kind(child), "word" | "number" | "brace_expression");
            if literal {
                template.extend(self.text(child).iter().map(|&b| Tok::Byte(b)));
            } else {
                template.push(Tok::Atom(atoms.len()));
                atoms.push(child);
            }
        }
        let Some(words) = expand_template(&template, &mut self.room).map_err(|_| Fault::Memory)?
        else {
            return Ok(None);
        };
        let mut out = Vec::with_capacity(words.len());
        // `{1..1000000}` is a million words: making them pauses as it goes,
        // so a cancel or the line's deadline lands before the last.
        for (index, word) in words.iter().enumerate() {
            let chunks = self.brace_word(word, &atoms).await?;
            self.spend(chunk_bytes(&chunks))?;
            out.push(chunks);
            if index % BRACE_SLICE == BRACE_SLICE - 1 {
                self.host.pause(self.shell).await?;
            }
        }
        Ok(Some(out))
    }

    /// One word brace expansion made, expanded: its text literal with its
    /// escapes quoting what they name, each atom expanded in turn. An
    /// empty word is no word (`{,x}` is `x`).
    async fn brace_word(&mut self, word: &[Tok], atoms: &[usize]) -> Result<Vec<Chunk>, Fault> {
        let mut out = Vec::new();
        let mut literal = Vec::new();
        let mut i = 0;
        while i < word.len() {
            let atom = match word[i] {
                Tok::Byte(byte) => {
                    literal.push(byte);
                    i += 1;
                    continue;
                }
                Tok::Nothing => {
                    flush_literal(&mut literal, &mut out);
                    out.push(Chunk::quoted(Vec::new()));
                    i += 1;
                    continue;
                }
                Tok::Atom(index) => atoms[index],
            };
            flush_literal(&mut literal, &mut out);
            i += 1;
            let text = self.text(atom);
            let bare = self.kind(atom) == "simple_expansion"
                && text
                    .get(1)
                    .is_some_and(|b| *b == b'_' || b.is_ascii_alphabetic());
            let tail = word[i..]
                .iter()
                .map_while(|tok| match tok {
                    Tok::Byte(b) if *b == b'_' || b.is_ascii_alphanumeric() => Some(*b),
                    _ => None,
                })
                .count();
            if bare && tail > 0 {
                let mut name = text[1..].to_vec();
                name.extend(word[i..i + tail].iter().map(|tok| match tok {
                    Tok::Byte(b) => *b,
                    _ => unreachable!("only bytes extend a name"),
                }));
                i += tail;
                out.extend(self.parameter_chunks(&name, false)?);
            } else {
                out.extend(self.chunks(atom, false).await?);
            }
        }
        flush_literal(&mut literal, &mut out);
        Ok(out)
    }

    /// Expand a node to the pieces field splitting reads; what an
    /// expansion yields comes out of the bytes left to build in.
    pub async fn chunks(&mut self, node: usize, quoted: bool) -> Result<Vec<Chunk>, Fault> {
        let chunks = match Box::pin(self.node_chunks(node, quoted)).await {
            Err(fault) => {
                let word = trim_start(self.text(node)).to_vec();
                return Err(within(fault, &word, false));
            }
            Ok(chunks) => chunks,
        };
        if matches!(
            self.kind(node),
            "simple_expansion" | "expansion" | "command_substitution" | "arithmetic_expansion"
        ) {
            self.spend(chunk_bytes(&chunks))?;
        }
        Ok(chunks)
    }

    async fn node_chunks(&mut self, node: usize, quoted: bool) -> Result<Vec<Chunk>, Fault> {
        match self.kind(node) {
            "word" => Ok(unquoted_runs(self.text(node))
                .into_iter()
                .map(|(run, escaped)| {
                    if escaped {
                        Chunk::quoted(run)
                    } else {
                        Chunk::literal(run)
                    }
                })
                .collect()),
            "command_name" => match self.tree.named_children(node).next() {
                Some(child) => self.chunks(child, false).await,
                None => Ok(vec![Chunk::literal(self.text(node).to_vec())]),
            },
            "simple_expansion" => {
                let fold = self.fold(node);
                let raw = self.text(node)[fold.len()..].to_vec();
                let mut out = Vec::new();
                if !fold.is_empty() {
                    out.push(Chunk::literal(fold));
                }
                let Some((name, end)) = scan_parameter(&raw, 0) else {
                    out.push(text_chunk(raw, quoted));
                    return Ok(out);
                };
                let name = name.to_vec();
                out.extend(self.parameter_chunks(&name, quoted)?);
                if end < raw.len() {
                    out.push(text_chunk(raw[end..].to_vec(), quoted));
                }
                Ok(out)
            }
            "expansion" => {
                let fold = self.fold(node);
                let braces = self.braces(node, quoted).await?;
                if fold.is_empty() {
                    Ok(braces)
                } else {
                    Ok(std::iter::once(Chunk::literal(fold))
                        .chain(braces)
                        .collect())
                }
            }
            kind @ ("command_substitution" | "arithmetic_expansion") => {
                let fold = self.fold(node);
                let text = if kind == "arithmetic_expansion" {
                    self.arith_expansion(node).await?
                } else {
                    self.substitution(node, fold.len()).await?
                };
                let mut out = Vec::new();
                if !fold.is_empty() {
                    out.push(Chunk::literal(fold));
                }
                out.push(Chunk::value(text, quoted));
                Ok(out)
            }
            "concatenation" => {
                let children: Vec<usize> = self.tree.children(node).collect();
                let mut out = Vec::new();
                for (position, &child) in children.iter().enumerate() {
                    if self.kind(child) == "$"
                        && children
                            .get(position + 1)
                            .is_some_and(|&next| self.kind(next) == "string")
                    {
                        continue;
                    }
                    out.extend(self.chunks(child, false).await?);
                }
                Ok(out)
            }
            "string" => self.string_chunks(node).await,
            "translated_string" => {
                let string = self
                    .tree
                    .named_children(node)
                    .find(|&child| self.kind(child) == "string");
                match string {
                    Some(string) => self.string_chunks(string).await,
                    None => Ok(vec![Chunk::literal(Vec::new())]),
                }
            }
            "number" => Ok(vec![Chunk::literal(self.text(node).to_vec())]),
            "string_content" => Ok(vec![text_chunk(unescape_dquoted(self.text(node)), quoted)]),
            "raw_string" => {
                let text = self.text(node);
                Ok(vec![Chunk::quoted(text[1..text.len() - 1].to_vec())])
            }
            "ansi_c_string" => {
                let text = self.text(node);
                Ok(vec![Chunk::quoted(decode_ansi_c(
                    &text[2..text.len() - 1],
                    self.shell.utf8(),
                ))])
            }
            "process_substitution" => {
                let path = self.host.process_substitution(self.shell, node).await?;
                Ok(vec![Chunk::literal(path)])
            }
            _ => Ok(vec![text_chunk(self.text(node).to_vec(), quoted)]),
        }
    }

    /// A double-quoted string's pieces: everything it encloses literal,
    /// one field even around nothing (`""`), except that a `$@`-style
    /// splat over no elements, with no other text, is no field at all
    /// (`"$@"` with no parameters), where one empty parameter is one empty
    /// word: only the element count decides.
    async fn string_chunks(&mut self, node: usize) -> Result<Vec<Chunk>, Fault> {
        let mut chunks = vec![Chunk::quoted(Vec::new())];
        let mut at_splat = false;
        let mut yielded = false;
        let parent = self.tree.nodes[node].parent as usize;
        let document = (self.tree.nodes[node].parent != u32::MAX)
            .then(|| self.tree.heredoc(parent))
            .flatten();
        let inside = match document {
            Some(heredoc) => heredoc.body.clone(),
            None => {
                let text = self.text(node);
                text.get(1..text.len().saturating_sub(1))
                    .unwrap_or_default()
                    .to_vec()
            }
        };
        for part in self.parts(node) {
            match part {
                Part::Text(..) => {
                    chunks.push(Chunk::quoted(unescape_dquoted(self.part_text(part))))
                }
                Part::Node(child) if self.kind(child) == "\"" => {
                    let text = self.text(child);
                    chunks.push(Chunk::quoted(unescape_dquoted(&text[..text.len() - 1])));
                }
                Part::Node(child) => {
                    let pieces = match self.chunks(child, true).await {
                        Ok(pieces) => pieces,
                        Err(fault) => return Err(within(fault, &inside, true)),
                    };
                    if self.is_at_splat(child) {
                        at_splat = true;
                        yielded = yielded || !pieces.is_empty();
                    }
                    chunks.extend(pieces);
                }
            }
        }
        if at_splat && !yielded && join(&chunks).is_empty() {
            return Ok(Vec::new());
        }
        Ok(chunks)
    }

    /// Whether a string's child is a `$@`-style splat: `$@`, `${@}`,
    /// `${a[@]}`, and not `${#a[@]}`, a count.
    fn is_at_splat(&self, node: usize) -> bool {
        match self.kind(node) {
            "simple_expansion" => trim_start(self.text(node)) == b"$@",
            "expansion" => {
                let braces = self.parse_braces(node);
                !braces.length
                    && (braces.subscript.as_deref() == Some(b"@")
                        || (braces.subscript.is_none() && braces.name.as_deref() == Some(b"@")))
            }
            _ => false,
        }
    }
}

/// Text outside an expansion: literal, its glob characters quoted when it
/// stands inside double quotes.
fn text_chunk(text: Vec<u8>, quoted: bool) -> Chunk {
    if quoted {
        Chunk::quoted(text)
    } else {
        Chunk::literal(text)
    }
}

/// The literal text a brace word has gathered, as pieces: its escapes
/// quote what they name.
fn flush_literal(literal: &mut Vec<u8>, out: &mut Vec<Chunk>) {
    for (run, escaped) in unquoted_runs(&std::mem::take(literal)) {
        out.push(if escaped {
            Chunk::quoted(run)
        } else {
            Chunk::literal(run)
        });
    }
}

/// The reference as a message names it: `m[zz]` for an element.
fn reference(p: &Braces) -> String {
    let name = String::from_utf8_lossy(p.name.as_deref().unwrap_or_default()).into_owned();
    match &p.subscript {
        Some(subscript) => format!("{name}[{}]", String::from_utf8_lossy(subscript)),
        None => name,
    }
}

/// A line discarded on a diagnostic of the shell's own, led by its `voice`.
fn discard(voice: &[u8], message: &str) -> Fault {
    Signal::Discard {
        stderr: voiced(voice, message),
        contained: 1,
    }
    .into()
}

fn bad_subscript(voice: &[u8], p: &Braces) -> Fault {
    discard(voice, &format!("{}: bad array subscript\n", reference(p)))
}
