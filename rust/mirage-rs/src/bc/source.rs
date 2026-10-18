use std::collections::VecDeque;

use super::common::Budget;

pub(super) struct Line {
    pub(super) chars: Vec<char>,
    pub(super) lines: Vec<u64>,
    pub(super) end_line: u64,
    pub(super) quotes: Vec<usize>,
}

pub(super) enum FrontEvent {
    Program(Line),
    EofInComment,
    End,
}

pub(super) enum FrontStep {
    Pending,
    NeedsInput,
    Event(FrontEvent),
}

#[derive(Default)]
enum Mode {
    #[default]
    Normal,
    Slash,
    Hash,
    Block,
    BlockStar,
    Quote(VecDeque<char>),
}

#[derive(Default)]
pub(super) struct Source {
    bytes: VecDeque<u8>,
    replay: VecDeque<char>,
    quote_copy: VecDeque<char>,
    mode: Mode,
    chars: Vec<char>,
    lines: Vec<u64>,
    line: u64,
    quotes: Vec<usize>,
    eof: bool,
    ended: bool,
}

impl Source {
    pub(super) fn new() -> Self {
        Self {
            line: 1,
            ..Self::default()
        }
    }

    pub(super) fn feed(&mut self, input: &[u8]) {
        if !self.eof && !self.ended {
            self.bytes.extend(input);
        }
    }

    pub(super) fn finish(&mut self) {
        self.eof = true;
    }

    pub(super) fn busy(&self) -> bool {
        !self.ended
            && (!self.quote_copy.is_empty()
                || !self.replay.is_empty()
                || !self.bytes.is_empty()
                || self.eof)
    }

    fn append(&mut self, character: char) {
        self.chars.push(character);
        self.lines.push(self.line);
    }

    fn take_line(&mut self) -> Line {
        Line {
            chars: std::mem::take(&mut self.chars),
            lines: std::mem::take(&mut self.lines),
            end_line: self.line,
            quotes: std::mem::take(&mut self.quotes),
        }
    }

    fn decode(&mut self) -> Option<char> {
        if let Some(character) = self.replay.pop_front() {
            return Some(character);
        }
        let first = *self.bytes.front()?;
        if first < 0x80 {
            self.bytes.pop_front();
            return Some(char::from(first));
        }
        let length = match first {
            0xc2..=0xdf => 2,
            0xe0..=0xef => 3,
            0xf0..=0xf4 => 4,
            _ => {
                self.bytes.pop_front();
                return Some('\u{fffd}');
            }
        };
        let mut value = u32::from(first & (0x7f >> length));
        let mut consumed = 1;
        while consumed < length {
            let Some(&next) = self.bytes.get(consumed) else {
                if !self.eof {
                    return None;
                }
                break;
            };
            let valid = match (first, consumed) {
                (0xe0, 1) => (0xa0..=0xbf).contains(&next),
                (0xed, 1) => (0x80..=0x9f).contains(&next),
                (0xf0, 1) => (0x90..=0xbf).contains(&next),
                (0xf4, 1) => (0x80..=0x8f).contains(&next),
                _ => (0x80..=0xbf).contains(&next),
            };
            if !valid {
                break;
            }
            value = (value << 6) | u32::from(next & 0x3f);
            consumed += 1;
        }
        for _ in 0..consumed {
            self.bytes.pop_front();
        }
        Some(if consumed == length {
            char::from_u32(value).unwrap_or('\u{fffd}')
        } else {
            '\u{fffd}'
        })
    }

