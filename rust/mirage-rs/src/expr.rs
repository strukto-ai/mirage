use std::collections::HashSet;
use std::sync::Arc;

use num_bigint::BigInt;
use num_traits::{ToPrimitive, Zero};
use serde::Deserialize;

use crate::regex::{
    self, Step,
    parse::Dialect,
    posix::{Options, Posix},
};
use crate::task::{self, Host};
use crate::{Stream, StreamError, constants::WORK, parse_config, quoted};

type Text = Arc<[u8]>;
type Answer = Result<Text, String>;
const MISSING: &str = "expr: missing operand\nTry 'expr --help' for more information.\n";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(deserialize_with = "crate::latin1_list")]
    words: Vec<Vec<u8>>,
    utf8: bool,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let Config { words, utf8 } = parse_config(config)?;
    Ok(task::spawn(move |host| async move {
        if words.is_empty() {
            host.warn(MISSING.as_bytes());
            return 2;
        }
        let mut reader = Reader {
            words: words.into_iter().map(Text::from).collect(),
            next: 0,
            depth: 0,
            utf8,
            host: host.clone(),
            work: WORK,
        };
        let answer = reader.evaluate().await;
        let answer = match answer {
            Ok(_) if reader.next < reader.words.len() => Err(format!(
                "expr: syntax error: unexpected argument '{}'",
                quoted(&reader.words[reader.next])
            )),
            other => other,
        };
        match answer {
            Ok(value) => {
                let status = i32::from(reader.null(&value).await);
                for piece in value.chunks(WORK) {
                    host.print(piece);
                    host.pause().await;
                }
                status
            }
            Err(message) => {
                host.warn(message.as_bytes());
                host.warn(b"\n");
                2
            }
        }
    }))
}

struct Reader {
    words: Vec<Text>,
    next: usize,
    depth: usize,
    utf8: bool,
    host: Host,
    work: usize,
}

type Waiting = Vec<(Text, Vec<Text>)>;

enum Frame {
    Expression {
        level: usize,
        live: bool,
    },
    More {
        level: usize,
        live: bool,
    },
    Apply {
        level: usize,
        live: bool,
        left: Text,
        op: Text,
    },
    Operand {
        live: bool,
        waiting: Waiting,
    },
    Collect {
        live: bool,
        waiting: Waiting,
    },
    Close {
        live: bool,
        waiting: Waiting,
    },
}

impl Reader {
    async fn spend(&mut self, work: usize) {
        self.work = self.work.saturating_sub(work);
        if self.work == 0 {
            self.host.pause().await;
            self.work = WORK;
        }
    }

    async fn read(&mut self) -> Answer {
        self.spend(1).await;
        let word = self.words.get(self.next).cloned().ok_or_else(|| {
            format!(
                "expr: syntax error: missing argument after '{}'",
                quoted(&self.words[self.next - 1])
            )
        })?;
        self.next += 1;
        Ok(word)
    }

    fn take(&mut self, word: &[u8]) -> bool {
        if self
            .words
            .get(self.next)
            .is_some_and(|next| next.as_ref() == word)
        {
            self.next += 1;
            true
        } else {
            false
        }
    }

    async fn null(&mut self, value: &[u8]) -> bool {
        if value.is_empty() {
            return true;
        }
        let digits = value.strip_prefix(b"-").unwrap_or(value);
        if digits.is_empty() {
            return false;
        }
        for piece in digits.chunks(WORK) {
            if piece.iter().any(|b| *b != b'0') {
                return false;
            }
            self.spend(piece.len()).await;
        }
        true
    }

