use std::cmp::Ordering;
use std::collections::{BTreeMap, VecDeque};
use std::ops::Range;
use std::sync::Arc;

use serde::Deserialize;

use crate::records::{Bytes, Input, Output, Piece, Read, STEP};
use crate::{Stream, StreamError, parse_config};

#[derive(Clone, Copy, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Order {
    Warn,
    Fail,
    Off,
}

#[derive(Deserialize)]
struct Index(#[serde(deserialize_with = "crate::saturating_u64")] u64);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    keys: [Index; 2],
    unpaired: [bool; 2],
    paired: bool,
    #[serde(deserialize_with = "crate::latin1_opt")]
    filler: Option<Vec<u8>>,
    columns: Vec<(u8, Index)>,
    auto_columns: bool,
    #[serde(deserialize_with = "crate::latin1_opt")]
    delimiter: Option<Vec<u8>>,
    #[serde(deserialize_with = "crate::latin1")]
    separator: Vec<u8>,
    fold_case: bool,
    terminator: u8,
    order: Order,
    header: bool,
    #[serde(deserialize_with = "crate::latin1_list")]
    names: Vec<Vec<u8>>,
}

struct Line {
    bytes: Arc<Bytes>,
    fields: BTreeMap<usize, Range<usize>>,
    key: Range<usize>,
}

impl Line {
    fn field(&self, index: u64) -> Piece {
        let span = usize::try_from(index)
            .ok()
            .and_then(|index| self.fields.get(&index))
            .cloned()
            .unwrap_or(0..0);
        Piece {
            bytes: self.bytes.clone(),
            span,
        }
    }

    fn key(&self) -> Piece {
        Piece {
            bytes: self.bytes.clone(),
            span: self.key.clone(),
        }
    }
}

struct Builder {
    bytes: Arc<Bytes>,
    fields: BTreeMap<usize, Range<usize>>,
    position: usize,
    start: Option<usize>,
}

impl Builder {
    fn new(bytes: Bytes) -> Self {
        Self {
            bytes: Arc::new(bytes),
            fields: BTreeMap::new(),
            position: 0,
            start: None,
        }
    }

    fn step(&mut self, config: &Config, side: usize, budget: &mut usize) -> Option<Arc<Line>> {
        let length = self.bytes.len();
        if config.delimiter.as_deref() == Some(b"\n") {
            if length > 0 {
                self.fields.insert(self.fields.len(), 0..length);
            }
            self.position = length;
        } else {
            while self.position < length && *budget > 0 {
                let byte = self.bytes.at(self.position);
                if let Some(delimiter) = &config.delimiter {
                    let start = *self.start.get_or_insert(0);
                    if byte == delimiter[0] {
                        self.fields.insert(self.fields.len(), start..self.position);
                        self.start = Some(self.position + 1);
                    }
                } else if byte == b' ' || byte == b'\t' || (config.terminator == 0 && byte == b'\n')
                {
                    if let Some(start) = self.start.take() {
                        self.fields.insert(self.fields.len(), start..self.position);
                    }
                } else {
                    self.start.get_or_insert(self.position);
                }
                self.position += 1;
                *budget -= 1;
            }
            if self.position != length {
                return None;
            }
            if let Some(start) = self.start.take() {
                self.fields.insert(self.fields.len(), start..length);
            }
        }
        let key = usize::try_from(config.keys[side].0)
            .ok()
            .and_then(|index| self.fields.get(&index))
            .cloned()
            .unwrap_or(0..0);
        Some(Arc::new(Line {
            bytes: self.bytes.clone(),
            fields: std::mem::take(&mut self.fields),
            key,
        }))
    }
}

