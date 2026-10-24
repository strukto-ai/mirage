use serde::Deserialize;

use crate::records::{Records, Take};
use crate::{Stream, StreamError, parse_config};

/// Output is handed on in pieces of about this size while two groups of
/// equal keys print their product.
const CHUNK: usize = 1 << 16;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Order {
    Warn,
    Fail,
    Off,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    /// Each file's join field, counted from 0.
    keys: [u64; 2],
    /// Whether each file's unpairable lines print (`-a`, `-v`).
    unpaired: [bool; 2],
    /// Whether joined lines print; any `-v` clears it.
    paired: bool,
    #[serde(deserialize_with = "crate::latin1_opt")]
    filler: Option<Vec<u8>>,
    /// The `-o` list: a file number and a field counted from 0, file 0
    /// standing for the join field.
    columns: Vec<[u64; 2]>,
    auto_columns: bool,
    /// The `-t` byte; none parts fields at runs of blanks, and a newline
    /// keeps each record whole.
    #[serde(deserialize_with = "crate::latin1_opt")]
    delimiter: Option<Vec<u8>>,
    #[serde(deserialize_with = "crate::latin1")]
    separator: Vec<u8>,
    fold_case: bool,
    zero_terminated: bool,
    order: Order,
    header: bool,
    /// Each operand as typed, for the order diagnostics.
    #[serde(deserialize_with = "crate::latin1_list")]
    names: Vec<Vec<u8>>,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    if config.names.len() != 2 || config.delimiter.as_ref().is_some_and(|d| d.len() != 1) {
        return Err(StreamError::new("join takes two names and a one-byte tab"));
    }
    let layout = (!config.columns.is_empty()).then(|| config.columns.clone());
    Ok(Box::new(Join {
        terminator: if config.zero_terminated { 0 } else { b'\n' },
        sides: [0, 1].map(|n| Side {
            key: config.keys[n],
            shown: config.unpaired[n],
            input: Records::default(),
            count: 0,
            last: None,
            reported: false,
            line: None,
        }),
        config,
        layout,
        phase: Phase::Open(0),
        lone_seen: false,
        stderr: Vec::new(),
        status: 0,
    }))
}

struct Line {
    text: Vec<u8>,
    fields: Vec<(usize, usize)>,
    key: (usize, usize),
    rank: Vec<u8>,
}

impl Line {
    fn field(&self, (start, end): (usize, usize)) -> &[u8] {
        &self.text[start..end]
    }

    fn key(&self) -> &[u8] {
        self.field(self.key)
    }
}

struct Side {
    key: u64,
    shown: bool,
    input: Records,
    count: u64,
    last: Option<Vec<u8>>,
    reported: bool,
    line: Option<Line>,
}

/// Where the walk is: each phase that reads waits there for its input.
enum Phase {
    /// Taking each file's first record.
    Open(usize),
    /// Taking each file's first record after the header lines.
    AfterHeader(usize),
    Compare,
    /// Taking the next record of the file whose line went unpaired.
    Unpaired(usize),
    /// Gathering each file's run of records with the key `rank`.
    Group {
        side: usize,
        rank: Vec<u8>,
        groups: Vec<Vec<Line>>,
    },
    /// Printing the product of two groups, at pair `(i, j)`.
    Pairs {
        groups: [Vec<Line>; 2],
        i: usize,
        j: usize,
    },
    /// Past the other file's end, reading on only to print or check order.
    Tail(usize),
    /// Taking the next record there.
    TailRead(usize),
    Done,
}

enum Advance {
    Taken,
    Wait,
    Halt,
}

/// GNU join's walk of two sorted inputs, which `wants` names one at a time,
/// keys compared byte by byte (upper-cased in ASCII under -i). A record
/// whose key sorts before the one above it is named under --check-order,
/// which stops there, and by default only once some line has gone
/// unpaired, once per file and closing with `input is not in sorted order`.
struct Join {
    config: Config,
    terminator: u8,
    sides: [Side; 2],
    layout: Option<Vec<[u64; 2]>>,
    phase: Phase,
    lone_seen: bool,
    stderr: Vec<u8>,
    status: i32,
}

