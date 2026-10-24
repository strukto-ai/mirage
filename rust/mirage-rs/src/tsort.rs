use std::collections::{BTreeMap, HashMap, VecDeque, btree_map};

use serde::Deserialize;

use crate::{Stream, StreamError, parse_config};

/// The most a call does: names ranked, pairs linked or names placed.
const STEPS: usize = 1 << 14;
/// The most the graph may take: GNU runs out of memory past what it can
/// get.
#[cfg(not(test))]
const MAX_HELD: usize = 1 << 30;
#[cfg(test)]
const MAX_HELD: usize = 1 << 12;
/// What a name and a pair take besides a name's bytes, about.
const NAME_COST: usize = 64;
const PAIR_COST: usize = 32;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    /// The input as tsort's messages name it.
    #[serde(deserialize_with = "crate::latin1")]
    name: Vec<u8>,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let Config { name } = parse_config(config)?;
    Ok(Box::new(Tsort {
        name,
        ..Tsort::default()
    }))
}

#[derive(Default)]
enum Phase {
    #[default]
    Read,
    /// Numbering the names in byte order.
    Rank(btree_map::IntoIter<Box<[u8]>, u32>),
    Link(usize),
    Seed(usize),
    Order,
    Done,
}

/// GNU tsort 9.7, its order measured on 10,000 random inputs: the names
/// nothing has to precede go first, in byte order, then each name as soon
/// as every name that must precede it is out, a name's own followers taken
/// newest pair first. When every name left still waits on another, one
/// loop is reported and cut: stepping back from the smallest name left,
/// each step takes the name before it that sorts next after it (wrapping
/// round to the smallest), and the first name met twice closes the loop.
/// The loop is listed from the last step forward and the pair that closed
/// it is dropped, which may free the first name listed; if it does not,
/// the next loop is found the same way. A token is split at spaces, tabs
/// and newlines alone, and a name ends at a NUL.
#[derive(Default)]
struct Tsort {
    name: Vec<u8>,
    /// A token the input has not ended yet.
    token: Vec<u8>,
    /// Each name and the number it was first read as.
    ids: BTreeMap<Box<[u8]>, u32>,
    pairs: Vec<(u32, u32)>,
    /// A pair's first name, while its second is unread.
    first: Option<u32>,
    held: usize,
    phase: Phase,
    // By rank: the name, its rank by number, the names after it, the
    // pairs before it (counted by name) and how many of them are left.
    names: Vec<Box<[u8]>>,
    rank: Vec<u32>,
    followers: Vec<Vec<u32>>,
    leaders: Vec<BTreeMap<u32, u32>>,
    waiting: Vec<u32>,
    ready: VecDeque<u32>,
    /// The name being placed, and its followers left to release, newest
    /// last.
    placing: u32,
    after: Vec<u32>,
    /// A loop's walk back so far, each name and where it was met.
    trail: Vec<u32>,
    met: HashMap<u32, usize>,
    /// No name below this rank is left: with none ready, a name waiting
    /// on none is out.
    lowest: usize,
    status: i32,
    stderr: Vec<u8>,
}

impl Tsort {
    fn take(&mut self, token: &[u8]) {
        let name = token.split(|&b| b == 0).next().unwrap_or_default();
        let fresh = u32::try_from(self.ids.len()).unwrap_or(u32::MAX);
        let id = *self.ids.entry(name.into()).or_insert_with(|| {
            self.held += name.len() + NAME_COST;
            fresh
        });
        match self.first.take() {
            Some(first) => {
                self.pairs.push((first, id));
                self.held += PAIR_COST;
            }
            None => self.first = Some(id),
        }
    }

    fn fail(&mut self, message: &[u8]) {
        self.stderr.extend_from_slice(message);
        self.status = 1;
        self.phase = Phase::Done;
    }

    fn release(&mut self, first: u32, then: u32) {
        let leaders = &mut self.leaders[then as usize];
        if let Some(count) = leaders.get_mut(&first) {
            *count -= 1;
            if *count == 0 {
                leaders.remove(&first);
            }
        }
        self.waiting[then as usize] -= 1;
        if self.waiting[then as usize] == 0 {
            self.ready.push_back(then);
        }
    }

    /// One step back along a loop from `here`, or the loop's report and
    /// cut once a name is met twice.
    fn walk(&mut self, here: u32) {
        let before = &self.leaders[here as usize];
        let next = before
            .range(here + 1..)
            .next()
            .or_else(|| before.iter().next());
        let Some((&step, _)) = next else {
            self.phase = Phase::Done;
            return;
        };
        let Some(&at) = self.met.get(&step) else {
            self.met.insert(step, self.trail.len());
            self.trail.push(step);
            return;
        };
        let mut found = self.trail.split_off(at);
        found.reverse();
        self.stderr.extend_from_slice(b"tsort: ");
        self.stderr.extend_from_slice(&self.name);
        self.stderr.extend_from_slice(b": input contains a loop:\n");
        for &member in &found {
            self.stderr.extend_from_slice(b"tsort: ");
            self.stderr.extend_from_slice(&self.names[member as usize]);
            self.stderr.push(b'\n');
        }
        self.status = 1;
        self.trail.clear();
        self.met.clear();
        self.release(found[found.len() - 1], found[0]);
    }

