use std::collections::{HashSet, VecDeque};

use serde::Deserialize;
use serde_json::json;

use crate::{Stream, StreamError, parse_config};

const WORK: usize = 16 * 1024;
const MEMORY: u64 = 1024 * 1024;
const DRAWS: usize = 1024;
const MAX_LINES: u64 = 1_000_000;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum Mode {
    Records,
    Count,
    Index,
    Shuffle,
    Scatter,
    Draw,
    Range,
    Indexed,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    mode: Mode,
    separator: u8,
    #[serde(default)]
    size: u64,
    #[serde(default)]
    available: u64,
    #[serde(default)]
    need: u64,
    #[serde(default)]
    repeat: bool,
    #[serde(default, deserialize_with = "decimal_u64")]
    low: u64,
    #[serde(default, deserialize_with = "decimal_u64")]
    high: u64,
}

fn decimal_u64<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    String::deserialize(deserializer)?
        .parse()
        .map_err(serde::de::Error::custom)
}

#[derive(Clone, Copy)]
enum Phase {
    Load,
    Scan,
    Index,
    Initialize,
    Shuffle,
    Emit,
    Scatter,
    Flush(usize),
    Done,
}

enum Request {
    Read {
        offset: u64,
        size: usize,
        index: bool,
    },
    Random {
        limit: u64,
        count: usize,
        descending: bool,
    },
    Write(usize),
    Swap {
        left: u64,
        right: u64,
    },
}

/// The host owns spools and randomness. Requests batch exact bounded draws,
/// preserving IdSource's next word as well as the resulting permutation.
struct Shuf {
    config: Config,
    phase: Phase,
    request: Option<Request>,
    taken: bool,
    data: Vec<u8>,
    at: usize,
    start: usize,
    index_start: u64,
    offset: u64,
    count: u64,
    last: Option<u8>,
    spans: Vec<(u32, u32)>,
    order: Vec<u64>,
    shuffle_left: u64,
    random: VecDeque<u64>,
    seen: HashSet<u64>,
    emitted: u64,
    selected: Option<(u64, u64)>,
    bucket: Option<usize>,
    parts: [Vec<u8>; 16],
    counts: [u64; 16],
    sizes: [u64; 16],
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let mut config: Config = parse_config(config)?;
    if config.mode == Mode::Range {
        config.available = config
            .high
            .checked_sub(config.low)
            .and_then(|n| n.checked_add(1))
            .ok_or_else(|| StreamError::new("shuf: invalid input range"))?;
    }
    if config.need > MAX_LINES || config.mode == Mode::Shuffle && config.size > MEMORY {
        return Err(StreamError::new("shuf: memory exhausted"));
    }
    if config.mode == Mode::Records {
        return Ok(Box::new(Plan::new(config)));
    }
    Ok(Box::new(create(config)))
}

fn create(config: Config) -> Shuf {
    let phase = match config.mode {
        Mode::Range | Mode::Indexed => Phase::Initialize,
        Mode::Count | Mode::Index => Phase::Done,
        _ => Phase::Load,
    };
    Shuf {
        config,
        phase,
        request: None,
        taken: false,
        data: Vec::new(),
        at: 0,
        start: 0,
        index_start: 0,
        offset: 0,
        count: 0,
        last: None,
        spans: Vec::new(),
        order: Vec::new(),
        shuffle_left: 0,
        random: VecDeque::new(),
        seen: HashSet::new(),
        emitted: 0,
        selected: None,
        bucket: None,
        parts: std::array::from_fn(|_| Vec::new()),
        counts: [0; 16],
        sizes: [0; 16],
    }
}

