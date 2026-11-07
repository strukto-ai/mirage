//! Word expansion over the parsed tree: a word's pieces, each carrying its
//! quoting, then fields split on IFS. Quoting rides on the piece instead of
//! a mark inside the text, so a quoted glob character stays literal (`'*'`)
//! however the pieces are joined. What the shell cannot answer itself, a
//! command substitution's output, the host does.

mod arithmetic;
mod arrays;
mod braces;
mod patterns;
mod substitution;
mod substring;
#[cfg(test)]
mod tests;

use std::future::Future;

use super::brace::{self, Tok, expand_template};
use super::escapes::{decode_ansi_c, unescape_dquoted, unquoted_runs};
use super::parameter::scan_parameter;
use super::pattern::{Pattern, Replacement};
use super::shell::{IFS_DEFAULT, Shell};
pub(super) use super::voiced;
use super::write::{Fault, Gate, Writer};
use super::{Diagnostic, Signal};
use crate::shell::Tree;
use crate::vars::RANDOM;

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

/// The characters the glob matcher reads specially, each a quoted run's
/// mark at `0xFDD0` plus its place here, as the hosts' `mark_globs` spells
/// them.
const GLOB_SPECIALS: &[u8] = b"*?[@+!()|";

/// Runs as the hosts' globbing reads them: each quoted glob character
/// under its mark, everything else as it is.
pub fn marked(runs: &[(Vec<u8>, bool)]) -> Vec<u8> {
    let mut out = Vec::new();
    for (text, quoted) in runs {
        if !quoted {
            out.extend_from_slice(text);
            continue;
        }
        for &byte in text {
            match GLOB_SPECIALS.iter().position(|&c| c == byte) {
                Some(at) => {
                    let mark = char::from_u32(0xFDD0 + at as u32).unwrap_or('\u{FFFD}');
                    let mut buf = [0; 4];
                    out.extend_from_slice(mark.encode_utf8(&mut buf).as_bytes());
                }
                None => out.push(byte),
            }
        }
    }
    out
}

/// A field after splitting: its runs, each quoted or live for globbing.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Field(pub Vec<(Vec<u8>, bool)>);

impl Field {
    fn push(&mut self, text: &[u8], quoted: bool) {
        if text.is_empty() {
            return;
        }
        match self.0.last_mut() {
            Some((run, q)) if *q == quoted => run.extend_from_slice(text),
            _ => self.0.push((text.to_vec(), quoted)),
        }
    }

    /// The field's text, quoting removed.
    pub fn text(&self) -> Vec<u8> {
        self.0
            .iter()
            .flat_map(|(run, _)| run.iter().copied())
            .collect()
    }
}

/// What `"$*"` joins the parameters with: IFS's first character, a space
/// when IFS is unset and nothing when it is empty. A character is a whole
/// UTF-8 sequence when `utf8`, else a byte.
pub fn ifs_joiner(ifs: Option<&[u8]>, utf8: bool) -> Vec<u8> {
    match ifs {
        None => b" ".to_vec(),
        Some(ifs) => char_at(ifs, utf8).to_vec(),
    }
}

/// The character `text` starts with: its UTF-8 sequence when `utf8` and
/// the bytes form one, else its first byte; empty for empty text.
fn char_at(text: &[u8], utf8: bool) -> &[u8] {
    if text.is_empty() {
        return text;
    }
    &text[..if utf8 { patterns::char_len(text) } else { 1 }]
}

/// A splat's elements, a field boundary between each two.
pub fn splat(elements: &[Vec<u8>], joiner: &[u8], quoted: bool) -> Vec<Chunk> {
    let mut out = Vec::with_capacity(elements.len() * 2);
    for (index, element) in elements.iter().enumerate() {
        if index > 0 {
            out.push(Chunk::Break(joiner.to_vec()));
        }
        out.push(Chunk::value(element.clone(), quoted));
    }
    out
}

/// A word's text where no field splitting happens (an assignment, a `case`
/// word, `[[ ]]`): a splat boundary reads as its joiner.
pub fn join(chunks: &[Chunk]) -> Vec<u8> {
    let mut out = Vec::new();
    for chunk in chunks {
        match chunk {
            Chunk::Piece(piece) => out.extend_from_slice(&piece.text),
            Chunk::Break(joiner) => out.extend_from_slice(joiner),
        }
    }
    out
}

