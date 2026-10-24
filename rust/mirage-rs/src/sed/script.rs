use std::collections::HashMap;

use crate::regex::parse::Dialect;
use crate::regex::posix::{Options, Posix};

use super::text::{Refusal, unit};

/// The release whose behaviour this follows; `v` refuses a newer one.
const VERSION: &[u8] = b"4.9";
const BLANKS: &[u8] = b" \t";
const SPACES: &[u8] = b" \t\n\x0b\x0c\r";
const RECURSIVE: &str = "recursive escaping after \\c not allowed";
/// The one expression error GNU words without a place.
const CLASS_SYNTAX: &str = "character class syntax is";

/// One -e expression, or one -f file with the name its diagnostics give.
pub(super) struct Piece {
    pub(super) text: Vec<u8>,
    pub(super) file: Option<Vec<u8>>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Address {
    Line(u64),
    Last,
    /// An expression by its place in the program's table, None for the
    /// empty one, which matches as the last expression used.
    Regex(Option<usize>),
    /// `first~step`, the step past zero.
    Step(u64, u64),
    /// `addr,+N`.
    Plus(u64),
    /// `addr,~N`.
    Multiple(u64),
}

impl Address {
    /// The number GNU checks against line 0.
    fn number(self) -> u64 {
        match self {
            Address::Line(n) | Address::Step(n, _) | Address::Plus(n) | Address::Multiple(n) => n,
            Address::Last | Address::Regex(_) => 0,
        }
    }
}

/// A piece of an `s` replacement: text, a group (0 for the whole match),
/// or a case conversion (`L U l u E`).
pub(super) enum Part {
    Text(Vec<u8>),
    Group(usize),
    Case(u8),
}

pub(super) struct Subst {
    pub(super) regex: Option<usize>,
    pub(super) parts: Vec<Part>,
    pub(super) global: bool,
    pub(super) occurrence: u64,
    pub(super) print: bool,
    pub(super) wfile: Option<usize>,
}

/// `y`'s table: by byte, or by character under UTF-8.
pub(super) enum Translit {
    Bytes(Box<[u8; 256]>),
    Chars(HashMap<Vec<u8>, Vec<u8>>),
}

/// One command: its addresses, its letter and what it carries.
pub(super) struct Command {
    pub(super) name: u8,
    pub(super) addr1: Option<Address>,
    pub(super) addr2: Option<Address>,
    pub(super) negate: bool,
    /// `a`, `i` and `c`'s text, None when there is none at all.
    pub(super) text: Option<Vec<u8>>,
    label: Vec<u8>,
    /// Where `b`, `t` and `T` jump; where `{` ends.
    pub(super) target: usize,
    /// The file `r`, `R`, `w` or `W` names, by its place in the
    /// program's list for that kind.
    pub(super) file: usize,
    pub(super) number: Option<i64>,
    pub(super) subst: Option<Box<Subst>>,
    pub(super) translit: Option<Translit>,
}

impl Command {
    /// Whether the command is addressed by line 0 alone (`0r`).
    pub(super) fn zero_line(&self) -> bool {
        self.addr1 == Some(Address::Line(0)) && self.addr2.is_none()
    }
}

/// A compiled script: its commands in order, its expressions, the files
/// its `w`, `r` and `R` commands name in the order they first appear, and
/// whether `#n` made it quiet.
#[derive(Default)]
pub(super) struct Program {
    pub(super) commands: Vec<Command>,
    pub(super) regexes: Vec<Posix>,
    pub(super) wfiles: Vec<Vec<u8>>,
    pub(super) rfiles: Vec<Vec<u8>>,
    pub(super) reader_files: Vec<Vec<u8>>,
    pub(super) quiet: bool,
}

/// The script's pieces as one text, joined by newlines, read one byte at
/// a time, with the place GNU names in a diagnostic for the last one read.
struct Script {
    text: Vec<u8>,
    starts: Vec<usize>,
    lengths: Vec<usize>,
    /// The newlines that join one piece to the next, which only text
    /// continues across.
    joins: Vec<usize>,
    numbers: Vec<usize>,
    files: Vec<Option<Vec<u8>>>,
    pos: usize,
}

fn lines(text: &[u8]) -> usize {
    text.iter().filter(|&&c| c == b'\n').count() + 1
}

impl Script {
    fn new(pieces: Vec<Piece>) -> Script {
        let mut script = Script {
            text: Vec::new(),
            starts: Vec::new(),
            lengths: Vec::new(),
            joins: Vec::new(),
            numbers: Vec::new(),
            files: Vec::new(),
            pos: 0,
        };
        let mut expressions = 0;
        for (index, piece) in pieces.into_iter().enumerate() {
            if index > 0 {
                script.joins.push(script.text.len());
                script.text.push(b'\n');
            }
            script.starts.push(script.text.len());
            script.lengths.push(piece.text.len());
            script.text.extend_from_slice(&piece.text);
            if piece.file.is_none() {
                expressions += 1;
            }
            script.numbers.push(expressions);
            script.files.push(piece.file);
        }
        script
    }

