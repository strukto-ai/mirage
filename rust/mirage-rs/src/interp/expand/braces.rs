//! One `${...}`: its name, subscript and operator read off the node,
//! the operator's words expanded only when the parameter's state selects
//! them, and the value operators and transformations.

use super::{
    Braces, Chunk, Expander, Host, Operands, PATTERN_OPS, Part, bad_subscript, discard, ifs_joiner,
    join, reference, splat, trim_start, voiced, within,
};

use crate::interp::escapes::decode_ansi_c;
use crate::interp::parameter::{bad_substitution, scan_parameter};
use crate::interp::pattern::{Case, Pattern};
use crate::interp::write::{Denied, Fault, element_reference};
use crate::interp::{Diagnostic, Signal, listing, pattern, quote};
use crate::vars::{Indexed, RANDOM};

/// The letters `${v@x}` knows.
const TRANSFORMS: &[u8] = b"QEPAKakUuL";
const PARAM_OPS: [&str; 23] = [
    ":-", "-", ":+", "+", ":?", "?", ":=", "=", "#", "##", "%", "%%", "/", "//", "/#", "/%", ":",
    "^", "^^", ",", ",,", "!", "@",
];

/// The operators whose word bash expands only once the parameter's state
/// selects it: a default, an alternate, an assignment, a message.
const UNSET_GUARD_OPS: [&str; 8] = ["-", ":-", "+", ":+", "=", ":=", "?", ":?"];

/// What a backslash escapes in an operator's word inside double quotes.
const OPERAND_DQUOTE_ESCAPES: &[u8] = b"$`\"\\}";

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

    /// The operands a value operator needs whatever the value: the
    /// pattern as a pattern, the replacement with unquoted rules even
    /// inside double quotes, as bash reads them.
    async fn operands(&mut self, p: &Braces) -> Result<Operands, Fault> {
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
                let array = match self.shell.indexed(&var) {
                    Some(array) => array.into_owned(),
                    None => Indexed::dense(self.shell.vars.scalar(&var).map(<[u8]>::to_vec)),
                };
                let key = self.subscript_key(&p).await?;
                let mut index = self.expansion_index(&key).await?;
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
                if !starts_name(&name) {
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

    /// A plain name's or a positional's value when it holds one: element
    /// 0 of an array, a map's key `0`, a positional the count reaches, a
    /// special that is not empty.
    fn held(&mut self, name: &[u8]) -> Result<Option<Vec<u8>>, Fault> {
        if !starts_name(name) {
            let value = self.lookup(name, false)?;
            return Ok((!value.is_empty() || self.positional_set(name)).then_some(value));
        }
        let var = String::from_utf8_lossy(name).into_owned();
        if let Some(array) = self.shell.indexed(&var) {
            return Ok(array.get(0).map(<[u8]>::to_vec));
        }
        if let Some(map) = self.shell.vars.assoc(&var) {
            return Ok(map.get(b"0").map(<[u8]>::to_vec));
        }
        if var == RANDOM {
            if let Some(drawn) = self.shell.vars.next_random().map_err(Fault::Arith)? {
                return Ok(Some(drawn.to_string().into_bytes()));
            }
        }
        if let Some(value) = self.shell.vars.dynamic(&var) {
            return Ok(Some(value));
        }
        Ok(self.shell.vars.scalar(&var).map(<[u8]>::to_vec))
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
            && starts_name(&target)
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

    /// Whether a name holds a value, read without drawing `$RANDOM`.
    fn holds(&self, var: &str) -> bool {
        if var == RANDOM || self.shell.vars.dynamic(var).is_some() {
            return true;
        }
        if let Some(array) = self.shell.indexed(var) {
            return array.get(0).is_some();
        }
        if let Some(map) = self.shell.vars.assoc(var) {
            return map.get(b"0").is_some();
        }
        self.shell.vars.scalar(var).is_some()
    }

    /// How long a value is: in characters under a UTF-8 locale, a byte
    /// that is no character counting one, and in bytes otherwise.
    fn measure(&self, value: &[u8]) -> usize {
        pattern::length(value, self.shell.utf8())
    }

    /// Whether `name` is a positional parameter the count reaches, set
    /// even when empty (`set -- ""` sets `$1`).
    pub(super) fn positional_set(&self, name: &[u8]) -> bool {
        if name.is_empty() || !name.iter().all(u8::is_ascii_digit) {
            return false;
        }
        let index: usize = std::str::from_utf8(name)
            .ok()
            .and_then(|n| n.parse().ok())
            .unwrap_or(usize::MAX);
        index == 0 || index <= self.shell.params().len()
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
    fn default_refused(&self, fault: Fault) -> Fault {
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

/// Whether a parameter is a name, which can be assigned, rather than a
/// positional or a special.
fn starts_name(name: &[u8]) -> bool {
    name.first()
        .is_some_and(|b| *b == b'_' || b.is_ascii_alphabetic())
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
