//! `${a[@]}` and `${a[*]}`: an array's or a map's elements, each
//! operator applied per element, and the subscripts that select one.

use super::operators::{bad_transformation, write_refusal};
use super::{
    Braces, Chunk, Expander, Host, Operands, PATTERN_OPS, bad_subscript, discard, ifs_joiner,
    splat, trim_start, within,
};

use crate::interp::write::Fault;
use crate::interp::{listing, quote};
use crate::vars::Indexed;

impl<H: Host> Expander<'_, H> {
    /// The elements a splat walks, by index, with their keys: the
    /// positional parameters for `${@}` and `${*}`, which a slice numbers
    /// from 1 so that index 0 is `$0`; every element of an array by index,
    /// so a slice keeps its indices; an associative array's in sorted-key
    /// order (bash walks its hash order); a scalar as element 0. None for
    /// any other expansion.
    pub(super) fn splat_source(&self, p: &Braces) -> Option<(Indexed, Vec<Vec<u8>>)> {
        let Some(subscript) = &p.subscript else {
            let name = p.name.as_deref()?;
            if name != b"@" && name != b"*" {
                return None;
            }
            let params = self.shell.params().to_vec();
            let keys = (1..=params.len())
                .map(|i| i.to_string().into_bytes())
                .collect();
            if p.op == Some(":") {
                let all = std::iter::once(self.shell.argv0.clone()).chain(params);
                return Some((Indexed::dense(all), keys));
            }
            return Some((Indexed::dense(params), keys));
        };
        if subscript != b"@" && subscript != b"*" {
            return None;
        }
        let var = String::from_utf8_lossy(p.name.as_deref()?).into_owned();
        if let Some(map) = self.shell.vars.assoc(&var) {
            let sorted = map.sorted();
            return Some((
                Indexed::dense(sorted.iter().map(|(_, v)| v.to_vec())),
                sorted.iter().map(|(k, _)| k.to_vec()).collect(),
            ));
        }
        let array = match self.shell.indexed(&var) {
            Some(array) => array.into_owned(),
            None => Indexed::dense(self.shell.vars.scalar(&var).map(<[u8]>::to_vec)),
        };
        let keys = array
            .iter()
            .map(|(i, _)| i.to_string().into_bytes())
            .collect();
        Some((array, keys))
    }

    /// `${#a[@]}` and `${#a[*]}` of a named array: its count, read where
    /// it lives rather than from a copy of its elements.
    pub(super) fn splat_count(&self, p: &Braces) -> Option<usize> {
        let subscript = p.subscript.as_deref().filter(|_| p.length)?;
        if subscript != b"@" && subscript != b"*" {
            return None;
        }
        let var = String::from_utf8_lossy(p.name.as_deref()?).into_owned();
        Some(
            match (self.shell.vars.assoc(&var), self.shell.indexed(&var)) {
                (Some(map), _) => map.len(),
                (None, Some(array)) => array.count(),
                (None, None) => usize::from(self.shell.vars.scalar(&var).is_some()),
            },
        )
    }

    /// A splat: one field per element, whatever the operator. A quoted `*`
    /// joins on IFS's first character. `${#a[@]}` is the count and
    /// `${!a[@]}` the keys; a slice, the per-element value operators and
    /// transformations stay a splat. A conditional operator tests the
    /// elements as one: set when there is any, null when they join to
    /// nothing.
    pub(super) async fn expand_splat(
        &mut self,
        p: &Braces,
        array: Indexed,
        keys: Vec<Vec<u8>>,
        quoted: bool,
        operands: &Operands,
    ) -> Result<Vec<Chunk>, Fault> {
        let star = p.subscript.as_deref().or(p.name.as_deref()) == Some(b"*");
        let joiner = if star {
            ifs_joiner(self.shell.ifs(), self.shell.utf8())
        } else {
            b" ".to_vec()
        };
        let values: Vec<Vec<u8>> = array.iter().map(|(_, v)| v.to_vec()).collect();
        if p.length {
            return Ok(vec![Chunk::value(values.len().to_string(), quoted)]);
        }
        let mut items = values.clone();
        if p.indirect {
            items = keys;
        } else if let Some(op) = p.op {
            match op {
                ":" => {
                    let unset = p.subscript.is_some() && values.is_empty();
                    items = if unset {
                        Vec::new()
                    } else {
                        match self.slice_bounds(p, array.extent(), false).await? {
                            None => Vec::new(),
                            Some((offset, length)) => array
                                .slice(offset, length)
                                .into_iter()
                                .map(<[u8]>::to_vec)
                                .collect(),
                        }
                    };
                }
                "@" => {
                    let Some(letter) = operands.letter else {
                        if values.is_empty() {
                            return Ok(Vec::new());
                        }
                        return Err(bad_transformation(
                            self.shell.vars.voice(),
                            trim_start(self.text(p.node)),
                        ));
                    };
                    let var =
                        String::from_utf8_lossy(p.name.as_deref().unwrap_or_default()).into_owned();
                    let whole = p.subscript.is_some();
                    let array =
                        self.shell.indexed(&var).is_some() || self.shell.vars.assoc(&var).is_some();
                    match letter {
                        b'A' if whole && array && star => {
                            return Ok(vec![Chunk::value(self.array_assignment(&var), quoted)]);
                        }
                        b'A' if whole && array => {
                            items = self
                                .array_assignment(&var)
                                .splitn(3, |b| *b == b' ')
                                .map(<[u8]>::to_vec)
                                .collect();
                        }
                        b'K' if whole => {
                            return Ok(vec![Chunk::value(
                                self.key_values(&var, &keys, &values),
                                quoted,
                            )]);
                        }
                        b'k' if whole => {
                            items = keys
                                .iter()
                                .zip(&values)
                                .flat_map(|(k, v)| [k.clone(), v.clone()])
                                .collect();
                        }
                        _ => {
                            items = values
                                .iter()
                                .filter_map(|v| self.transform(letter, &var, v, true))
                                .collect();
                        }
                    }
                }
                op if PATTERN_OPS.contains(&op) => {
                    items.clear();
                    for value in &values {
                        items.push(self.value_op(op, value, operands).await?);
                    }
                }
                _ => {
                    let triggered = if matches!(op, "-" | "+" | "=" | "?") {
                        values.is_empty()
                    } else {
                        values.join(joiner.as_slice()).is_empty()
                    };
                    if matches!(op, "+" | ":+") {
                        if triggered {
                            return Ok(if values.is_empty() {
                                Vec::new()
                            } else {
                                splat(&[Vec::new()], &joiner, quoted)
                            });
                        }
                        return Ok(word_result(self.operator_word(p, quoted).await?, quoted));
                    }
                    if triggered && matches!(op, "-" | ":-") {
                        return Ok(word_result(self.operator_word(p, quoted).await?, quoted));
                    }
                    if triggered && matches!(op, "?" | ":?") {
                        return Err(self.unset_error(p).await?);
                    }
                    if triggered && p.subscript.is_some() {
                        return Err(bad_subscript(self.shell.vars.voice(), p));
                    }
                    if triggered {
                        let name = String::from_utf8_lossy(p.name.as_deref().unwrap_or_default());
                        return Err(discard(
                            self.shell.vars.voice(),
                            &format!("${name}: cannot assign in this way\n"),
                        ));
                    }
                }
            }
        }
        if star && quoted {
            return Ok(vec![Chunk::value(items.join(joiner.as_slice()), true)]);
        }
        Ok(splat(&items, &joiner, quoted))
    }

    /// `${a[@]@A}`: the declaration that recreates the array, which `[@]`
    /// hands out as three words (`declare`, `-a`, `a=(...)`) and `[*]` as
    /// one, as bash does; one never assigned has no `=(...)`.
    fn array_assignment(&self, name: &str) -> Vec<u8> {
        let vars = &self.shell.vars;
        let target = vars.deref(name);
        if let Some(var) = listing::computed(vars, &target) {
            return listing::line(&target, &var);
        }
        match vars.visible(name) {
            Some(var) => listing::line(name, var),
            None => format!("declare -- {name}").into_bytes(),
        }
    }

    /// `${a[@]@K}`: keys and values as one word, each value quoted, an
    /// associative array's ending in a space as bash prints it.
    fn key_values(&self, name: &str, keys: &[Vec<u8>], values: &[Vec<u8>]) -> Vec<u8> {
        let assoc = self.shell.vars.assoc(name).is_some();
        let parts: Vec<Vec<u8>> = keys
            .iter()
            .zip(values)
            .map(|(key, value)| {
                let key = if assoc { quote::key(key) } else { key.clone() };
                [key, b" ".to_vec(), quote::declare(value)].concat()
            })
            .collect();
        let mut out = parts.join(&b' ');
        if assoc && !parts.is_empty() {
            out.push(b' ');
        }
        out
    }

    /// The key a subscript spells, or the text its index evaluates: one
    /// with no expansion, quote or escape as typed, spaces included
    /// (`m[ k ]`); any other expanded where it stands, the text between
    /// its parts kept (`m[$k  $k]`, `a[$i + 1]`). A subscript a reference
    /// named (`r='m[$k]'; ${!r}`) reads as typed in `${x[...]}`.
    pub(super) async fn subscript_key(&mut self, p: &Braces) -> Result<Vec<u8>, Fault> {
        let subscript = p.subscript.clone().unwrap_or_default();
        if !subscript.iter().any(|b| b"$`'\"\\".contains(b)) {
            return Ok(subscript);
        }
        let expanded = if p.subscript_nodes.is_empty() {
            Box::pin(self.subscript_text(&subscript)).await
        } else {
            let (start, stop) = p.subscript_span;
            self.substituted(start, stop, p.subscript_nodes.clone())
                .await
        };
        expanded.map_err(|fault| within(fault, &subscript, true))
    }

    /// A subscript given as text (`unset 'a[$i]'`, `r='m[$k]'`),
    /// expanded as one typed in `${x[...]}` is.
    async fn subscript_text(&mut self, text: &[u8]) -> Result<Vec<u8>, Fault> {
        let mut source = b"${x[".to_vec();
        source.extend_from_slice(text);
        source.extend_from_slice(b"]}");
        let tree = crate::shell::parse(&source);
        self.over(&tree).subscript(0).await
    }

    /// An expander over another tree with this one's shell, host and
    /// diagnostics, for a text read anew as the line runs.
    pub(super) fn over<'t>(&'t mut self, tree: &'t crate::shell::Tree) -> Expander<'t, H> {
        Expander {
            shell: &mut *self.shell,
            host: &mut *self.host,
            tree,
            diagnostics: &mut *self.diagnostics,
            room: self.room,
        }
    }

    /// The subscript of the first `${x[...]}` at or under `node`, expanded
    /// as its key or index text is; a source that reads as none, or reads
    /// it with no parts, is the text between `${x[` and `]}` as typed.
    pub async fn subscript(&mut self, node: usize) -> Result<Vec<u8>, Fault> {
        let found = (node..self.tree.nodes.len()).find(|&n| self.kind(n) == "expansion");
        if let Some(p) = found.map(|n| self.parse_braces(n)) {
            if p.name.as_deref() == Some(b"x") && !p.subscript_nodes.is_empty() {
                let (start, stop) = p.subscript_span;
                return self.substituted(start, stop, p.subscript_nodes).await;
            }
        }
        let source = &self.tree.source;
        Ok(source
            .get(4..source.len().saturating_sub(2))
            .unwrap_or_default()
            .to_vec())
    }

    /// An index in the expansion's voice: what it assigns lands first.
    pub(super) async fn expansion_index(&mut self, subscript: &[u8]) -> Result<i64, Fault> {
        self.writer()
            .subscript_index(subscript)
            .map_err(|fault| write_refusal(self.shell.vars.voice(), fault))
    }
}

/// An operator's word standing in for a quoted splat yields that word even
/// when empty: `"${e[@]:-}"` is one empty word where `"${e[@]}"` is none.
fn word_result(chunks: Vec<Chunk>, quoted: bool) -> Vec<Chunk> {
    if quoted {
        std::iter::once(Chunk::quoted(Vec::new()))
            .chain(chunks)
            .collect()
    } else {
        chunks
    }
}
