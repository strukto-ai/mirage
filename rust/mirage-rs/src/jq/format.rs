use std::cmp::Ordering;
use std::collections::{BTreeMap, LinkedList};

use serde::Deserialize;

use crate::{Stream, StreamError};

const LIMIT: usize = 16 * 1024;
const STEP: usize = 64;
const BLOCK: usize = 4096;
const NUL_REFUSAL: &str = "Cannot dump a string containing NUL with --raw-output0 option";

#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct Config {
    compact: bool,
    raw_output: bool,
    join_output: bool,
    nul_output: bool,
    ascii_output: bool,
    sort_keys: bool,
    tab: bool,
    indent: u8,
    seq: bool,
    separator: bool,
    check_only: bool,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            compact: false,
            raw_output: false,
            join_output: false,
            nul_output: false,
            ascii_output: false,
            sort_keys: false,
            tab: false,
            indent: 2,
            seq: false,
            separator: true,
            check_only: false,
        }
    }
}

pub fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    Ok(Box::new(Formatter::new(crate::parse_config(config)?)))
}

#[derive(Default)]
struct Source {
    chunks: BTreeMap<usize, Box<[u8]>>,
    len: usize,
}

impl Source {
    fn append(&mut self, input: &[u8]) {
        for bytes in input.chunks(BLOCK) {
            self.chunks.insert(self.len, bytes.into());
            self.len += bytes.len();
        }
    }

    fn byte(&self, at: usize) -> u8 {
        let (start, bytes) = self.chunks.range(..=at).next_back().expect("source span");
        bytes[at - start]
    }
}

#[derive(Clone, Copy, Default)]
struct Span {
    start: usize,
    end: usize,
}

type Id = usize;

struct Node {
    span: Span,
    next: Option<Id>,
    kind: Kind,
}

enum Kind {
    Literal,
    String,
    Array(Children),
    Object(Children),
    Member { key: Span, value: Id },
}

#[derive(Default)]
struct Children {
    head: Option<Id>,
    tail: Option<Id>,
    len: usize,
}

#[derive(Default)]
struct Arena {
    nodes: BTreeMap<Id, Node>,
    count: usize,
}

impl Arena {
    fn add(&mut self, span: Span, kind: Kind) -> Id {
        let id = self.count;
        self.count += 1;
        self.nodes.insert(
            id,
            Node {
                span,
                next: None,
                kind,
            },
        );
        id
    }

    fn node(&self, id: Id) -> &Node {
        self.nodes.get(&id).expect("node id")
    }

    fn node_mut(&mut self, id: Id) -> &mut Node {
        self.nodes.get_mut(&id).expect("node id")
    }

    fn children(&self, id: Id) -> &Children {
        match &self.node(id).kind {
            Kind::Array(children) | Kind::Object(children) => children,
            _ => unreachable!("container id"),
        }
    }

    fn children_mut(&mut self, id: Id) -> &mut Children {
        match &mut self.node_mut(id).kind {
            Kind::Array(children) | Kind::Object(children) => children,
            _ => unreachable!("container id"),
        }
    }

    fn append(&mut self, parent: Id, child: Id) {
        if let Some(tail) = self.children(parent).tail {
            self.node_mut(tail).next = Some(child);
        } else {
            self.children_mut(parent).head = Some(child);
        }
        let children = self.children_mut(parent);
        children.tail = Some(child);
        children.len += 1;
    }

    fn key(&self, id: Id) -> Span {
        match self.node(id).kind {
            Kind::Member { key, .. } => key,
            _ => unreachable!("member id"),
        }
    }
}

struct BuildFrame {
    id: Id,
    key: Option<Span>,
}

enum Token {
    String { start: usize, escaped: bool },
    Literal { start: usize },
}

#[derive(Default)]
struct Indexer {
    at: usize,
    stack: LinkedList<BuildFrame>,
    token: Option<Token>,
    root: Option<Id>,
}

impl Indexer {
    fn attach(&mut self, arena: &mut Arena, span: Span, kind: Kind) -> Id {
        let id = arena.add(span, kind);
        if let Some(parent) = self.stack.back_mut() {
            let child = match &arena.node(parent.id).kind {
                Kind::Object(_) => {
                    let key = parent.key.take().expect("trusted object key");
                    arena.add(Span::default(), Kind::Member { key, value: id })
                }
                _ => id,
            };
            arena.append(parent.id, child);
        } else {
            self.root = Some(id);
        }
        id
    }

    fn string(&mut self, arena: &mut Arena, span: Span) {
        match self.stack.back_mut() {
            Some(parent)
                if matches!(arena.node(parent.id).kind, Kind::Object(_))
                    && parent.key.is_none() =>
            {
                parent.key = Some(span);
                return;
            }
            _ => {}
        }
        self.attach(arena, span, Kind::String);
    }