    async fn evaluate(&mut self) -> Answer {
        let mut frames = vec![Frame::Expression {
            level: 0,
            live: true,
        }];
        let mut value = text(b"");
        while let Some(frame) = frames.pop() {
            self.spend(1).await;
            match frame {
                Frame::Expression { level: 6, live } => frames.push(Frame::Operand {
                    live,
                    waiting: Vec::new(),
                }),
                Frame::Expression { level, live } => {
                    frames.push(Frame::More { level, live });
                    frames.push(Frame::Expression {
                        level: level + 1,
                        live,
                    });
                }
                Frame::More { level, live } => {
                    if let Some(op) = self
                        .words
                        .get(self.next)
                        .cloned()
                        .filter(|word| precedence(word) == Some(level))
                    {
                        self.next += 1;
                        let right_live = live
                            && match level {
                                0 => self.null(&value).await,
                                1 => !self.null(&value).await,
                                _ => true,
                            };
                        frames.push(Frame::Apply {
                            level,
                            live,
                            left: value.clone(),
                            op,
                        });
                        frames.push(Frame::Expression {
                            level: level + 1,
                            live: right_live,
                        });
                    }
                }
                Frame::Apply {
                    level,
                    live,
                    left,
                    op,
                } => {
                    value = if live {
                        self.apply(level, left, &op, value).await?
                    } else {
                        left
                    };
                    frames.push(Frame::More { level, live });
                }
                Frame::Operand { live, mut waiting } => {
                    let word = self.read().await?;
                    if arity(&word).is_some() {
                        waiting.push((word, Vec::new()));
                        frames.push(Frame::Operand { live, waiting });
                    } else if word.as_ref() == b"(" {
                        if self.depth == 64 {
                            return Err("expr: expression nesting too deep (limit 64)".into());
                        }
                        self.depth += 1;
                        frames.push(Frame::Close { live, waiting });
                        frames.push(Frame::Expression { level: 0, live });
                    } else {
                        value = match word.as_ref() {
                            b"+" => self.read().await?,
                            b")" => return Err("expr: syntax error: unexpected ')'".into()),
                            _ => word,
                        };
                        frames.push(Frame::Collect { live, waiting });
                    }
                }
                Frame::Close { live, waiting } => {
                    self.depth -= 1;
                    if !self.take(b")") {
                        let (clause, word) = self
                            .words
                            .get(self.next)
                            .map_or(("after", &self.words[self.next - 1]), |word| {
                                ("instead of", word)
                            });
                        return Err(format!(
                            "expr: syntax error: expecting ')' {clause} '{}'",
                            quoted(word)
                        ));
                    }
                    frames.push(Frame::Collect { live, waiting });
                }
                Frame::Collect { live, mut waiting } => {
                    while let Some((keyword, given)) = waiting.last_mut() {
                        given.push(value.clone());
                        if given.len() < arity(keyword).unwrap() {
                            frames.push(Frame::Operand { live, waiting });
                            break;
                        }
                        let (keyword, given) = waiting.pop().unwrap();
                        value = if live {
                            self.keyword(&keyword, &given).await?
                        } else {
                            text(b"")
                        };
                    }
                }
            }
        }
        Ok(value)
    }

    async fn apply(&mut self, level: usize, left: Text, op: &[u8], right: Text) -> Answer {
        Ok(match level {
            0 => {
                if self.null(&left).await {
                    if self.null(&right).await {
                        text(b"0")
                    } else {
                        right
                    }
                } else {
                    left
                }
            }
            1 => {
                if self.null(&left).await || self.null(&right).await {
                    text(b"0")
                } else {
                    left
                }
            }
            2 => {
                let order = self.compare(&left, &right).await;
                let held = match op {
                    b"=" | b"==" => order.is_eq(),
                    b"!=" => !order.is_eq(),
                    b"<" => order.is_lt(),
                    b"<=" => !order.is_gt(),
                    b">" => order.is_gt(),
                    _ => !order.is_lt(),
                };
                text(if held { b"1" } else { b"0" })
            }
            3 | 4 => {
                let a = self
                    .integer(&left)
                    .await
                    .ok_or("expr: non-integer argument")?;
                let b = self
                    .integer(&right)
                    .await
                    .ok_or("expr: non-integer argument")?;
                if matches!(op, b"/" | b"%") && b.is_zero() {
                    return Err("expr: division by zero".into());
                }
                let value = match op {
                    b"+" => a + b,
                    b"-" => a - b,
                    b"*" => a * b,
                    b"/" => a / b,
                    _ => a % b,
                };
                text(value.to_str_radix(10).as_bytes())
            }
            _ => self.matching(&left, &right).await?,
        })
    }

