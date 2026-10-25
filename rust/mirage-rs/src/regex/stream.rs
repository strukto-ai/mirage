use serde::{Deserialize, Serialize};

use super::parse::{self, Ast, Dialect};
use super::posix::{self, Posix, Spans};
use super::{Options as GrepOptions, Regex, Step, Syntax};
use crate::{Stream, StreamError, parse_config};

/// An offset that stands for a group with no part in the match.
const UNSET: u32 = u32::MAX;

/// The most subject bytes a stream keeps room for between requests.
const KEPT_SUBJECT: usize = 1 << 16;

#[derive(Deserialize)]
#[serde(tag = "mode", rename_all = "lowercase", deny_unknown_fields)]
enum Config {
    /// One expression, matched against a whole subject with its groups.
    Posix {
        #[serde(deserialize_with = "crate::latin1")]
        pattern: Vec<u8>,
        #[serde(default)]
        extended: bool,
        dialect: Dialect,
        #[serde(default)]
        ignore_case: bool,
        #[serde(default)]
        utf8: bool,
        #[serde(default)]
        multiline: bool,
        #[serde(default)]
        word: bool,
    },
    /// grep's pattern list, matched against one line at a time.
    Lines {
        #[serde(deserialize_with = "crate::latin1_list")]
        patterns: Vec<Vec<u8>>,
        syntax: Syntax,
        #[serde(default)]
        ignore_case: bool,
        #[serde(default)]
        utf8: bool,
        #[serde(default)]
        word: bool,
        #[serde(default)]
        line: bool,
    },
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum Operation {
    /// The leftmost-longest match at or after `at` and its groups.
    Search,
    /// Every match a global substitution replaces.
    All,
    /// Whether the line, or a POSIX expression's subject, matches.
    Test,
    /// Each match grep -o prints from the line.
    Extents,
    /// How many times git's pickaxe counts the pattern in the subject.
    Contains,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    op: Operation,
    #[serde(default)]
    at: usize,
}

#[derive(Serialize)]
struct Metadata<'a> {
    groups: usize,
    warnings: &'a [&'static str],
    needles: Option<Vec<String>>,
}

enum Matcher {
    Posix(Box<Posix>),
    Lines {
        regex: Box<Regex>,
        warnings: Vec<&'static str>,
        needles: Option<Vec<Vec<u8>>>,
    },
}

/// A compiled expression the host searches one subject after another:
/// `begin` names the search, `feed` the subject's bytes, and `finish`
/// writes the answer as little-endian u32 offsets, a start and an end per
/// group with `u32::MAX` for none (posix), a pair per match (extents), or
/// one byte (test).
struct RegexStream {
    matcher: Matcher,
    subject: Vec<u8>,
    operation: Operation,
    at: usize,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let matcher = match parse_config::<Config>(config)? {
        Config::Posix {
            pattern,
            extended,
            dialect,
            ignore_case,
            utf8,
            multiline,
            word,
        } => {
            let options = posix::Options {
                extended,
                dialect,
                ignore_case,
                utf8,
                multiline,
                word,
            };
            Matcher::Posix(Box::new(
                Posix::compile(&pattern, &options).map_err(StreamError::new)?,
            ))
        }
        Config::Lines {
            patterns,
            syntax,
            ignore_case,
            utf8,
            word,
            line,
        } => {
            let options = GrepOptions {
                syntax,
                ignore_case,
                utf8,
                word,
                line,
                terminator: b'\n',
                extents: true,
            };
            let compiled = Regex::compile(&patterns, &options).map_err(StreamError::new)?;
            let needles = match compiled.regex.perl_regular() {
                Some(regular) => super::perl_needles(regular, ignore_case, utf8),
                None => line_needles(&patterns, syntax, ignore_case, utf8),
            };
            Matcher::Lines {
                regex: Box::new(compiled.regex),
                warnings: compiled.warnings,
                needles,
            }
        }
    };
    Ok(Box::new(RegexStream {
        matcher,
        subject: Vec::new(),
        operation: Operation::Search,
        at: 0,
    }))
}