    fn peek(&self) -> Option<u8> {
        self.text.get(self.pos).copied()
    }

    fn get(&mut self) -> Option<u8> {
        let ch = self.peek();
        if ch.is_some() {
            self.pos += 1;
        }
        ch
    }

    /// Pass over any of `chars`; the next byte after them.
    fn skip(&mut self, chars: &[u8]) -> Option<u8> {
        while self.peek().is_some_and(|ch| chars.contains(&ch)) {
            self.pos += 1;
        }
        self.peek()
    }

    fn joined(&self, at: usize) -> bool {
        self.joins.contains(&at)
    }

    /// GNU's name for a place in the script: the last byte read, or the
    /// one before `at`.
    fn place(&self, at: Option<usize>) -> Vec<u8> {
        let last = at.unwrap_or(self.pos) as isize - 1;
        let index = self
            .starts
            .partition_point(|&start| start as isize <= last.max(0))
            .saturating_sub(1);
        let start = self.starts[index];
        let offset = last - start as isize;
        if let Some(name) = &self.files[index] {
            let mut end = start as isize + offset;
            if end < 0 {
                end += self.text.len() as isize;
            }
            let end = (end.max(0) as usize).min(self.text.len());
            let body = self.text.get(start..end).unwrap_or_default();
            return [
                b"file ".as_slice(),
                name,
                format!(" line {}", lines(body)).as_bytes(),
            ]
            .concat();
        }
        let count = (offset + 1).clamp(0, self.lengths[index] as isize);
        format!("-e expression #{}, char {count}", self.numbers[index]).into_bytes()
    }

    /// The end of the last piece, where GNU reports an unclosed block.
    fn last_place(&self) -> Vec<u8> {
        let index = self.starts.len() - 1;
        if let Some(name) = &self.files[index] {
            let body = &self.text[self.starts[index]..];
            return [
                b"file ".as_slice(),
                name,
                format!(" line {}", lines(body)).as_bytes(),
            ]
            .concat();
        }
        format!("-e expression #{}, char 0", self.numbers[index]).into_bytes()
    }
}

/// A `\c` before a backslash that does not stand for itself.
struct Recursive;

/// The byte a `\d`, `\o`, `\x` or `\c` escape names at `text[at]`, its
/// letter, and where the escape ends; None when no digits follow (the
/// escape is then its letter).
fn numeric_escape(text: &[u8], at: usize) -> Result<Option<(u8, usize)>, Recursive> {
    let kind = text[at];
    if kind == b'c' {
        // `\c` at the end stands for a backslash, and `\c\\` is the
        // control character of a backslash.
        let Some(&next) = text.get(at + 1) else {
            return Ok(Some((b'\\', at + 1)));
        };
        if next == b'\\' {
            if text.get(at + 2) == Some(&b'\\') {
                return Ok(Some((0x1C, at + 3)));
            }
            return Err(Recursive);
        }
        // Only an ASCII letter takes its capital: the text is bytes.
        return Ok(Some((next.to_ascii_uppercase() ^ 0x40, at + 2)));
    }
    let (base, width) = match kind {
        b'd' => (10, 3),
        b'o' => (8, 3),
        _ => (16, 2),
    };
    let mut end = at + 1;
    while end < text.len() && end - at - 1 < width && char::from(text[end]).is_digit(base) {
        end += 1;
    }
    if end == at + 1 {
        return Ok(None);
    }
    let digits = std::str::from_utf8(&text[at + 1..end]).unwrap_or("0");
    let value = u32::from_str_radix(digits, base).unwrap_or(0);
    Ok(Some(((value & 0xFF) as u8, end)))
}

/// A sed escape at `text[at]`, the letter after a backslash: the byte it
/// stands for and where it ends, or None when the letter is no escape.
fn escape(text: &[u8], at: usize) -> Result<Option<(u8, usize)>, Recursive> {
    let control = match text[at] {
        b'a' => 0x07,
        b'f' => 0x0C,
        b'n' => b'\n',
        b'r' => b'\r',
        b't' => b'\t',
        b'v' => 0x0B,
        b'd' | b'o' | b'x' | b'c' => return numeric_escape(text, at),
        _ => return Ok(None),
    };
    Ok(Some((control, at + 1)))
}

/// An expression's text as regcomp gets it from sed: the escapes sed
/// reads itself turned into the bytes they stand for, which keep whatever
/// meaning they have there (`\x2e` is any character).
fn regex_text(raw: &[u8]) -> Result<Vec<u8>, Recursive> {
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] != b'\\' || i + 1 >= raw.len() {
            out.push(raw[i]);
            i += 1;
            continue;
        }
        match escape(raw, i + 1)? {
            Some((byte, end)) => {
                out.push(byte);
                i = end;
            }
            None => {
                out.extend_from_slice(&raw[i..i + 2]);
                i += 2;
            }
        }
    }
    Ok(out)
}