impl Shuf {
    fn ask(&mut self, request: Request) {
        self.request = Some(request);
        self.taken = false;
    }
    fn draws(&mut self, limit: u64, count: usize, descending: bool) {
        self.ask(Request::Random {
            limit,
            count: count.min(DRAWS),
            descending,
        });
    }
    fn indexed(&self) -> bool {
        self.config.mode == Mode::Indexed
            || self.config.mode == Mode::Draw && self.config.size > MEMORY
    }
    fn step(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut work = WORK;
        let output_end = out.len() + WORK;
        while work > 0 && out.len() < output_end && self.request.is_none() {
            work -= 1;
            match self.phase {
                Phase::Done => break,
                Phase::Index => {
                    if output_end - out.len() < 16 {
                        break;
                    }
                    let end = self.data.len().min(self.at + work);
                    if let Some(found) =
                        memchr::memchr(self.config.separator, &self.data[self.at..end])
                    {
                        let next = self.at + found + 1;
                        let offset = self.offset + next as u64;
                        out.extend_from_slice(&self.index_start.to_le_bytes());
                        out.extend_from_slice(&(offset - self.index_start - 1).to_le_bytes());
                        self.index_start = offset;
                        self.at = next;
                        self.count += 1;
                        work -= found + 1;
                    } else {
                        work -= end - self.at;
                        self.at = end;
                    }
                    if self.at == self.data.len() {
                        self.offset += self.data.len() as u64;
                        self.data.clear();
                        self.at = 0;
                        self.phase = Phase::Done;
                    }
                }
                Phase::Load => {
                    if self.config.mode == Mode::Draw && self.indexed() {
                        self.phase = Phase::Emit;
                    } else if self.offset < self.config.size {
                        self.ask(Request::Read {
                            offset: self.offset,
                            size: (self.config.size - self.offset).min(WORK as u64) as usize,
                            index: false,
                        });
                    } else {
                        self.phase = if self.config.mode == Mode::Scatter {
                            Phase::Done
                        } else {
                            Phase::Scan
                        };
                    }
                }
                Phase::Scan => {
                    let end = self.data.len().min(self.at + work);
                    if let Some(found) =
                        memchr::memchr(self.config.separator, &self.data[self.at..end])
                    {
                        let cut = self.at + found;
                        self.spans.push((self.start as u32, cut as u32));
                        self.start = cut + 1;
                        self.at = self.start;
                        work -= found + 1;
                    } else {
                        work -= end - self.at;
                        self.at = end;
                    }
                    if self.at == self.data.len() {
                        if self.start < self.data.len() {
                            self.spans.push((self.start as u32, self.data.len() as u32));
                        }
                        if self.spans.len() as u64 != self.config.available {
                            return Err(StreamError::new("shuf: invalid record count"));
                        }
                        self.shuffle_left = self.spans.len() as u64;
                        self.phase = if self.config.repeat {
                            Phase::Emit
                        } else {
                            Phase::Shuffle
                        };
                    }
                }
                Phase::Initialize => {
                    if !self.config.repeat && self.config.available <= MAX_LINES {
                        if (self.order.len() as u64) < self.config.available {
                            self.order.push(self.order.len() as u64);
                            continue;
                        }
                        self.shuffle_left = self.order.len() as u64;
                        self.phase = Phase::Shuffle;
                    } else if !self.config.repeat && self.indexed() {
                        self.shuffle_left = self.config.available;
                        self.phase = Phase::Shuffle;
                    } else {
                        self.phase = Phase::Emit;
                    }
                }
                Phase::Shuffle => {
                    if self.shuffle_left <= 1 {
                        self.phase = Phase::Emit;
                        continue;
                    }
                    let Some(pick) = self.random.pop_front() else {
                        self.draws(
                            self.shuffle_left,
                            (self.shuffle_left - 1).min(DRAWS as u64) as usize,
                            true,
                        );
                        continue;
                    };
                    if pick >= self.shuffle_left {
                        return Err(StreamError::new("shuf: random draw out of range"));
                    }
                    if self.config.mode == Mode::Shuffle {
                        self.spans
                            .swap(self.shuffle_left as usize - 1, pick as usize);
                    } else if self.indexed() && self.order.is_empty() {
                        self.ask(Request::Swap {
                            left: self.shuffle_left - 1,
                            right: pick,
                        });
                    } else {
                        self.order
                            .swap(self.shuffle_left as usize - 1, pick as usize);
                    }
                    self.shuffle_left -= 1;
                }
                Phase::Emit => {
                    if let Some((offset, end)) = self.selected {
                        if offset < end {
                            let len = (end - offset).min((output_end - out.len()) as u64) as usize;
                            if self.indexed() {
                                self.ask(Request::Read {
                                    offset,
                                    size: len,
                                    index: false,
                                });
                            } else {
                                out.extend_from_slice(
                                    &self.data[offset as usize..offset as usize + len],
                                );
                                self.selected = Some((offset + len as u64, end));
                            }
                        } else {
                            out.push(self.config.separator);
                            self.selected = None;
                            self.emitted += 1;
                        }
                        continue;
                    }
                    if self.emitted >= self.config.need || self.config.available == 0 {
                        self.phase = Phase::Done;
                        continue;
                    }
                    if self.config.mode == Mode::Range && output_end - out.len() < 21 {
                        break;
                    }
                    let randomized = self.config.repeat
                        || self.config.mode == Mode::Range && self.config.available > MAX_LINES;
                    let pick = if randomized {
                        let Some(pick) = self.random.pop_front() else {
                            self.draws(
                                self.config.available,
                                (self.config.need - self.emitted) as usize,
                                false,
                            );
                            continue;
                        };
                        if pick >= self.config.available {
                            return Err(StreamError::new("shuf: random draw out of range"));
                        }
                        if !self.config.repeat && !self.seen.insert(pick) {
                            continue;
                        }
                        pick
                    } else if !self.order.is_empty() {
                        self.order[self.emitted as usize]
                    } else {
                        self.emitted
                    };
                    if self.config.mode == Mode::Range {
                        crate::integer::decimal(self.config.low + pick, false, 0, out);
                        out.push(self.config.separator);
                        self.emitted += 1;
                    } else if self.indexed() {
                        self.ask(Request::Read {
                            offset: pick * 16,
                            size: 16,
                            index: true,
                        });
                    } else {
                        let (start, end) = self.spans[pick as usize];
                        self.selected = Some((u64::from(start), u64::from(end)));
                    }
                }
                Phase::Scatter => {
                    if self.at == self.data.len() {
                        self.phase = Phase::Flush(0);
                        continue;
                    }
                    if self.bucket.is_none() {
                        let Some(pick) = self.random.pop_front() else {
                            let rest = &self.data[self.at..];
                            let starts = memchr::memchr_iter(self.config.separator, rest).count()
                                + usize::from(rest.last() != Some(&self.config.separator));
                            self.draws(16, starts, false);
                            continue;
                        };
                        if pick >= 16 {
                            return Err(StreamError::new("shuf: random draw out of range"));
                        }
                        self.bucket = Some(pick as usize);
                        self.counts[pick as usize] += 1;
                    }
                    let bucket = self.bucket.unwrap();
                    let remaining = &self.data[self.at..];
                    let cut = memchr::memchr(self.config.separator, remaining);
                    let len = cut.map_or(remaining.len(), |at| at + 1).min(work.max(1));
                    self.parts[bucket].extend_from_slice(&remaining[..len]);
                    self.sizes[bucket] += len as u64;
                    self.at += len;
                    work = work.saturating_sub(len);
                    if cut == Some(len - 1) {
                        self.bucket = None;
                    }
                }
                Phase::Flush(at) => {
                    if at == 16 {
                        self.data.clear();
                        self.at = 0;
                        self.phase = Phase::Load;
                    } else if self.parts[at].is_empty()
                        || self.parts[at].len() < WORK && self.offset < self.config.size
                    {
                        self.phase = Phase::Flush(at + 1);
                    } else {
                        self.ask(Request::Write(at));
                    }
                }
            }
        }
        Ok(())
    }
}