    fn step(&mut self, source: &Source, arena: &mut Arena) -> bool {
        if self.at == source.len {
            if let Some(Token::Literal { start }) = self.token.take() {
                self.attach(
                    arena,
                    Span {
                        start,
                        end: self.at,
                    },
                    Kind::Literal,
                );
            }
            return true;
        }
        let byte = source.byte(self.at);
        match self.token.take() {
            Some(Token::String { start, escaped }) => {
                self.at += 1;
                if byte == b'"' && !escaped {
                    self.string(
                        arena,
                        Span {
                            start,
                            end: self.at,
                        },
                    );
                } else {
                    self.token = Some(Token::String {
                        start,
                        escaped: byte == b'\\' && !escaped,
                    });
                }
            }
            Some(Token::Literal { start }) => {
                if matches!(
                    byte,
                    b',' | b']' | b'}' | b':' | b' ' | b'\n' | b'\r' | b'\t'
                ) {
                    self.attach(
                        arena,
                        Span {
                            start,
                            end: self.at,
                        },
                        Kind::Literal,
                    );
                } else {
                    self.at += 1;
                    self.token = Some(Token::Literal { start });
                }
            }
            None => {
                let start = self.at;
                self.at += 1;
                match byte {
                    b'"' => {
                        self.token = Some(Token::String {
                            start,
                            escaped: false,
                        })
                    }
                    b'[' | b'{' => {
                        let kind = if byte == b'[' {
                            Kind::Array(Children::default())
                        } else {
                            Kind::Object(Children::default())
                        };
                        let id = self.attach(arena, Span { start, end: 0 }, kind);
                        self.stack.push_back(BuildFrame { id, key: None });
                    }
                    b']' | b'}' => {
                        let frame = self.stack.pop_back().expect("trusted container close");
                        arena.node_mut(frame.id).span.end = self.at;
                    }
                    b',' | b':' | b' ' | b'\n' | b'\r' | b'\t' => {}
                    _ => self.token = Some(Token::Literal { start }),
                }
            }
        }
        false
    }
}

fn hex(source: &Source, start: usize) -> u32 {
    let mut value = 0;
    for at in start..start + 4 {
        value = value * 16
            + match source.byte(at) {
                byte @ b'0'..=b'9' => u32::from(byte - b'0'),
                byte @ b'a'..=b'f' => u32::from(byte - b'a' + 10),
                byte @ b'A'..=b'F' => u32::from(byte - b'A' + 10),
                _ => unreachable!("trusted unicode escape"),
            };
    }
    value
}

fn point(source: &Source, at: &mut usize) -> u32 {
    let first = source.byte(*at);
    *at += 1;
    if first == b'\\' {
        let escaped = source.byte(*at);
        *at += 1;
        return match escaped {
            b'"' | b'\\' | b'/' => u32::from(escaped),
            b'b' => 8,
            b'f' => 12,
            b'n' => 10,
            b'r' => 13,
            b't' => 9,
            b'u' => {
                let high = hex(source, *at);
                *at += 4;
                if (0xd800..=0xdbff).contains(&high) {
                    let low = hex(source, *at + 2);
                    *at += 6;
                    0x10000 + ((high - 0xd800) << 10) + low - 0xdc00
                } else if (0xdc00..=0xdfff).contains(&high) {
                    0xfffd
                } else {
                    high
                }
            }
            _ => unreachable!("trusted string escape"),
        };
    }
    if first < 0x80 {
        return u32::from(first);
    }
    let (mut value, rest) = if first < 0xe0 {
        (u32::from(first & 0x1f), 1)
    } else if first < 0xf0 {
        (u32::from(first & 0xf), 2)
    } else {
        (u32::from(first & 7), 3)
    };
    for _ in 0..rest {
        value = (value << 6) | u32::from(source.byte(*at) & 0x3f);
        *at += 1;
    }
    value
}

struct Comparison {
    left: Span,
    right: Span,
}

impl Comparison {
    fn new(left: Span, right: Span) -> Self {
        Self {
            left: Span {
                start: left.start + 1,
                end: left.end - 1,
            },
            right: Span {
                start: right.start + 1,
                end: right.end - 1,
            },
        }
    }

    fn step(&mut self, source: &Source) -> Option<Ordering> {
        match (
            self.left.start == self.left.end,
            self.right.start == self.right.end,
        ) {
            (true, true) => Some(Ordering::Equal),
            (true, false) => Some(Ordering::Less),
            (false, true) => Some(Ordering::Greater),
            (false, false) => {
                let order =
                    point(source, &mut self.left.start).cmp(&point(source, &mut self.right.start));
                (order != Ordering::Equal).then_some(order)
            }
        }
    }
}

enum MergePhase {
    NextRun,
    Split { at: Option<Id>, remaining: usize },
    Merge,
}

struct MergeSort {
    object: Id,
    width: usize,
    input: Option<Id>,
    left: Option<Id>,
    right: Option<Id>,
    left_len: usize,
    right_len: usize,
    head: Option<Id>,
    tail: Option<Id>,
    runs: usize,
    phase: MergePhase,
    comparison: Option<Comparison>,
}

impl MergeSort {
    fn new(object: Id, arena: &Arena) -> Self {
        Self {
            object,
            width: 1,
            input: arena.children(object).head,
            left: None,
            right: None,
            left_len: 0,
            right_len: 0,
            head: None,
            tail: None,
            runs: 0,
            phase: MergePhase::NextRun,
            comparison: None,
        }
    }