/// A `y` string's bytes: `\\` a backslash, sed's escapes the bytes they
/// name, and any other escaped byte itself.
fn y_text(raw: &[u8]) -> Result<Vec<u8>, Recursive> {
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        if raw[i] != b'\\' || i + 1 >= raw.len() {
            out.push(raw[i]);
            i += 1;
            continue;
        }
        let found = if raw[i + 1] == b'\\' {
            None
        } else {
            escape(raw, i + 1)?
        };
        match found {
            Some((byte, end)) => {
                out.push(byte);
                i = end;
            }
            None => {
                out.push(raw[i + 1]);
                i += 2;
            }
        }
    }
    Ok(out)
}

/// glibc's strverscmp order: text compares byte by byte, but where the
/// first difference falls inside a run of digits the two runs compare as
/// numbers, and a run that starts with `0` is a fraction that sorts
/// before every whole number.
fn version_after(a: &[u8], b: &[u8]) -> bool {
    if a == b {
        return false;
    }
    let split = a.iter().zip(b).take_while(|(x, y)| x == y).count();
    let (left, right) = (a.get(split), b.get(split));
    let mut head = split;
    while head > 0 && a[head - 1].is_ascii_digit() {
        head -= 1;
    }
    let run = |text: &[u8]| -> usize {
        text.get(head..)
            .unwrap_or_default()
            .iter()
            .take_while(|c| c.is_ascii_digit())
            .count()
    };
    let (run_a, run_b) = (run(a), run(b));
    if run_a == 0 || run_b == 0 {
        return left > right;
    }
    let fraction_a = run_a > 1 && a[head] == b'0';
    let fraction_b = run_b > 1 && b[head] == b'0';
    if fraction_a != fraction_b {
        return fraction_b;
    }
    if !fraction_a && run_a != run_b {
        return run_a > run_b;
    }
    let digit = |c: Option<&u8>| c.is_some_and(u8::is_ascii_digit);
    if fraction_a && a[head..split].iter().all(|&c| c == b'0') && digit(left) != digit(right) {
        return !digit(left);
    }
    left > right
}

/// Reads a script into a `Program` the way GNU sed 4.9 does.
struct Compiler {
    src: Script,
    extended: bool,
    utf8: bool,
    program: Program,
    blocks: Vec<usize>,
}

type Compiled<T> = Result<T, Refusal>;

impl Compiler {
    fn fail_at(&self, at: Option<usize>, message: &str) -> Refusal {
        Refusal::new(
            [
                b"sed: ".as_slice(),
                &self.src.place(at),
                b": ",
                message.as_bytes(),
            ]
            .concat(),
            1,
        )
    }

    fn fail(&self, message: &str) -> Refusal {
        self.fail_at(None, message)
    }

    fn fail_named(&self, message: &str, name: u8, tail: &str) -> Refusal {
        let mut refusal = self.fail(message);
        refusal.message.push(name);
        refusal.message.extend_from_slice(tail.as_bytes());
        refusal
    }

    fn compile(&mut self) -> Compiled<()> {
        if self.src.text.starts_with(b"#n") {
            self.program.quiet = true;
        }
        loop {
            match self.src.skip(b" \t\n\x0b\x0c\r;") {
                None => break,
                Some(b'#') => while self.src.get().is_some_and(|ch| ch != b'\n') {},
                Some(_) => self.command()?,
            }
        }
        if !self.blocks.is_empty() {
            return Err(Refusal::new(
                [
                    b"sed: ".as_slice(),
                    &self.src.last_place(),
                    b": unmatched `{'",
                ]
                .concat(),
                1,
            ));
        }
        self.resolve()
    }

    fn resolve(&mut self) -> Compiled<()> {
        let mut labels: HashMap<Vec<u8>, usize> = HashMap::new();
        for (index, cmd) in self.program.commands.iter().enumerate() {
            if cmd.name == b':' {
                labels.entry(cmd.label.clone()).or_insert(index);
            }
        }
        let end = self.program.commands.len();
        for cmd in &mut self.program.commands {
            if !b"btT".contains(&cmd.name) {
                continue;
            }
            if cmd.label.is_empty() {
                cmd.target = end;
                continue;
            }
            let Some(&target) = labels.get(&cmd.label) else {
                return Err(Refusal::new(
                    [
                        b"sed: can't find label for jump to `".as_slice(),
                        &cmd.label,
                        b"'",
                    ]
                    .concat(),
                    4,
                ));
            };
            cmd.target = target;
        }
        Ok(())
    }

