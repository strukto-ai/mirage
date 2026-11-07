//! --debug: the program as sed lists it before it runs, and how its trace
//! shows the spaces it works on.

use crate::regex::posix::Spans;

use super::script::{Address, Command, Part, Program, Translit};

/// An expression as --debug lists it: the text regcomp gets, and its
/// flags.
pub(super) struct Source {
    pub(super) text: Vec<u8>,
    pub(super) icase: bool,
    pub(super) multiline: bool,
}

/// Bytes as the trace shows them: printable ASCII as itself, the C
/// controls and the backslash as their escapes, `/` escaped in an
/// expression, and every other byte in octal.
pub(super) fn escape(out: &mut Vec<u8>, text: &[u8], slash: bool) {
    for &byte in text {
        match byte {
            b'\\' => out.extend_from_slice(b"\\\\"),
            0x07 => out.extend_from_slice(b"\\a"),
            0x0C => out.extend_from_slice(b"\\f"),
            0x0B => out.extend_from_slice(b"\\v"),
            b'\r' => out.extend_from_slice(b"\\r"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\t' => out.extend_from_slice(b"\\t"),
            b'/' if slash => out.extend_from_slice(b"\\/"),
            0x20..=0x7E => out.push(byte),
            _ => out.extend_from_slice(format!("\\o{byte:03o}").as_bytes()),
        }
    }
}

fn expression(out: &mut Vec<u8>, regex: Option<usize>, sources: &[Source]) -> Option<usize> {
    out.push(b'/');
    if let Some(source) = regex.and_then(|index| sources.get(index)) {
        escape(out, &source.text, true);
    }
    out.push(b'/');
    regex
}

fn address(out: &mut Vec<u8>, addr: Address, sources: &[Source]) {
    match addr {
        Address::Line(n) => out.extend_from_slice(n.to_string().as_bytes()),
        Address::Last => out.push(b'$'),
        Address::Regex(regex) => {
            if let Some(source) = expression(out, regex, sources).and_then(|i| sources.get(i)) {
                if source.icase {
                    out.push(b'I');
                }
                if source.multiline {
                    out.push(b'M');
                }
            }
        }
        Address::Step(first, step) => out.extend_from_slice(format!("{first}~{step}").as_bytes()),
        Address::Plus(n) => out.extend_from_slice(format!("+{n}").as_bytes()),
        Address::Multiple(n) => out.extend_from_slice(format!("~{n}").as_bytes()),
    }
}

/// A `y` table's changes in byte order, as a byte table lists them.
pub(super) fn table(translit: &Translit) -> Vec<u8> {
    let (mut from, mut to) = (Vec::new(), Vec::new());
    if let Translit::Bytes(table) = translit {
        for (byte, &mapped) in table.iter().enumerate() {
            if usize::from(mapped) != byte {
                from.push(byte as u8);
                to.push(mapped);
            }
        }
    }
    [b"/".as_slice(), &from, b"/", &to, b"/"].concat()
}

/// The groups of the first match `s` made in pattern space `ps`, before
/// it replaced it.
#[cold]
pub(super) fn registers(out: &mut Vec<u8>, ps: &[u8], groups: &Spans) {
    out.extend_from_slice(b"MATCHED REGEX REGISTERS\n");
    for (index, span) in groups.iter().enumerate() {
        let Some((start, end)) = *span else {
            break;
        };
        let head = format!("  regex[{index}] = {start}-{end} '");
        out.extend_from_slice(head.as_bytes());
        out.extend_from_slice(&ps[start..end]);
        out.extend_from_slice(b"'\n");
    }
}

/// Command `cmd` as --debug lists it: its addresses, a `!`, a space
/// after any address, its letter and what it carries; `y` shows `y`.
pub(super) fn listed(cmd: &Command, program: &Program, sources: &[Source], y: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    if let Some(first) = cmd.addr1 {
        // `0r` runs on the first line, and lists as it runs.
        if cmd.zero_line() {
            out.push(b'1');
        } else {
            address(&mut out, first, sources);
        }
        if let Some(second) = cmd.addr2 {
            out.push(b',');
            address(&mut out, second, sources);
        }
    }
    if cmd.negate {
        out.push(b'!');
    }
    if cmd.addr1.is_some() {
        out.push(b' ');
    }
    out.push(cmd.name);
    match cmd.name {
        b'a' | b'i' | b'c' => {
            out.push(b'\\');
            out.extend_from_slice(cmd.text.as_deref().unwrap_or_default());
        }
        b':' => out.extend_from_slice(&cmd.label),
        b'b' | b't' | b'T' if !cmd.label.is_empty() => {
            out.push(b' ');
            out.extend_from_slice(&cmd.label);
        }
        b'l' | b'q' | b'Q' => {
            if let Some(number) = cmd.number {
                out.extend_from_slice(format!(" {number}").as_bytes());
            }
        }
        b'r' => {
            out.push(b' ');
            out.extend_from_slice(&program.rfiles[cmd.file]);
        }
        b'R' => {
            out.push(b' ');
            out.extend_from_slice(&program.reader_files[cmd.file]);
        }
        b'w' | b'W' => out.extend_from_slice(&program.wfiles[cmd.file]),
        b'y' => out.extend_from_slice(y),
        b's' => {
            let Some(subst) = cmd.subst.as_deref() else {
                return out;
            };
            let source = expression(&mut out, subst.regex, sources).and_then(|i| sources.get(i));
            for part in &subst.parts {
                match part {
                    Part::Text(text) => out.extend_from_slice(text),
                    Part::Group(0) => out.push(b'&'),
                    Part::Group(group) => out.extend_from_slice(format!("\\{group}").as_bytes()),
                    Part::Case(case) => out.extend_from_slice(&[b'\\', *case]),
                }
            }
            out.push(b'/');
            if source.is_some_and(|source| source.icase) {
                out.push(b'i');
            }
            if source.is_some_and(|source| source.multiline) {
                out.push(b'm');
            }
            if subst.global {
                out.push(b'g');
            }
            if subst.print {
                out.push(b'p');
            }
            if subst.occurrence != 1 {
                out.extend_from_slice(subst.occurrence.to_string().as_bytes());
            }
            if let Some(wfile) = subst.wfile {
                out.push(b'w');
                out.extend_from_slice(&program.wfiles[wfile]);
            }
        }
        _ => {}
    }
    out
}

/// The program as --debug lists it before it runs, each block's commands
/// two spaces further in.
#[cold]
pub(super) fn program(listing: &[Vec<u8>], names: impl Iterator<Item = u8>, out: &mut Vec<u8>) {
    out.extend_from_slice(b"SED PROGRAM:\n");
    let mut depth = 1;
    for (line, name) in listing.iter().zip(names) {
        if name == b'}' {
            depth -= 1;
        }
        out.extend(std::iter::repeat_n(b' ', depth * 2));
        out.extend_from_slice(line);
        out.push(b'\n');
        if name == b'{' {
            depth += 1;
        }
    }
}
