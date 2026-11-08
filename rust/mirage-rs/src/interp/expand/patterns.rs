//! Words read as patterns: a `case` or `[[ == ]]` pattern's runs, an
//! operator's pattern with its quoted characters marked, and the right
//! side of `[[ =~ ]]` as an extended regex.

use super::{Expander, Host, Part, join};

use crate::interp::escapes::{decode_ansi_c, unquoted_runs};
use crate::interp::parameter::scan_parameter;
use crate::interp::pattern::Pattern;
use crate::interp::write::Fault;
use crate::utf8::unit_len;

impl<H: Host> Expander<'_, H> {
    /// A pattern word as runs, each quoted or live: what `case` patterns
    /// and the right side of `[[ == ]]` match with. Text under any quote
    /// is literal, an unquoted word keeps its special characters live with
    /// a backslash quoting the next one, an expansion's value is live
    /// unquoted and literal inside double quotes, and a leading tilde names
    /// the home directory as literal text. Patterns never split.
    pub async fn pattern_runs(&mut self, node: usize) -> Result<Vec<(Vec<u8>, bool)>, Fault> {
        self.pattern_pieces(node, true).await
    }

    async fn pattern_pieces(
        &mut self,
        node: usize,
        leading: bool,
    ) -> Result<Vec<(Vec<u8>, bool)>, Fault> {
        match self.kind(node) {
            "word" | "extglob_pattern" | "regex" => {
                let raw = self.text(node).to_vec();
                if leading && raw.starts_with(b"~") {
                    let end = raw.iter().position(|&b| b == b'/').unwrap_or(raw.len());
                    if !raw[..end].contains(&b'\\') {
                        if let Some(home) = self.tilde_prefix(&raw[..end]) {
                            let mut out = vec![(home, true)];
                            out.extend(unquoted_runs(&raw[end..]));
                            return Ok(out);
                        }
                    }
                }
                Ok(unquoted_runs(&raw))
            }
            "raw_string" => {
                let text = self.text(node);
                Ok(vec![(text[1..text.len() - 1].to_vec(), true)])
            }
            "ansi_c_string" => {
                let text = self.text(node);
                Ok(vec![(
                    decode_ansi_c(&text[2..text.len() - 1], self.shell.utf8()),
                    true,
                )])
            }
            "string" => Ok(vec![(join(&self.chunks(node, false).await?), true)]),
            "translated_string" => {
                let string = self
                    .tree
                    .named_children(node)
                    .find(|&c| self.kind(c) == "string");
                match string {
                    Some(string) => Ok(vec![(join(&self.chunks(string, false).await?), true)]),
                    None => Ok(Vec::new()),
                }
            }
            "concatenation" => {
                let children: Vec<usize> = self.tree.children(node).collect();
                let mut out: Vec<(Vec<u8>, bool)> = Vec::new();
                for (position, &child) in children.iter().enumerate() {
                    if self.kind(child) == "$"
                        && children
                            .get(position + 1)
                            .is_some_and(|&next| self.kind(next) == "string")
                    {
                        continue;
                    }
                    let prefix = leading
                        && out.is_empty()
                        && (position + 1 == children.len() || self.text(child).contains(&b'/'));
                    out.extend(Box::pin(self.pattern_pieces(child, prefix)).await?);
                }
                Ok(out)
            }
            _ => Ok(vec![(join(&self.chunks(node, false).await?), false)]),
        }
    }

    /// The right side of `[[ =~ ]]` as a POSIX extended regex, read as a
    /// pattern word: a quoted character matches itself, except inside a
    /// bracket expression, where every character stands for itself (bash
    /// reads `['^'a]` as `[^a]`).
    pub async fn regex(&mut self, node: usize) -> Result<Vec<u8>, Fault> {
        let runs = self.pattern_runs(node).await?;
        Ok(regex_text(&runs))
    }

    /// One pattern operand, the scanner's text between nodes included:
    /// blanks, a line continuation, which vanishes, and an escaped blank.
    pub(super) async fn pattern_group(
        &mut self,
        parts: &[Part],
        pattern: &mut Pattern,
    ) -> Result<(), Fault> {
        let utf8 = self.shell.utf8();
        for &part in parts {
            match part {
                Part::Text(..) => {
                    let text = self.part_text(part);
                    let mut kept = Vec::with_capacity(text.len());
                    let mut i = 0;
                    while i < text.len() {
                        if text[i] == b'\\' {
                            i += if text.get(i + 1) == Some(&b'\n') {
                                2
                            } else {
                                1
                            };
                            continue;
                        }
                        kept.push(text[i]);
                        i += 1;
                    }
                    pattern.push(&kept, false, utf8);
                }
                Part::Node(node) => match self.kind(node) {
                    "concatenation" => {
                        let inner = self.parts(node);
                        Box::pin(self.pattern_group(&inner, pattern)).await?;
                    }
                    "string" | "raw_string" | "ansi_c_string" | "translated_string" => {
                        let text = join(&self.chunks(node, false).await?);
                        pattern.push(&text, true, utf8);
                    }
                    "word" | "number" | "regex" => {
                        let text = self.text(node).to_vec();
                        self.pattern_text(&text, pattern)?;
                    }
                    _ => {
                        let text = join(&self.chunks(node, false).await?);
                        pattern.push(&text, false, utf8);
                    }
                },
            }
        }
        Ok(())
    }

    /// An opaque pattern token read with bash's quoting: quoted segments
    /// (single, double, ANSI-C) match literally, a backslash quotes the
    /// character after it, an unquoted `$name` splices a live pattern and a
    /// double-quoted one literal text, and the rest, glob syntax included,
    /// stays live.
    fn pattern_text(&mut self, text: &[u8], pattern: &mut Pattern) -> Result<(), Fault> {
        let utf8 = self.shell.utf8();
        let mut live = Vec::new();
        let mut i = 0;
        while i < text.len() {
            let byte = text[i];
            if byte == b'\\' && i + 1 < text.len() {
                let end = i + 1 + unit_len(&text[i + 1..]);
                pattern.push(&std::mem::take(&mut live), false, utf8);
                pattern.push(&text[i + 1..end], true, utf8);
                i = end;
                continue;
            }
            if byte == b'\'' {
                if let Some(close) = memchr::memchr(b'\'', &text[i + 1..]) {
                    pattern.push(&std::mem::take(&mut live), false, utf8);
                    pattern.push(&text[i + 1..i + 1 + close], true, utf8);
                    i += close + 2;
                    continue;
                }
            }
            if byte == b'"' {
                if let Some(close) = escaped_find(text, i + 1, b'"') {
                    pattern.push(&std::mem::take(&mut live), false, utf8);
                    let inner = self.dquoted_pattern(&text[i + 1..close])?;
                    pattern.push(&inner, true, utf8);
                    i = close + 1;
                    continue;
                }
            }
            if byte == b'$' && i + 1 < text.len() {
                if text[i + 1] == b'\'' {
                    if let Some(close) = escaped_find(text, i + 2, b'\'') {
                        pattern.push(&std::mem::take(&mut live), false, utf8);
                        pattern.push(&decode_ansi_c(&text[i + 2..close], utf8), true, utf8);
                        i = close + 1;
                        continue;
                    }
                }
                if let Some((name, end)) = scan_parameter(text, i) {
                    let name = name.to_vec();
                    live.extend(self.lookup(&name, true)?);
                    i = end;
                    continue;
                }
            }
            live.push(byte);
            i += 1;
        }
        pattern.push(&live, false, utf8);
        Ok(())
    }

    /// A double-quoted pattern segment, all of it literal.
    fn dquoted_pattern(&mut self, inner: &[u8]) -> Result<Vec<u8>, Fault> {
        let mut out = Vec::with_capacity(inner.len());
        let mut i = 0;
        while i < inner.len() {
            let byte = inner[i];
            if byte == b'\\' && inner.get(i + 1).is_some_and(|b| b"$`\"\\".contains(b)) {
                out.push(inner[i + 1]);
                i += 2;
                continue;
            }
            if byte == b'$' {
                if let Some((name, end)) = scan_parameter(inner, i) {
                    let name = name.to_vec();
                    out.extend(self.lookup(&name, true)?);
                    i = end;
                    continue;
                }
            }
            out.push(byte);
            i += 1;
        }
        Ok(out)
    }
}

