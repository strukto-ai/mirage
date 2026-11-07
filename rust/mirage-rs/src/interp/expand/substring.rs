//! `${v:offset:length}`: the bounds, each an arithmetic expression, read
//! off the operator's words and evaluated in order.

use super::{Braces, Expander, Host, discard, join, reference, within};

use crate::interp::escapes::unquoted_runs;
use crate::interp::write::Fault;

impl<H: Host> Expander<'_, H> {
    /// A substring's bounds, each expanded then evaluated as arithmetic
    /// and its writes landed before the next is expanded: the offset from
    /// the start, or back from the end when negative, and the length.
    /// None when the offset lands outside the value, which then expands
    /// to nothing; a scalar may start at its end. A negative length is an
    /// error for an array, and for a scalar once it ends before the
    /// offset, named as written (`bash:  -5 : substring expression < 0`).
    pub(super) async fn slice_bounds(
        &mut self,
        p: &Braces,
        extent: i128,
        scalar: bool,
    ) -> Result<Option<(i64, Option<i64>)>, Fault> {
        let bounds = self.substring_operands(p.node);
        let lead = reference(p);
        let mut texts = Vec::new();
        let mut values = Vec::new();
        for &span in &bounds.spans {
            let text = self.operand_text(&bounds, span).await?;
            let mut value = self.evaluate(&text, &lead).await?;
            if values.is_empty() {
                let at = i128::from(value) + if value < 0 { extent } else { 0 };
                if at < 0 || at > extent || (at == extent && !scalar) {
                    return Ok(None);
                }
                value = at as i64;
            }
            texts.push(text);
            values.push(value);
        }
        let offset = values.first().copied().unwrap_or(0);
        let length = values.get(1).copied();
        if length.is_some_and(|length| {
            length < 0 && (!scalar || extent + i128::from(length) < i128::from(offset))
        }) {
            let text = String::from_utf8_lossy(&texts[1]);
            return Err(discard(
                self.shell.vars.voice(),
                &format!("{text}: substring expression < 0\n"),
            ));
        }
        Ok(Some((offset, length)))
    }

    /// A substring's offset and length as written: the source after the
    /// `:` split at its top-level `:` (not one in parentheses, a
    /// subscript, a ternary or a nested expansion), and the expansions
    /// within it.
    fn substring_operands(&self, node: usize) -> Bounds {
        let children: Vec<usize> = self.tree.children(node).collect();
        let mut atoms = Vec::new();
        let Some(colon) = children.iter().position(|&c| self.kind(c) == ":") else {
            return Bounds {
                data: Vec::new(),
                atoms,
                opaque: Vec::new(),
                spans: Vec::new(),
            };
        };
        for &child in &children[colon + 1..] {
            if self.kind(child) != "}" {
                self.atoms(child, &mut atoms);
            }
        }
        let base = self.tree.nodes[node].start as usize;
        let data = self.text(node).to_vec();
        let start = self.tree.nodes[children[colon]].end as usize - base;
        let end = data.len().saturating_sub(1);
        let opaque: Vec<(usize, usize)> = atoms
            .iter()
            .map(|&a| {
                (
                    self.tree.nodes[a].start as usize - base,
                    self.tree.nodes[a].end as usize - base,
                )
            })
            .collect();
        let separator = substring_separator(&data, start, end, &opaque);
        let mut spans = vec![(start, separator)];
        if separator < end {
            spans.push((separator + 1, end));
        }
        Bounds {
            data,
            atoms,
            opaque,
            spans,
        }
    }

    /// One substring operand's text, its expansions substituted and its
    /// escapes removed.
    async fn operand_text(
        &mut self,
        bounds: &Bounds,
        (begin, stop): (usize, usize),
    ) -> Result<Vec<u8>, Fault> {
        let data = &bounds.data;
        let word = &data[begin..stop];
        let mut text = Vec::new();
        let mut cursor = begin;
        for (&atom, &(left, right)) in bounds.atoms.iter().zip(&bounds.opaque) {
            if begin <= left && right <= stop {
                text.extend(unquoted_text(&data[cursor..left]));
                match self.chunks(atom, false).await {
                    Ok(chunks) => text.extend(join(&chunks)),
                    Err(fault) => return Err(within(fault, word, true)),
                }
                cursor = right;
            }
        }
        text.extend(unquoted_text(&data[cursor..stop]));
        Ok(text)
    }
}

/// A substring's operands as written: the expansion's source, the
/// expansions within it and their spans, and each operand's span.
struct Bounds {
    data: Vec<u8>,
    atoms: Vec<usize>,
    opaque: Vec<(usize, usize)>,
    spans: Vec<(usize, usize)>,
}

/// Where a substring's offset ends: its first `:` outside parentheses,
/// brackets, a ternary and the opaque nested expansions.
fn substring_separator(data: &[u8], start: usize, end: usize, opaque: &[(usize, usize)]) -> usize {
    let mut depth = 0i32;
    let mut ternary = 0;
    let mut index = start;
    while index < end {
        if let Some(&(_, right)) = opaque.iter().find(|(left, _)| *left == index) {
            index = right;
            continue;
        }
        match data[index] {
            b'\\' => {
                index += 2;
                continue;
            }
            b'(' | b'[' => depth += 1,
            b')' | b']' => depth -= 1,
            b'?' if depth == 0 => ternary += 1,
            b':' if depth == 0 => {
                if ternary == 0 {
                    return index;
                }
                ternary -= 1;
            }
            _ => {}
        }
        index += 1;
    }
    end
}

/// An unquoted word's text with its escapes removed.
fn unquoted_text(text: &[u8]) -> Vec<u8> {
    unquoted_runs(text)
        .into_iter()
        .flat_map(|(run, _)| run)
        .collect()
}