impl Join {
    /// Without -t a field is a run of bytes other than space and tab, and
    /// under -z a newline parts fields too; every other byte, \v, \f and
    /// \r included, belongs to a field.
    fn split(&self, side: usize, text: Vec<u8>) -> Line {
        let mut fields = Vec::new();
        match self.config.delimiter.as_deref() {
            _ if text.is_empty() => {}
            None => {
                let blank = |b: u8| b == b' ' || b == b'\t' || (b == b'\n' && self.terminator == 0);
                let mut at = 0;
                while at < text.len() {
                    if blank(text[at]) {
                        at += 1;
                        continue;
                    }
                    let start = at;
                    while at < text.len() && !blank(text[at]) {
                        at += 1;
                    }
                    fields.push((start, at));
                }
            }
            Some(b"\n") => fields.push((0, text.len())),
            Some(delimiter) => {
                let mut start = 0;
                for at in memchr::memchr_iter(delimiter[0], &text) {
                    fields.push((start, at));
                    start = at + 1;
                }
                fields.push((start, text.len()));
            }
        }
        let key = usize::try_from(self.sides[side].key)
            .ok()
            .and_then(|k| fields.get(k).copied())
            .unwrap_or((0, 0));
        let mut rank = text[key.0..key.1].to_vec();
        if self.config.fold_case {
            rank.make_ascii_uppercase();
        }
        Line {
            text,
            fields,
            key,
            rank,
        }
    }

    fn advance(&mut self, side: usize) -> Advance {
        let line = match self.sides[side].input.next(self.terminator) {
            Take::Wait => return Advance::Wait,
            Take::End => {
                self.sides[side].line = None;
                return Advance::Taken;
            }
            Take::Record(text) => text,
        };
        self.sides[side].count += 1;
        let line = self.split(side, line);
        let disordered = self.sides[side]
            .last
            .as_ref()
            .is_some_and(|last| line.rank < *last);
        if disordered && self.config.order != Order::Off && self.out_of_order(side, &line) {
            return Advance::Halt;
        }
        let state = &mut self.sides[side];
        state.last = Some(line.rank.clone());
        state.line = Some(line);
        Advance::Taken
    }

    fn out_of_order(&mut self, side: usize, line: &Line) -> bool {
        let state = &mut self.sides[side];
        if self.config.order == Order::Warn && (state.reported || !self.lone_seen) {
            return false;
        }
        let shown = line.text.split(|b| *b == 0).next().unwrap_or_default();
        self.stderr.extend_from_slice(b"join: ");
        self.stderr.extend_from_slice(&self.config.names[side]);
        self.stderr
            .extend_from_slice(format!(":{}: is not sorted: ", state.count).as_bytes());
        self.stderr.extend_from_slice(shown);
        self.stderr.push(b'\n');
        self.status = 1;
        state.reported = true;
        self.config.order == Order::Fail
    }

    fn still_reading(&self, side: usize) -> bool {
        let state = &self.sides[side];
        state.shown
            || self.config.order == Order::Fail
            || (self.config.order == Order::Warn && !state.reported)
    }

    fn settle_layout(&mut self) {
        if self.layout.is_some() || !self.config.auto_columns {
            return;
        }
        let mut layout = vec![[0, 0]];
        for (number, side) in self.sides.iter().enumerate() {
            let count = side.line.as_ref().map_or(0, |line| line.fields.len());
            layout.extend(
                (0..count as u64)
                    .filter(|i| *i != side.key)
                    .map(|i| [number as u64 + 1, i]),
            );
        }
        self.layout = Some(layout);
    }

