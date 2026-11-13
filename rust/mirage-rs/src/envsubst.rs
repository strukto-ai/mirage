use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use serde::Deserialize;

use crate::{
    Stream, StreamError,
    constants::{OUTPUT, WORK},
    parse_config,
};

const MAX_REFERENCE: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(default, deserialize_with = "crate::latin1_list")]
    args: Vec<Vec<u8>>,
    #[serde(default)]
    variables: bool,
    #[serde(default)]
    env: BTreeMap<String, Value>,
    #[serde(default, deserialize_with = "crate::latin1_list")]
    names: Vec<Vec<u8>>,
}

#[derive(Deserialize)]
struct Value(#[serde(deserialize_with = "crate::latin1")] Vec<u8>);

fn name_start(b: u8) -> bool {
    b.is_ascii_alphabetic() || b == b'_'
}
fn name_part(b: u8) -> bool {
    name_start(b) || b.is_ascii_digit()
}

fn reference(data: &[u8], start: usize) -> Option<(Range<usize>, usize)> {
    let mut at = start + 1;
    let braced = data.get(at) == Some(&b'{');
    at += usize::from(braced);
    let name = at;
    if !data.get(at).is_some_and(|b| name_start(*b)) {
        return None;
    }
    at += 1;
    while data.get(at).is_some_and(|b| name_part(*b)) {
        at += 1;
    }
    let end = at;
    if braced {
        if data.get(at) != Some(&b'}') {
            return None;
        }
        at += 1;
    }
    Some((name..end, at))
}

fn names(format: &[u8]) -> impl Iterator<Item = &[u8]> {
    let mut at = 0;
    std::iter::from_fn(move || {
        while let Some(found) = memchr::memchr(b'$', &format[at..]) {
            let start = at + found;
            at = start + 1;
            if let Some((name, end)) = reference(format, start) {
                at = end;
                return Some(&format[name]);
            }
        }
        None
    })
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let Config {
        args,
        variables,
        env,
        names: available,
    } = parse_config(config)?;
    if args.len() > 1 {
        return Err(StreamError::new("envsubst: too many arguments"));
    }
    let format = args.first();
    if variables && format.is_none() {
        return Err(StreamError::new("envsubst: missing arguments"));
    }
    let selected = if variables {
        None
    } else {
        format.map(|text| names(text).map(<[u8]>::to_vec).collect())
    };
    let mut listing = Vec::new();
    if variables {
        for name in names(format.map_or(&[], Vec::as_slice)) {
            listing.extend_from_slice(name);
            listing.push(b'\n');
        }
    }
    let mut values = Vec::new();
    let bindings = env
        .into_iter()
        .map(|(key, value)| {
            let index = values.len();
            values.push(value.0);
            (key.into_bytes(), index)
        })
        .collect();
    Ok(Box::new(Envsubst {
        selected,
        available: available.into_iter().collect(),
        pending: Pending::Idle,
        bindings,
        values,
        variables,
        ready: listing.len(),
        input: listing,
        held: Vec::new(),
        at: 0,
        value: None,
        ended: false,
    }))
}

enum Pending {
    Idle,
    Ready(Vec<Vec<u8>>),
    Sent(Vec<Vec<u8>>),
}

struct Envsubst {
    available: BTreeSet<Vec<u8>>,
    pending: Pending,
    selected: Option<BTreeSet<Vec<u8>>>,
    bindings: BTreeMap<Vec<u8>, usize>,
    values: Vec<Vec<u8>>,
    variables: bool,
    input: Vec<u8>,
    ready: usize,
    held: Vec<u8>,
    at: usize,
    value: Option<(usize, usize)>,
    ended: bool,
}

impl Envsubst {
    fn prepare(&mut self, input: &[u8], end: bool) {
        self.input.drain(..self.at);
        self.input.append(&mut self.held);
        self.input.extend_from_slice(input);
        self.at = 0;
        self.ready = if end {
            self.input.len()
        } else {
            memchr::memrchr(b'$', &self.input)
                .filter(|at| {
                    let tail = &self.input[*at + 1..];
                    let tail = tail.strip_prefix(b"{").unwrap_or(tail);
                    self.input.len() - *at <= MAX_REFERENCE && tail.iter().all(|b| name_part(*b))
                })
                .unwrap_or(self.input.len())
        };
        self.held.extend_from_slice(&self.input[self.ready..]);
        self.input.truncate(self.ready);
    }

    fn pump(&mut self, out: &mut Vec<u8>) {
        if !matches!(self.pending, Pending::Idle) {
            return;
        }
        let limit = out.len().saturating_add(OUTPUT);
        let mut work = 0;
        while out.len() < limit && work < WORK {
            if let Some((index, offset)) = self.value {
                let value = &self.values[index];
                let count = (value.len() - offset).min(limit - out.len());
                out.extend_from_slice(&value[offset..offset + count]);
                self.value = (offset + count < value.len()).then_some((index, offset + count));
                work += 1;
                continue;
            }
            if self.at == self.ready {
                break;
            }
            let next = if self.variables {
                self.ready
            } else {
                memchr::memchr(b'$', &self.input[self.at..]).map_or(self.ready, |n| self.at + n)
            };
            if next > self.at {
                let count = (next - self.at).min(limit - out.len()).min(WORK - work);
                out.extend_from_slice(&self.input[self.at..self.at + count]);
                self.at += count;
                work += count;
                continue;
            }
            if let Some((name, end)) = reference(&self.input, self.at) {
                if self
                    .selected
                    .as_ref()
                    .is_none_or(|set| set.contains(&self.input[name.clone()]))
                {
                    if self.available.contains(&self.input[name.clone()])
                        && !self.bindings.contains_key(&self.input[name.clone()])
                    {
                        let needed: BTreeSet<Vec<u8>> = names(&self.input[self.at..])
                            .filter(|name| {
                                self.available.contains(*name)
                                    && !self.bindings.contains_key(*name)
                                    && self.selected.as_ref().is_none_or(|set| set.contains(*name))
                            })
                            .map(<[u8]>::to_vec)
                            .collect();
                        self.pending = Pending::Ready(needed.into_iter().collect());
                        return;
                    }
                    self.value = self
                        .bindings
                        .get(&self.input[name])
                        .copied()
                        .map(|index| (index, 0));
                    work += end - self.at;
                    self.at = end;
                    continue;
                }
            }
            out.push(self.input[self.at]);
            self.at += 1;
            work += 1;
        }
    }
}

impl Stream for Envsubst {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !self.variables {
            self.prepare(input, false);
        }
        self.pump(out);
        Ok(())
    }
    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !self.variables && !self.ended {
            self.prepare(&[], true);
        }
        self.ended = true;
        self.pump(out);
        Ok(())
    }
    fn busy(&self) -> bool {
        matches!(self.pending, Pending::Idle) && (self.at < self.ready || self.value.is_some())
    }
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.pump(out);
        Ok(())
    }
    fn request(&mut self, _data: &mut Vec<u8>) -> Option<Vec<u8>> {
        match std::mem::replace(&mut self.pending, Pending::Idle) {
            Pending::Ready(names) => {
                let header = serde_json::json!({"op":"env", "names":names.iter().map(|name| crate::byte_text(name)).collect::<Vec<_>>()});
                self.pending = Pending::Sent(names);
                Some(header.to_string().into_bytes())
            }
            other => {
                self.pending = other;
                None
            }
        }
    }
    fn respond(
        &mut self,
        reply: &[u8],
        _data: &[u8],
        out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Reply {
            env: BTreeMap<String, Value>,
        }
        let mut reply: Reply = parse_config(reply)?;
        let Pending::Sent(names) = std::mem::replace(&mut self.pending, Pending::Idle) else {
            return Err(StreamError::new("envsubst: unexpected environment reply"));
        };
        for name in names {
            let value = reply
                .env
                .remove(&crate::byte_text(&name))
                .ok_or_else(|| StreamError::new("envsubst: missing environment value"))?;
            self.bindings.insert(name, self.values.len());
            self.values.push(value.0);
        }
        self.pump(out);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::run;

    #[test]
    fn values_are_requested_in_batches_and_cached() {
        let mut stream = open(br#"{"names":["X","UNUSED"]}"#).unwrap();
        let mut out = Vec::new();
        stream.feed(b"$X $X!", &mut out).unwrap();
        let request = stream.request(&mut Vec::new()).unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&request).unwrap(),
            serde_json::json!({"op":"env","names":["X"]})
        );
        stream
            .respond(br#"{"env":{"X":"\u00ff"}}"#, &[], &mut out)
            .unwrap();
        assert_eq!(out, b"\xff \xff!");
        out.clear();
        stream.feed(b"$X!", &mut out).unwrap();
        assert_eq!(out, b"\xff!");
        assert!(stream.request(&mut Vec::new()).is_none());
        let mut empty = open(br#"{"args":[""],"names":["UNUSED"]}"#).unwrap();
        out.clear();
        empty.feed(b"$UNUSED!", &mut out).unwrap();
        assert_eq!(out, b"$UNUSED!");
        assert!(empty.request(&mut Vec::new()).is_none());
    }

    #[test]
    fn references_and_raw_values_survive_every_split() {
        let input = b"$X ${X} $MISSING ${ $1 $$ ${X";
        for split in 0..=input.len() {
            let (out, error) = run(
                "envsubst",
                r#"{"env":{"X":"\u00ff"}}"#,
                &[&input[..split], &input[split..]],
            );
            assert_eq!(out, b"\xff \xff  ${ $1 $$ ${X");
            assert!(error.is_none());
        }
    }

    #[test]
    fn selected_names_and_listing_share_the_reference_grammar() {
        assert_eq!(
            run(
                "envsubst",
                r#"{"args":["$Y"],"env":{"X":"1","Y":"2"}}"#,
                &[b"$X ${Y} $MISSING"]
            )
            .0,
            b"$X 2 $MISSING"
        );
        assert_eq!(
            run(
                "envsubst",
                r#"{"args":["a $X ${Y} $X"],"variables":true}"#,
                &[]
            )
            .0,
            b"X\nY\nX\n"
        );
        assert_eq!(
            run("envsubst", r#"{"args":[""],"env":{"X":"1"}}"#, &[b"$X"]).0,
            b"$X"
        );
        assert_eq!(
            open(br#"{"variables":true}"#).err().unwrap().message,
            "envsubst: missing arguments"
        );
        assert_eq!(
            open(br#"{"args":["a","b"]}"#).err().unwrap().message,
            "envsubst: too many arguments"
        );
    }

    #[test]
    fn expansion_and_listing_output_are_bounded() {
        let config = serde_json::json!({"env":{"X":"z".repeat(100000)}}).to_string();
        let mut stream = open(config.as_bytes()).unwrap();
        let mut piece = Vec::new();
        let mut output = Vec::new();
        stream.feed(b"${X}", &mut piece).unwrap();
        loop {
            assert!(piece.len() <= OUTPUT);
            output.append(&mut piece);
            if !stream.busy() {
                break;
            }
            stream.drain(&mut piece).unwrap();
        }
        assert_eq!(output, vec![b'z'; 100000]);
        let format = "$X ".repeat(20000);
        let config = serde_json::json!({"args":[format],"variables":true}).to_string();
        let mut listing = open(config.as_bytes()).unwrap();
        listing.finish(&mut piece).unwrap();
        let mut count = piece.len();
        while listing.busy() {
            piece.clear();
            listing.drain(&mut piece).unwrap();
            assert!(piece.len() <= OUTPUT);
            count += piece.len();
        }
        assert_eq!(count, 40000);
    }

    #[test]
    fn the_unfinished_name_cap_matches_chunk_boundaries() {
        let mut input = vec![b'$'];
        input.extend(std::iter::repeat_n(b'X', MAX_REFERENCE + 4));
        input.push(b'!');
        assert_eq!(run("envsubst", "{}", &[&input]).0, b"!");
        let chunks = [&input[..MAX_REFERENCE + 1], &input[MAX_REFERENCE + 1..]];
        assert_eq!(run("envsubst", "{}", &chunks).0, b"XXXX!");
    }
}