/// Pattern runs as a POSIX extended regex: a literal character escaped,
/// except inside a bracket expression; a live backslash escapes only a
/// live character after it; `[:class:]`, `[.x.]` and `[=x=]` inside a
/// bracket pass whole.
pub(super) fn regex_text(runs: &[(Vec<u8>, bool)]) -> Vec<u8> {
    const SPECIAL: &[u8] = b"\\.[]()*+?{}|^$";
    let chars: Vec<(u8, bool)> = runs
        .iter()
        .flat_map(|(text, quoted)| text.iter().map(move |&b| (b, *quoted)))
        .collect();
    let mut out = Vec::with_capacity(chars.len());
    let mut members: Option<usize> = None;
    let mut unclosed: Vec<u8> = Vec::new();
    let mut i = 0;
    while i < chars.len() {
        let (byte, quoted) = chars[i];
        let Some(first) = members else {
            if quoted {
                if SPECIAL.contains(&byte) {
                    out.push(b'\\');
                }
                out.push(byte);
            } else if byte == b'\\' && chars.get(i + 1).is_some_and(|c| !c.1) {
                out.extend_from_slice(&[byte, chars[i + 1].0]);
                i += 1;
            } else {
                out.push(byte);
                if byte == b'[' {
                    if chars.get(i + 1).is_some_and(|c| c.0 == b'^') {
                        out.push(b'^');
                        i += 1;
                    }
                    members = Some(i + 1);
                }
            }
            i += 1;
            continue;
        };
        let next = chars.get(i + 1).map(|c| c.0);
        let delimiter = match next {
            Some(delimiter @ (b':' | b'.' | b'=')) if byte == b'[' => Some(delimiter),
            _ => None,
        };
        if let Some(delimiter) = delimiter.filter(|d| !unclosed.contains(d)) {
            let close = (i + 2..chars.len().saturating_sub(1))
                .find(|&j| chars[j].0 == delimiter && chars[j + 1].0 == b']');
            if let Some(close) = close {
                out.extend(chars[i..close + 2].iter().map(|c| c.0));
                i = close + 2;
                continue;
            }
            unclosed.push(delimiter);
        }
        out.push(byte);
        if byte == b']' && i > first {
            members = None;
        }
        i += 1;
    }
    out
}

/// Index of the next unescaped `quote` from `start`.
fn escaped_find(text: &[u8], start: usize, quote: u8) -> Option<usize> {
    let mut i = start;
    while i < text.len() {
        if text[i] == b'\\' && i + 1 < text.len() {
            i += 2;
            continue;
        }
        if text[i] == quote {
            return Some(i);
        }
        i += 1;
    }
    None
}