    /// The digits here, kept to 64 bits as sed counts them, so no length
    /// of them is refused.
    fn number(&mut self) -> u64 {
        let mut value: u64 = 0;
        while let Some(ch) = self.src.peek().filter(u8::is_ascii_digit) {
            value = value.wrapping_mul(10).wrapping_add(u64::from(ch - b'0'));
            self.src.pos += 1;
        }
        value
    }

    /// Refuse a delimiter that opens a multibyte character.
    fn delimiter(&self, delim: u8) -> Compiled<()> {
        if self.utf8 && (0xC2..=0xFD).contains(&delim) {
            return Err(self.fail("delimiter character is not a single-byte character"));
        }
        Ok(())
    }

    fn address(&mut self) -> Compiled<Option<Address>> {
        let Some(ch) = self.src.peek() else {
            return Ok(None);
        };
        if ch.is_ascii_digit() {
            let first = self.number();
            if self.src.skip(BLANKS) == Some(b'~') {
                self.src.get();
                self.src.skip(BLANKS);
                let step = if self.src.peek().is_some_and(|c| c.is_ascii_digit()) {
                    self.number()
                } else {
                    0
                };
                // `first~0` is the line `first` itself.
                return Ok(Some(if step == 0 {
                    Address::Line(first)
                } else {
                    Address::Step(first, step)
                }));
            }
            return Ok(Some(Address::Line(first)));
        }
        if ch == b'$' {
            self.src.get();
            return Ok(Some(Address::Last));
        }
        if ch != b'/' && ch != b'\\' {
            return Ok(None);
        }
        self.src.get();
        let delim = if ch == b'\\' {
            match self.src.get() {
                None | Some(b'\n') => return Err(self.fail("unterminated address regex")),
                Some(delim) => {
                    self.delimiter(delim)?;
                    delim
                }
            }
        } else {
            b'/'
        };
        let raw = self.delimited(delim, "unterminated address regex")?;
        let (mut icase, mut multiline) = (false, false);
        while let Some(flag) = self.src.skip(BLANKS).filter(|f| *f == b'I' || *f == b'M') {
            self.src.get();
            if flag == b'I' {
                icase = true;
            } else {
                multiline = true;
            }
        }
        Ok(Some(Address::Regex(self.regex(&raw, icase, multiline)?)))
    }

    fn second_address(&mut self) -> Compiled<Address> {
        let ch = self.src.skip(BLANKS);
        if ch == Some(b'+') || ch == Some(b'~') {
            self.src.get();
            self.src.skip(BLANKS);
            if !self.src.peek().is_some_and(|c| c.is_ascii_digit()) {
                self.src.get();
                return Err(self.fail("unexpected `,'"));
            }
            let number = self.number();
            return Ok(if ch == Some(b'+') {
                Address::Plus(number)
            } else {
                Address::Multiple(number)
            });
        }
        match self.address()? {
            Some(found) => Ok(found),
            None => {
                self.src.get();
                Err(self.fail("unexpected `,'"))
            }
        }
    }

    /// The text up to an unescaped `delim`, bracket expressions read
    /// whole, a `\delim` made the plain delimiter and `\n` a newline.
    fn delimited(&mut self, delim: u8, unterminated: &str) -> Compiled<Vec<u8>> {
        let mut out = Vec::new();
        loop {
            match self.src.get() {
                None | Some(b'\n') => return Err(self.fail(unterminated)),
                Some(ch) if ch == delim => return Ok(out),
                Some(b'\\') => {
                    let next = self.src.get();
                    match next {
                        None => return Err(self.fail(unterminated)),
                        Some(b'\n') if self.src.joined(self.src.pos - 1) => {
                            return Err(self.fail(unterminated));
                        }
                        Some(next) if next == delim => out.push(delim),
                        Some(b'\n') => out.push(b'\n'),
                        Some(next) => out.extend_from_slice(&[b'\\', next]),
                    }
                }
                Some(b'[') => self.bracket(&mut out, unterminated)?,
                Some(ch) => out.push(ch),
            }
        }
    }

    /// A bracket expression, from after its `[`: the delimiter is an
    /// ordinary character inside it.
    fn bracket(&mut self, out: &mut Vec<u8>, unterminated: &str) -> Compiled<()> {
        out.push(b'[');
        if self.src.peek() == Some(b'^') {
            out.push(b'^');
            self.src.pos += 1;
        }
        if self.src.peek() == Some(b']') {
            out.push(b']');
            self.src.pos += 1;
        }
        loop {
            let ch = match self.src.get() {
                None | Some(b'\n') => return Err(self.fail(unterminated)),
                Some(ch) => ch,
            };
            out.push(ch);
            if ch == b']' {
                return Ok(());
            }
            let Some(kind) = self.src.peek().filter(|k| ch == b'[' && b":.=".contains(k)) else {
                continue;
            };
            out.push(kind);
            self.src.pos += 1;
            loop {
                let inner = match self.src.get() {
                    None | Some(b'\n') => return Err(self.fail(unterminated)),
                    Some(inner) => inner,
                };
                out.push(inner);
                if inner == kind && self.src.peek() == Some(b']') {
                    out.push(b']');
                    self.src.pos += 1;
                    break;
                }
            }
        }
    }