fn line_needles(
    patterns: &[Vec<u8>],
    syntax: Syntax,
    ignore_case: bool,
    utf8: bool,
) -> Option<Vec<Vec<u8>>> {
    if patterns.is_empty() {
        return None;
    }
    let asts: Vec<Ast> = patterns
        .iter()
        .map(|pattern| match syntax {
            Syntax::Fixed => Some(parse::literal(pattern, utf8)),
            syntax => parse::parse(pattern, syntax == Syntax::Extended, utf8, Dialect::Grep)
                .ok()
                .map(|parsed| parsed.ast),
        })
        .collect::<Option<_>>()?;
    let refs: Vec<&Ast> = asts.iter().collect();
    posix::needles(&refs, ignore_case, utf8)
}

fn put(out: &mut Vec<u8>, value: Option<usize>) {
    let value = value.map_or(UNSET, |v| u32::try_from(v).unwrap_or(UNSET - 1));
    out.extend_from_slice(&value.to_le_bytes());
}

fn put_spans(out: &mut Vec<u8>, spans: &Spans) {
    for span in spans {
        put(out, span.map(|(start, _)| start));
        put(out, span.map(|(_, end)| end));
    }
}

fn done<T>(step: Step<T>) -> T {
    match step {
        Step::Done(value) => value,
        Step::Paused => unreachable!("an unlimited search paused"),
    }
}

impl RegexStream {
    fn answer(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let hay = self.subject.as_slice();
        match (&mut self.matcher, self.operation) {
            (Matcher::Posix(regex), Operation::Search) => {
                if self.at <= hay.len() {
                    if let Some(spans) = regex.search(hay, self.at) {
                        put_spans(out, &spans);
                    }
                }
            }
            (Matcher::Posix(regex), Operation::All) => {
                for spans in regex.all(hay) {
                    put_spans(out, &spans);
                }
            }
            (Matcher::Posix(regex), Operation::Contains) => {
                put(out, Some(regex.contains(hay)));
            }
            (Matcher::Posix(regex), Operation::Test) => {
                put(out, Some(usize::from(regex.test(hay))));
            }
            (Matcher::Lines { regex, .. }, Operation::Test) => {
                let mut line = hay.to_vec();
                line.push(b'\n');
                let to = hay.len();
                let hit = done(regex.matches(&line, 0, to, &mut u64::MAX.clone()));
                out.push(u8::from(hit));
            }
            (Matcher::Lines { regex, .. }, Operation::Extents) => {
                let mut line = hay.to_vec();
                line.push(b'\n');
                let to = hay.len();
                let mut at = 0;
                while at <= to {
                    let Some((start, end)) =
                        done(regex.extent(&line, 0, at, to, &mut u64::MAX.clone()))
                    else {
                        break;
                    };
                    if end > start {
                        put(out, Some(start));
                        put(out, Some(end));
                        at = end;
                    } else {
                        at = start + regex.unit_len(&line, start, to);
                    }
                }
            }
            _ => return Err(StreamError::new("regex operation does not fit its mode")),
        }
        Ok(())
    }
}

impl Stream for RegexStream {
    fn feed(&mut self, input: &[u8], _: &mut Vec<u8>) -> Result<(), StreamError> {
        self.subject.extend_from_slice(input);
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let answered = self.answer(out);
        // A cached pattern keeps its stream: the subject and the buffers a
        // long one grew go back rather than stay with it.
        self.subject.clear();
        if self.subject.capacity() > KEPT_SUBJECT {
            self.subject.shrink_to(KEPT_SUBJECT);
        }
        if let Matcher::Posix(regex) = &mut self.matcher {
            regex.release();
        }
        answered
    }

    fn begin(&mut self, config: &[u8]) -> Result<(), StreamError> {
        let request: Request = parse_config(config)?;
        self.subject.clear();
        self.operation = request.op;
        self.at = request.at;
        Ok(())
    }