impl Stream for Shuf {
    fn feed(&mut self, input: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !matches!(self.config.mode, Mode::Count | Mode::Index) {
            return Err(StreamError::new("shuf reads through requests"));
        }
        if let Some(&last) = input.last() {
            self.last = Some(last);
        }
        if self.config.mode == Mode::Index {
            if self.busy() {
                return Err(StreamError::new("shuf: drain before feeding input"));
            }
            self.data.extend_from_slice(input);
            self.phase = Phase::Index;
            return self.step(out);
        }
        self.count += memchr::memchr_iter(self.config.separator, input).count() as u64;
        self.offset += input.len() as u64;
        if let Some(&last) = input.last() {
            self.last = Some(last);
        }
        Ok(())
    }
    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if matches!(self.config.mode, Mode::Count | Mode::Index) {
            if self.last.is_some_and(|last| last != self.config.separator) {
                self.count += 1;
                if self.config.mode == Mode::Index {
                    out.extend_from_slice(&self.index_start.to_le_bytes());
                    out.extend_from_slice(&(self.offset - self.index_start).to_le_bytes());
                }
                self.last = None;
            }
            if self.config.mode == Mode::Count {
                crate::integer::decimal(self.count, false, 0, out);
            }
            Ok(())
        } else {
            self.step(out)
        }
    }
    fn busy(&self) -> bool {
        self.request.is_none() && !matches!(self.phase, Phase::Done)
    }
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.step(out)
    }
    fn request(&mut self, data: &mut Vec<u8>) -> Option<Vec<u8>> {
        if self.taken {
            return None;
        }
        let request = self.request.as_ref()?;
        self.taken = true;
        let header = match *request {
            Request::Read {
                offset,
                size,
                index,
            } => json!({"op":"read", "offset":offset, "size":size, "index":index}),
            Request::Random {
                limit,
                count,
                descending,
            } => {
                json!({"op":"random", "limit":limit.to_string(), "count":count, "descending":descending})
            }
            Request::Swap { left, right } => json!({"op":"swap", "left":left, "right":right}),
            Request::Write(bucket) => {
                let len = self.parts[bucket].len().min(WORK);
                data.extend(self.parts[bucket].drain(..len));
                json!({"op":"write", "bucket":bucket})
            }
        };
        Some(serde_json::to_vec(&header).expect("shuf request serializes"))
    }
    fn respond(
        &mut self,
        _reply: &[u8],
        data: &[u8],
        out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        match self
            .request
            .take()
            .ok_or_else(|| StreamError::new("shuf: no pending request"))?
        {
            Request::Random { count, .. } => {
                if data.len() != count * 8 {
                    return Err(StreamError::new("shuf: invalid random response"));
                }
                self.random.extend(
                    data.chunks_exact(8)
                        .map(|bytes| u64::from_le_bytes(bytes.try_into().unwrap())),
                );
            }
            Request::Read {
                offset,
                size,
                index,
            } => {
                if data.len() != size {
                    return Err(StreamError::new("shuf: unexpected end of spool"));
                }
                if index {
                    let start = u64::from_le_bytes(data[..8].try_into().unwrap());
                    let len = u64::from_le_bytes(data[8..].try_into().unwrap());
                    self.selected = Some((
                        start,
                        start
                            .checked_add(len)
                            .ok_or_else(|| StreamError::new("shuf: invalid index"))?,
                    ));
                } else if matches!(self.phase, Phase::Emit) {
                    out.extend_from_slice(data);
                    let (_, end) = self.selected.unwrap();
                    self.selected = Some((offset + size as u64, end));
                    return Ok(());
                } else {
                    self.data.extend_from_slice(data);
                    self.offset += size as u64;
                    if self.config.mode == Mode::Scatter {
                        self.phase = Phase::Scatter;
                    }
                }
            }
            Request::Write(bucket) => self.phase = Phase::Flush(bucket),
            Request::Swap { .. } => {}
        }
        self.step(out)
    }
    fn metadata(&self, out: &mut Vec<u8>) {
        serde_json::to_writer(out, &self.counts).expect("shuf counts serialize");
    }
}