    fn regex(&mut self, raw: &[u8], icase: bool, multiline: bool) -> Compiled<Option<usize>> {
        if raw.is_empty() {
            if icase || multiline {
                return Err(self.fail("cannot specify modifiers on empty regexp"));
            }
            return Ok(None);
        }
        let text = regex_text(raw).map_err(|_| self.fail(RECURSIVE))?;
        let options = Options {
            extended: self.extended,
            dialect: Dialect::Sed,
            ignore_case: icase,
            utf8: self.utf8,
            multiline,
            word: false,
        };
        match Posix::compile(&text, &options) {
            Ok(compiled) => {
                self.program.regexes.push(compiled);
                Ok(Some(self.program.regexes.len() - 1))
            }
            Err(message) if message.starts_with(CLASS_SYNTAX) => {
                Err(Refusal::new(format!("sed: {message}").into_bytes(), 4))
            }
            Err(message) => Err(self.fail(message)),
        }
    }

    fn end_of_command(&mut self) -> Compiled<()> {
        match self.src.skip(BLANKS) {
            None | Some(b'}' | b'#') => Ok(()),
            Some(b'\n' | b';') => {
                self.src.get();
                Ok(())
            }
            Some(_) => {
                self.src.get();
                Err(self.fail("extra characters after command"))
            }
        }
    }

    fn command(&mut self) -> Compiled<()> {
        let mut cmd = Command {
            name: 0,
            addr1: None,
            addr2: None,
            negate: false,
            text: None,
            label: Vec::new(),
            target: 0,
            file: 0,
            number: None,
            subst: None,
            translit: None,
        };
        cmd.addr1 = self.address()?;
        if cmd.addr1.is_some() && self.src.skip(BLANKS) == Some(b',') {
            self.src.get();
            cmd.addr2 = Some(self.second_address()?);
        }
        let mut bang = None;
        if self.src.skip(BLANKS) == Some(b'!') {
            self.src.get();
            bang = Some(self.src.pos);
            cmd.negate = true;
            if self.src.skip(BLANKS) == Some(b'!') {
                self.src.get();
                return Err(self.fail("multiple `!'s"));
            }
        }
        let name = match self.src.get() {
            None | Some(b'\n' | b';') => return Err(self.fail("missing command")),
            Some(name) => name,
        };
        cmd.name = name;
        self.check_addresses(&cmd, bang)?;
        match name {
            b'{' => {
                self.blocks.push(self.program.commands.len());
                self.program.commands.push(cmd);
            }
            b'}' => {
                let Some(start) = self.blocks.pop() else {
                    return Err(self.fail("unexpected `}'"));
                };
                if cmd.addr1.is_some() {
                    return Err(self.fail("`}' doesn't want any addresses"));
                }
                self.program.commands[start].target = self.program.commands.len();
                self.end_of_command()?;
                self.program.commands.push(cmd);
            }
            b'=' | b'd' | b'D' | b'F' | b'g' | b'G' | b'h' | b'H' | b'n' | b'N' | b'p' | b'P'
            | b'x' | b'z' => {
                self.end_of_command()?;
                self.program.commands.push(cmd);
            }
            // sed 4.9 still reads `L` as `l` reads, and refuses it where
            // it runs.
            b'l' | b'L' | b'q' | b'Q' => {
                self.src.skip(BLANKS);
                if self.src.peek().is_some_and(|c| c.is_ascii_digit()) {
                    // `l` and `q` keep their number's low 32 bits as a
                    // signed int.
                    cmd.number = Some(i64::from(self.number() as u32 as i32));
                }
                self.end_of_command()?;
                self.program.commands.push(cmd);
            }
            b'a' | b'i' | b'c' => {
                cmd.text = self.text(name)?;
                self.program.commands.push(cmd);
            }
            b':' => {
                cmd.label = self.label();
                if cmd.label.is_empty() {
                    return Err(self.fail("\":\" lacks a label"));
                }
                self.program.commands.push(cmd);
            }
            b'b' | b't' | b'T' => {
                cmd.label = self.label();
                self.program.commands.push(cmd);
            }
            b'r' | b'R' | b'w' | b'W' => {
                let file = self.filename()?;
                cmd.file = match name {
                    b'r' => listed(&mut self.program.rfiles, file),
                    b'R' => listed(&mut self.program.reader_files, file),
                    _ => listed(&mut self.program.wfiles, file),
                };
                self.program.commands.push(cmd);
            }
            b's' => {
                cmd.subst = Some(Box::new(self.substitute()?));
                self.program.commands.push(cmd);
            }
            b'v' => self.version()?,
            b'y' => {
                cmd.translit = Some(self.transliterate()?);
                self.end_of_command()?;
                self.program.commands.push(cmd);
            }
            b'e' => return Err(self.fail("`e' command not supported")),
            _ => return Err(self.fail_named("unknown command: `", name, "'")),
        }
        Ok(())
    }