fn compare(
    left: &Line,
    right: &Line,
    fold: bool,
    offset: &mut usize,
    budget: &mut usize,
) -> Option<Ordering> {
    let length = left.key.len().min(right.key.len());
    while *offset < length && *budget > 0 {
        let a = left.bytes.at(left.key.start + *offset);
        let b = right.bytes.at(right.key.start + *offset);
        *offset += 1;
        *budget -= 1;
        let order = if fold {
            a.to_ascii_uppercase().cmp(&b.to_ascii_uppercase())
        } else {
            a.cmp(&b)
        };
        if order != Ordering::Equal {
            return Some(order);
        }
    }
    (*offset == length).then(|| left.key.len().cmp(&right.key.len()))
}

#[derive(Clone, Copy)]
enum Resume {
    FirstLeft,
    FirstRight,
    HeaderLeft,
    HeaderRight,
    Unpaired,
    Group(usize),
    Tail(usize),
}

enum Loading {
    Read,
    Parse(Builder),
    Check { line: Arc<Line>, offset: usize },
    Diagnose { line: Arc<Line>, scan: usize },
    Report { line: Arc<Line>, output: Output },
}

enum Phase {
    Load {
        side: usize,
        resume: Resume,
        work: Loading,
    },
    Setup,
    Compare(usize),
    Group {
        side: usize,
        offset: usize,
    },
    Product,
    ReleaseGroups(usize),
    Tail(usize),
    Complete,
}

struct Row {
    lines: [Option<Arc<Line>>; 2],
    key_side: usize,
    field: usize,
    side: usize,
    first: bool,
    key_done: bool,
    ended: bool,
    output: Output,
}

impl Row {
    fn new(lines: [Option<Arc<Line>>; 2]) -> Self {
        let key_side = usize::from(lines[0].is_none());
        Self {
            lines,
            key_side,
            field: 0,
            side: 0,
            first: true,
            key_done: false,
            ended: false,
            output: Output::default(),
        }
    }

    fn next(
        &mut self,
        config: &Config,
        automatic: &[usize; 2],
        empty: &Arc<Bytes>,
    ) -> Option<Piece> {
        let key = || {
            self.lines[self.key_side]
                .as_ref()
                .map_or_else(|| Piece::whole(empty.clone()), |line| line.key())
        };
        if !config.columns.is_empty() {
            let (side, index) = config.columns.get(self.field)?;
            self.field += 1;
            return Some(if *side == 0 {
                key()
            } else {
                self.lines[usize::from(*side - 1)]
                    .as_ref()
                    .map_or_else(|| Piece::whole(empty.clone()), |line| line.field(index.0))
            });
        }
        if !self.key_done {
            self.key_done = true;
            return Some(key());
        }
        while self.side < 2 {
            let length = if config.auto_columns {
                automatic[self.side]
            } else {
                self.lines[self.side]
                    .as_ref()
                    .map_or(0, |line| line.fields.len())
            };
            if self.field >= length {
                self.side += 1;
                self.field = 0;
                continue;
            }
            let field = self.field;
            self.field += 1;
            if field as u64 == config.keys[self.side].0 {
                continue;
            }
            return Some(self.lines[self.side].as_ref().map_or_else(
                || Piece::whole(empty.clone()),
                |line| line.field(field as u64),
            ));
        }
        None
    }

    fn step(&mut self, owner: &Join, out: &mut Vec<u8>, budget: &mut usize) -> bool {
        while *budget > 0 {
            self.output.write(out, budget);
            if !self.output.empty() {
                return false;
            }
            if self.ended {
                return true;
            }
            if *budget == 0 {
                return false;
            }
            *budget -= 1;
            if let Some(mut value) = self.next(&owner.config, &owner.automatic, &owner.empty) {
                if !self.first {
                    self.output.push(Piece::whole(owner.separator.clone()));
                }
                self.first = false;
                if value.span.is_empty() {
                    value = Piece::whole(owner.filler.clone());
                }
                self.output.push(value);
            } else {
                self.output.push(Piece::whole(owner.terminator.clone()));
                self.ended = true;
            }
        }
        false
    }
}

