use super::heredoc::Body;
use super::tree::Tree;

/// How deep the expansions a heredoc body holds may nest before the
/// rest of it is read as text.
const MAX_NESTING: usize = 128;

/// A heredoc the line reads, folded into the tree's source as a `<`
/// redirect from a double-quoted word that holds its body.
#[derive(Debug, Clone)]
pub struct Heredoc {
    /// Where its `<` stands in the tree's source.
    pub at: usize,
    /// Where its `<<` stands in the line as typed.
    pub operator: usize,
    /// Where its delimiter word ends in the line as typed.
    pub word_end: usize,
    /// The delimiter word as typed.
    pub word: Vec<u8>,
    pub delimiter: Vec<u8>,
    /// A quoted delimiter: the body is not expanded.
    pub quoted: bool,
    /// `<<-`: its lines lose their leading tabs.
    pub dash: bool,
    /// Where the body starts in the line as typed.
    pub body_start: usize,
    /// Past its delimiter line, or the end of the line as typed.
    pub end: usize,
    /// The body as bash reads it.
    pub body: Vec<u8>,
    /// Whether the delimiter line ended it, not the end of the input.
    pub terminated: bool,
    /// The line bash names the heredoc by when the input ends inside it.
    pub line: usize,
    /// The line bash's reader stands on when the input ends inside it.
    pub eof_line: usize,
}

/// A span of the line, the text that takes its place with where each of
/// its bytes came from, and the heredoc whose `<` the text starts with.
type Edit = (usize, usize, Vec<u8>, Vec<usize>, Option<Heredoc>);

/// A line with its heredoc bodies folded in.
pub(super) struct Lowered {
    pub source: Vec<u8>,
    /// Where each byte of `source` came from, one more for its end.
    pub offsets: Vec<usize>,
    pub heredocs: Vec<Heredoc>,
}

/// Fold each body into the line: its `<<word` becomes `<"body"`, and the
/// lines it read leave the place they stood. `bodies` are every read, in
/// the order bash makes them; a heredoc read twice, pending across an
/// array's newline, gets its last.
pub(super) fn lower(data: &[u8], bodies: &[Body]) -> Lowered {
    let mut read: Vec<(Heredoc, &[usize])> = Vec::with_capacity(bodies.len());
    for body in bodies {
        let line = match read.last() {
            Some((previous, _)) if previous.end == body.start && !previous.terminated => {
                previous.eof_line
            }
            _ => newlines(&data[..body.start.saturating_sub(1)]) + 1,
        };
        read.push((
            Heredoc {
                at: 0,
                operator: body.heredoc.operator,
                word_end: body.heredoc.word_end,
                word: data[body.heredoc.word_start..body.heredoc.word_end].to_vec(),
                delimiter: body.heredoc.delimiter.clone(),
                quoted: body.heredoc.raw,
                dash: body.heredoc.dash,
                body_start: body.start,
                end: body.end,
                body: body.text.clone(),
                terminated: body.terminated,
                line,
                eof_line: body.eof_line.max(line),
            },
            &body.offsets,
        ));
    }
    let mut edits: Vec<Edit> = Vec::new();
    for (index, (heredoc, offsets)) in read.iter().enumerate() {
        if heredoc.end > heredoc.body_start {
            edits.push((
                heredoc.body_start,
                heredoc.end,
                Vec::new(),
                Vec::new(),
                None,
            ));
        }
        if read[index + 1..]
            .iter()
            .any(|(later, _)| later.operator == heredoc.operator)
        {
            continue;
        }
        let (word, mut places) = quoted_body(heredoc, offsets);
        let mut replacement = vec![b'<'];
        replacement.extend(word);
        places.insert(0, heredoc.operator);
        edits.push((
            heredoc.operator,
            heredoc.word_end,
            replacement,
            places,
            Some(heredoc.clone()),
        ));
    }
    edits.sort_by_key(|edit| edit.0);
    let mut source = Vec::with_capacity(data.len());
    let mut offsets = Vec::with_capacity(data.len() + 1);
    let mut heredocs = Vec::new();
    let mut cursor = 0;
    for (start, end, replacement, places, heredoc) in edits {
        if start > cursor {
            source.extend_from_slice(&data[cursor..start]);
            offsets.extend(cursor..start);
        }
        if let Some(mut heredoc) = heredoc {
            heredoc.at = source.len();
            heredocs.push(heredoc);
        }
        source.extend(replacement);
        offsets.extend(places);
        cursor = end;
    }
    if cursor < data.len() {
        source.extend_from_slice(&data[cursor..]);
        offsets.extend(cursor..data.len());
    }
    offsets.push(data.len());
    Lowered {
        source,
        offsets,
        heredocs,
    }
}

