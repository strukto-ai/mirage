//! `$(...)` and backticks: the body the host runs in a child shell, its
//! output with trailing newlines removed, and `$(< file)`.

use super::{Expander, Field, Host};

use crate::interp::Diagnostic;
use crate::interp::write::Fault;

impl<H: Host> Expander<'_, H> {
    /// A command substitution's output, trailing newlines dropped; its
    /// stderr joins the statement's and its status is `$?` from here.
    pub(super) async fn substitution(
        &mut self,
        node: usize,
        fold: usize,
    ) -> Result<Vec<u8>, Fault> {
        let inlined = self.tree.inlined(node);
        let source = if inlined.is_empty() {
            self.tree.source_text(node).into_owned()
        } else {
            inlined
        };
        let raw = source[fold.min(source.len())..].to_vec();
        if raw.starts_with(b"`") {
            let mut out = Vec::new();
            for (text, command, start, end) in backtick_segments(&raw) {
                if !command {
                    out.extend(text);
                    continue;
                }
                let span = Some((fold + start, fold + end));
                out.extend(self.run_substitution(&text, node, span, None).await?);
            }
            return Ok(out);
        }
        let inner = raw.get(2..raw.len().saturating_sub(1)).unwrap_or_default();
        if inner.iter().all(u8::is_ascii_whitespace) {
            return Ok(Vec::new());
        }
        let read = match self.input_redirect(node) {
            Some(target) => Some(self.fields(target).await?),
            None => None,
        };
        self.run_substitution(inner, node, None, read.as_deref())
            .await
    }

    /// The file of bash's `$(< file)`, a lone foreground `<` (or `0<`)
    /// that reads the file in, not a heredoc or here-string folded into
    /// one: its name expands in this shell, as bash expands it before the
    /// substitution starts.
    fn input_redirect(&self, node: usize) -> Option<usize> {
        if self
            .tree
            .children(node)
            .any(|child| self.kind(child) == "&")
        {
            return None;
        }
        let statements: Vec<usize> = self
            .tree
            .named_children(node)
            .filter(|&child| self.kind(child) != "comment")
            .collect();
        let [redirect] = statements.as_slice() else {
            return None;
        };
        if self.kind(*redirect) != "file_redirect" || self.tree.heredoc(*redirect).is_some() {
            return None;
        }
        let mut target = None;
        let mut reads = false;
        for child in self.tree.children(*redirect) {
            match self.kind(child) {
                "<" => reads = true,
                "file_descriptor" if self.text(child) == b"0" => {}
                _ if self.tree.nodes[child].named && target.is_none() => target = Some(child),
                _ => return None,
            }
        }
        target.filter(|_| reads)
    }

    async fn run_substitution(
        &mut self,
        body: &[u8],
        node: usize,
        span: Option<(usize, usize)>,
        read: Option<&[Field]>,
    ) -> Result<Vec<u8>, Fault> {
        let ran = self
            .host
            .substitute(self.shell, body, node, span, read)
            .await?;
        self.diagnostics.push(Diagnostic::Bytes(ran.stderr));
        self.shell.status = ran.status;
        let mut out = ran.stdout;
        while out.last() == Some(&b'\n') {
            out.pop();
        }
        Ok(out)
    }
}

/// A backtick region's commands and the text between them, each with its
/// span in the region. bash removes a backtick body's backslashes before
/// it parses it, so the body is lexed again: inside a command a backslash
/// stays literal except before `$`, `` ` `` and `\`, where it escapes, and
/// consuming those pairs whole is what lets a backtick after `\\` close
/// the region.
fn backtick_segments(raw: &[u8]) -> Vec<(Vec<u8>, bool, usize, usize)> {
    let mut segments = Vec::new();
    let mut buf = Vec::new();
    let mut command = false;
    let mut start = 0;
    let mut i = 0;
    while i < raw.len() {
        if raw[i] == b'\\' && command && raw.get(i + 1).is_some_and(|b| b"$`\\".contains(b)) {
            buf.push(raw[i + 1]);
            i += 2;
            continue;
        }
        if raw[i] == b'`' {
            segments.push((std::mem::take(&mut buf), command, start, i));
            command = !command;
            i += 1;
            start = i;
            continue;
        }
        buf.push(raw[i]);
        i += 1;
    }
    segments.push((buf, command, start, raw.len()));
    segments.retain(|(text, command, _, _)| !text.is_empty() || *command);
    segments
}