struct Join {
    config: Config,
    inputs: [Input; 2],
    heads: [Option<Arc<Line>>; 2],
    last: [Option<Arc<Line>>; 2],
    counts: [u64; 2],
    warned: [bool; 2],
    lone_seen: bool,
    automatic: [usize; 2],
    groups: [BTreeMap<usize, Arc<Line>>; 2],
    product: [usize; 2],
    retired: VecDeque<Arc<Line>>,
    retirement: Option<Retirement>,
    phase: Phase,
    wanted: Option<usize>,
    row: Option<Row>,
    empty: Arc<Bytes>,
    filler: Arc<Bytes>,
    separator: Arc<Bytes>,
    terminator: Arc<Bytes>,
    stderr: Vec<u8>,
    status: i32,
}

pub(crate) fn open(bytes: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(bytes)?;
    if config.names.len() != 2
        || config
            .delimiter
            .as_ref()
            .is_some_and(|value| value.len() != 1)
        || config.columns.iter().any(|(side, _)| *side > 2)
    {
        return Err(StreamError::new("bad join configuration"));
    }
    let filler = Arc::new(Bytes::new(config.filler.as_deref().unwrap_or_default()));
    let separator = Arc::new(Bytes::new(&config.separator));
    let terminator = Arc::new(Bytes::new(&[config.terminator]));
    Ok(Box::new(Join {
        config,
        inputs: std::array::from_fn(|_| Input::default()),
        heads: [None, None],
        last: [None, None],
        counts: [0; 2],
        warned: [false; 2],
        lone_seen: false,
        automatic: [0; 2],
        groups: std::array::from_fn(|_| BTreeMap::new()),
        retired: VecDeque::new(),
        retirement: None,
        product: [0; 2],
        phase: Phase::Load {
            side: 0,
            resume: Resume::FirstLeft,
            work: Loading::Read,
        },
        wanted: Some(0),
        row: None,
        empty: Arc::new(Bytes::default()),
        filler,
        separator,
        terminator,
        stderr: Vec::new(),
        status: 0,
    }))
}

enum Retirement {
    Line(Line),
    Bytes(Bytes),
}

impl Join {
    fn retire(&mut self, budget: &mut usize) -> bool {
        while *budget > 0 {
            if let Some(work) = self.retirement.take() {
                match work {
                    Retirement::Line(mut line) => {
                        while *budget > 0 && line.fields.pop_first().is_some() {
                            *budget -= 1;
                        }
                        if !line.fields.is_empty() {
                            self.retirement = Some(Retirement::Line(line));
                            return false;
                        }
                        if let Ok(bytes) = Arc::try_unwrap(line.bytes) {
                            self.retirement = Some(Retirement::Bytes(bytes));
                        }
                    }
                    Retirement::Bytes(mut bytes) => {
                        if !bytes.retire(budget) {
                            self.retirement = Some(Retirement::Bytes(bytes));
                            return false;
                        }
                    }
                }
            } else if let Some(line) = self.retired.pop_front() {
                *budget -= 1;
                if let Ok(line) = Arc::try_unwrap(line) {
                    self.retirement = Some(Retirement::Line(line));
                }
            } else {
                return true;
            }
        }
        false
    }

    fn load(&mut self, side: usize, resume: Resume) {
        self.phase = Phase::Load {
            side,
            resume,
            work: Loading::Read,
        };
    }

    fn loaded(&mut self, side: usize, line: Option<Arc<Line>>, resume: Resume) {
        if let Some(previous) = self.last[side].take() {
            self.retired.push_back(previous);
        }
        self.last[side] = line.clone();
        if let Some(previous) = self.heads[side].take() {
            self.retired.push_back(previous);
        }
        self.heads[side] = line;
        match resume {
            Resume::FirstLeft => self.load(1, Resume::FirstRight),
            Resume::FirstRight => self.phase = Phase::Setup,
            Resume::HeaderLeft => self.load(1, Resume::HeaderRight),
            Resume::HeaderRight => self.phase = Phase::Compare(0),
            Resume::Unpaired => {
                self.lone_seen = true;
                self.phase = Phase::Compare(0);
            }
            Resume::Group(side) => self.phase = Phase::Group { side, offset: 0 },
            Resume::Tail(side) => self.phase = Phase::Tail(side),
        }
    }