pub(super) fn newlines(text: &[u8]) -> usize {
    memchr::memchr_iter(b'\n', text).count()
}

/// A body as one double-quoted word: the expansions an unquoted body
/// holds kept whole, every other `"` and `\`, and in a quoted body every
/// `$` and backtick too, escaped. With where each byte came from.
fn quoted_body(heredoc: &Heredoc, offsets: &[usize]) -> (Vec<u8>, Vec<usize>) {
    let body = &heredoc.body;
    let mut out = vec![b'"'];
    let mut places = vec![heredoc.body_start];
    let mut index = 0;
    while index < body.len() {
        let byte = body[index];
        let mut end = None;
        if !heredoc.quoted {
            let closer = if byte == b'$' {
                construct_closer(body, index, false)
            } else {
                None
            };
            if let Some(closer) = closer {
                end = construct_end(body, index, closer, 0);
            } else if byte == b'`' {
                end = quote_end(body, index, 0);
            } else if byte == b'\\' && matches!(body.get(index + 1), Some(b'$' | b'`' | b'\\')) {
                end = Some(index + 2);
            }
        }
        if let Some(end) = end {
            out.extend_from_slice(&body[index..end]);
            places.extend_from_slice(&offsets[index..end]);
            index = end;
            continue;
        }
        if matches!(byte, b'"' | b'\\') || heredoc.quoted && matches!(byte, b'$' | b'`') {
            out.push(b'\\');
            places.push(offsets[index]);
        }
        out.push(byte);
        places.push(offsets[index]);
        index += 1;
    }
    out.push(b'"');
    places.push(heredoc.end);
    (out, places)
}

/// Bytes after which a `#` opens a comment.
fn comment_preceder(byte: u8) -> bool {
    matches!(
        byte,
        b' ' | b'\t' | b'\n' | b';' | b'|' | b'&' | b'(' | b')' | b'<' | b'>'
    )
}

/// The byte closing the construct that opens at `index`: `${` its brace,
/// `$[` its bracket, `$(`, `<(` and `>(` their paren, and a lone `(` its
/// paren where `bare` lets one open.
fn construct_closer(data: &[u8], index: usize, bare: bool) -> Option<u8> {
    let following = data.get(index + 1).copied();
    match (data[index], following) {
        (b'$', Some(b'{')) => Some(b'}'),
        (b'$', Some(b'[')) => Some(b']'),
        (b'$' | b'<' | b'>', Some(b'(')) => Some(b')'),
        (b'(', _) if bare => Some(b')'),
        _ => None,
    }
}

/// Whether the reserved word `word` stands alone at `index` where a
/// command starts.
fn reserved_word(data: &[u8], index: usize, word: &[u8]) -> bool {
    if !data[index..].starts_with(word) {
        return false;
    }
    if data
        .get(index + word.len())
        .is_some_and(|after| !comment_preceder(*after))
    {
        return false;
    }
    let mut before = index;
    while before > 0 && matches!(data[before - 1], b' ' | b'\t' | b'\r') {
        before -= 1;
    }
    before > 0 && matches!(data[before - 1], b'\n' | b';' | b'|' | b'&' | b'(' | b')')
}

/// Past the quote closing the one at `start`: a backslash escapes inside
/// double quotes, backticks and `$'...'`, and a substitution inside an
/// expanding quote runs to its own close.
fn quote_end(data: &[u8], start: usize, depth: usize) -> Option<usize> {
    if depth > MAX_NESTING {
        return None;
    }
    let quote = data[start];
    let expands = quote != b'\'';
    let escapes = expands || start > 0 && data[start - 1] == b'$';
    let mut index = start + 1;
    while index < data.len() {
        let byte = data[index];
        let closer = if expands && byte == b'$' {
            construct_closer(data, index, false)
        } else {
            None
        };
        let nested = match quote {
            b'"' => byte == b'`',
            b'`' => matches!(byte, b'\'' | b'"'),
            _ => false,
        };
        if byte == b'\\' && escapes {
            index += 2;
        } else if byte == quote {
            return Some(index + 1);
        } else if nested {
            index = quote_end(data, index, depth + 1)?;
        } else if let Some(closer) = closer {
            index = construct_end(data, index, closer, depth + 1)?;
        } else {
            index += 1;
        }
    }
    None
}