    /// Refuse addresses the command cannot take, where GNU does: line 0
    /// at the `!` when there is one, the rest at the command.
    fn check_addresses(&self, cmd: &Command, bang: Option<usize>) -> Compiled<()> {
        let (first, second) = (cmd.addr1, cmd.addr2);
        if let Some(first) = first.filter(|first| first.number() == 0) {
            let zero_line = matches!(first, Address::Line(_))
                && !matches!(second, Some(Address::Regex(_)))
                && !(cmd.name == b'r' && second.is_none());
            if zero_line {
                return Err(self.fail_at(bang, "invalid usage of line address 0"));
            }
        }
        if cmd.name == b':' && first.is_some() {
            return Err(self.fail(": doesn't want any addresses"));
        }
        if cmd.name == b'#' && first.is_some() {
            return Err(self.fail("comments don't accept any addresses"));
        }
        if b"qQ".contains(&cmd.name) && second.is_some() {
            return Err(self.fail("command only uses one address"));
        }
        Ok(())
    }

    fn label(&mut self) -> Vec<u8> {
        self.src.skip(BLANKS);
        let start = self.src.pos;
        while self
            .src
            .peek()
            .is_some_and(|ch| !SPACES.contains(&ch) && !b";}#".contains(&ch))
        {
            self.src.pos += 1;
        }
        self.src.text[start..self.src.pos].to_vec()
    }

    fn filename(&mut self) -> Compiled<Vec<u8>> {
        self.src.skip(BLANKS);
        let start = self.src.pos;
        while self.src.peek().is_some_and(|ch| ch != b'\n') {
            self.src.pos += 1;
        }
        let name = self.src.text[start..self.src.pos].to_vec();
        if name.is_empty() {
            return Err(self.fail("missing filename in r/R/w/W commands"));
        }
        if self.src.peek() == Some(b'\n') {
            self.src.get();
        }
        Ok(name)
    }

    /// The text of `a`, `i` or `c`: GNU's one-line form after blanks, or
    /// after a backslash and a newline the lines that follow, each escaped
    /// newline continuing it. None when there is none at all.
    fn text(&mut self, name: u8) -> Compiled<Option<Vec<u8>>> {
        match self.src.skip(BLANKS) {
            None | Some(b'\n') => return Err(self.fail("expected \\ after `a', `c' or `i'")),
            Some(b'\\') => {
                self.src.get();
                match self.src.peek() {
                    Some(b'\n') => self.src.pos += 1,
                    None => return Ok(None),
                    Some(_) => {}
                }
            }
            Some(_) => {}
        }
        // A script that ends on a backslash no other escapes (an odd run,
        // counted with the one-line form's own backslash where it touches
        // it) leaves text that runs to that end as written, unescaped,
        // that backslash dropped. After an even run, a backslash the text
        // is left with at the end is dropped too.
        let tail = self
            .src
            .text
            .iter()
            .rev()
            .take_while(|&&c| c == b'\\')
            .count();
        let mut out = Vec::new();
        let (mut read, mut recursive) = (false, false);
        let start = self.src.pos;
        while let Some(ch) = self.src.get() {
            read = true;
            if ch == b'\n' {
                break;
            }
            if ch != b'\\' {
                out.push(ch);
                continue;
            }
            let Some(next) = self.src.get() else {
                break;
            };
            if next == b'\n' {
                out.push(b'\n');
                continue;
            }
            if next == b'c' && matches!(self.src.peek(), None | Some(b'\n')) {
                // A `\c` that ends the text: `a` takes the closing newline
                // into it (^J), `i` and `c` drop it.
                if self.src.peek() == Some(b'\n') {
                    self.src.pos += 1;
                }
                if recursive {
                    return Err(self.fail(RECURSIVE));
                }
                out.push(if name == b'a' { b'J' } else { b'\n' });
                return Ok(Some(out));
            }
            match escape(&self.src.text, self.src.pos - 1) {
                // GNU refuses it once the text has been read.
                Err(Recursive) => recursive = true,
                Ok(None) => out.push(next),
                Ok(Some((byte, end))) => {
                    out.push(byte);
                    self.src.pos = end;
                }
            }
        }
        if tail % 2 == 1 && self.src.peek().is_none() {
            // The backslash that carries it from one piece to the next
            // goes as well, its newline staying.
            let mut raw: Vec<u8> = (start..self.src.text.len() - 1)
                .filter(|&i| !self.src.joined(i + 1))
                .map(|i| self.src.text[i])
                .collect();
            raw.push(b'\n');
            return Ok(Some(raw));
        }
        if recursive {
            return Err(self.fail(RECURSIVE));
        }
        if !read {
            return Ok(None);
        }
        out.push(b'\n');
        Ok(Some(out))
    }