    fn take(&mut self, arena: &mut Arena, left: bool) {
        let id = if left {
            let id = self.left.expect("left run");
            self.left = arena.node(id).next;
            self.left_len -= 1;
            id
        } else {
            let id = self.right.expect("right run");
            self.right = arena.node(id).next;
            self.right_len -= 1;
            id
        };
        if let Some(tail) = self.tail {
            arena.node_mut(tail).next = Some(id);
        } else {
            self.head = Some(id);
        }
        self.tail = Some(id);
    }

    fn step(&mut self, source: &Source, arena: &mut Arena) -> bool {
        match self.phase {
            MergePhase::NextRun => {
                if self.input.is_none() {
                    if let Some(tail) = self.tail {
                        arena.node_mut(tail).next = None;
                    }
                    if self.runs <= 1 {
                        let children = arena.children_mut(self.object);
                        children.head = self.head;
                        children.tail = self.tail;
                        return true;
                    }
                    self.width = self.width.saturating_mul(2);
                    self.input = self.head;
                    self.head = None;
                    self.tail = None;
                    self.runs = 0;
                } else {
                    self.runs += 1;
                    self.left = self.input;
                    self.left_len = 0;
                    self.phase = MergePhase::Split {
                        at: self.input,
                        remaining: self.width,
                    };
                }
            }
            MergePhase::Split { at, remaining } => {
                if let Some(id) = at.filter(|_| remaining != 0) {
                    self.left_len += 1;
                    self.phase = MergePhase::Split {
                        at: arena.node(id).next,
                        remaining: remaining - 1,
                    };
                } else {
                    self.right = at;
                    self.right_len = self.width;
                    self.phase = MergePhase::Merge;
                }
            }
            MergePhase::Merge => {
                if self.left_len == 0 && (self.right_len == 0 || self.right.is_none()) {
                    self.input = self.right;
                    self.phase = MergePhase::NextRun;
                } else if self.left_len == 0 {
                    self.take(arena, false);
                } else if self.right_len == 0 || self.right.is_none() {
                    self.take(arena, true);
                } else {
                    let comparison = self.comparison.get_or_insert_with(|| {
                        Comparison::new(
                            arena.key(self.left.expect("left run")),
                            arena.key(self.right.expect("right run")),
                        )
                    });
                    if let Some(order) = comparison.step(source) {
                        self.comparison = None;
                        self.take(arena, order != Ordering::Greater);
                    }
                }
            }
        }
        false
    }
}

#[derive(Default)]
struct Sorter {
    next: Id,
    active: Option<MergeSort>,
}

impl Sorter {
    fn step(&mut self, source: &Source, arena: &mut Arena) -> bool {
        if let Some(active) = &mut self.active {
            if active.step(source, arena) {
                self.active = None;
                self.next += 1;
            }
        } else if self.next == arena.count {
            return true;
        } else if matches!(&arena.node(self.next).kind, Kind::Object(children) if children.len > 1)
        {
            self.active = Some(MergeSort::new(self.next, arena));
        } else {
            self.next += 1;
        }
        false
    }
}

enum Action {
    Node {
        id: Id,
        depth: usize,
    },
    Items {
        at: Id,
        depth: usize,
        first: bool,
    },
    Close {
        byte: u8,
        depth: usize,
        nonempty: bool,
    },
    Copy {
        span: Span,
        ascii: bool,
    },
    Raw(Span),
    Repeat {
        byte: u8,
        remaining: usize,
    },
    Byte(u8),
}

#[derive(Default)]
struct Renderer {
    actions: LinkedList<Action>,
}

impl Renderer {
    fn byte(&mut self, byte: u8) {
        self.actions.push_front(Action::Byte(byte));
    }

    fn line(&mut self, options: &Config, depth: usize) {
        let (byte, width) = if options.tab {
            (b'\t', 1)
        } else {
            (b' ', usize::from(options.indent))
        };
        self.actions.push_front(Action::Repeat {
            byte,
            remaining: depth.saturating_mul(width),
        });
        self.byte(b'\n');
    }