/// Past the `closer` that closes the construct at `start`, read as the
/// line around it is: escapes, quotes and nested constructs skipped, a
/// `case` pattern's `)` closing nothing, and a comment inside `$( )`.
fn construct_end(data: &[u8], start: usize, closer: u8, depth: usize) -> Option<usize> {
    if depth > MAX_NESTING {
        return None;
    }
    let paren = closer == b')';
    let mut index = start
        + if matches!(data[start], b'(' | b'[') {
            1
        } else {
            2
        };
    let mut cases = 0usize;
    while index < data.len() {
        let byte = data[index];
        let nested = if closer == b']' && byte == b'[' {
            Some(b']')
        } else {
            construct_closer(data, index, paren)
        };
        if byte == b'\\' {
            index += 2;
        } else if matches!(byte, b'\'' | b'"' | b'`') {
            index = quote_end(data, index, depth + 1)?;
        } else if let Some(nested) = nested {
            index = construct_end(data, index, nested, depth + 1)?;
        } else if byte == closer && cases == 0 {
            return Some(index + 1);
        } else if paren && reserved_word(data, index, b"case") {
            cases += 1;
            index += 4;
        } else if cases > 0 && reserved_word(data, index, b"esac") {
            cases -= 1;
            index += 4;
        } else if paren && byte == b'#' && comment_preceder(data[index - 1]) {
            index = index + memchr::memchr(b'\n', &data[index..])? + 1;
        } else {
            index += 1;
        }
    }
    None
}

impl Tree {
    /// The heredoc a `file_redirect` node was folded from.
    pub fn heredoc(&self, index: usize) -> Option<&Heredoc> {
        let node = &self.nodes[index];
        if self.kind(index) != "file_redirect" {
            return None;
        }
        let children = node.first_child as usize..(node.first_child + node.child_count) as usize;
        self.heredocs.iter().find(|heredoc| {
            children.clone().any(|child| {
                self.kind(child) == "<" && self.nodes[child].start as usize == heredoc.at
            })
        })
    }