/// Split a word's pieces into fields on IFS, as bash does. Only split
/// pieces split. An IFS whitespace run delimits a field and is dropped at
/// either end; any other IFS character, with the whitespace around it,
/// delimits exactly one, so `a,,b` under `IFS=,` is three fields and `a,`
/// one. A splat boundary always ends a field. A field exists once literal
/// or quoted text, or a split value that is not empty, opened it, so an
/// unquoted expansion that comes back empty is no word while `""` is one.
/// Under `utf8` a separator is a whole character, so `IFS=é` splits on
/// `é` alone and never inside `à`. A long value pauses through `pause`
/// as it is scanned, so a cancel or the line's deadline lands inside it.
pub async fn split_fields(
    chunks: &[Chunk],
    ifs: Option<&[u8]>,
    utf8: bool,
    pause: &mut impl AsyncFnMut() -> Result<(), Fault>,
) -> Result<Vec<Field>, Fault> {
    let separators = ifs.unwrap_or(IFS_DEFAULT);
    let mut set: Vec<&[u8]> = Vec::new();
    let mut rest = separators;
    while !rest.is_empty() {
        let c = char_at(rest, utf8);
        set.push(c);
        rest = &rest[c.len()..];
    }
    let separator = |text: &[u8]| set.contains(&char_at(text, utf8));
    let blank = |text: &[u8]| IFS_DEFAULT.contains(&text[0]) && separator(text);
    let mut fields = Vec::new();
    let mut current = Field::default();
    let mut started = false;
    for chunk in chunks {
        let piece = match chunk {
            Chunk::Break(_) => {
                if started {
                    fields.push(std::mem::take(&mut current));
                }
                current = Field::default();
                started = false;
                continue;
            }
            Chunk::Piece(piece) => piece,
        };
        if !piece.split || separators.is_empty() {
            current.push(&piece.text, piece.quoted);
            started = started || !piece.split || !piece.text.is_empty();
            continue;
        }
        let text = &piece.text;
        let mut index = 0;
        let mut paused = 0;
        while index < text.len() {
            if index - paused >= SPLIT_SLICE {
                pause().await?;
                paused = index;
            }
            let mut end = index;
            while end < text.len() && !separator(&text[end..]) {
                end += char_at(&text[end..], utf8).len();
            }
            if end > index {
                current.push(&text[index..end], false);
                started = true;
                index = end;
                continue;
            }
            while end < text.len() && blank(&text[end..]) {
                end += 1;
            }
            let hard = end < text.len() && separator(&text[end..]);
            if hard {
                end += char_at(&text[end..], utf8).len();
                while end < text.len() && blank(&text[end..]) {
                    end += 1;
                }
            }
            if started || hard {
                fields.push(std::mem::take(&mut current));
            }
            current = Field::default();
            started = false;
            index = end;
        }
    }
    if started {
        fields.push(current);
    }
    Ok(fields)
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

/// The bytes of a value field splitting scans between two pauses.
const SPLIT_SLICE: usize = 64 * 1024;

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
        Writer {
            allexport: self.shell.option("allexport"),
            nounset: self.shell.option("nounset"),
            limit: self.shell.env_limit,
            outside: self.shell.outside,
            store: &mut self.shell.vars,
            gate: self.host,
            diagnostics: Some(self.diagnostics),
        }
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

    /// A word in a command's argument list: its pieces, its tilde prefix
    /// expanded, split into fields on IFS.
    pub async fn fields(&mut self, node: usize) -> Result<Vec<Field>, Fault> {
        if matches!(self.kind(node), "concatenation" | "brace_expression")
            && self.shell.option("braceexpand")
        {
            if let Some(words) = self.brace_words(node).await? {
                let mut out = Vec::new();
                for mut chunks in words {
                    self.tilde(&mut chunks);
                    out.extend(self.split(&chunks).await?);
                }
                return Ok(out);
            }
        }
        let mut chunks = self.chunks(node, false).await?;
        self.tilde(&mut chunks);
        self.assignment_tildes(&mut chunks);
        self.split(&chunks).await
    }

    /// Split a word's pieces into fields on the shell's IFS, pausing as a
    /// long value is scanned.
    async fn split(&mut self, chunks: &[Chunk]) -> Result<Vec<Field>, Fault> {
        let (host, shell) = (&mut *self.host, &*self.shell);
        let pause = &mut async || host.pause(shell).await;
        split_fields(chunks, shell.ifs(), shell.utf8(), pause).await
    }

    /// An argument shaped like an assignment (`a=~/x`, `a+=~`, `a[$k]=~`):
    /// bash expands a tilde prefix after its `=` and after each unquoted
    /// `:` in it, as in an assignment's value, so `echo a=~` names the home
    /// directory while `echo --a=~` and a word brace expansion made do not.
    fn assignment_tildes(&self, chunks: &mut Vec<Chunk>) {
        let mut merged: Vec<Chunk> = Vec::with_capacity(chunks.len());
        for chunk in std::mem::take(chunks) {
            if let (Some(Chunk::Piece(prev)), Chunk::Piece(next)) = (merged.last_mut(), &chunk) {
                if plain(prev) && plain(next) {
                    prev.text.extend_from_slice(&next.text);
                    continue;
                }
            }
            merged.push(chunk);
        }
        *chunks = merged;
        let Some((value_chunk, value_at)) = assignment_value_at(chunks) else {
            return;
        };
        let count = chunks.len();
        let mut out = Vec::with_capacity(count + 2);
        for (index, chunk) in std::mem::take(chunks).into_iter().enumerate() {
            let piece = match chunk {
                Chunk::Piece(piece) if index >= value_chunk && plain(&piece) => piece,
                other => {
                    out.push(other);
                    continue;
                }
            };
            let text = piece.text;
            let last = index + 1 == count;
            let mut from = 0;
            let mut i = if index == value_chunk { value_at } else { 0 };
            let mut start = index == value_chunk;
            while i < text.len() {
                if start && text[i] == b'~' {
                    let end = (i + 1..text.len())
                        .find(|&j| matches!(text[j], b'/' | b':'))
                        .unwrap_or(text.len());
                    if end < text.len() || last {
                        if let Some(named) = self.tilde_prefix(&text[i..end]) {
                            out.push(Chunk::literal(text[from..i].to_vec()));
                            out.push(Chunk::quoted(named));
                            from = end;
                            i = end;
                            start = false;
                            continue;
                        }
                    }
                }
                start = text[i] == b':';
                i += 1;
            }
            out.push(Chunk::literal(text[from..].to_vec()));
        }
        out.retain(|chunk| {
            !matches!(chunk, Chunk::Piece(piece) if piece.text.is_empty() && !piece.quoted && !piece.split)
        });
        *chunks = out;
    }

    /// A word where no field splitting happens (a `case` word, a `[[`
    /// operand, a here-string), quoting removed. A `name=value` argument
    /// (`export a=~/x`) expands its value as an assignment does.
    pub async fn word_text(&mut self, node: usize) -> Result<Vec<u8>, Fault> {
        if self.kind(node) == "variable_assignment" {
            let raw = self.text(node).to_vec();
            let Some(eq) = raw.iter().position(|&b| b == b'=') else {
                return Ok(raw);
            };
            let value = self
                .tree
                .named_children(node)
                .find(|&child| self.kind(child) != "variable_name");
            let mut out = raw[..=eq].to_vec();
            match value {
                Some(value) => out.extend(self.assignment(value).await?),
                None => out.extend_from_slice(&raw[eq + 1..]),
            }
            return Ok(out);
        }
        let mut chunks = self.chunks(node, false).await?;
        self.tilde(&mut chunks);
        Ok(join(&chunks))
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

    /// Expand a word's tilde prefix: a `~` the word starts with, unquoted,
    /// up to the first unquoted slash. A prefix that holds a quoted
    /// character or an expansion is no tilde prefix (`~"/x"`, `\~`), and
    /// what it names is quoted, so it neither splits nor globs.
    pub fn tilde(&self, chunks: &mut Vec<Chunk>) {
        let Some(Chunk::Piece(first)) = chunks.first() else {
            return;
        };
        if first.quoted || first.split || !first.text.starts_with(b"~") {
            return;
        }
        let slash = first.text.iter().position(|b| *b == b'/');
        if slash.is_none() && chunks.len() > 1 {
            return;
        }
        let end = slash.unwrap_or(first.text.len());
        let Some(named) = self.tilde_prefix(&first.text[..end]) else {
            return;
        };
        let rest = first.text[end..].to_vec();
        chunks[0] = Chunk::quoted(named);
        if !rest.is_empty() {
            chunks.insert(1, Chunk::literal(rest));
        }
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

    /// A parameter's value where nothing splits. `strict` is `set -u`'s
    /// refusal of an unset name or positional; the defaulting operators
    /// pass false. The specials never refuse.
    fn lookup(&mut self, name: &[u8], strict: bool) -> Result<Vec<u8>, Fault> {
        let nounset = strict && self.shell.option("nounset");
        let params = self.shell.params();
        match name {
            b"@" => return Ok(params.join(&b' ')),
            b"*" => {
                return Ok(params.join(ifs_joiner(self.shell.ifs(), self.shell.utf8()).as_slice()));
            }
            b"#" => return Ok(params.len().to_string().into_bytes()),
            b"?" => return Ok(self.shell.status.to_string().into_bytes()),
            b"$" => return Ok(self.shell.pid.to_string().into_bytes()),
            b"-" => return Ok(self.shell.flags()),
            b"!" => {
                return Ok(self
                    .shell
                    .last_job
                    .map(|job| job.to_string().into_bytes())
                    .unwrap_or_default());
            }
            _ => {}
        }
        if name.iter().all(u8::is_ascii_digit) && !name.is_empty() {
            let index: usize = std::str::from_utf8(name)
                .ok()
                .and_then(|n| n.parse().ok())
                .unwrap_or(usize::MAX);
            if index == 0 {
                return Ok(self.shell.argv0.clone());
            }
            if let Some(param) = params.get(index - 1) {
                return Ok(param.clone());
            }
            if nounset {
                return Err(Signal::unbound(
                    self.shell.vars.voice(),
                    &String::from_utf8_lossy(name),
                )
                .into());
            }
            return Ok(Vec::new());
        }
        let name = String::from_utf8_lossy(name).into_owned();
        if name == RANDOM {
            if let Some(value) = self.shell.vars.next_random().map_err(Fault::Arith)? {
                return Ok(value.to_string().into_bytes());
            }
        }
        let vars = &self.shell.vars;
        let found = if let Some(array) = self.shell.indexed(&name) {
            array.get(0).map(<[u8]>::to_vec)
        } else if let Some(map) = vars.assoc(&name) {
            map.get(b"0").map(<[u8]>::to_vec)
        } else if let Some(value) = vars.dynamic(&name) {
            Some(value)
        } else {
            vars.scalar(&name).map(<[u8]>::to_vec)
        };
        match found {
            Some(value) => Ok(value),
            None if nounset => Err(Signal::unbound(self.shell.vars.voice(), &name).into()),
            None => Ok(Vec::new()),
        }
    }

    /// One `$name` as pieces: `$@` is one field per positional parameter,
    /// quoted or not, and so is an unquoted `$*`; inside double quotes `$*`
    /// is the parameters joined on IFS's first character.
    fn parameter_chunks(&mut self, name: &[u8], quoted: bool) -> Result<Vec<Chunk>, Fault> {
        if name != b"@" && name != b"*" {
            let positional = name.iter().all(u8::is_ascii_digit) && name != b"0";
            if positional && self.shell.option("nounset") && !self.positional_set(name) {
                let spelled = format!("${}", String::from_utf8_lossy(name));
                return Err(Signal::unbound(self.shell.vars.voice(), &spelled).into());
            }
            return Ok(vec![Chunk::value(self.lookup(name, true)?, quoted)]);
        }
        let params = self.shell.params().to_vec();
        let joiner = if name == b"@" {
            b" ".to_vec()
        } else {
            ifs_joiner(self.shell.ifs(), self.shell.utf8())
        };
        if name == b"*" && quoted {
            return Ok(vec![Chunk::value(params.join(joiner.as_slice()), true)]);
        }
        Ok(splat(&params, &joiner, quoted))
    }

    /// What a word's tilde prefix names: `~` and `~/rest` the home
    /// directory (`HOME=/` makes `~/x` `//x`), `~+` `$PWD`, `~-` `$OLDPWD`;
    /// None for any other prefix, a user name (no user database) or a
    /// variable that is unset.
    pub fn tilde_prefix(&self, text: &[u8]) -> Option<Vec<u8>> {
        let rest = text.strip_prefix(b"~")?;
        let slash = rest.iter().position(|b| *b == b'/').unwrap_or(rest.len());
        let (prefix, tail) = rest.split_at(slash);
        let base = match prefix {
            b"" => self.shell.home()?,
            b"+" => self.shell.vars.scalar("PWD")?,
            b"-" => self.shell.vars.scalar("OLDPWD")?,
            _ => return None,
        };
        Some([base, tail].concat())
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

/// A piece as typed: unquoted, and no expansion's value.
fn plain(piece: &Piece) -> bool {
    !piece.quoted && !piece.split
}

/// Where the value of an assignment-shaped word starts, as a chunk and a
/// byte in it: past a typed `name=`, `name+=` or `name[subscript]=`, the
/// subscript's brackets balanced and its text free to be quoted or
/// expanded (`c[$k]=~`); None when the first typed `=` ends anything else.
fn assignment_value_at(chunks: &[Chunk]) -> Option<(usize, usize)> {
    let Some(Chunk::Piece(first)) = chunks.first() else {
        return None;
    };
    if !plain(first)
        || !first
            .text
            .first()
            .is_some_and(|b| *b == b'_' || b.is_ascii_alphabetic())
    {
        return None;
    }
    let mut depth = 0usize;
    let mut closed = false;
    let mut plus = false;
    for (index, chunk) in chunks.iter().enumerate() {
        let piece = match chunk {
            Chunk::Piece(piece) if plain(piece) => piece,
            _ if depth > 0 => continue,
            _ => return None,
        };
        for (at, &byte) in piece.text.iter().enumerate() {
            match byte {
                b'=' if depth == 0 => return Some((index, at + 1)),
                b'=' => return None,
                _ if plus => return None,
                b'[' if depth > 0 || !closed => depth += 1,
                b']' if depth > 0 => {
                    depth -= 1;
                    closed = depth == 0;
                }
                _ if depth > 0 => {}
                b'+' => plus = true,
                b'_' | b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' if !closed => {}
                _ => return None,
            }
        }
    }
    None
}
