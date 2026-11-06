//! `$((...))`, `((...))` and arithmetic subscripts: the expression's
//! text with its expansions done, handed to the evaluator.

use super::{Expander, Host, join, trim_start, within};

use crate::arith;
use crate::interp::Signal;
use crate::interp::write::Fault;
use crate::vars::Draws;

const ARITH_DELIMITERS: [&str; 5] = ["$((", "((", "))", "$[", "]"];

const ARITH_PLAIN: [&str; 10] = [
    "number",
    "variable_name",
    "word",
    "binary_expression",
    "unary_expression",
    "parenthesized_expression",
    "ternary_expression",
    "postfix_expression",
    "concatenation",
    "subscript",
];

impl<H: Host> Expander<'_, H> {
    pub(super) fn atoms(&self, node: usize, out: &mut Vec<usize>) {
        if self.kind(node) == "concatenation" {
            for child in self.tree.children(node) {
                self.atoms(child, out);
            }
        } else if self.tree.nodes[node].named && !matches!(self.kind(node), "word" | "number") {
            out.push(node);
        }
    }

    /// Evaluate one arithmetic text, landing what it assigns; an error
    /// names `lead`, the reference it belongs to.
    pub(super) async fn evaluate(&mut self, text: &[u8], lead: &str) -> Result<i64, Fault> {
        let mut draws = Draws::default();
        let nounset = self.shell.option("nounset");
        let outcome = self.shell.vars.arith(&mut draws, text, None, nounset);
        let value = match outcome.value {
            Err(arith::Error::Unbound(name)) => return Err(Signal::unbound(&name).into()),
            other => other,
        };
        for write in outcome.writes {
            let (name, key) = (write.name.clone(), write.key.clone());
            self.expansion_write(&name, key, write.value.into_bytes())
                .await?;
        }
        self.shell.vars.settle(&mut draws).map_err(Fault::Arith)?;
        match value {
            Ok(value) => Ok(value),
            Err(arith::Error::Readonly { name, subscript }) => {
                Err(Signal::readonly(&name, subscript).into())
            }
            Err(error) => Err(Signal::arith(&error, lead, false).into()),
        }
    }

    /// An arithmetic command's or clause's expression text (`((...))`,
    /// `for ((...))`), its `$`-expansions substituted; a bad substitution
    /// names the expression as written.
    pub async fn arith(&mut self, node: usize) -> Result<Vec<u8>, Fault> {
        match self.arith_text(node).await {
            Ok(text) => Ok(text),
            Err(fault) => {
                let inside = arith_inside(trim_start(self.text(node))).to_vec();
                Err(within(fault, &inside, true))
            }
        }
    }

    /// The expression text of a `$((...))`: `$`-expansions substitute as
    /// text, as bash expands before it evaluates, while names stay names
    /// for the evaluator to read and assign. The expression reads as if
    /// double-quoted, so a single-quoted string stays as typed for the
    /// evaluator to refuse (`$(('1'))`).
    async fn arith_text(&mut self, node: usize) -> Result<Vec<u8>, Fault> {
        let mut out = Vec::new();
        let start = self.tree.nodes[node].start as usize;
        let mut end = start;
        let children: Vec<usize> = self.tree.children(node).collect();
        for child in children {
            let (child_start, child_end) = (
                self.tree.nodes[child].start as usize,
                self.tree.nodes[child].end as usize,
            );
            out.extend_from_slice(&self.tree.source[end..child_start]);
            end = child_end;
            let kind = self.kind(child);
            if ARITH_DELIMITERS.contains(&kind) {
                continue;
            }
            if matches!(
                kind,
                "binary_expression"
                    | "unary_expression"
                    | "parenthesized_expression"
                    | "ternary_expression"
                    | "postfix_expression"
                    | "concatenation"
            ) {
                out.extend(Box::pin(self.arith_text(child)).await?);
            } else if kind == "subscript" {
                out.extend(self.arith_subscript(child).await?);
            } else if !self.tree.nodes[child].named
                || ARITH_PLAIN.contains(&kind)
                || matches!(kind, "raw_string" | "ansi_c_string")
            {
                out.extend_from_slice(self.text(child));
            } else {
                out.extend(join(&self.chunks(child, false).await?));
            }
        }
        out.extend_from_slice(&self.tree.source[end..self.tree.nodes[node].end as usize]);
        Ok(out)
    }

    /// One element reference for the evaluator: its `$`-expansions
    /// substitute, a literal interior rides as typed (an associative key
    /// is its text, `m[k]` the key `k`).
    async fn arith_subscript(&mut self, node: usize) -> Result<Vec<u8>, Fault> {
        let mut name = Vec::new();
        let mut inner = Vec::new();
        for child in self.tree.named_children(node) {
            if self.kind(child) == "variable_name" && name.is_empty() {
                name = self.text(child).to_vec();
            } else {
                inner.push(child);
            }
        }
        let text = self.text(node);
        let raw = text[name.len() + 1..text.len() - 1].to_vec();
        let mut out = name.clone();
        out.push(b'[');
        if !raw.iter().any(|b| b"$'\"`".contains(b)) {
            out.extend(raw);
        } else {
            for child in inner {
                if matches!(
                    self.kind(child),
                    "simple_expansion"
                        | "expansion"
                        | "command_substitution"
                        | "string"
                        | "raw_string"
                        | "ansi_c_string"
                        | "translated_string"
                        | "concatenation"
                ) {
                    out.extend(join(&self.chunks(child, false).await?));
                } else {
                    out.extend_from_slice(self.text(child));
                }
            }
        }
        out.push(b']');
        Ok(out)
    }

    /// A `$((...))`'s value: evaluated, its writes landed through the gate
    /// before an error is reported, as bash binds each as it is made.
    pub(super) async fn arith_expansion(&mut self, node: usize) -> Result<Vec<u8>, Fault> {
        let text = match self.arith_text(node).await {
            Ok(text) => text,
            Err(fault) => {
                let inside = arith_inside(trim_start(self.text(node))).to_vec();
                return Err(within(fault, &inside, true));
            }
        };
        let mut draws = Draws::default();
        let nounset = self.shell.option("nounset");
        let outcome = self.shell.vars.arith(&mut draws, &text, None, nounset);
        let value = match outcome.value {
            Err(arith::Error::Unbound(name)) => return Err(Signal::unbound(&name).into()),
            other => other,
        };
        for write in outcome.writes {
            let key = write.key.clone();
            let name = write.name.clone();
            self.expansion_write(&name, key, write.value.into_bytes())
                .await?;
        }
        self.shell.vars.settle(&mut draws).map_err(Fault::Arith)?;
        match value {
            Ok(value) => Ok(value.to_string().into_bytes()),
            Err(arith::Error::Readonly { name, subscript }) => {
                Err(Signal::readonly(&name, subscript).into())
            }
            Err(error) => Err(Signal::arith(&error, "", false).into()),
        }
    }
}

/// The expression between `$((` and `))`, `((` and `))` or `$[` and `]`.
fn arith_inside(text: &[u8]) -> &[u8] {
    for (open, close) in [(&b"$(("[..], &b"))"[..]), (b"((", b"))"), (b"$[", b"]")] {
        if text.starts_with(open) && text.ends_with(close) && text.len() >= open.len() + close.len()
        {
            return &text[open.len()..text.len() - close.len()];
        }
    }
    text
}