    /// A node's text in the line as typed: the heredoc bodies of the
    /// heredocs it holds included where they stand, not those it reads
    /// after it.
    pub fn source_text(&self, index: usize) -> std::borrow::Cow<'_, [u8]> {
        let node = &self.nodes[index];
        if node.parent == u32::MAX {
            return std::borrow::Cow::Borrowed(&self.original);
        }
        let (start, end) = (node.start as usize, node.end as usize);
        if !self
            .heredocs
            .iter()
            .any(|heredoc| start <= heredoc.at && heredoc.at < end)
        {
            return std::borrow::Cow::Borrowed(&self.source[start..end]);
        }
        if end <= start {
            return std::borrow::Cow::Borrowed(&[]);
        }
        let to = (self.offsets[end - 1] + 1).min(self.original.len());
        let from = self.offsets[start].min(to);
        std::borrow::Cow::Owned(self.typed(start, end, from, to, Vec::new()))
    }

    /// The line as typed from `from` to `to` with `edits` (start, end,
    /// replacement; `from`-based and sorted) made, less the line
    /// continuations the parser dropped: those no byte of nodes `start` to
    /// `end` came from, outside the heredocs it folded.
    fn typed(
        &self,
        start: usize,
        end: usize,
        from: usize,
        to: usize,
        edits: Vec<(usize, usize, Vec<u8>)>,
    ) -> Vec<u8> {
        let mut kept = vec![false; to - from];
        let mut keep = |a: usize, b: usize| {
            for at in a.max(from)..b.min(to) {
                kept[at - from] = true;
            }
        };
        for &at in &self.offsets[start..end] {
            keep(at, at + 1);
        }
        for heredoc in &self.heredocs {
            keep(heredoc.operator, heredoc.word_end);
            keep(heredoc.body_start, heredoc.end);
        }
        let typed = &self.original[from..to];
        let mut out = Vec::with_capacity(typed.len());
        let mut edits = edits.into_iter().peekable();
        let mut at = 0;
        while at <= typed.len() {
            if let Some((_, edit_end, replacement)) = edits.next_if(|edit| edit.0 == at) {
                out.extend(replacement);
                at = at.max(edit_end);
                continue;
            }
            if at == typed.len() {
                break;
            }
            if typed[at] == b'\\' && typed.get(at + 1) == Some(&b'\n') && !kept[at] && !kept[at + 1]
            {
                at += 2;
                continue;
            }
            out.push(typed[at]);
            at += 1;
        }
        out
    }

    /// A node's text with each heredoc body the line reads after a
    /// substitution in it moved inside that substitution, just before its
    /// `)`, and out of where it stood: the same command to bash, and one
    /// that carries no heredoc out of itself. A body the input ended
    /// inside gets its delimiter on a line of its own. Empty for a node
    /// that is no substitution, or one that carries none out: only a
    /// substitution's text is read as a line of its own.
    pub fn inlined(&self, index: usize) -> Vec<u8> {
        let node = &self.nodes[index];
        let (start, end) = (node.start as usize, node.end as usize);
        let kind = super::tree::KINDS[usize::from(node.kind)].0;
        if !matches!(kind, "command_substitution" | "process_substitution") || end <= start {
            return Vec::new();
        }
        let (first, last) = (self.offsets[start], self.offsets[end - 1]);
        let closes: Vec<&(usize, Vec<usize>)> = self
            .closes
            .iter()
            .filter(|(close, _)| first <= *close && *close <= last)
            .collect();
        if closes.is_empty() {
            return Vec::new();
        }
        let mut edits: Vec<(usize, usize, Vec<u8>)> = Vec::new();
        for (close, opened) in closes {
            let mut bodies = vec![b'\n'];
            for at in opened {
                let Some(heredoc) = self.heredocs.iter().find(|heredoc| heredoc.operator == *at)
                else {
                    continue;
                };
                let body = &self.original[heredoc.body_start..heredoc.end];
                bodies.extend_from_slice(body);
                if !bodies.ends_with(b"\n") {
                    bodies.push(b'\n');
                }
                if !heredoc.terminated {
                    let line = body.strip_suffix(b"\n").unwrap_or(body);
                    let escaped =
                        line.iter().rev().take_while(|byte| **byte == b'\\').count() % 2 == 1;
                    if !heredoc.quoted && escaped {
                        bodies.push(b'\n');
                    }
                    bodies.extend_from_slice(&heredoc.delimiter);
                    bodies.push(b'\n');
                }
                if first <= heredoc.body_start && heredoc.end <= last + 1 {
                    edits.push((heredoc.body_start - first, heredoc.end - first, Vec::new()));
                }
            }
            edits.push((close - first, close - first, bodies));
        }
        edits.sort_by_key(|edit| (edit.0, edit.1));
        self.typed(
            start,
            end,
            first,
            (last + 1).min(self.original.len()),
            edits,
        )
    }

    /// What bash warns of while it reads the line's heredocs, in the order
    /// it reads them: a substitution closing with bodies still to read, on
    /// the line its reader stands on then, and a body the input ends
    /// inside.
    pub fn warnings(&self) -> Vec<u8> {
        let mut heredocs: Vec<&Heredoc> = self.heredocs.iter().collect();
        heredocs.sort_by_key(|heredoc| heredoc.body_start);
        let mut out = Vec::new();
        let mut previous: Option<&Heredoc> = None;
        for heredoc in heredocs {
            if let Some((close, opened)) = self
                .closes
                .iter()
                .find(|(_, opened)| opened.first() == Some(&heredoc.operator))
            {
                let mut line = newlines(&self.original[..*close]) + 1;
                if let Some(previous) = previous {
                    line = line.max(newlines(&self.original[..previous.end.saturating_sub(1)]) + 1);
                }
                let plural = if opened.len() > 1 { "s" } else { "" };
                out.extend(
                    format!(
                        "mirage: line {line}: warning: command substitution: {} unterminated here-document{plural}\n",
                        opened.len()
                    )
                    .into_bytes(),
                );
            }
            if !heredoc.terminated {
                out.extend(
                    format!(
                        "mirage: line {}: warning: here-document at line {} delimited by end-of-file (wanted `",
                        heredoc.eof_line, heredoc.line
                    )
                    .into_bytes(),
                );
                out.extend_from_slice(&heredoc.delimiter);
                out.extend_from_slice(b"')\n");
            }
            previous = Some(heredoc);
        }
        out
    }

    fn kind(&self, index: usize) -> &'static str {
        super::tree::KINDS[self.nodes[index].kind as usize].0
    }
}