    fn metadata(&self, out: &mut Vec<u8>) {
        let metadata = match &self.matcher {
            Matcher::Posix(regex) => Metadata {
                groups: regex.groups(),
                warnings: &[],
                needles: None,
            },
            Matcher::Lines {
                warnings, needles, ..
            } => Metadata {
                groups: 0,
                warnings,
                needles: needles.as_ref().map(|needles| {
                    needles
                        .iter()
                        .map(|needle| String::from_utf8_lossy(needle).into_owned())
                        .collect()
                }),
            },
        };
        if let Ok(json) = serde_json::to_vec(&metadata) {
            out.extend_from_slice(&json);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(out: &[u8]) -> Vec<u32> {
        out.chunks(4)
            .map(|word| u32::from_le_bytes(word.try_into().unwrap()))
            .collect()
    }

    fn ask(stream: &mut dyn Stream, request: &str, subject: &[u8]) -> Vec<u8> {
        stream.begin(request.as_bytes()).unwrap();
        let mut out = Vec::new();
        stream.feed(subject, &mut out).unwrap();
        stream.finish(&mut out).unwrap();
        out
    }

    #[test]
    fn posix_search_reports_each_group() {
        let mut stream =
            open(br#"{"mode":"posix","pattern":"\\(a\\)\\|\\(b\\)","dialect":"sed"}"#).unwrap();
        let mut meta = Vec::new();
        stream.metadata(&mut meta);
        assert!(String::from_utf8(meta).unwrap().contains(r#""groups":2"#));
        let out = ask(stream.as_mut(), r#"{"op":"search"}"#, b"xb");
        assert_eq!(words(&out), [1, 2, UNSET, UNSET, 1, 2]);
        let out = ask(stream.as_mut(), r#"{"op":"search","at":2}"#, b"xb");
        assert!(out.is_empty());
        let out = ask(stream.as_mut(), r#"{"op":"all"}"#, b"ab");
        assert_eq!(words(&out).len(), 12);
        assert_eq!(words(&ask(stream.as_mut(), r#"{"op":"test"}"#, b"xb")), [1]);
        assert_eq!(words(&ask(stream.as_mut(), r#"{"op":"test"}"#, b"xy")), [0]);
    }

    #[test]
    fn a_refused_pattern_carries_regerrors_wording() {
        let err = open(br#"{"mode":"posix","pattern":"a**","dialect":"sed"}"#)
            .err()
            .unwrap();
        assert_eq!(err.message, parse::INVALID_PRECEDING);
        assert!(open(br#"{"mode":"posix","pattern":"a**","dialect":"posix"}"#).is_ok());
    }

    #[test]
    fn lines_select_and_extend_like_grep() {
        let mut stream =
            open(br#"{"mode":"lines","patterns":["ab|abcd","x"],"syntax":"extended","word":true}"#)
                .unwrap();
        assert_eq!(ask(stream.as_mut(), r#"{"op":"test"}"#, b"abcd y"), [1]);
        assert_eq!(ask(stream.as_mut(), r#"{"op":"test"}"#, b"abcde"), [0]);
        let out = ask(stream.as_mut(), r#"{"op":"extents"}"#, b"abcd x");
        assert_eq!(words(&out), [0, 4, 5, 6]);
        let mut meta = Vec::new();
        stream.metadata(&mut meta);
        assert!(
            String::from_utf8(meta)
                .unwrap()
                .contains(r#""needles":["ab","abcd","x"]"#)
        );
    }

    #[test]
    fn perl_lines_select_and_find_needles_past_their_assertions() {
        let mut stream = open(
            br#"{"mode":"lines","patterns":["(?<=id=)value\\d+|key=\\Kvalue"],"syntax":"perl"}"#,
        )
        .unwrap();
        assert_eq!(ask(stream.as_mut(), r#"{"op":"test"}"#, b"id=value1"), [1]);
        assert_eq!(ask(stream.as_mut(), r#"{"op":"test"}"#, b"value1"), [0]);
        let out = ask(stream.as_mut(), r#"{"op":"extents"}"#, b"key=value");
        assert_eq!(words(&out), [4, 9]);
        let mut meta = Vec::new();
        stream.metadata(&mut meta);
        assert!(
            String::from_utf8(meta)
                .unwrap()
                .contains(r#""needles":["value","key=value"]"#)
        );
    }
}