    fn replacement(&self, raw: &[u8], groups: usize) -> Compiled<Vec<Part>> {
        let mut parts = Vec::new();
        let mut literal = Vec::new();
        let flush = |parts: &mut Vec<Part>, literal: &mut Vec<u8>| {
            if !literal.is_empty() {
                parts.push(Part::Text(std::mem::take(literal)));
            }
        };
        let mut i = 0;
        while i < raw.len() {
            let ch = raw[i];
            if ch == b'&' {
                flush(&mut parts, &mut literal);
                parts.push(Part::Group(0));
                i += 1;
                continue;
            }
            if ch != b'\\' || i + 1 >= raw.len() {
                literal.push(ch);
                i += 1;
                continue;
            }
            let next = raw[i + 1];
            if next.is_ascii_digit() {
                let group = usize::from(next - b'0');
                if group > groups {
                    return Err(
                        self.fail(&format!("invalid reference \\{group} on `s' command's RHS"))
                    );
                }
                flush(&mut parts, &mut literal);
                parts.push(Part::Group(group));
                i += 2;
                continue;
            }
            if b"LUluE".contains(&next) {
                flush(&mut parts, &mut literal);
                parts.push(Part::Case(next));
                i += 2;
                continue;
            }
            match escape(raw, i + 1).map_err(|_| self.fail(RECURSIVE))? {
                Some((byte, end)) => {
                    literal.push(byte);
                    i = end;
                }
                None => {
                    literal.push(next);
                    i += 2;
                }
            }
        }
        flush(&mut parts, &mut literal);
        Ok(parts)
    }

    fn substitute(&mut self) -> Compiled<Subst> {
        let delim = match self.src.get() {
            None | Some(b'\n' | b'\\') => return Err(self.fail("unterminated `s' command")),
            Some(delim) => delim,
        };
        self.delimiter(delim)?;
        let raw = self.delimited(delim, "unterminated `s' command")?;
        let rhs = self.rhs(delim)?;
        let mut subst = Subst {
            regex: None,
            parts: Vec::new(),
            global: false,
            occurrence: 1,
            print: false,
            wfile: None,
        };
        let (mut icase, mut multiline) = (false, false);
        let (mut seen_g, mut seen_p, mut seen_n) = (false, false, false);
        loop {
            let ch = match self.src.get() {
                None | Some(b'\n' | b';') => break,
                Some(b'}' | b'#') => {
                    self.src.pos -= 1;
                    break;
                }
                Some(ch) => ch,
            };
            match ch {
                // A script written with CRLF line ends.
                b'\r' if self.src.peek() == Some(b'\n') => {
                    self.src.pos += 1;
                    break;
                }
                b' ' | b'\t' => {}
                b'g' => {
                    if seen_g {
                        return Err(self.fail("multiple `g' options to `s' command"));
                    }
                    seen_g = true;
                    subst.global = true;
                }
                b'p' => {
                    if seen_p {
                        return Err(self.fail("multiple `p' options to `s' command"));
                    }
                    seen_p = true;
                    subst.print = true;
                }
                b'0'..=b'9' => {
                    self.src.pos -= 1;
                    if seen_n {
                        self.number();
                        return Err(self.fail("multiple number options to `s' command"));
                    }
                    seen_n = true;
                    subst.occurrence = self.number();
                    if subst.occurrence == 0 {
                        return Err(self.fail("number option to `s' command may not be zero"));
                    }
                }
                b'i' | b'I' => icase = true,
                b'm' | b'M' => multiline = true,
                b'e' => return Err(self.fail("`e' command not supported")),
                b'w' => {
                    let file = self.filename()?;
                    subst.wfile = Some(listed(&mut self.program.wfiles, file));
                    break;
                }
                _ => return Err(self.fail("unknown option to `s'")),
            }
        }
        subst.regex = self.regex(&raw, icase, multiline)?;
        let groups = subst
            .regex
            .map_or(9, |regex| self.program.regexes[regex].groups());
        subst.parts = self.replacement(&rhs, groups)?;
        Ok(subst)
    }

