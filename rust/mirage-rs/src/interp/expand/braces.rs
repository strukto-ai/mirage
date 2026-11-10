//! One `${...}`: its name, subscript and operator read off the node, the
//! parameter it reads, and an indirection aimed at what a name holds.

use std::borrow::Cow;

use super::operators::bad_transformation;
use super::{
    Braces, Chunk, Expander, Host, Operands, Part, bad_subscript, discard, ifs_joiner, join,
    reference, splat, trim_start, voiced,
};

use crate::interp::parameter::{bad_substitution, starts_name};
use crate::interp::write::{Fault, element_reference};
use crate::interp::{Diagnostic, Signal, pattern};
use crate::vars::Indexed;

const PARAM_OPS: [&str; 23] = [
    ":-", "-", ":+", "+", ":?", "?", ":=", "=", "#", "##", "%", "%%", "/", "//", "/#", "/%", ":",
    "^", "^^", ",", ",,", "!", "@",
];

/// The operators whose word bash expands only once the parameter's state
/// selects it: a default, an alternate, an assignment, a message.
const UNSET_GUARD_OPS: [&str; 8] = ["-", ":-", "+", ":+", "=", ":=", "?", ":?"];

impl<H: Host> Expander<'_, H> {
    pub(super) fn parse_braces(&self, node: usize) -> Braces {
        let mut braces = Braces::default();
        let mut seen = false;
        let parts = self.parts(node);
        for (position, &part) in parts.iter().enumerate() {
            let Part::Node(child) = part else {
                if braces.op.is_some() {
                    braces
                        .groups
                        .last_mut()
                        .expect("a group per operator")
                        .push(part);
                }
                continue;
            };
            let kind = self.kind(child);
            match kind {
                "${" | "}" => continue,
                "#" if !seen => {
                    braces.length = true;
                    continue;
                }
                "!" if !seen => {
                    braces.indirect = true;
                    continue;
                }
                "variable_name" | "special_variable_name" if !seen => {
                    braces.name = Some(self.text(child).to_vec());
                    seen = true;
                    continue;
                }
                "subscript" if !seen => {
                    for inner in self.tree.named_children(child) {
                        if self.kind(inner) == "variable_name" && braces.name.is_none() {
                            braces.name = Some(self.text(inner).to_vec());
                        } else {
                            braces.subscript_nodes.push(inner);
                        }
                    }
                    if let Some(name) = &braces.name {
                        let text = self.text(child);
                        braces.subscript = Some(text[name.len() + 1..text.len() - 1].to_vec());
                        let node = &self.tree.nodes[child];
                        braces.subscript_span =
                            (node.start as usize + name.len() + 1, node.end as usize - 1);
                    }
                    seen = true;
                    continue;
                }
                "@" | "*"
                    if braces.indirect
                        && seen
                        && braces.op.is_none()
                        && braces.subscript.is_none()
                        && matches!(parts.get(position + 1), Some(Part::Node(n)) if self.kind(*n) == "}") =>
                {
                    braces.prefix = true;
                    continue;
                }
                _ => {}
            }
            if braces.op.is_none() {
                if let Some(op) = PARAM_OPS.iter().find(|op| **op == kind) {
                    braces.op = Some(op);
                    braces.groups.push(Vec::new());
                    continue;
                }
            }
            if let Some(op) = braces.op {
                let separator = match op {
                    "/" | "//" | "/#" | "/%" => Some("/"),
                    _ => None,
                };
                if !self.tree.nodes[child].named
                    && Some(kind) == separator
                    && braces.groups.len() == 1
                {
                    braces.groups.push(Vec::new());
                    continue;
                }
                braces
                    .groups
                    .last_mut()
                    .expect("a group per operator")
                    .push(part);
            }
        }
        if braces.length && braces.name.is_none() {
            braces.name = Some(b"#".to_vec());
            braces.length = false;
        }
        if braces.indirect && braces.name.is_none() && braces.op.is_none() {
            braces.name = Some(b"!".to_vec());
            braces.indirect = false;
        }
        if braces.name.is_none() && braces.op.is_none() {
            self.reread_word(&parts, &mut braces);
        }
        braces
    }

    /// A `${...}` the parser left as one word: a name, an optional `[@]`
    /// or `[*]`, then an operator it has no token for, `~` or `~~` (case
    /// toggled) with its pattern, or `@` with letters that name no
    /// transformation (`${v@Z}`), split here as bash reads it.
    fn reread_word(&self, parts: &[Part], braces: &mut Braces) {
        let words: Vec<usize> = parts
            .iter()
            .filter_map(|&part| match part {
                Part::Node(child) if self.kind(child) == "word" => Some(child),
                _ => None,
            })
            .collect();
        let [word] = words[..] else {
            return;
        };
        let text = self.text(word);
        if !text
            .first()
            .is_some_and(|b| *b == b'_' || b.is_ascii_alphabetic())
        {
            return;
        }
        let mut end = text
            .iter()
            .position(|b| !(*b == b'_' || b.is_ascii_alphanumeric()))
            .unwrap_or(text.len());
        let name = text[..end].to_vec();
        let mut subscript = None;
        if let Some(splat) = [b"[@]", b"[*]"]
            .into_iter()
            .find(|splat| text[end..].starts_with(*splat))
        {
            subscript = Some(vec![splat[1]]);
            end += splat.len();
        }
        let rest = &text[end..];
        let op = if rest.starts_with(b"~~") {
            "~~"
        } else if rest.starts_with(b"~") {
            "~"
        } else if rest.starts_with(b"@") {
            "@"
        } else {
            return;
        };
        let start = self.tree.nodes[word].start as usize;
        let (from, to) = (start + end + op.len(), start + text.len());
        braces.name = Some(name);
        braces.subscript = subscript;
        braces.op = Some(op);
        braces.groups.push(if from < to {
            vec![Part::Text(from, to)]
        } else {
            Vec::new()
        });
    }

    /// `${!prefix@}` and `${!prefix*}`: the names of the set variables that
    /// start with the prefix, the ones the shell computes too, sorted.
    fn prefixed(&self, p: &Braces, quoted: bool) -> Vec<Chunk> {
        let prefix = p.name.as_deref().unwrap_or_default();
        let vars = &self.shell.vars;
        let mut names: Vec<Vec<u8>> = vars
            .records()
            .filter(|(name, var)| var.value.is_some() && !vars.hidden(name))
            .map(|(name, _)| name.as_bytes().to_vec())
            .chain(vars.computed().map(|name| name.as_bytes().to_vec()))
            .filter(|name| name.starts_with(prefix))
            .collect();
        names.sort();
        names.dedup();
        let star = p.star;
        let joiner = if star {
            ifs_joiner(self.shell.ifs(), self.shell.utf8())
        } else {
            b" ".to_vec()
        };
        if star && quoted {
            return vec![Chunk::value(names.join(joiner.as_slice()), true)];
        }
        splat(&names, &joiner, quoted)
    }

    /// One `${...}` as pieces.
    pub(super) async fn braces(&mut self, node: usize, quoted: bool) -> Result<Vec<Chunk>, Fault> {
        let text = trim_start(self.text(node)).to_vec();
        if bad_substitution(&text) {
            return Err(Fault::Bad { text, fixed: false });
        }
        let mut p = self.parse_braces(node);
        p.node = node;
        if p.prefix {
            p.star = text.ends_with(b"*}");
            return Ok(self.prefixed(&p, quoted));
        }
        if p.indirect && p.subscript.is_none() {
            let var = String::from_utf8_lossy(p.name.as_deref().unwrap_or_default()).into_owned();
            if self.shell.vars.nameref_target(&var).is_none() {
                self.aim_indirect(&mut p).await?;
            }
        }
        let lazy =
            p.op.is_some_and(|op| UNSET_GUARD_OPS.contains(&op) || op == ":");
        let operands = if lazy {
            Operands::default()
        } else {
            self.operands(&p).await?
        };
        if let Some(count) = self.splat_count(&p) {
            return Ok(vec![Chunk::value(count.to_string(), quoted)]);
        }
        if let Some((array, keys)) = self.splat_source(&p) {
            return self.expand_splat(&p, array, keys, quoted, &operands).await;
        }
        let name = p.name.clone().unwrap_or_default();
        let var = String::from_utf8_lossy(&name).into_owned();
        let mut value = Vec::new();
        let mut set = false;
        let mut write_key: Option<Vec<u8>> = None;
        if p.subscript.is_some() {
            if self.shell.vars.assoc(&var).is_some() {
                let key = self.subscript_key(&p).await?;
                let map = self.shell.vars.assoc(&var).expect("checked above");
                if let Some(found) = map.get(&key) {
                    value = found.to_vec();
                    set = true;
                }
                write_key = Some(key);
            } else {
                let key = self.subscript_key(&p).await?;
                let mut index = self.expansion_index(&key).await?;
                let array = match self.shell.indexed(&var) {
                    Some(array) => array,
                    None => Cow::Owned(Indexed::dense(
                        self.shell.vars.scalar(&var).map(<[u8]>::to_vec),
                    )),
                };
                if index < 0 {
                    index = array.back(index);
                    let assigns = matches!(p.op, Some("=" | ":="));
                    if index < 0 && !assigns {
                        self.diagnostics.push(Diagnostic::Bytes(voiced(
                            self.shell.vars.voice(),
                            &format!("{var}: bad array subscript\n"),
                        )));
                    }
                }
                if let Some(found) = array.get(index) {
                    value = found.to_vec();
                    set = true;
                }
                if index >= 0 {
                    write_key = Some(index.to_string().into_bytes());
                }
            }
        } else if !name.is_empty() {
            match self.held(&name)? {
                Some(found) => {
                    value = found;
                    set = true;
                }
                None => {
                    let strict = !p.op.is_some_and(|op| UNSET_GUARD_OPS.contains(&op));
                    value = self.lookup(&name, strict)?;
                }
            }
        }
        if p.subscript.is_some()
            && !set
            && self.shell.option("nounset")
            && !p.length
            && !p.indirect
            && !p.op.is_some_and(|op| UNSET_GUARD_OPS.contains(&op))
        {
            return Err(Signal::unbound(self.shell.vars.voice(), &reference(&p)).into());
        }
        if p.indirect {
            let target = match self.shell.vars.nameref_target(&var) {
                Some(target) => target.as_bytes().to_vec(),
                None if value.is_empty() => Vec::new(),
                None => self.lookup(&value.clone(), true)?,
            };
            return Ok(vec![Chunk::value(target, quoted)]);
        }
        if p.length {
            return Ok(vec![Chunk::value(self.measure(&value).to_string(), quoted)]);
        }
        let Some(op) = p.op else {
            return Ok(vec![Chunk::value(value, quoted)]);
        };
        match op {
            "?" | ":?" => {
                if if op == "?" { set } else { !value.is_empty() } {
                    return Ok(vec![Chunk::value(value, quoted)]);
                }
                Err(self.unset_error(&p).await?)
            }
            "=" | ":=" => {
                if if op == "=" { set } else { !value.is_empty() } {
                    return Ok(vec![Chunk::value(value, quoted)]);
                }
                let default = join(&self.operator_word(&p, quoted).await?);
                if !starts_name(name.first()) {
                    return Err(discard(
                        self.shell.vars.voice(),
                        &format!("${var}: cannot assign in this way\n"),
                    ));
                }
                let written = if p.subscript.is_some() {
                    let Some(key) = write_key else {
                        return Err(bad_subscript(self.shell.vars.voice(), &p));
                    };
                    self.expansion_write(&var, Some(key), default.clone()).await
                } else if !name.is_empty() {
                    self.expansion_write(&var, None, default.clone()).await
                } else {
                    Ok(())
                };
                written.map_err(|fault| self.default_refused(fault))?;
                Ok(vec![Chunk::value(default, quoted)])
            }
            ":-" | "-" => {
                if if op == ":-" { !value.is_empty() } else { set } {
                    return Ok(vec![Chunk::value(value, quoted)]);
                }
                self.operator_word(&p, quoted).await
            }
            ":+" | "+" => {
                if !(if op == ":+" { !value.is_empty() } else { set }) {
                    return Ok(Vec::new());
                }
                self.operator_word(&p, quoted).await
            }
            ":" => {
                if !set {
                    return Ok(vec![Chunk::value(Vec::new(), quoted)]);
                }
                let utf8 = self.shell.utf8();
                let extent = pattern::length(&value, utf8) as i128;
                let Some((offset, length)) = self.slice_bounds(&p, extent, true).await? else {
                    return Ok(vec![Chunk::value(Vec::new(), quoted)]);
                };
                Ok(vec![Chunk::value(
                    pattern::substring(&value, offset as usize, length, utf8),
                    quoted,
                )])
            }
            "@" => {
                let Some(letter) = operands.letter else {
                    if set {
                        return Err(bad_transformation(self.shell.vars.voice(), &text));
                    }
                    return Ok(Vec::new());
                };
                Ok(self
                    .transform(letter, &var, &value, set)
                    .map(|text| vec![Chunk::value(text, quoted)])
                    .unwrap_or_default())
            }
            "/" | "//" | "/#" | "/%" if !set => Ok(vec![Chunk::value(Vec::new(), quoted)]),
            _ => Ok(vec![Chunk::value(
                self.value_op(op, &value, &operands).await?,
                quoted,
            )]),
        }
    }

    /// Aim `${!x...}` at what x's value names, which the rest of the
    /// expansion then reads in x's place: a name, an element (`a[1]`,
    /// `a[@]`), a positional or a special. bash refuses an unset x (`x:
    /// invalid indirect expansion`) and a value naming no parameter (`1a:
    /// invalid variable name`), and under `set -u` a name no variable
    /// holds (`!x: unbound variable`).
    async fn aim_indirect(&mut self, p: &mut Braces) -> Result<(), Fault> {
        let name = p.name.clone().unwrap_or_default();
        let shown = String::from_utf8_lossy(&name).into_owned();
        let Some(reference) = self.held(&name)? else {
            return Err(discard(
                self.shell.vars.voice(),
                &format!("{shown}: invalid indirect expansion\n"),
            ));
        };
        let special = reference.len() == 1 && b"@*#?-$!".contains(&reference[0]);
        let digits = !reference.is_empty() && reference.iter().all(u8::is_ascii_digit);
        let (target, subscript) = if special || digits {
            (reference.clone(), None)
        } else {
            match element_reference(&reference) {
                Some((target, subscript)) => {
                    (target.as_bytes().to_vec(), subscript.map(<[u8]>::to_vec))
                }
                None => {
                    return Err(discard(
                        self.shell.vars.voice(),
                        &format!(
                            "{}: invalid variable name\n",
                            String::from_utf8_lossy(&reference)
                        ),
                    ));
                }
            }
        };
        let guarded = p.op.is_some_and(|op| UNSET_GUARD_OPS.contains(&op));
        if subscript.is_none()
            && !guarded
            && starts_name(target.first())
            && self.shell.option("nounset")
            && !self.holds(&String::from_utf8_lossy(&target))
        {
            return Err(Signal::unbound(self.shell.vars.voice(), &format!("!{shown}")).into());
        }
        p.name = Some(target);
        p.subscript = subscript;
        p.subscript_nodes.clear();
        p.indirect = false;
        Ok(())
    }

    /// How long a value is: in characters under a UTF-8 locale, a byte
    /// that is no character counting one, and in bytes otherwise.
    fn measure(&self, value: &[u8]) -> usize {
        pattern::length(value, self.shell.utf8())
    }
}