    fn step(
        &mut self,
        options: &Config,
        source: &Source,
        arena: &Arena,
        out: &mut Vec<u8>,
    ) -> bool {
        let Some(action) = self.actions.pop_front() else {
            return true;
        };
        match action {
            Action::Byte(byte) => out.push(byte),
            Action::Repeat { byte, remaining } => {
                if remaining != 0 {
                    out.push(byte);
                    self.actions.push_front(Action::Repeat {
                        byte,
                        remaining: remaining - 1,
                    });
                }
            }
            Action::Raw(mut span) => {
                if span.start != span.end {
                    let value = point(source, &mut span.start);
                    let mut buffer = [0; 4];
                    out.extend_from_slice(
                        char::from_u32(value)
                            .expect("trusted scalar")
                            .encode_utf8(&mut buffer)
                            .as_bytes(),
                    );
                    self.actions.push_front(Action::Raw(span));
                }
            }
            Action::Copy { mut span, ascii } => {
                if span.start != span.end {
                    let byte = source.byte(span.start);
                    if ascii && byte >= 0x80 {
                        let value = point(source, &mut span.start);
                        if value < 0x10000 {
                            escape(out, value as u16);
                        } else {
                            let value = value - 0x10000;
                            escape(out, 0xd800 | (value >> 10) as u16);
                            escape(out, 0xdc00 | (value & 0x3ff) as u16);
                        }
                    } else {
                        out.push(byte);
                        span.start += 1;
                    }
                    self.actions.push_front(Action::Copy { span, ascii });
                }
            }
            Action::Node { id, depth } => {
                let node = arena.node(id);
                match &node.kind {
                    Kind::Literal | Kind::String => self.actions.push_front(Action::Copy {
                        span: node.span,
                        ascii: options.ascii_output,
                    }),
                    Kind::Array(children) | Kind::Object(children) => {
                        let object = matches!(node.kind, Kind::Object(_));
                        self.actions.push_front(Action::Close {
                            byte: if object { b'}' } else { b']' },
                            depth,
                            nonempty: children.head.is_some(),
                        });
                        if let Some(at) = children.head {
                            self.actions.push_front(Action::Items {
                                at,
                                depth: depth + 1,
                                first: true,
                            });
                        }
                        self.byte(if object { b'{' } else { b'[' });
                    }
                    Kind::Member { .. } => unreachable!("value node"),
                }
            }
            Action::Items { at, depth, first } => {
                let node = arena.node(at);
                if let Some(next) = node.next {
                    self.actions.push_front(Action::Items {
                        at: next,
                        depth,
                        first: false,
                    });
                }
                match node.kind {
                    Kind::Member { key, value } => {
                        self.actions.push_front(Action::Node { id: value, depth });
                        if !options.compact {
                            self.byte(b' ');
                        }
                        self.byte(b':');
                        self.actions.push_front(Action::Copy {
                            span: key,
                            ascii: options.ascii_output,
                        });
                    }
                    _ => self.actions.push_front(Action::Node { id: at, depth }),
                }
                if !options.compact {
                    self.line(options, depth);
                }
                if !first {
                    self.byte(b',');
                }
            }
            Action::Close {
                byte,
                depth,
                nonempty,
            } => {
                self.byte(byte);
                if nonempty && !options.compact {
                    self.line(options, depth);
                }
            }
        }
        false
    }
}

fn escape(out: &mut Vec<u8>, value: u16) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.extend_from_slice(b"\\u");
    for shift in [12, 8, 4, 0] {
        out.push(HEX[usize::from((value >> shift) & 15)]);
    }
}

#[derive(Default)]
struct Lexical {
    at: usize,
    depth: usize,
    string: bool,
    escaped: bool,
    pending: Renderer,
}

impl Lexical {
    fn step(&mut self, options: &Config, source: &Source, out: &mut Vec<u8>) -> bool {
        if !self.pending.actions.is_empty() {
            self.pending.step(options, source, &Arena::default(), out);
            return false;
        }
        if self.at == source.len {
            return true;
        }
        let byte = source.byte(self.at);
        self.at += 1;
        if self.string {
            if options.ascii_output && byte >= 0x80 {
                self.at -= 1;
                let value = point(source, &mut self.at);
                if value < 0x10000 {
                    escape(out, value as u16);
                } else {
                    let value = value - 0x10000;
                    escape(out, 0xd800 | (value >> 10) as u16);
                    escape(out, 0xdc00 | (value & 0x3ff) as u16);
                }
            } else {
                out.push(byte);
            }
            if byte == b'"' && !self.escaped {
                self.string = false;
            }
            self.escaped = byte == b'\\' && !self.escaped;
        } else if byte == b'"' {
            out.push(byte);
            self.string = true;
        } else if options.compact {
            out.push(byte);
        } else {
            match byte {
                b'[' | b'{' => {
                    out.push(byte);
                    if self.at < source.len && !matches!(source.byte(self.at), b']' | b'}') {
                        self.depth += 1;
                        self.pending.line(options, self.depth);
                    }
                }
                b']' | b'}' => {
                    if self.at >= 2 && matches!(source.byte(self.at - 2), b'[' | b'{') {
                        out.push(byte);
                    } else {
                        self.depth -= 1;
                        self.pending.byte(byte);
                        self.pending.line(options, self.depth);
                    }
                }
                b',' => {
                    out.push(byte);
                    self.pending.line(options, self.depth);
                }
                b':' => {
                    out.extend_from_slice(b": ");
                }
                _ => out.push(byte),
            }
        }
        false
    }
}

enum State {
    Reading,
    Checking { at: usize, end: usize },
    Indexing(Indexer),
    Sorting { root: Id, sorter: Sorter },
    Rendering(Renderer),
    Lexical(Lexical),
    Cleanup { refused: bool },
    Discarding(Box<State>),
    Finished,
}

struct Formatter {
    options: Config,
    source: Source,
    arena: Arena,
    state: State,
}