    /// An `s` replacement up to its unescaped delimiter, escapes kept for
    /// `replacement` and a `\delim` its literal character.
    fn rhs(&mut self, delim: u8) -> Compiled<Vec<u8>> {
        let mut out = Vec::new();
        loop {
            match self.src.get() {
                None | Some(b'\n') => return Err(self.fail("unterminated `s' command")),
                Some(ch) if ch == delim => return Ok(out),
                Some(b'\\') => match self.src.get() {
                    None => return Err(self.fail("unterminated `s' command")),
                    Some(b'\n') if self.src.joined(self.src.pos - 1) => {
                        return Err(self.fail("unterminated `s' command"));
                    }
                    Some(next) if next == delim => {
                        if delim == b'&' || delim == b'\\' {
                            out.push(b'\\');
                        }
                        out.push(delim);
                    }
                    Some(b'\n') => out.push(b'\n'),
                    Some(next) => out.extend_from_slice(&[b'\\', next]),
                },
                Some(ch) => out.push(ch),
            }
        }
    }

    fn transliterate(&mut self) -> Compiled<Translit> {
        let delim = match self.src.get() {
            None | Some(b'\n' | b'\\') => return Err(self.fail("unterminated `y' command")),
            Some(delim) => delim,
        };
        self.delimiter(delim)?;
        let source = self.y_string(delim)?;
        let target = self.y_string(delim)?;
        let units = |text: &[u8]| -> Vec<Vec<u8>> {
            let mut out = Vec::new();
            let mut at = 0;
            while at < text.len() {
                let len = unit(text, at, self.utf8);
                out.push(text[at..at + len].to_vec());
                at += len;
            }
            out
        };
        let (left, right) = (units(&source), units(&target));
        if left.len() != right.len() {
            return Err(self.fail("strings for `y' command are different lengths"));
        }
        if !self.utf8 {
            let mut table = Box::new([0u8; 256]);
            for (byte, slot) in table.iter_mut().enumerate() {
                *slot = byte as u8;
            }
            let mut seen = [false; 256];
            for (a, b) in left.iter().zip(&right) {
                if !std::mem::replace(&mut seen[usize::from(a[0])], true) {
                    table[usize::from(a[0])] = b[0];
                }
            }
            return Ok(Translit::Bytes(table));
        }
        let mut table = HashMap::new();
        for (a, b) in left.into_iter().zip(right) {
            table.entry(a).or_insert(b);
        }
        Ok(Translit::Chars(table))
    }

    /// One `y` string: read up to its delimiter first, so no escape can
    /// take the delimiter, then decoded.
    fn y_string(&mut self, delim: u8) -> Compiled<Vec<u8>> {
        let mut raw = Vec::new();
        loop {
            match self.src.get() {
                None | Some(b'\n') => return Err(self.fail("unterminated `y' command")),
                Some(ch) if ch == delim => break,
                Some(b'\\') => match self.src.get() {
                    None => return Err(self.fail("unterminated `y' command")),
                    Some(b'\n') if self.src.joined(self.src.pos - 1) => {
                        return Err(self.fail("unterminated `y' command"));
                    }
                    Some(next) if next == delim => raw.push(next),
                    Some(next) => raw.extend_from_slice(&[b'\\', next]),
                },
                Some(ch) => raw.push(ch),
            }
        }
        // GNU refuses a recursive escape at the end of the string.
        y_text(&raw).map_err(|_| self.fail(RECURSIVE))
    }

    fn version(&mut self) -> Compiled<()> {
        self.src.skip(BLANKS);
        let start = self.src.pos;
        while self
            .src
            .peek()
            .is_some_and(|ch| !SPACES.contains(&ch) && !b";}#".contains(&ch))
        {
            self.src.pos += 1;
        }
        let wanted = &self.src.text[start..self.src.pos];
        if !wanted.is_empty() && version_after(wanted, VERSION) {
            return Err(self.fail("expected newer version of sed"));
        }
        self.end_of_command()
    }
}

/// Where `name` stands in `names`, added at the end when it is new.
fn listed(names: &mut Vec<Vec<u8>>, name: Vec<u8>) -> usize {
    match names.iter().position(|known| *known == name) {
        Some(at) => at,
        None => {
            names.push(name);
            names.len() - 1
        }
    }
}

/// Compile a script as GNU sed 4.9 reads it. The pieces join with
/// newlines, so one command may span them (`-e 'a\' -e 'text'`), and each
/// diagnostic names the piece it is in: `-e expression #N, char C` or
/// `file NAME line L`. A refused script comes back with the `w` files
/// opened before the refusal, which GNU has already emptied.
pub(super) fn compile(
    pieces: Vec<Piece>,
    extended: bool,
    utf8: bool,
) -> Result<Program, (Refusal, Vec<Vec<u8>>)> {
    let mut compiler = Compiler {
        src: Script::new(pieces),
        extended,
        utf8,
        program: Program::default(),
        blocks: Vec::new(),
    };
    match compiler.compile() {
        Ok(()) => Ok(compiler.program),
        Err(refusal) => Err((refusal, compiler.program.wfiles)),
    }
}