    fn print(&self, values: &[&[u8]], out: &mut Vec<u8>) {
        for (n, value) in values.iter().enumerate() {
            if n > 0 {
                out.extend_from_slice(&self.config.separator);
            }
            match &self.config.filler {
                Some(filler) if value.is_empty() => out.extend_from_slice(filler),
                _ => out.extend_from_slice(value),
            }
        }
        out.push(self.terminator);
    }

    fn others<'a>(&self, line: &'a Line, side: usize) -> impl Iterator<Item = &'a [u8]> {
        let skip = self.sides[side].key;
        line.fields
            .iter()
            .enumerate()
            .filter(move |(i, _)| *i as u64 != skip)
            .map(|(_, span)| line.field(*span))
    }

    fn pick<'a>(&self, lines: [Option<&'a Line>; 2], key: &'a [u8]) -> Vec<&'a [u8]> {
        let layout = self.layout.as_deref().unwrap_or_default();
        layout
            .iter()
            .map(|[number, index]| match number {
                0 => key,
                _ => lines[(*number - 1) as usize]
                    .and_then(|line| {
                        let index = usize::try_from(*index).ok()?;
                        line.fields.get(index).map(|span| line.field(*span))
                    })
                    .unwrap_or_default(),
            })
            .collect()
    }

    /// A joined line shows FILE1's spelling of the key, as -i joins `a`
    /// with `A`.
    fn print_pair(&self, left: &Line, right: &Line, out: &mut Vec<u8>) {
        let values: Vec<&[u8]> = if self.layout.is_none() {
            std::iter::once(left.key())
                .chain(self.others(left, 0))
                .chain(self.others(right, 1))
                .collect()
        } else {
            self.pick([Some(left), Some(right)], left.key())
        };
        self.print(&values, out);
    }

    fn print_alone(&self, side: usize, line: &Line, out: &mut Vec<u8>) {
        let values: Vec<&[u8]> = if self.layout.is_none() {
            std::iter::once(line.key())
                .chain(self.others(line, side))
                .collect()
        } else {
            let mut lines = [None, None];
            lines[side] = Some(line);
            self.pick(lines, line.key())
        };
        self.print(&values, out);
    }

    fn print_current(&self, side: usize, out: &mut Vec<u8>) {
        if let Some(line) = &self.sides[side].line {
            self.print_alone(side, line, out);
        }
    }

    fn pump(&mut self, out: &mut Vec<u8>) {
        loop {
            let phase = std::mem::replace(&mut self.phase, Phase::Done);
            let advanced = |join: &mut Self, side: usize, phase: Phase| match join.advance(side) {
                Advance::Taken => true,
                Advance::Wait => {
                    join.phase = phase;
                    false
                }
                Advance::Halt => false,
            };
            match phase {
                Phase::Open(side) | Phase::AfterHeader(side) => {
                    let header = matches!(phase, Phase::AfterHeader(_));
                    if !advanced(self, side, phase) {
                        return;
                    }
                    if side == 0 {
                        self.phase = if header {
                            Phase::AfterHeader(1)
                        } else {
                            Phase::Open(1)
                        };
                        continue;
                    }
                    self.phase = Phase::Compare;
                    let lines = self.sides.iter().filter(|s| s.line.is_some()).count();
                    if !header && self.config.header && lines > 0 {
                        // The header lines print even under -v, the lone one
                        // when the other file is empty, and nothing after them
                        // is compared with them.
                        self.settle_layout();
                        match (&self.sides[0].line, &self.sides[1].line) {
                            (Some(left), Some(right)) => self.print_pair(left, right, out),
                            (Some(_), None) => self.print_current(0, out),
                            _ => self.print_current(1, out),
                        }
                        for side in &mut self.sides {
                            side.last = None;
                        }
                        self.phase = Phase::AfterHeader(0);
                    } else if !header {
                        self.settle_layout();
                    }
                }
                Phase::Compare => {
                    let (Some(left), Some(right)) = (&self.sides[0].line, &self.sides[1].line)
                    else {
                        self.phase = Phase::Tail(0);
                        continue;
                    };
                    if left.rank == right.rank {
                        let rank = left.rank.clone();
                        self.phase = Phase::Group {
                            side: 0,
                            rank,
                            groups: Vec::new(),
                        };
                        continue;
                    }
                    // The next line is read, and its order checked, before
                    // this one counts as unpaired (GNU 9.7).
                    let side = usize::from(left.rank > right.rank);
                    if self.sides[side].shown {
                        self.print_current(side, out);
                    }
                    self.phase = Phase::Unpaired(side);
                }
                Phase::Unpaired(side) => {
                    if !advanced(self, side, phase) {
                        return;
                    }
                    self.lone_seen = true;
                    self.phase = Phase::Compare;
                }
                Phase::Group {
                    side,
                    rank,
                    mut groups,
                } => {
                    if groups.len() == side {
                        match self.sides[side].line.take() {
                            Some(head) => groups.push(vec![head]),
                            None => {
                                self.phase = Phase::Pairs {
                                    groups: [groups.pop().unwrap_or_default(), Vec::new()],
                                    i: 0,
                                    j: 0,
                                };
                                continue;
                            }
                        }
                    }
                    match self.advance(side) {
                        Advance::Wait => {
                            self.phase = Phase::Group { side, rank, groups };
                            return;
                        }
                        Advance::Halt => return,
                        Advance::Taken => {}
                    }
                    match self.sides[side].line.take() {
                        Some(line) if line.rank == rank => {
                            groups[side].push(line);
                            self.phase = Phase::Group { side, rank, groups };
                        }
                        next => {
                            self.sides[side].line = next;
                            self.phase = if side == 0 {
                                Phase::Group {
                                    side: 1,
                                    rank,
                                    groups,
                                }
                            } else {
                                let second = groups.pop().unwrap_or_default();
                                let first = groups.pop().unwrap_or_default();
                                Phase::Pairs {
                                    groups: [first, second],
                                    i: 0,
                                    j: 0,
                                }
                            };
                        }
                    }
                }
                Phase::Pairs {
                    groups,
                    mut i,
                    mut j,
                } => {
                    // Two groups of n equal keys make n * n lines, so they
                    // are handed on as they fill.
                    if self.config.paired && !groups[1].is_empty() {
                        while i < groups[0].len() {
                            if out.len() >= CHUNK {
                                self.phase = Phase::Pairs { groups, i, j };
                                return;
                            }
                            self.print_pair(&groups[0][i], &groups[1][j], out);
                            j += 1;
                            if j == groups[1].len() {
                                i += 1;
                                j = 0;
                            }
                        }
                    }
                    self.phase = Phase::Compare;
                }
                Phase::Tail(side) => {
                    // Once the other file has ended no line counts as
                    // unpaired.
                    if self.sides[side].line.is_some() && self.still_reading(side) {
                        if self.sides[side].shown {
                            self.print_current(side, out);
                        }
                        self.phase = Phase::TailRead(side);
                    } else if side == 0 {
                        self.phase = Phase::Tail(1);
                    } else {
                        if self.config.order == Order::Warn && self.sides.iter().any(|s| s.reported)
                        {
                            self.stderr
                                .extend_from_slice(b"join: input is not in sorted order\n");
                        }
                        return;
                    }
                }
                Phase::TailRead(side) => {
                    if !advanced(self, side, phase) {
                        return;
                    }
                    self.phase = Phase::Tail(side);
                }
                Phase::Done => return,
            }
        }
    }
}