    fn begin_row(&mut self, lines: [Option<Arc<Line>>; 2]) {
        self.row = Some(Row::new(lines));
    }

    fn step(&mut self, out: &mut Vec<u8>) {
        let mut budget = STEP;
        self.wanted = None;
        while budget > 0 {
            if !self.retire(&mut budget) {
                return;
            }
            if let Some(mut row) = self.row.take() {
                if !row.step(self, out, &mut budget) {
                    self.row = Some(row);
                    return;
                }
                for line in row.lines.into_iter().flatten() {
                    self.retired.push_back(line);
                }
                continue;
            }
            let phase = std::mem::replace(&mut self.phase, Phase::Complete);
            budget = budget.saturating_sub(1);
            match phase {
                Phase::Load { side, resume, work } => match work {
                    Loading::Read => {
                        match self.inputs[side].read(self.config.terminator, &mut budget) {
                            Read::Waiting => {
                                self.load(side, resume);
                                self.wanted = Some(side);
                                return;
                            }
                            Read::Working => self.load(side, resume),
                            Read::End => self.loaded(side, None, resume),
                            Read::Record(bytes) => {
                                self.phase = Phase::Load {
                                    side,
                                    resume,
                                    work: Loading::Parse(Builder::new(bytes)),
                                }
                            }
                        }
                    }
                    Loading::Parse(mut builder) => {
                        let work = if let Some(line) = builder.step(&self.config, side, &mut budget)
                        {
                            self.counts[side] = self.counts[side].saturating_add(1);
                            Loading::Check { line, offset: 0 }
                        } else {
                            Loading::Parse(builder)
                        };
                        self.phase = Phase::Load { side, resume, work };
                    }
                    Loading::Check { line, mut offset } => {
                        let check = self.config.order != Order::Off
                            && !self.warned[side]
                            && (self.config.order == Order::Fail || self.lone_seen);
                        let order = if check {
                            self.last[side]
                                .as_ref()
                                .map_or(Some(Ordering::Equal), |previous| {
                                    compare(
                                        previous,
                                        &line,
                                        self.config.fold_case,
                                        &mut offset,
                                        &mut budget,
                                    )
                                })
                        } else {
                            Some(Ordering::Equal)
                        };
                        match order {
                            None => {
                                self.phase = Phase::Load {
                                    side,
                                    resume,
                                    work: Loading::Check { line, offset },
                                }
                            }
                            Some(Ordering::Greater) => {
                                self.status = 1;
                                self.warned[side] = true;
                                self.phase = Phase::Load {
                                    side,
                                    resume,
                                    work: Loading::Diagnose { line, scan: 0 },
                                };
                            }
                            Some(_) => self.loaded(side, Some(line), resume),
                        }
                    }
                    Loading::Diagnose { line, mut scan } => {
                        while scan < line.bytes.len() && budget > 0 && line.bytes.at(scan) != 0 {
                            scan += 1;
                            budget -= 1;
                        }
                        let work = if scan == line.bytes.len()
                            || (scan < line.bytes.len() && line.bytes.at(scan) == 0)
                        {
                            let mut output = Output::default();
                            output.push(Piece::whole(Arc::new(Bytes::new(b"join: "))));
                            output
                                .push(Piece::whole(Arc::new(Bytes::new(&self.config.names[side]))));
                            output.push(Piece::whole(Arc::new(Bytes::new(
                                format!(":{}: is not sorted: ", self.counts[side]).as_bytes(),
                            ))));
                            output.push(Piece {
                                bytes: line.bytes.clone(),
                                span: 0..scan,
                            });
                            output.push(Piece::whole(Arc::new(Bytes::new(b"\n"))));
                            Loading::Report { line, output }
                        } else {
                            Loading::Diagnose { line, scan }
                        };
                        self.phase = Phase::Load { side, resume, work };
                    }
                    Loading::Report { line, mut output } => {
                        output.write(&mut self.stderr, &mut budget);
                        if !output.empty() {
                            self.phase = Phase::Load {
                                side,
                                resume,
                                work: Loading::Report { line, output },
                            };
                        } else if self.config.order == Order::Fail {
                            self.retired.push_back(line);
                            self.phase = Phase::Complete;
                        } else {
                            self.loaded(side, Some(line), resume);
                        }
                    }
                },
                Phase::Setup => {
                    self.automatic = std::array::from_fn(|side| {
                        self.heads[side]
                            .as_ref()
                            .map_or(0, |line| line.fields.len())
                    });
                    if self.config.header && self.heads.iter().any(Option::is_some) {
                        self.begin_row(self.heads.clone());
                        self.last = [None, None];
                        self.load(0, Resume::HeaderLeft);
                    } else {
                        self.phase = Phase::Compare(0);
                    }
                }
                Phase::Compare(mut offset) => {
                    let (Some(left), Some(right)) = (&self.heads[0], &self.heads[1]) else {
                        self.phase = Phase::Tail(0);
                        continue;
                    };
                    match compare(left, right, self.config.fold_case, &mut offset, &mut budget) {
                        None => self.phase = Phase::Compare(offset),
                        Some(Ordering::Equal) => {
                            self.groups[0].insert(self.groups[0].len(), left.clone());
                            self.load(0, Resume::Group(0));
                        }
                        Some(order) => {
                            let side = usize::from(order == Ordering::Greater);
                            if self.config.unpaired[side] {
                                let mut lines = [None, None];
                                lines[side] = self.heads[side].clone();
                                self.begin_row(lines);
                            }
                            self.load(side, Resume::Unpaired);
                        }
                    }
                }
                Phase::Group { side, mut offset } => {
                    let order = self.heads[side]
                        .as_ref()
                        .map_or(Some(Ordering::Greater), |line| {
                            compare(
                                &self.groups[side][&0],
                                line,
                                self.config.fold_case,
                                &mut offset,
                                &mut budget,
                            )
                        });
                    match order {
                        None => self.phase = Phase::Group { side, offset },
                        Some(Ordering::Equal) => {
                            self.groups[side].insert(
                                self.groups[side].len(),
                                self.heads[side]
                                    .as_ref()
                                    .expect("head was compared")
                                    .clone(),
                            );
                            self.load(side, Resume::Group(side));
                        }
                        Some(_) if side == 0 => {
                            self.groups[1].insert(
                                self.groups[1].len(),
                                self.heads[1].as_ref().expect("right group head").clone(),
                            );
                            self.load(1, Resume::Group(1));
                        }
                        Some(_) => {
                            self.product = [0; 2];
                            self.phase = Phase::Product;
                        }
                    }
                }
                Phase::Product => {
                    if !self.config.paired || self.product[0] == self.groups[0].len() {
                        self.phase = Phase::ReleaseGroups(0);
                    } else {
                        self.begin_row([
                            Some(self.groups[0][&self.product[0]].clone()),
                            Some(self.groups[1][&self.product[1]].clone()),
                        ]);
                        self.product[1] += 1;
                        if self.product[1] == self.groups[1].len() {
                            self.product[0] += 1;
                            self.product[1] = 0;
                        }
                        self.phase = Phase::Product;
                    }
                }
                Phase::ReleaseGroups(side) => {
                    if side == 2 {
                        self.phase = Phase::Compare(0);
                    } else if let Some((_, line)) = self.groups[side].pop_first() {
                        self.retired.push_back(line);
                        self.phase = Phase::ReleaseGroups(side);
                    } else {
                        self.phase = Phase::ReleaseGroups(side + 1);
                    }
                }
                Phase::Tail(side) => {
                    if side == 2 {
                        if self.config.order == Order::Warn
                            && self.warned.iter().any(|value| *value)
                        {
                            self.stderr
                                .extend_from_slice(b"join: input is not in sorted order\n");
                        }
                        self.phase = Phase::Complete;
                    } else if self.heads[side].is_some()
                        && (self.config.unpaired[side]
                            || self.config.order == Order::Fail
                            || (self.config.order == Order::Warn && !self.warned[side]))
                    {
                        if self.config.unpaired[side] {
                            let mut lines = [None, None];
                            lines[side] = self.heads[side].clone();
                            self.begin_row(lines);
                        }
                        self.load(side, Resume::Tail(side));
                    } else {
                        self.phase = Phase::Tail(side + 1);
                    }
                }
                Phase::Complete => {
                    for side in 0..2 {
                        if let Some(line) = self.heads[side].take() {
                            self.retired.push_back(line);
                        }
                        if let Some(line) = self.last[side].take() {
                            self.retired.push_back(line);
                        }
                    }
                    for side in 0..2 {
                        if let Some((_, line)) = self.groups[side].pop_first() {
                            self.retired.push_back(line);
                        }
                    }
                    if self.retired.is_empty() {
                        return;
                    }
                }
            }
        }
    }
}