    async fn integer(&mut self, value: &[u8]) -> Option<BigInt> {
        let digits = value.strip_prefix(b"-").unwrap_or(value);
        if digits.is_empty() {
            return None;
        }
        for piece in digits.chunks(WORK) {
            if !piece.iter().all(u8::is_ascii_digit) {
                return None;
            }
            self.spend(piece.len()).await;
        }
        BigInt::parse_bytes(value, 10)
    }

    async fn compare(&mut self, left: &[u8], right: &[u8]) -> std::cmp::Ordering {
        match (self.integer(left).await, self.integer(right).await) {
            (Some(a), Some(b)) => a.cmp(&b),
            _ => left.cmp(right),
        }
    }

    async fn length(&mut self, value: &[u8]) -> usize {
        let (mut at, mut count) = (0, 0);
        while let Some((_, width)) = regex::unit_at(value, at, value.len(), self.utf8) {
            at += width;
            count += 1;
            self.spend(width).await;
        }
        count
    }

    async fn keyword(&mut self, keyword: &[u8], given: &[Text]) -> Answer {
        match keyword {
            b"length" => Ok(text(self.length(&given[0]).await.to_string().as_bytes())),
            b"match" => self.matching(&given[0], &given[1]).await,
            b"index" => {
                let mut wanted = HashSet::new();
                let mut at = 0;
                while let Some((unit, width)) =
                    regex::unit_at(&given[1], at, given[1].len(), self.utf8)
                {
                    wanted.insert(unit);
                    at += width;
                    self.spend(width).await;
                }
                let (mut at, mut count) = (0, 0);
                while let Some((unit, width)) =
                    regex::unit_at(&given[0], at, given[0].len(), self.utf8)
                {
                    count += 1;
                    if wanted.contains(&unit) {
                        return Ok(text(count.to_string().as_bytes()));
                    }
                    at += width;
                    self.spend(width).await;
                }
                Ok(text(b"0"))
            }
            _ => {
                let Some(start) = self
                    .integer(&given[1])
                    .await
                    .filter(|n| *n > BigInt::zero())
                    .and_then(|n| n.to_usize())
                else {
                    return Ok(text(b""));
                };
                let Some(count) = self
                    .integer(&given[2])
                    .await
                    .filter(|n| *n >= BigInt::zero())
                else {
                    return Ok(text(b""));
                };
                let count = count.to_usize().unwrap_or(usize::MAX);
                let (mut at, mut unit, mut begin) = (0, 1usize, None);
                while let Some((_, width)) =
                    regex::unit_at(&given[0], at, given[0].len(), self.utf8)
                {
                    if unit == start {
                        begin = Some(at);
                    }
                    if unit >= start.saturating_add(count) {
                        break;
                    }
                    at += width;
                    unit += 1;
                    self.spend(width).await;
                }
                Ok(begin.map_or_else(|| text(b""), |begin| text(&given[0][begin..at])))
            }
        }
    }

    async fn matching(&mut self, subject: &[u8], pattern: &[u8]) -> Answer {
        let mut regex = Posix::compile(
            pattern,
            &Options {
                extended: false,
                dialect: Dialect::Posix,
                ignore_case: false,
                utf8: self.utf8,
                multiline: false,
                word: false,
            },
        )
        .map_err(|error| format!("expr: {error}"))?;
        let found = loop {
            let mut budget = regex::STEPS;
            match regex.search(subject, 0, &mut budget) {
                Step::Paused => self.host.pause().await,
                Step::Done(found) => {
                    break found.filter(|spans| spans[0].is_some_and(|(start, _)| start == 0));
                }
            }
        };
        if regex.groups() > 0 {
            Ok(found
                .and_then(|spans| spans[1])
                .map_or_else(|| text(b""), |(start, end)| text(&subject[start..end])))
        } else {
            let end = found.and_then(|spans| spans[0]).map_or(0, |(_, end)| end);
            Ok(text(
                self.length(&subject[..end]).await.to_string().as_bytes(),
            ))
        }
    }
}