#[derive(Clone, Copy)]
struct Task {
    spool: u64,
    size: u64,
    available: u64,
    need: u64,
    depth: u8,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Stage {
    Next,
    Run,
    Index,
    Copy,
    Done,
}

enum Storage {
    Random(usize),
    Read {
        spool: u64,
        offset: u64,
        size: usize,
    },
    Write(u64),
    Close(u64),
}

/// One shuffle plan owns every spill decision; hosts only serve storage and RNG.
struct Plan {
    separator: u8,
    repeat: bool,
    tasks: Vec<Task>,
    task: Option<Task>,
    stage: Stage,
    active: Option<Shuf>,
    next_spool: u64,
    index: Option<u64>,
    buckets: [u64; 16],
    offset: u64,
    indexed: bool,
    close: Vec<u64>,
    pending: Option<Storage>,
    taken: bool,
    payload: Vec<u8>,
}

impl Plan {
    fn new(config: Config) -> Self {
        Self {
            separator: config.separator,
            repeat: config.repeat,
            tasks: vec![Task {
                spool: 0,
                size: config.size,
                available: config.available,
                need: config.need,
                depth: 0,
            }],
            task: None,
            stage: Stage::Next,
            active: None,
            next_spool: 2,
            index: None,
            buckets: [0; 16],
            offset: 0,
            indexed: false,
            close: Vec::new(),
            pending: None,
            taken: false,
            payload: Vec::new(),
        }
    }
    fn spool(&mut self) -> u64 {
        let id = self.next_spool;
        self.next_spool += 1;
        id
    }
    fn ask(&mut self, request: Storage) {
        self.pending = Some(request);
        self.taken = false;
    }
    fn engine(&mut self, mode: Mode) {
        let task = self.task.unwrap();
        self.active = Some(create(Config {
            mode,
            separator: self.separator,
            size: task.size,
            available: task.available,
            need: task.need,
            repeat: self.repeat,
            low: 0,
            high: 0,
        }));
    }
    fn retire(&mut self) {
        self.close.push(self.task.take().unwrap().spool);
        if let Some(index) = self.index.take() {
            self.close.push(index);
        }
        self.active = None;
        self.stage = Stage::Next;
    }
    fn step(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if let Some(spool) = self.close.pop() {
            self.ask(Storage::Close(spool));
            return Ok(());
        }
        match self.stage {
            Stage::Done => {}
            Stage::Next => {
                let Some(task) = self.tasks.pop() else {
                    self.stage = Stage::Done;
                    return Ok(());
                };
                self.task = Some(task);
                self.offset = 0;
                self.indexed = false;
                if task.need == 0 {
                    self.retire();
                } else if task.size <= MEMORY {
                    self.engine(if self.repeat {
                        Mode::Draw
                    } else {
                        Mode::Shuffle
                    });
                    self.stage = Stage::Run;
                } else if !self.repeat && task.available == 1 {
                    self.stage = Stage::Copy;
                    if task.depth < 4 {
                        self.ask(Storage::Random(usize::from(4 - task.depth)));
                    }
                } else if self.repeat || task.depth == 4 {
                    self.index = Some(self.spool());
                    self.engine(Mode::Index);
                    self.stage = Stage::Index;
                } else {
                    for at in 0..16 {
                        self.buckets[at] = self.spool();
                    }
                    self.engine(Mode::Scatter);
                    self.stage = Stage::Run;
                }
            }
            Stage::Run => {
                let engine = self.active.as_mut().unwrap();
                if engine.busy() {
                    return engine.drain(out);
                }
                if engine.config.mode == Mode::Scatter {
                    let task = self.task.unwrap();
                    let mut need = task.need;
                    let mut children = Vec::new();
                    for at in 0..16 {
                        let count = engine.counts[at];
                        let take = need.min(count);
                        need -= take;
                        if take == 0 {
                            self.close.push(self.buckets[at]);
                        } else {
                            children.push(Task {
                                spool: self.buckets[at],
                                size: engine.sizes[at],
                                available: count,
                                need: take,
                                depth: task.depth + 1,
                            });
                        }
                    }
                    self.tasks.extend(children.into_iter().rev());
                }
                self.retire();
            }
            Stage::Copy => {
                let task = self.task.unwrap();
                if self.offset == task.size {
                    self.retire();
                } else {
                    self.ask(Storage::Read {
                        spool: task.spool,
                        offset: self.offset,
                        size: (task.size - self.offset).min(WORK as u64) as usize,
                    });
                }
            }
            Stage::Index => {
                let task = self.task.unwrap();
                let engine = self.active.as_mut().unwrap();
                if engine.busy() {
                    engine.drain(&mut self.payload)?;
                } else if self.offset < task.size {
                    self.ask(Storage::Read {
                        spool: task.spool,
                        offset: self.offset,
                        size: (task.size - self.offset).min(WORK as u64) as usize,
                    });
                } else if !self.indexed {
                    engine.finish(&mut self.payload)?;
                    self.indexed = true;
                } else {
                    self.engine(Mode::Indexed);
                    self.stage = Stage::Run;
                }
                if !self.payload.is_empty() {
                    self.ask(Storage::Write(self.index.unwrap()));
                }
            }
        }
        Ok(())
    }
}

impl Stream for Plan {
    fn feed(&mut self, _input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("shuf reads through requests"))
    }
    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.step(out)
    }
    fn busy(&self) -> bool {
        self.stage != Stage::Done
            && self.pending.is_none()
            && self
                .active
                .as_ref()
                .is_none_or(|engine| engine.request.is_none())
    }
    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.step(out)
    }
    fn request(&mut self, data: &mut Vec<u8>) -> Option<Vec<u8>> {
        if let Some(pending) = &self.pending {
            if self.taken {
                return None;
            }
            self.taken = true;
            let header = match *pending {
                Storage::Random(count) => {
                    json!({"op":"random", "limit":"16", "count":count, "descending":false})
                }
                Storage::Read {
                    spool,
                    offset,
                    size,
                } => json!({"op":"read", "spool":spool, "offset":offset, "size":size}),
                Storage::Write(spool) => {
                    data.append(&mut self.payload);
                    json!({"op":"write", "spool":spool})
                }
                Storage::Close(spool) => json!({"op":"close", "spool":spool}),
            };
            return Some(serde_json::to_vec(&header).expect("shuf storage request serializes"));
        }
        let mut header: serde_json::Value =
            serde_json::from_slice(&self.active.as_mut()?.request(data)?)
                .expect("shuf request is JSON");
        let spool = match header["op"].as_str()? {
            "read" => Some(if header["index"] == true {
                self.index.unwrap()
            } else {
                self.task.unwrap().spool
            }),
            "write" => Some(self.buckets[header["bucket"].as_u64().unwrap() as usize]),
            "swap" => self.index,
            _ => None,
        };
        if let Some(spool) = spool {
            header["spool"] = spool.into();
        }
        Some(serde_json::to_vec(&header).expect("shuf request serializes"))
    }
    fn respond(&mut self, reply: &[u8], data: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        match self.pending.take() {
            Some(Storage::Read { size, .. }) => {
                if data.len() != size {
                    return Err(StreamError::new("shuf: unexpected end of spool"));
                }
                self.offset += size as u64;
                if self.stage == Stage::Copy {
                    out.extend_from_slice(data);
                } else {
                    self.active
                        .as_mut()
                        .unwrap()
                        .feed(data, &mut self.payload)?;
                    if !self.payload.is_empty() {
                        self.ask(Storage::Write(self.index.unwrap()));
                    }
                }
                Ok(())
            }
            Some(Storage::Random(_) | Storage::Write(_) | Storage::Close(_)) => Ok(()),
            None => self
                .active
                .as_mut()
                .ok_or_else(|| StreamError::new("shuf: no pending request"))?
                .respond(reply, data, out),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drive(config: serde_json::Value, data: &[u8], index: &[u8]) -> (Vec<u8>, [Vec<u8>; 16]) {
        drive_stream(open(config.to_string().as_bytes()).unwrap(), data, index)
    }

    fn drive_stream(
        mut stream: Box<dyn Stream>,
        data: &[u8],
        index: &[u8],
    ) -> (Vec<u8>, [Vec<u8>; 16]) {
        let mut index = index.to_vec();
        let mut spools = std::collections::HashMap::from([(0, data.to_vec())]);
        let mut output = Vec::new();
        let mut buckets: [Vec<u8>; 16] = std::array::from_fn(|_| Vec::new());
        loop {
            while stream.busy() {
                let mut out = Vec::new();
                stream.drain(&mut out).unwrap();
                assert!(out.len() <= WORK);
                output.extend(out);
            }
            let mut payload = Vec::new();
            let Some(header) = stream.request(&mut payload) else {
                break;
            };
            assert!(payload.len() <= WORK);
            let request: serde_json::Value = serde_json::from_slice(&header).unwrap();
            let response = match request["op"].as_str().unwrap() {
                "read" => {
                    let source = if let Some(id) = request["spool"].as_u64() {
                        spools.get(&id).unwrap().as_slice()
                    } else if request["index"] == true {
                        index.as_slice()
                    } else {
                        data
                    };
                    let offset = request["offset"].as_u64().unwrap() as usize;
                    let size = request["size"].as_u64().unwrap() as usize;
                    source[offset..offset + size].to_vec()
                }
                "random" => vec![0; request["count"].as_u64().unwrap() as usize * 8],
                "swap" => {
                    let left = request["left"].as_u64().unwrap() as usize * 16;
                    let right = request["right"].as_u64().unwrap() as usize * 16;
                    let stored = if let Some(id) = request["spool"].as_u64() {
                        spools.get_mut(&id).unwrap()
                    } else {
                        &mut index
                    };
                    for byte in 0..16 {
                        stored.swap(left + byte, right + byte);
                    }
                    Vec::new()
                }
                "write" => {
                    if let Some(id) = request["spool"].as_u64() {
                        spools.entry(id).or_default().extend(payload);
                    } else {
                        buckets[request["bucket"].as_u64().unwrap() as usize].extend(payload);
                    }
                    Vec::new()
                }
                "close" => {
                    spools.remove(&request["spool"].as_u64().unwrap());
                    Vec::new()
                }
                _ => unreachable!(),
            };
            let mut out = Vec::new();
            stream.respond(b"{}", &response, &mut out).unwrap();
            assert!(out.len() <= WORK);
            output.extend(out);
        }
        (output, buckets)
    }

    #[test]
    fn record_plan_scattering_and_indexing_preserve_the_permutation() {
        let mut data = Vec::new();
        for byte in b"abc" {
            data.extend(std::iter::repeat_n(*byte, MEMORY as usize + 7));
            data.push(b'\n');
        }
        let config =
            json!({"mode":"records", "separator":10, "size":data.len(), "available":3, "need":3});
        let row = MEMORY as usize + 8;
        let expected = [&data[row..], &data[..row]].concat();
        assert_eq!(drive(config, &data, b"").0, expected);
        let config = json!({"mode":"records", "separator":10, "size":data.len(), "available":3, "need":2, "repeat":true});
        assert_eq!(drive(config, &data, b"").0, data[..row].repeat(2));
        let config = json!({"mode":"records", "separator":10, "size":row, "available":1, "need":1});
        assert_eq!(drive(config, &data[..row], b"").0, data[..row]);
    }

    #[test]
    fn spilled_index_shuffle_keeps_the_injected_permutation_without_an_order_vector() {
        let config = json!({"mode":"indexed","separator":10,"size":3,"available":3,"need":3});
        let mut stream = create(serde_json::from_value(config).unwrap());
        stream.phase = Phase::Shuffle;
        stream.shuffle_left = 3;
        let mut index = Vec::new();
        for at in 0..3u64 {
            index.extend_from_slice(&at.to_le_bytes());
            index.extend_from_slice(&1u64.to_le_bytes());
        }
        assert_eq!(
            drive_stream(Box::new(stream), b"abc", &index).0,
            b"b\nc\na\n"
        );
        let config = json!({"mode":"indexed","separator":10,"available":MAX_LINES+1,"need":1});
        let mut stream = create(serde_json::from_value(config).unwrap());
        stream.drain(&mut Vec::new()).unwrap();
        assert!(stream.order.is_empty());
        assert!(matches!(stream.request, Some(Request::Random { .. })));
    }

    #[test]
    fn shuffle_and_draw_use_the_same_injected_indices() {
        let data = b"a\nb\nc\n";
        let config =
            json!({"mode":"shuffle", "separator":10,"size":data.len(),"available":3,"need":3});
        assert_eq!(drive(config, data, b"").0, b"b\nc\na\n");
        let config = json!({"mode":"draw", "separator":10,"size":data.len(),"available":3,"need":5,"repeat":true});
        assert_eq!(drive(config, data, b"").0, b"a\na\na\na\na\n");
    }

    #[test]
    fn output_windows_do_not_drop_a_range_pick() {
        let count = 10_000;
        let config = json!({"mode":"range","separator":0,"low":u64::MAX.to_string(),"high":u64::MAX.to_string(),"need":count,"repeat":true});
        let expected = format!("{}\0", u64::MAX).repeat(count);
        assert_eq!(drive(config, b"", b"").0, expected.as_bytes());
    }

    #[test]
    fn scatter_carries_only_a_bucket_across_a_large_record() {
        let mut data = vec![b'x'; 3 * WORK + 7];
        data.extend_from_slice(b"\n\nend\n");
        let config = json!({"mode":"scatter", "separator":10,"size":data.len()});
        let (out, buckets) = drive(config, &data, b"");
        assert!(out.is_empty());
        assert_eq!(buckets[0], data);
        assert!(buckets[1..].iter().all(Vec::is_empty));
    }

    #[test]
    fn indexed_records_keep_embedded_separators_and_stream_large_records() {
        let data = b"one\ntwo\0three".repeat(WORK);
        let mut index = Vec::new();
        index.extend_from_slice(&0u64.to_le_bytes());
        index.extend_from_slice(&(data.len() as u64).to_le_bytes());
        let config =
            json!({"mode":"indexed","separator":10,"size":data.len(),"available":1,"need":1});
        let mut expected = data.clone();
        expected.push(b'\n');
        assert_eq!(drive(config, &data, &index).0, expected);
    }

    #[test]
    fn index_and_count_are_independent_of_input_splits() {
        let input = b"\0x\0\xfflast";
        for width in 1..=input.len() {
            let chunks: Vec<_> = input.chunks(width).collect();
            assert_eq!(
                crate::run("shuf", r#"{"mode":"count","separator":0}"#, &chunks).0,
                b"3"
            );
            let mut expected = Vec::new();
            for (start, len) in [(0u64, 0u64), (1, 1), (3, 5)] {
                expected.extend_from_slice(&start.to_le_bytes());
                expected.extend_from_slice(&len.to_le_bytes());
            }
            assert_eq!(
                crate::run("shuf", r#"{"mode":"index","separator":0}"#, &chunks).0,
                expected
            );
        }
    }
}