impl Stream for Join {
    fn cancel(&mut self) -> bool {
        for input in &mut self.inputs {
            self.retired.push_back(Arc::new(Line {
                bytes: Arc::new(input.cancel()),
                fields: BTreeMap::new(),
                key: 0..0,
            }));
        }
        if let Some(row) = self.row.take() {
            for line in row.lines.into_iter().flatten() {
                self.retired.push_back(line);
            }
        }
        if let Phase::Load { work, .. } = std::mem::replace(&mut self.phase, Phase::Complete) {
            match work {
                Loading::Parse(builder) => self.retired.push_back(Arc::new(Line {
                    bytes: builder.bytes,
                    fields: builder.fields,
                    key: 0..0,
                })),
                Loading::Check { line, .. }
                | Loading::Diagnose { line, .. }
                | Loading::Report { line, .. } => self.retired.push_back(line),
                Loading::Read => {}
            }
        }
        self.wanted = None;
        true
    }

    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.feed_input(0, input, out)
    }
    fn finish(&mut self, _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Ok(())
    }
    fn wants(&self) -> Option<usize> {
        self.wanted
    }
    fn busy(&self) -> bool {
        self.wanted.is_none()
            && (!matches!(self.phase, Phase::Complete)
                || self.row.is_some()
                || !self.retired.is_empty()
                || self.retirement.is_some()
                || self.heads.iter().any(Option::is_some)
                || self.last.iter().any(Option::is_some)
                || self.groups.iter().any(|group| !group.is_empty()))
    }
    fn done(&self) -> bool {
        matches!(self.phase, Phase::Complete)
            && self.row.is_none()
            && self.retired.is_empty()
            && self.retirement.is_none()
            && self.heads.iter().all(Option::is_none)
            && self.last.iter().all(Option::is_none)
            && self.groups.iter().all(BTreeMap::is_empty)
    }
    fn feed_input(
        &mut self,
        side: usize,
        input: &[u8],
        out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        let Some(source) = self.inputs.get_mut(side) else {
            return Err(StreamError::new("invalid join input"));
        };
        source.feed(input);
        self.step(out);
        Ok(())
    }
    fn end_input(&mut self, side: usize, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let Some(source) = self.inputs.get_mut(side) else {
            return Err(StreamError::new("invalid join input"));
        };
        source.end();
        self.step(out);
        Ok(())
    }
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.step(out);
        Ok(())
    }
    fn status(&self) -> i32 {
        self.status
    }
    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        err.append(&mut self.stderr);
    }
}