    /// Place names until none is ready, reporting and cutting a loop when
    /// every name left waits, a step at a time.
    fn order(&mut self, out: &mut Vec<u8>) {
        for _ in 0..STEPS {
            if let Some(then) = self.after.pop() {
                if self.leaders[then as usize].contains_key(&self.placing) {
                    self.release(self.placing, then);
                }
            } else if let Some(&here) = self.trail.last() {
                self.walk(here);
            } else if let Some(name) = self.ready.pop_front() {
                out.extend_from_slice(&self.names[name as usize]);
                out.push(b'\n');
                self.placing = name;
                self.after = std::mem::take(&mut self.followers[name as usize]);
            } else if self.waiting.get(self.lowest) == Some(&0) {
                self.lowest += 1;
            } else if self.lowest == self.names.len() {
                self.phase = Phase::Done;
            } else {
                let start = self.lowest as u32;
                self.walk(start);
            }
            if matches!(self.phase, Phase::Done) {
                return;
            }
        }
    }
}

impl Stream for Tsort {
    fn feed(&mut self, input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut rest = input;
        while matches!(self.phase, Phase::Read) && !rest.is_empty() {
            let len = rest
                .iter()
                .position(|&b| matches!(b, b' ' | b'\t' | b'\n'))
                .unwrap_or(rest.len());
            let (word, after) = rest.split_at(len);
            if after.is_empty() {
                self.token.extend_from_slice(word);
                self.held += word.len();
            } else if self.token.is_empty() {
                if !word.is_empty() {
                    self.take(word);
                }
            } else {
                self.token.extend_from_slice(word);
                let token = std::mem::take(&mut self.token);
                self.held -= token.len() - word.len();
                self.take(&token);
            }
            if self.held > MAX_HELD {
                self.fail(b"tsort: memory exhausted\n");
            }
            rest = after.get(1..).unwrap_or_default();
        }
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.end_input(0, out)
    }

    /// The host reads the input as one of a multi-input stream's, which
    /// leaves the stream open for its status.
    fn wants(&self) -> Option<usize> {
        matches!(self.phase, Phase::Read).then_some(0)
    }

    fn end_input(&mut self, _index: usize, _out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !matches!(self.phase, Phase::Read) {
            return Ok(());
        }
        let token = std::mem::take(&mut self.token);
        if !token.is_empty() {
            self.take(&token);
        }
        if self.first.is_some() {
            let mut message = b"tsort: ".to_vec();
            message.extend_from_slice(&self.name);
            message.extend_from_slice(b": input contains an odd number of tokens\n");
            self.fail(&message);
            return Ok(());
        }
        let count = self.ids.len();
        self.rank = vec![0; count];
        self.names = Vec::with_capacity(count);
        self.phase = Phase::Rank(std::mem::take(&mut self.ids).into_iter());
        Ok(())
    }

    fn busy(&self) -> bool {
        !matches!(self.phase, Phase::Read | Phase::Done)
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        match &mut self.phase {
            Phase::Rank(names) => {
                for (name, id) in names.by_ref().take(STEPS) {
                    self.rank[id as usize] = self.names.len() as u32;
                    self.names.push(name);
                }
                if self.names.len() == self.rank.len() {
                    let count = self.names.len();
                    self.followers = vec![Vec::new(); count];
                    self.leaders = vec![BTreeMap::new(); count];
                    self.waiting = vec![0; count];
                    self.phase = Phase::Link(0);
                }
            }
            Phase::Link(at) => {
                let to = (*at + STEPS).min(self.pairs.len());
                for &(first, then) in &self.pairs[*at..to] {
                    let (first, then) = (self.rank[first as usize], self.rank[then as usize]);
                    if first != then {
                        self.followers[first as usize].push(then);
                        *self.leaders[then as usize].entry(first).or_insert(0) += 1;
                        self.waiting[then as usize] += 1;
                    }
                }
                *at = to;
                if to == self.pairs.len() {
                    self.pairs = Vec::new();
                    self.rank = Vec::new();
                    self.phase = Phase::Seed(0);
                }
            }
            Phase::Seed(at) => {
                let to = (*at + STEPS).min(self.names.len());
                let free = (*at..to).filter(|&name| self.waiting[name] == 0);
                self.ready.extend(free.map(|name| name as u32));
                *at = to;
                if to == self.names.len() {
                    self.phase = Phase::Order;
                }
            }
            Phase::Order => self.order(out),
            Phase::Read | Phase::Done => {}
        }
        Ok(())
    }

    fn status(&self) -> i32 {
        self.status
    }

    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        err.append(&mut self.stderr);
    }
}

#[cfg(test)]
mod tests {
    use crate::{drain_all, open};

    #[test]
    fn a_graph_past_what_it_may_hold_runs_out_of_memory() {
        let names: Vec<u8> = (0..200)
            .flat_map(|n| format!("n{n} n{}\n", n + 1).into_bytes())
            .collect();
        let mut stream = open("tsort", br#"{"name":"-"}"#).expect("opens");
        let mut out = Vec::new();
        stream.feed(&names, &mut out).expect("feeds");
        stream.finish(&mut out).expect("finishes");
        drain_all(stream.as_mut(), &mut out);
        let mut err = Vec::new();
        stream.take_stderr(&mut err);
        assert_eq!((out.as_slice(), stream.status()), (b"".as_slice(), 1));
        assert_eq!(err, b"tsort: memory exhausted\n");
    }
}
