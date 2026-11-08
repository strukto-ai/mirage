//! An operator's words, expanded once the parameter's state selects
//! them, and the value operators and transformations applied to a value.

use super::{
    Braces, Chunk, Expander, Host, Operands, PATTERN_OPS, Part, discard, join, reference, voiced,
    within,
};

use crate::interp::escapes::decode_ansi_c;
use crate::interp::parameter::scan_parameter;
use crate::interp::pattern::{Case, Pattern};
use crate::interp::write::{Denied, Fault};
use crate::interp::{Signal, listing, pattern, quote};

/// The letters `${v@x}` knows.
const TRANSFORMS: &[u8] = b"QEPAKakUuL";

/// What a backslash escapes in an operator's word inside double quotes.
const OPERAND_DQUOTE_ESCAPES: &[u8] = b"$`\"\\}";

impl<H: Host> Expander<'_, H> {
    /// The operands a value operator needs whatever the value: the
    /// pattern as a pattern, the replacement with unquoted rules even
    /// inside double quotes, as bash reads them.
    pub(super) async fn operands(&mut self, p: &Braces) -> Result<Operands, Fault> {
        let mut operands = Operands::default();
        operands.replacement.amp = self.shell.shopt("patsub_replacement");
        let Some(op) = p.op else {
            return Ok(operands);
        };
        if op == "@" {
            let letters: Vec<u8> = p
                .groups
                .first()
                .into_iter()
                .flatten()
                .flat_map(|&part| self.part_text(part).to_vec())
                .collect();
            operands.letter = match letters[..] {
                [letter] if TRANSFORMS.contains(&letter) => Some(letter),
                _ => None,
            };
            return Ok(operands);
        }
        if !PATTERN_OPS.contains(&op) {
            return Ok(operands);
        }
        for (index, group) in p.groups.iter().enumerate() {
            let source: Vec<u8> = group
                .iter()
                .flat_map(|&part| self.part_text(part).to_vec())
                .collect();
            let expanded = if index == 0 {
                let mut pattern = Pattern::default();
                self.pattern_group(group, &mut pattern).await.map(|()| {
                    operands.pattern = pattern;
                })
            } else {
                self.word_chunks(group, false).await.map(|chunks| {
                    operands.replacement.runs = chunks
                        .into_iter()
                        .map(|chunk| match chunk {
                            Chunk::Piece(piece) => (piece.text, piece.quoted),
                            Chunk::Break(joiner) => (joiner, false),
                        })
                        .collect();
                })
            };
            if let Err(fault) = expanded {
                return Err(within(fault, &source, true));
            }
        }
        Ok(operands)
    }

    /// A value operator applied to one value, pausing through the host
    /// while the matcher works.
    pub(super) async fn value_op(
        &mut self,
        op: &str,
        value: &[u8],
        operands: &Operands,
    ) -> Result<Vec<u8>, Fault> {
        let (extglob, utf8) = (self.shell.shopt("extglob"), self.shell.utf8());
        let pattern = &operands.pattern;
        let room = self.room;
        let (host, shell) = (&mut *self.host, &*self.shell);
        let pause = &mut async || host.pause(shell).await;
        Ok(match op {
            "#" | "##" | "%" | "%%" => {
                pattern::strip(
                    value,
                    pattern,
                    op.len() == 2,
                    op.starts_with('#'),
                    extglob,
                    utf8,
                    pause,
                )
                .await?
            }
            "/" | "//" | "/#" | "/%" => {
                let anchor = match op {
                    "/#" => Some("#"),
                    "/%" => Some("%"),
                    _ => None,
                };
                pattern::replace(
                    value,
                    pattern,
                    &operands.replacement,
                    op == "//",
                    anchor,
                    extglob,
                    utf8,
                    room,
                    pause,
                )
                .await?
                .ok_or(Fault::Memory)?
            }
            "^" | "^^" | "," | ",," | "~" | "~~" => {
                pattern::recase(op, value, pattern, extglob, utf8, pause).await?
            }
            _ => value.to_vec(),
        })
    }

    /// A `${v@x}` transformation of one value; None for an unset one,
    /// which yields nothing, but `@a`, the variable's attributes, answers
    /// whenever the variable exists (`${m@a}` is `A` for a map with no
    /// key `0`), and so does `@A` once it has attributes to declare
    /// (`declare -A m`). `@A` names a reference's target. A hidden name
    /// does not exist, attributes and all.
    pub(super) fn transform(
        &self,
        letter: u8,
        name: &str,
        value: &[u8],
        set: bool,
    ) -> Option<Vec<u8>> {
        let utf8 = self.shell.utf8();
        let name = self.shell.vars.deref(name);
        let computed = listing::computed(&self.shell.vars, &name);
        let record = computed.as_ref().or(self.shell.vars.visible(&name));
        if letter == b'a' {
            return record.map(|var| var.cluster().into_bytes());
        }
        if !set {
            let cluster = record.map(|var| var.cluster()).unwrap_or_default();
            return (letter == b'A' && !cluster.is_empty())
                .then(|| format!("declare -{cluster} {name}").into_bytes());
        }
        Some(match letter {
            b'Q' | b'K' | b'k' => quote::single(value, utf8),
            b'E' => decode_ansi_c(value, utf8),
            b'U' => pattern::cased(value, Case::Upper, true, utf8),
            b'u' => pattern::cased(value, Case::Upper, false, utf8),
            b'L' => pattern::cased(value, Case::Lower, true, utf8),
            b'A' => {
                let cluster = record.map(|var| var.cluster()).unwrap_or_default();
                let mut out = if cluster.is_empty() {
                    Vec::new()
                } else {
                    format!("declare -{cluster} ").into_bytes()
                };
                out.extend_from_slice(name.as_bytes());
                out.push(b'=');
                out.extend(quote::single(value, utf8));
                out
            }
            _ => value.to_vec(),
        })
    }

    /// One write an expansion makes (`${X:=d}`, `$((X=5))`) through the
    /// gate, as `X=d` would: a bare name over an array lands at element 0.
    pub(super) async fn expansion_write(
        &mut self,
        name: &str,
        key: Option<Vec<u8>>,
        value: Vec<u8>,
    ) -> Result<(), Fault> {
        if self.shell.vars.hidden(name) {
            return Err(discard(
                self.shell.vars.voice(),
                &format!("{name}: permission denied\n"),
            ));
        }
        let landed = self.writer().land_element(name, key, value).await;
        match landed {
            Err(Fault::Readonly { name, .. }) => Err(discard(
                self.shell.vars.voice(),
                &format!("{name}: readonly variable\n"),
            )),
            other => other.map_err(|fault| write_refusal(self.shell.vars.voice(), fault)),
        }
    }

    /// A refused `${var:=word}` default ends a `( )` subshell, or a forked
    /// stage, with 2, unless `set -e` ends it first with 1.
    pub(super) fn default_refused(&self, fault: Fault) -> Fault {
        match fault {
            Fault::Signal(Signal::Discard { stderr, .. })
                if self.shell.paren && !self.shell.option("errexit") =>
            {
                Signal::Discard {
                    stderr,
                    contained: 2,
                }
                .into()
            }
            other => other,
        }
    }

    /// The word of a conditional operator, expanded now that it is needed.
    pub(super) async fn operator_word(
        &mut self,
        p: &Braces,
        quoted: bool,
    ) -> Result<Vec<Chunk>, Fault> {
        let Some(group) = p.groups.first().cloned() else {
            return Ok(Vec::new());
        };
        let source: Vec<u8> = group
            .iter()
            .flat_map(|&part| self.part_text(part).to_vec())
            .collect();
        match self.word_chunks(&group, quoted).await {
            Err(fault) => Err(within(fault, &source, true)),
            ok => ok,
        }
    }

    /// An operator's word as pieces. Inside double quotes it follows their
    /// rules: a backslash escapes only `` $ ` " \ } `` and a newline, a
    /// single-quoted string is literal text, quotes and all, and nothing
    /// splits. Unquoted, an escaped character and a quoted string are
    /// quoted text, while the literal text and the expansions split as an
    /// expansion's value would. A leading `~` names the home directory.
    async fn word_chunks(&mut self, group: &[Part], quoted: bool) -> Result<Vec<Chunk>, Fault> {
        let mut parts = Vec::new();
        self.flat_parts(group, &mut parts);
        let mut out: Vec<Chunk> = Vec::new();
        let mut literal: Vec<u8> = Vec::new();
        for part in parts {
            let is_literal = match part {
                Part::Text(..) => true,
                Part::Node(n) => matches!(self.kind(n), "word" | "number" | "regex"),
            };
            if is_literal {
                literal.extend_from_slice(self.part_text(part));
                continue;
            }
            let leading = out.is_empty();
            let run = std::mem::take(&mut literal);
            out.extend(self.operand_literal(&run, quoted, leading)?);
            let Part::Node(n) = part else { unreachable!() };
            match self.kind(n) {
                "raw_string" if quoted => out.push(Chunk::quoted(self.text(n).to_vec())),
                "string" if quoted => out.extend(self.nested_string(n).await?),
                _ => out.extend(self.chunks(n, quoted).await?),
            }
        }
        let leading = out.is_empty();
        out.extend(self.operand_literal(&literal, quoted, leading)?);
        Ok(out)
    }

    fn flat_parts(&self, group: &[Part], out: &mut Vec<Part>) {
        for &part in group {
            match part {
                Part::Node(n) if self.kind(n) == "concatenation" => {
                    let inner = self.parts(n);
                    self.flat_parts(&inner, out);
                }
                _ => out.push(part),
            }
        }
    }

    /// Literal operand text as pieces, `$name` references in it expanded.
    fn operand_literal(
        &mut self,
        text: &[u8],
        quoted: bool,
        leading: bool,
    ) -> Result<Vec<Chunk>, Fault> {
        if !quoted && leading && !text.contains(&b'\\') && !text.contains(&b'$') {
            if let Some(expanded) = self.tilde_prefix(text) {
                return Ok(vec![Chunk::quoted(expanded)]);
            }
        }
        let mut out = Vec::new();
        let mut run = Vec::new();
        let flush = |run: &mut Vec<u8>, out: &mut Vec<Chunk>| {
            if !run.is_empty() {
                out.push(Chunk::value(std::mem::take(run), quoted));
            }
        };
        let mut index = 0;
        while index < text.len() {
            let byte = text[index];
            if byte == b'\\' && index + 1 < text.len() {
                let escaped = text[index + 1];
                index += 2;
                if escaped == b'\n' {
                    continue;
                }
                if !quoted {
                    flush(&mut run, &mut out);
                    out.push(Chunk::quoted(vec![escaped]));
                } else if OPERAND_DQUOTE_ESCAPES.contains(&escaped) {
                    run.push(escaped);
                } else {
                    run.extend_from_slice(&[byte, escaped]);
                }
                continue;
            }
            if byte == b'$' {
                if let Some((name, end)) = scan_parameter(text, index) {
                    let name = name.to_vec();
                    flush(&mut run, &mut out);
                    out.extend(self.parameter_chunks(&name, quoted)?);
                    index = end;
                    continue;
                }
            }
            run.push(byte);
            index += 1;
        }
        flush(&mut run, &mut out);
        Ok(out)
    }

    /// A double-quoted string inside the word of a quoted expansion: bash
    /// reads the inner pair as leaving the outer quotes, so a backslash
    /// quotes any character (`"${u:-"a\ b"}"` is `a b`); the text is quoted
    /// all the same.
    async fn nested_string(&mut self, node: usize) -> Result<Vec<Chunk>, Fault> {
        let mut out = vec![Chunk::quoted(Vec::new())];
        let text = self.text(node);
        let inside = text[1..text.len() - 1].to_vec();
        for part in self.parts(node) {
            let literal = match part {
                Part::Text(..) => self.part_text(part).to_vec(),
                Part::Node(n) if self.kind(n) == "string_content" => self.text(n).to_vec(),
                Part::Node(n) if self.kind(n) == "\"" => {
                    let t = self.text(n);
                    t[..t.len() - 1].to_vec()
                }
                Part::Node(n) => {
                    match self.chunks(n, true).await {
                        Ok(chunks) => out.extend(chunks),
                        Err(fault) => return Err(within(fault, &inside, true)),
                    }
                    continue;
                }
            };
            out.push(Chunk::quoted(unescape_all(&literal)));
        }
        Ok(out)
    }

    /// The error a `${v:?word}` that found v unset or null stops on: the
    /// word is the message, read unquoted; fatal with 127 at top level, 1
    /// from a subshell.
    pub(super) async fn unset_error(&mut self, p: &Braces) -> Result<Fault, Fault> {
        let mut message = join(&self.operator_word(p, false).await?);
        if message.is_empty() {
            message = if p.op == Some("?") {
                b"parameter not set".to_vec()
            } else {
                b"parameter null or not set".to_vec()
            };
        }
        let mut stderr = voiced(self.shell.vars.voice(), &format!("{}: ", reference(p)));
        stderr.extend(message);
        stderr.push(b'\n');
        Ok(Signal::Exit {
            status: 127,
            stderr,
            contained: 1,
        }
        .into())
    }
}