impl Formatter {
    fn new(options: Config) -> Self {
        Self {
            options,
            source: Source::default(),
            arena: Arena::default(),
            state: State::Reading,
        }
    }

    fn render(&mut self, out: &mut Vec<u8>) {
        if self.options.check_only {
            self.state = State::Cleanup { refused: false };
            return;
        }
        let string = self.source.byte(0) == b'"';
        let raw = self.options.raw_output && string;
        if self.options.separator && self.options.seq && !raw {
            out.push(0x1e);
        }
        if raw && !self.options.ascii_output {
            let mut renderer = Renderer::default();
            renderer.actions.push_front(Action::Raw(Span {
                start: 1,
                end: self.source.len - 1,
            }));
            self.state = State::Rendering(renderer);
        } else if self.options.sort_keys && !raw {
            self.state = State::Indexing(Indexer::default());
        } else {
            self.state = State::Lexical(Lexical::default());
        }
    }

    fn ended(&mut self, out: &mut Vec<u8>) {
        if self.options.separator {
            if self.options.nul_output {
                out.push(0);
            } else if !self.options.join_output {
                out.push(b'\n');
            }
        }
        self.state = State::Cleanup { refused: false };
    }

    fn step(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        for _ in 0..LIMIT / STEP {
            match std::mem::replace(&mut self.state, State::Finished) {
                State::Reading => {
                    self.state = State::Reading;
                    break;
                }
                State::Finished => break,
                State::Checking { mut at, end } => {
                    if at == end {
                        self.render(out);
                    } else if point(&self.source, &mut at) == 0 {
                        self.state = State::Cleanup { refused: true };
                    } else {
                        self.state = State::Checking { at, end };
                    }
                }
                State::Indexing(mut indexer) => {
                    if indexer.step(&self.source, &mut self.arena) {
                        self.state = State::Sorting {
                            root: indexer.root.expect("trusted document"),
                            sorter: Sorter::default(),
                        };
                    } else {
                        self.state = State::Indexing(indexer);
                    }
                }
                State::Sorting { root, mut sorter } => {
                    if sorter.step(&self.source, &mut self.arena) {
                        let mut renderer = Renderer::default();
                        renderer
                            .actions
                            .push_front(Action::Node { id: root, depth: 0 });
                        self.state = State::Rendering(renderer);
                    } else {
                        self.state = State::Sorting { root, sorter };
                    }
                }
                State::Rendering(mut renderer) => {
                    if renderer.step(&self.options, &self.source, &self.arena, out) {
                        self.ended(out);
                    } else {
                        self.state = State::Rendering(renderer);
                    }
                }
                State::Lexical(mut lexical) => {
                    if lexical.step(&self.options, &self.source, out) {
                        self.ended(out);
                    } else {
                        self.state = State::Lexical(lexical);
                    }
                }
                State::Discarding(mut previous) => {
                    let more = match previous.as_mut() {
                        State::Indexing(indexer) => indexer.stack.pop_front().is_some(),
                        State::Rendering(renderer) => renderer.actions.pop_front().is_some(),
                        _ => false,
                    };
                    self.state = if more {
                        State::Discarding(previous)
                    } else {
                        State::Cleanup { refused: false }
                    };
                }
                State::Cleanup { refused } => {
                    if self.arena.nodes.pop_first().is_some()
                        || self.source.chunks.pop_first().is_some()
                    {
                        self.state = State::Cleanup { refused };
                    } else {
                        self.source.len = 0;
                        self.arena.count = 0;
                        if refused {
                            return Err(StreamError::new(NUL_REFUSAL));
                        }
                        break;
                    }
                }
            }
        }
        Ok(())
    }
}

impl Stream for Formatter {
    fn feed(&mut self, input: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        if !matches!(self.state, State::Reading) {
            return Err(StreamError::new("jq formatter input has ended"));
        }
        if input.len() > LIMIT {
            return Err(StreamError::new(
                "jq formatter input chunk exceeds 16384 bytes",
            ));
        }
        self.source.append(input);
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if matches!(self.state, State::Reading) {
            if self.source.len == 0 {
                return Err(StreamError::new("jq formatter requires one compact value"));
            }
            if (self.options.separator || self.options.check_only)
                && self.options.nul_output
                && !self.options.ascii_output
                && self.source.byte(0) == b'"'
            {
                self.state = State::Checking {
                    at: 1,
                    end: self.source.len - 1,
                };
            } else {
                self.render(out);
            }
        }
        self.step(out)
    }

    fn busy(&self) -> bool {
        !matches!(self.state, State::Reading | State::Finished)
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.step(out)
    }