impl Stream for Join {
    fn feed(&mut self, _: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("join reads two inputs"))
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.pump(out);
        Ok(())
    }

    fn wants(&self) -> Option<usize> {
        match self.phase {
            Phase::Open(side)
            | Phase::AfterHeader(side)
            | Phase::Unpaired(side)
            | Phase::Group { side, .. }
            | Phase::TailRead(side) => Some(side),
            _ => None,
        }
    }

    fn feed_input(
        &mut self,
        side: usize,
        input: &[u8],
        out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        self.sides[side.min(1)].input.push(input);
        self.pump(out);
        Ok(())
    }

    fn end_input(&mut self, side: usize, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.sides[side.min(1)].input.end();
        self.pump(out);
        Ok(())
    }

    fn busy(&self) -> bool {
        matches!(self.phase, Phase::Pairs { .. })
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.pump(out);
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
    use super::*;
    use crate::config;

    fn join(options: &str, left: &[u8], right: &[u8]) -> (Vec<u8>, Vec<u8>, i32) {
        let config = config(
            r#"{"keys":[0,0],"unpaired":[false,false],"paired":true,"filler":null,"columns":[],"auto_columns":false,"delimiter":null,"separator":" ","fold_case":false,"zero_terminated":false,"order":"warn","header":false,"names":["a","b"]}"#,
            options,
        );
        let mut stream = open(config.as_bytes()).unwrap();
        let inputs = [left, right];
        let mut at = [0, 0];
        let mut out = Vec::new();
        loop {
            while stream.busy() {
                let mut piece = Vec::new();
                stream.drain(&mut piece).unwrap();
                assert!(piece.len() < CHUNK + 4096);
                out.extend(piece);
            }
            let Some(side) = stream.wants() else { break };
            if at[side] == inputs[side].len() {
                stream.end_input(side, &mut out).unwrap();
            } else {
                let byte = &inputs[side][at[side]..at[side] + 1];
                stream.feed_input(side, byte, &mut out).unwrap();
                at[side] += 1;
            }
        }
        stream.finish(&mut out).unwrap();
        let mut err = Vec::new();
        stream.take_stderr(&mut err);
        (out, err, stream.status())
    }

    #[test]
    fn pairs_unpaired_lines_and_layouts() {
        let plain = join("{}", b"a 1\nb 2\nc 3\n", b"a x\nc y\nd z\n");
        assert_eq!(plain.0, b"a 1 x\nc 3 y\n");
        let options = r#"{"unpaired":[true,true],"filler":"-","columns":[[0,0],[1,1],[2,1]]}"#;
        let listed = join(options, b"a 1\nb 2\n", b"a x\nc y\n");
        assert_eq!(listed.0, b"a 1 x\nb 2 -\nc - y\n");
        let options = r#"{"delimiter":",","separator":",","auto_columns":true,"header":true}"#;
        let auto = join(options, b"k,v\na,1,extra\n", b"k,w\na,2\n");
        assert_eq!(auto.0, b"k,v,w\na,1,2\n");
        assert_eq!(
            join(r#"{"fold_case":true}"#, b"A 1\n", b"a 2\n").0,
            b"A 1 2\n"
        );
        let whole = join(r#"{"delimiter":"\n","separator":":"}"#, b"a b\n", b"a b\n");
        assert_eq!(whole.0, b"a b\n");
    }

    #[test]
    fn equal_key_groups_print_their_product_in_bounded_pieces() {
        let left = b"k l\n".repeat(300);
        let right = b"k r\n".repeat(300);
        assert_eq!(join("{}", &left, &right).0, b"k l r\n".repeat(90000));
    }

    #[test]
    fn disorder_is_named_once_a_line_goes_unpaired() {
        let unnamed = join("{}", b"a 1\nc 2\nb 3\n", b"a x\nz q\n");
        assert_eq!(unnamed, (b"a 1 x\n".to_vec(), vec![], 0));
        let named = join("{}", b"a 1\nc 2\nd 3\nb 4\n", b"a x\nz q\n");
        let notice = b"join: a:4: is not sorted: b 4\njoin: input is not in sorted order\n";
        assert_eq!((named.1, named.2), (notice.to_vec(), 1));
        let failed = join(r#"{"order":"fail"}"#, b"b 1\na 2\n", b"b x\n");
        let line = b"join: a:2: is not sorted: a 2\n";
        assert_eq!(failed, (vec![], line.to_vec(), 1));
    }
}