fn text(value: &[u8]) -> Text {
    Arc::from(value)
}

fn precedence(word: &[u8]) -> Option<usize> {
    match word {
        b"|" => Some(0),
        b"&" => Some(1),
        b"=" | b"==" | b"!=" | b"<" | b"<=" | b">" | b">=" => Some(2),
        b"+" | b"-" => Some(3),
        b"*" | b"/" | b"%" => Some(4),
        b":" => Some(5),
        _ => None,
    }
}

fn arity(word: &[u8]) -> Option<usize> {
    match word {
        b"length" => Some(1),
        b"index" | b"match" => Some(2),
        b"substr" => Some(3),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(words: &[&str], utf8: bool) -> (Vec<u8>, Vec<u8>, i32, usize) {
        let mut stream =
            open(&serde_json::to_vec(&json!({"words":words,"utf8":utf8})).unwrap()).unwrap();
        let mut out = Vec::new();
        let mut turns = 0;
        while stream.busy() {
            let mut piece = Vec::new();
            stream.drain(&mut piece).unwrap();
            assert!(piece.len() <= WORK);
            out.extend_from_slice(&piece);
            turns += 1;
            assert!(turns < 10000);
        }
        let mut err = Vec::new();
        stream.take_stderr(&mut err);
        (out, err, stream.status(), turns)
    }

    #[test]
    fn precedence_short_circuit_errors_and_arbitrary_precision_are_shared() {
        for (words, output, status) in [
            (vec!["2", "+", "3", "*", "4"], "14", 0),
            (vec!["-10", "%", "3"], "-1", 0),
            (vec!["1", "|", "a", "/", "0"], "1", 0),
            (vec!["00", "&", "a", "/", "0"], "0", 1),
            (vec!["abc", ":", "\\(a*\\)"], "a", 0),
            (vec!["abc", ":", "\\(z\\)"], "", 1),
            (
                vec!["9223372036854775807", "+", "1"],
                "9223372036854775808",
                0,
            ),
        ] {
            let (out, err, actual, _) = run(&words, false);
            assert_eq!(
                (out, err, actual),
                (output.as_bytes().to_vec(), Vec::new(), status)
            );
        }
        let (_, err, status, _) = run(&["(", "1", "+"], false);
        assert_eq!(err, b"expr: syntax error: missing argument after '+'\n");
        assert_eq!(status, 2);
    }

    #[test]
    fn parentheses_and_keyword_chains_do_not_recurse_on_the_native_stack() {
        std::thread::Builder::new()
            .stack_size(128 * 1024)
            .spawn(|| {
                let mut words = vec!["("; 64];
                words.push("1");
                words.extend(vec![")"; 64]);
                assert_eq!(run(&words, false).0, b"1");
                words.insert(0, "(");
                words.push(")");
                assert_eq!(run(&words, false).2, 2);
                let mut words = vec!["length"; 20000];
                words.push("abc");
                let (out, err, status, turns) = run(&words, false);
                assert_eq!((out, err, status), (b"1".to_vec(), Vec::new(), 0));
                assert!(turns > 1);
            })
            .unwrap()
            .join()
            .unwrap();
    }

    #[test]
    fn character_operations_and_large_output_resume_in_bounded_steps() {
        let long = "x".repeat(WORK * 8 + 1);
        let (out, err, status, turns) = run(&["+", &long], false);
        assert_eq!((out, err, status), (long.into_bytes(), Vec::new(), 0));
        assert!(turns > 8);
        let encoded = "\u{c3}\u{a9}\u{ff}";
        assert_eq!(run(&["length", encoded], false).0, b"3");
        assert_eq!(run(&["length", encoded], true).0, b"2");
        assert_eq!(run(&["substr", encoded, "1", "1"], true).0, [0xc3, 0xa9]);
    }
}