/// Text whose every backslash quotes the character after it.
fn unescape_all(text: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len());
    let mut index = 0;
    while index < text.len() {
        if text[index] == b'\\' && index + 1 < text.len() {
            if text[index + 1] != b'\n' {
                out.push(text[index + 1]);
            }
            index += 2;
            continue;
        }
        out.push(text[index]);
        index += 1;
    }
    out
}

/// A refused expansion-time write discards the line: a hidden name or the
/// gate's refusal in their words, and an `-i` value that does not evaluate
/// as `n=1+` does, in the shell's `voice`.
pub(super) fn write_refusal(voice: &[u8], fault: Fault) -> Fault {
    match fault {
        Fault::Hidden(name) | Fault::Denied(Denied { name, .. }) => {
            discard(voice, &format!("{name}: permission denied\n"))
        }
        Fault::Arith(error) => Signal::arith(voice, &error, "", true).into(),
        other => other,
    }
}

/// A `${v@x}` whose letter names no transformation, found once the value
/// is known to be set: bash ends the shell with 127 (1 from a subshell),
/// as it does for an unbound name, where `${}`, refused for its spelling,
/// only discards the line.
pub(super) fn bad_transformation(voice: &[u8], text: &[u8]) -> Fault {
    Signal::Exit {
        status: 127,
        stderr: [voice, text, b": bad substitution\n"].concat(),
        contained: 1,
    }
    .into()
}