    pub(super) fn advance(&mut self, budget: &mut Budget) -> FrontStep {
        if self.ended {
            return FrontStep::NeedsInput;
        }
        while budget.take() {
            if let Some(character) = self.quote_copy.pop_front() {
                self.append(character);
                if character == '\n' {
                    self.line = self.line.saturating_add(1);
                }
                continue;
            }
            let Some(character) = self.decode() else {
                if !self.eof {
                    return FrontStep::NeedsInput;
                }
                match std::mem::take(&mut self.mode) {
                    Mode::Quote(mut pending) => {
                        self.append('"');
                        pending.pop_front();
                        self.replay = pending;
                        continue;
                    }
                    Mode::Slash => self.append('/'),
                    Mode::Block | Mode::BlockStar => {
                        self.ended = true;
                        self.chars.clear();
                        self.lines.clear();
                        return FrontStep::Event(FrontEvent::EofInComment);
                    }
                    _ => {}
                }
                if !self.chars.is_empty() {
                    let line = self.take_line();
                    return FrontStep::Event(FrontEvent::Program(line));
                }
                self.ended = true;
                return FrontStep::Event(FrontEvent::End);
            };
            let mode = std::mem::take(&mut self.mode);
            match mode {
                Mode::Quote(mut pending) => {
                    pending.push_back(character);
                    if character == '"' {
                        self.quotes.push(self.chars.len());
                        self.quote_copy = pending;
                    } else {
                        self.mode = Mode::Quote(pending);
                    }
                }
                Mode::Slash => {
                    if character == '*' {
                        self.mode = Mode::Block;
                    } else {
                        self.append('/');
                        self.replay.push_front(character);
                    }
                }
                Mode::Hash => {
                    if character == '\n' {
                        let line = self.take_line();
                        self.line = self.line.saturating_add(1);
                        return FrontStep::Event(FrontEvent::Program(line));
                    }
                    self.mode = Mode::Hash;
                }
                Mode::Block | Mode::BlockStar => {
                    if matches!(mode, Mode::BlockStar) && character == '/' {
                        self.append(' ');
                    } else {
                        if character == '\n' {
                            self.line = self.line.saturating_add(1);
                        }
                        self.mode = if character == '*' {
                            Mode::BlockStar
                        } else {
                            Mode::Block
                        };
                    }
                }
                Mode::Normal => match character {
                    '"' => self.mode = Mode::Quote(VecDeque::from(['"'])),
                    '/' => self.mode = Mode::Slash,
                    '#' => self.mode = Mode::Hash,
                    '\n' => {
                        let line = self.take_line();
                        self.line = self.line.saturating_add(1);
                        return FrontStep::Event(FrontEvent::Program(line));
                    }
                    _ => self.append(character),
                },
            }
        }
        FrontStep::Pending
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(input: &[u8], width: usize) -> Vec<Line> {
        let mut source = Source::new();
        let mut lines = Vec::new();
        for chunk in input.chunks(width) {
            source.feed(chunk);
            collect(&mut source, &mut lines);
        }
        source.finish();
        collect(&mut source, &mut lines);
        lines
    }

    fn collect(source: &mut Source, lines: &mut Vec<Line>) {
        loop {
            let mut budget = Budget::new(2);
            match source.advance(&mut budget) {
                FrontStep::Event(FrontEvent::Program(line)) => lines.push(line),
                FrontStep::Pending => {}
                FrontStep::NeedsInput | FrontStep::Event(FrontEvent::End) => break,
                FrontStep::Event(FrontEvent::EofInComment) => panic!("unexpected comment EOF"),
            }
        }
    }

    #[test]
    fn chunks_preserve_strings_and_comment_locations() {
        let input = b"1/*comment\n*/+2#rest\nprint \"a#/*;\nxyz\"\n";
        for width in 1..=input.len() {
            let lines = scan(input, width);
            assert_eq!(lines.len(), 2);
            assert_eq!(lines[0].chars.iter().collect::<String>(), "1 +2");
            assert_eq!(lines[0].lines, [1, 2, 2, 2]);
            assert_eq!(
                lines[1].chars.iter().collect::<String>(),
                "print \"a#/*;\nxyz\""
            );
            assert_eq!(lines[1].end_line, 4);
        }
    }

    #[test]
    fn malformed_utf8_uses_replacement_maximal_subparts() {
        let input = b"\xe0\x80\x80 \xed\xa0\x80 \xf4\x90\x80\x80 \xe2\x82x \xf0\x9f";
        let expected = "��� ��� ���� �x �";
        for width in 1..=input.len() {
            let lines = scan(input, width);
            assert_eq!(lines[0].chars.iter().collect::<String>(), expected);
        }
    }

    #[test]
    fn unmatched_quote_replays_comments_and_newlines() {
        let lines = scan(b"1+\"a#c\n2+2\n", 1);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].chars.iter().collect::<String>(), "1+\"a");
        assert_eq!(lines[1].chars.iter().collect::<String>(), "2+2");
        assert!(lines[0].quotes.is_empty());
    }
}