    fn begin(&mut self, config: &[u8]) -> Result<(), StreamError> {
        let config: super::BeginConfig = crate::parse_config(config)?;
        if config.discard {
            if !matches!(self.state, State::Discarding(_)) {
                let previous = std::mem::replace(&mut self.state, State::Finished);
                self.state = State::Discarding(Box::new(previous));
            }
            return Ok(());
        }
        if !matches!(self.state, State::Finished) {
            return Err(StreamError::new("jq formatter value has not finished"));
        }
        self.state = State::Reading;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::{LIMIT, NUL_REFUSAL, open};
    use crate::{Stream, StreamError};

    const DOC: &str = "{\"b\":1.000,\"1\":[1E+2,-0,{},[]],\"a\":[],\"é\":\"ü😀\\u007f\"}";

    fn drain(stream: &mut dyn Stream, out: &mut Vec<u8>) -> Result<usize, StreamError> {
        let mut calls = 0;
        while stream.busy() {
            let before = out.len();
            stream.drain(out)?;
            assert!(out.len() - before <= LIMIT);
            calls += 1;
            assert!(calls < 10_000_000);
        }
        Ok(calls)
    }

    fn value(
        stream: &mut dyn Stream,
        text: &[u8],
        out: &mut Vec<u8>,
        size: usize,
    ) -> Result<usize, StreamError> {
        for piece in text.chunks(size) {
            let before = out.len();
            stream.feed(piece, out)?;
            assert!(out.len() - before <= LIMIT);
            drain(stream, out)?;
        }
        let before = out.len();
        stream.finish(out)?;
        assert!(out.len() - before <= LIMIT);
        drain(stream, out)
    }

    fn formatted(text: &str, config: &str) -> Vec<u8> {
        let mut stream = open(config.as_bytes()).unwrap();
        let mut out = Vec::new();
        value(stream.as_mut(), text.as_bytes(), &mut out, 7).unwrap();
        out
    }

    #[test]
    fn preflight_without_a_separator_still_refuses_nul() {
        let mut stream =
            open(br#"{"check_only":true,"separator":false,"nul_output":true}"#).unwrap();
        let mut out = Vec::new();
        let result = value(stream.as_mut(), br#""a\u0000b""#, &mut out, LIMIT);
        assert_eq!(result.unwrap_err().message, NUL_REFUSAL);
        assert!(out.is_empty());
    }

    #[test]
    fn abandonment_drains_index_and_source_before_reuse() {
        let text = format!("{}0{}", "[".repeat(20_000), "]".repeat(20_000));
        let mut stream = open(br#"{"sort_keys":true,"compact":true}"#).unwrap();
        let mut out = Vec::new();
        for piece in text.as_bytes().chunks(LIMIT) {
            stream.feed(piece, &mut out).unwrap();
        }
        stream.finish(&mut out).unwrap();
        stream.begin(br#"{"discard":true}"#).unwrap();
        out.clear();
        let calls = drain(stream.as_mut(), &mut out).unwrap();
        assert!(calls > 1);
        assert!(out.is_empty());
        stream.begin(b"{}").unwrap();
        value(stream.as_mut(), b"1.000", &mut out, LIMIT).unwrap();
        assert_eq!(out, b"1.000\n");
    }

    #[test]
    fn exact_layout_flags() {
        let fixtures = [
            (
                "{}",
                "{\n  \"b\": 1.000,\n  \"1\": [\n    1E+2,\n    -0,\n    {},\n    []\n  ],\n  \"a\": [],\n  \"é\": \"ü😀\\u007f\"\n}\n",
            ),
            (
                r#"{"compact":true}"#,
                "{\"b\":1.000,\"1\":[1E+2,-0,{},[]],\"a\":[],\"é\":\"ü😀\\u007f\"}\n",
            ),
            (
                r#"{"sort_keys":true}"#,
                "{\n  \"1\": [\n    1E+2,\n    -0,\n    {},\n    []\n  ],\n  \"a\": [],\n  \"b\": 1.000,\n  \"é\": \"ü😀\\u007f\"\n}\n",
            ),
            (
                r#"{"compact":true,"sort_keys":true}"#,
                "{\"1\":[1E+2,-0,{},[]],\"a\":[],\"b\":1.000,\"é\":\"ü😀\\u007f\"}\n",
            ),
            (
                r#"{"tab":true}"#,
                "{\n\t\"b\": 1.000,\n\t\"1\": [\n\t\t1E+2,\n\t\t-0,\n\t\t{},\n\t\t[]\n\t],\n\t\"a\": [],\n\t\"é\": \"ü😀\\u007f\"\n}\n",
            ),
            (
                r#"{"indent":0}"#,
                "{\n\"b\": 1.000,\n\"1\": [\n1E+2,\n-0,\n{},\n[]\n],\n\"a\": [],\n\"é\": \"ü😀\\u007f\"\n}\n",
            ),
            (
                r#"{"indent":7}"#,
                "{\n       \"b\": 1.000,\n       \"1\": [\n              1E+2,\n              -0,\n              {},\n              []\n       ],\n       \"a\": [],\n       \"é\": \"ü😀\\u007f\"\n}\n",
            ),
            (
                r#"{"ascii_output":true}"#,
                "{\n  \"b\": 1.000,\n  \"1\": [\n    1E+2,\n    -0,\n    {},\n    []\n  ],\n  \"a\": [],\n  \"\\u00e9\": \"\\u00fc\\ud83d\\ude00\\u007f\"\n}\n",
            ),
            (
                r#"{"ascii_output":true,"sort_keys":true,"tab":true}"#,
                "{\n\t\"1\": [\n\t\t1E+2,\n\t\t-0,\n\t\t{},\n\t\t[]\n\t],\n\t\"a\": [],\n\t\"b\": 1.000,\n\t\"\\u00e9\": \"\\u00fc\\ud83d\\ude00\\u007f\"\n}\n",
            ),
        ];
        for (config, expected) in fixtures {
            assert_eq!(formatted(DOC, config), expected.as_bytes(), "{config}");
        }
    }

    #[test]
    fn raw_strings_decode_escape_and_unicode_pairs() {
        assert_eq!(
            formatted(r#""ü😀\u007f\u0000""#, r#"{"raw_output":true}"#),
            "ü😀\u{7f}\0\n".as_bytes()
        );
        assert_eq!(
            formatted(
                r#""\"\\\/\b\f\n\r\t\u00fc\ud83d\ude00""#,
                r#"{"raw_output":true}"#
            ),
            "\"\\/\u{8}\u{c}\n\r\tü😀\n".as_bytes()
        );
        assert_eq!(
            formatted(
                r#""ü😀\u007f\u0000""#,
                r#"{"raw_output":true,"ascii_output":true,"seq":true}"#
            ),
            b"\"\\u00fc\\ud83d\\ude00\\u007f\\u0000\"\n"
        );
        assert_eq!(
            formatted("1.000", r#"{"raw_output":true,"compact":true,"seq":true}"#),
            b"\x1e1.000\n"
        );
        assert_eq!(
            formatted(
                r#""a""#,
                r#"{"raw_output":true,"join_output":true,"nul_output":true}"#
            ),
            b"a\0"
        );
        assert_eq!(
            formatted(r#""a""#, r#"{"raw_output":true,"join_output":true}"#),
            b"a"
        );
    }

    #[test]
    fn sorting_decodes_keys_but_keeps_numeric_text() {
        let text = r#"{"é":1,"z":2,"a\"":3,"😀":4,"ｚ":5,"\u0001":6,"2":1e+9999999,"10":999999999999999999999999999999.000}"#;
        let expected = "{\"\\u0001\":6,\"10\":999999999999999999999999999999.000,\"2\":1e+9999999,\"a\\\"\":3,\"z\":2,\"é\":1,\"ｚ\":5,\"😀\":4}\n";
        assert_eq!(
            formatted(text, r#"{"compact":true,"sort_keys":true}"#),
            expected.as_bytes()
        );
        assert_eq!(
            formatted(
                r#"{"b":{"y":0,"x":-0},"a":[{"d":1.000,"c":1E+2}]}"#,
                r#"{"compact":true,"sort_keys":true}"#
            ),
            b"{\"a\":[{\"c\":1E+2,\"d\":1.000}],\"b\":{\"x\":-0,\"y\":0}}\n"
        );
    }

    #[test]
    fn sort_is_stable_when_escaped_keys_decode_equally() {
        assert_eq!(
            formatted(
                r#"{"b":0,"a":1,"\u0061":2,"a":3}"#,
                r#"{"compact":true,"sort_keys":true}"#
            ),
            b"{\"a\":1,\"\\u0061\":2,\"a\":3,\"b\":0}\n"
        );
        assert_eq!(
            formatted(
                r#"{"\ud83d\ude00":1,"ｚ":2,"\u00e9":3,"é":4}"#,
                r#"{"compact":true,"sort_keys":true}"#
            ),
            "{\"\\u00e9\":3,\"é\":4,\"ｚ\":2,\"\\ud83d\\ude00\":1}\n".as_bytes()
        );
    }

    #[test]
    fn nul_refusal_preserves_prior_values_and_allows_begin() {
        let mut stream = open(br#"{"raw_output":true,"nul_output":true}"#).unwrap();
        let mut out = Vec::new();
        value(stream.as_mut(), br#""first""#, &mut out, 1).unwrap();
        assert_eq!(out, b"first\0");
        stream.begin(b"{}").unwrap();
        assert_eq!(
            value(stream.as_mut(), br#""a\u0000b""#, &mut out, 1)
                .unwrap_err()
                .message,
            NUL_REFUSAL
        );
        assert_eq!(out, b"first\0");
        assert!(!stream.busy());
        stream.begin(b"{}").unwrap();
        value(stream.as_mut(), br#""a\\u0000""#, &mut out, 1).unwrap();
        assert_eq!(out, b"first\0a\\u0000\0");
        assert_eq!(
            formatted(r#""\u0000""#, r#"{"nul_output":true,"ascii_output":true}"#),
            b"\"\\u0000\"\0"
        );
    }

    #[test]
    fn check_only_owns_the_same_refusal_without_any_output() {
        assert!(formatted(DOC, r#"{"check_only":true,"sort_keys":true,"seq":true}"#).is_empty());
        assert!(formatted(r#""ok""#, r#"{"check_only":true,"nul_output":true}"#).is_empty());
        let mut stream = open(br#"{"check_only":true,"nul_output":true}"#).unwrap();
        let mut out = Vec::new();
        assert_eq!(
            value(stream.as_mut(), br#""bad\u0000""#, &mut out, 1)
                .unwrap_err()
                .message,
            NUL_REFUSAL
        );
        assert!(out.is_empty());
        stream.begin(b"{}").unwrap();
        value(stream.as_mut(), br#""ok""#, &mut out, 1).unwrap();
        assert!(out.is_empty());
        assert!(
            formatted(
                r#""\u0000""#,
                r#"{"check_only":true,"nul_output":true,"ascii_output":true}"#
            )
            .is_empty()
        );
    }

    #[test]
    fn dump_has_no_separators_or_raw_processing() {
        assert_eq!(
            formatted(
                r#""\u0000""#,
                r#"{"separator":false,"nul_output":true,"seq":true,"compact":true}"#
            ),
            b"\"\\u0000\""
        );
        assert_eq!(formatted("{}", r#"{"separator":false,"seq":true}"#), b"{}");
    }

    #[test]
    fn every_utf8_and_escape_split_keeps_the_same_output() {
        let text = r#"{"é":"😀\n\ud83d\ude00","\u0000":1,"a\\b":-0}"#;
        let config = r#"{"ascii_output":true,"sort_keys":true}"#;
        let expected = formatted(text, config);
        for at in 0..=text.len() {
            let mut stream = open(config.as_bytes()).unwrap();
            let mut out = Vec::new();
            stream.feed(&text.as_bytes()[..at], &mut out).unwrap();
            stream.feed(&text.as_bytes()[at..], &mut out).unwrap();
            stream.finish(&mut out).unwrap();
            drain(stream.as_mut(), &mut out).unwrap();
            assert_eq!(out, expected, "split {at}");
        }
    }

    #[test]
    fn deep_indentation_and_sorted_values_use_bounded_drains() {
        let text = "[".repeat(300) + "1.000" + &"]".repeat(300);
        for sorted in [false, true] {
            let config = format!(r#"{{"sort_keys":{sorted}}}"#);
            let mut stream = open(config.as_bytes()).unwrap();
            let mut out = Vec::new();
            let calls = value(stream.as_mut(), text.as_bytes(), &mut out, 37).unwrap();
            assert!(calls > 20);
            assert!(out.starts_with(b"[\n  [\n    ["));
            let middle = "\n".to_owned() + &" ".repeat(600) + "1.000\n";
            assert!(std::str::from_utf8(&out).unwrap().contains(&middle));
        }
        let text = "{\"b\":".repeat(300) + "{\"a\":1}" + &"}".repeat(300);
        assert_eq!(
            formatted(&text, r#"{"compact":true,"sort_keys":true}"#),
            (text + "\n").as_bytes()
        );
    }

    #[test]
    fn long_strings_keys_and_common_prefix_comparisons_yield() {
        let prefix = "x".repeat(40_000);
        let body = "ü😀".repeat(10_000);
        let text = format!("{{\"{prefix}z\":\"{body}\",\"{prefix}a\":1.000}}");
        let expected = format!("{{\"{prefix}a\":1.000,\"{prefix}z\":\"{body}\"}}\n");
        let mut stream = open(br#"{"compact":true,"sort_keys":true}"#).unwrap();
        let mut out = Vec::new();
        assert!(value(stream.as_mut(), text.as_bytes(), &mut out, LIMIT).unwrap() > 100);
        assert_eq!(out, expected.as_bytes());
        let raw = "\"".to_owned() + &body + "\"";
        assert_eq!(
            formatted(&raw, r#"{"raw_output":true,"join_output":true}"#),
            body.as_bytes()
        );
    }

    #[test]
    fn many_members_sort_across_merge_passes() {
        let text = "{".to_owned()
            + &(0..300)
                .rev()
                .map(|i| format!("\"{i:03}\":{i}"))
                .collect::<Vec<_>>()
                .join(",")
            + "}";
        let expected = "{".to_owned()
            + &(0..300)
                .map(|i| format!("\"{i:03}\":{i}"))
                .collect::<Vec<_>>()
                .join(",")
            + "}\n";
        assert_eq!(
            formatted(&text, r#"{"compact":true,"sort_keys":true}"#),
            expected.as_bytes()
        );
    }

    #[test]
    fn rejects_unknown_config_and_invalid_lifecycle() {
        assert!(open(br#"{"unknown":true}"#).is_err());
        let mut stream = open(b"{}").unwrap();
        assert!(stream.begin(b"{}").is_err());
        assert!(
            stream
                .feed(&vec![b'x'; LIMIT + 1], &mut Vec::new())
                .is_err()
        );
        let mut out = Vec::new();
        value(stream.as_mut(), b"[]", &mut out, 1).unwrap();
        assert!(stream.feed(b"[]", &mut out).is_err());
        assert!(stream.begin(br#"{"compact":true}"#).is_err());
        stream.begin(b"{}").unwrap();
        value(stream.as_mut(), b"{}", &mut out, 1).unwrap();
        assert_eq!(out, b"[]\n{}\n");
    }
}
