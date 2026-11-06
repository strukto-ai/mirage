//! Shell patterns over a value: `${v#p}`, `${v%p}`, `${v/p/r}`, `${v^p}`
//! and `case`'s match, run by the glob matcher. A pattern is matcher units
//! with each quoted special character as the matcher's quote mark, so `"*"`
//! matches only a star. A value is units too: its characters under a UTF-8
//! locale, its bytes in the C locale, a byte that is no character standing
//! as its surrogate escape, which no class matches.

use serde_json::{Value as Json, json};

use super::write::Fault;

/// The characters the matcher reads specially, each quoted as its mark.
const QUOTED: &[u8] = b"*?[@+!()|";
const MARK: u32 = 0xFDD0;
const ESCAPE: u32 = 0xDC00;

/// Text as matcher units, and the byte offset each unit starts at, then
/// the end.
pub fn units(text: &[u8], utf8: bool) -> (Vec<u32>, Vec<usize>) {
    let mut units = Vec::with_capacity(text.len());
    let mut offsets = Vec::with_capacity(text.len() + 1);
    if !utf8 {
        for (at, &byte) in text.iter().enumerate() {
            offsets.push(at);
            units.push(if byte < 0x80 {
                u32::from(byte)
            } else {
                ESCAPE + u32::from(byte)
            });
        }
        offsets.push(text.len());
        return (units, offsets);
    }
    let mut at = 0;
    for chunk in text.utf8_chunks() {
        for c in chunk.valid().chars() {
            offsets.push(at);
            units.push(u32::from(c));
            at += c.len_utf8();
        }
        for &byte in chunk.invalid() {
            offsets.push(at);
            units.push(ESCAPE + u32::from(byte));
            at += 1;
        }
    }
    offsets.push(text.len());
    (units, offsets)
}

/// A pattern being built from a word's live and quoted runs.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Pattern(pub Vec<u32>);

impl Pattern {
    /// Append text, its special characters live or, `quoted`, literal.
    pub fn push(&mut self, text: &[u8], quoted: bool, utf8: bool) {
        for unit in units(text, utf8).0 {
            let mark = QUOTED
                .iter()
                .position(|&c| quoted && unit == u32::from(c))
                .map_or(unit, |i| MARK + i as u32);
            self.0.push(mark);
        }
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// The characters a recase handles between two pauses.
const RECASE_SLICE: usize = 2048;

fn glob_config(pattern: &Pattern, extglob: bool, operation: Json) -> Vec<u8> {
    json!({
        "pattern": pattern.0,
        "extglob": extglob,
        "operation": operation,
    })
    .to_string()
    .into_bytes()
}

fn unit_bytes(subject: &[u32]) -> Vec<u8> {
    subject.iter().flat_map(|unit| unit.to_le_bytes()).collect()
}

/// Run one glob operation over `subject` to its answer, pausing after each
/// slice of the matcher's work, so a long one lets the host run others or
/// stop it.
async fn ask(
    pattern: &Pattern,
    extglob: bool,
    operation: Json,
    subject: &[u32],
    pause: &mut impl AsyncFnMut() -> Result<(), Fault>,
) -> Result<Json, Fault> {
    let mut out = Vec::new();
    let Ok(mut glob) = crate::glob::open(&glob_config(pattern, extglob, operation)) else {
        return Ok(Json::Null);
    };
    let fed = glob
        .feed(&unit_bytes(subject), &mut out)
        .and_then(|()| glob.finish(&mut out));
    if fed.is_err() {
        return Ok(Json::Null);
    }
    while glob.busy() {
        if glob.drain(&mut out).is_err() {
            return Ok(Json::Null);
        }
        pause().await?;
    }
    Ok(serde_json::from_slice(&out).unwrap_or(Json::Null))
}

/// One pattern compiled once and tested against whole subjects.
struct Matcher(Option<Box<dyn crate::Stream>>);

impl Matcher {
    fn new(pattern: &Pattern, extglob: bool) -> Self {
        let config = glob_config(pattern, extglob, json!({"kind": "matches"}));
        Self(crate::glob::open(&config).ok())
    }

    fn matches(&mut self, subject: &[u32]) -> bool {
        let bytes = unit_bytes(subject);
        self.0
            .as_mut()
            .is_some_and(|glob| glob.test(&bytes).unwrap_or(false))
    }
}

/// Whether `pattern` matches the whole of `subject`.
pub fn matches(pattern: &Pattern, subject: &[u8], extglob: bool, utf8: bool) -> bool {
    Matcher::new(pattern, extglob).matches(&units(subject, utf8).0)
}

/// `${v#p}`, `${v##p}`, `${v%p}`, `${v%%p}`: the value less the shortest or
/// longest prefix or suffix the pattern matches, the value itself when it
/// matches none.
pub async fn strip(
    value: &[u8],
    pattern: &Pattern,
    longest: bool,
    prefix: bool,
    extglob: bool,
    utf8: bool,
    pause: &mut impl AsyncFnMut() -> Result<(), Fault>,
) -> Result<Vec<u8>, Fault> {
    if pattern.is_empty() {
        return Ok(value.to_vec());
    }
    let (subject, offsets) = units(value, utf8);
    let operation = if prefix {
        json!({"kind": "end", "start": 0, "longest": longest})
    } else {
        json!({"kind": "suffix", "longest": longest})
    };
    let Some(at) = ask(pattern, extglob, operation, &subject, pause)
        .await?
        .as_u64()
    else {
        return Ok(value.to_vec());
    };
    let at = offsets[at as usize];
    Ok(if prefix {
        value[at..].to_vec()
    } else {
        value[..at].to_vec()
    })
}

/// A replacement's runs, each quoted or live, and whether `&` in a live
/// run is the match (`patsub_replacement`, on by default): `${x/b/[&]}` is
/// `a[b]c`, while `\&` and `"&"` stay literal.
#[derive(Debug, Clone, Default)]
pub struct Replacement {
    pub runs: Vec<(Vec<u8>, bool)>,
    pub amp: bool,
}

impl Replacement {
    fn render(&self, matched: &[u8], out: &mut Vec<u8>) {
        for (run, quoted) in &self.runs {
            if *quoted || !self.amp {
                out.extend_from_slice(run);
                continue;
            }
            for &byte in run {
                if byte == b'&' {
                    out.extend_from_slice(matched);
                } else {
                    out.push(byte);
                }
            }
        }
    }
}

/// `${v/p/r}`, `${v//p/r}`, `${v/#p/r}`, `${v/%p/r}`: the value with the
/// first or every longest match replaced, or one anchored at its start or
/// end, where an empty pattern matches (`${v/#/P}` prefixes `P`); None
/// once the result grows past `room` bytes.
#[allow(clippy::too_many_arguments)]
pub async fn replace(
    value: &[u8],
    pattern: &Pattern,
    replacement: &Replacement,
    all: bool,
    anchor: Option<&str>,
    extglob: bool,
    utf8: bool,
    room: Option<usize>,
    pause: &mut impl AsyncFnMut() -> Result<(), Fault>,
) -> Result<Option<Vec<u8>>, Fault> {
    if pattern.is_empty() {
        let mut out = Vec::with_capacity(value.len());
        match anchor {
            Some("#") => {
                replacement.render(b"", &mut out);
                out.extend_from_slice(value);
            }
            Some("%") => {
                out.extend_from_slice(value);
                replacement.render(b"", &mut out);
            }
            _ => out.extend_from_slice(value),
        }
        return Ok(room.is_none_or(|room| out.len() <= room).then_some(out));
    }
    let (subject, offsets) = units(value, utf8);
    let spans = ask(
        pattern,
        extglob,
        json!({"kind": "replace", "all": all, "anchor": anchor}),
        &subject,
        pause,
    )
    .await?;
    let mut out = Vec::with_capacity(value.len());
    let mut cursor = 0;
    for span in spans.as_array().into_iter().flatten() {
        let (Some(start), Some(end)) = (span[0].as_u64(), span[1].as_u64()) else {
            continue;
        };
        let (start, end) = (offsets[start as usize], offsets[end as usize]);
        out.extend_from_slice(&value[cursor..start]);
        replacement.render(&value[start..end], &mut out);
        if room.is_some_and(|room| out.len() > room) {
            return Ok(None);
        }
        cursor = end;
    }
    out.extend_from_slice(&value[cursor..]);
    Ok(Some(out))
}

/// Which way a recase turns a letter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Case {
    Upper,
    Lower,
    /// `~`: upper to lower and lower to upper.
    Toggle,
}

impl Case {
    fn of(op: &str) -> Self {
        match op.as_bytes().first() {
            Some(b'^') => Case::Upper,
            Some(b',') => Case::Lower,
            _ => Case::Toggle,
        }
    }
}

/// `${v^p}`, `${v^^p}`, `${v,p}`, `${v,,p}`, `${v~p}`, `${v~~p}`: the
/// first or every character the pattern matches upper- or lowercased or
/// its case toggled, the pattern compiled once and a pause after each
/// slice of characters.
pub async fn recase(
    op: &str,
    value: &[u8],
    pattern: &Pattern,
    extglob: bool,
    utf8: bool,
    pause: &mut impl AsyncFnMut() -> Result<(), Fault>,
) -> Result<Vec<u8>, Fault> {
    let case = Case::of(op);
    let every = op.len() == 2;
    if pattern.is_empty() {
        return Ok(cased(value, case, every, utf8));
    }
    let mut matcher = Matcher::new(pattern, extglob);
    let (subject, offsets) = units(value, utf8);
    let mut out = Vec::with_capacity(value.len());
    for (index, window) in offsets.windows(2).enumerate() {
        if index % RECASE_SLICE == RECASE_SLICE - 1 {
            pause().await?;
        }
        let char = &value[window[0]..window[1]];
        if matcher.matches(&subject[index..=index]) {
            recase_char(char, case, utf8, &mut out);
        } else {
            out.extend_from_slice(char);
        }
        if !every {
            out.extend_from_slice(&value[window[1]..]);
            break;
        }
    }
    Ok(out)
}

/// The value with its first character, or every one, recased: `${v@U}`,
/// `${v@u}`, `${v@L}` and a recase with no pattern. In the C locale only
/// ASCII letters change, as a byte's case does.
pub fn cased(value: &[u8], case: Case, every: bool, utf8: bool) -> Vec<u8> {
    let (_, offsets) = units(value, utf8);
    let mut out = Vec::with_capacity(value.len());
    for window in offsets.windows(2) {
        recase_char(&value[window[0]..window[1]], case, utf8, &mut out);
        if !every {
            out.extend_from_slice(&value[window[1]..]);
            break;
        }
    }
    out
}

fn recase_char(char: &[u8], case: Case, utf8: bool, out: &mut Vec<u8>) {
    match (utf8, std::str::from_utf8(char)) {
        (true, Ok(text)) => {
            for c in text.chars() {
                let upper = match case {
                    Case::Upper => true,
                    Case::Lower => false,
                    Case::Toggle => c.is_lowercase(),
                };
                if upper {
                    out.extend(c.to_uppercase().to_string().as_bytes());
                } else {
                    out.extend(c.to_lowercase().to_string().as_bytes());
                }
            }
        }
        _ => out.extend(char.iter().map(|b| {
            let upper = match case {
                Case::Upper => true,
                Case::Lower => false,
                Case::Toggle => b.is_ascii_lowercase(),
            };
            if upper {
                b.to_ascii_uppercase()
            } else {
                b.to_ascii_lowercase()
            }
        })),
    }
}

/// A substring by character offsets (bytes in the C locale): `offset` from
/// the start, `length` characters or, negative, up to that many from the
/// end.
pub fn substring(value: &[u8], offset: usize, length: Option<i64>, utf8: bool) -> Vec<u8> {
    let (_, offsets) = units(value, utf8);
    let count = offsets.len() - 1;
    let end = match length {
        None => count,
        Some(length) if length < 0 => (count as i64 + length).max(offset as i64) as usize,
        Some(length) => (offset as i64 + length).min(count as i64) as usize,
    };
    let (start, end) = (offset.min(count), end.min(count).max(offset.min(count)));
    value[offsets[start]..offsets[end]].to_vec()
}

/// How many characters a value holds: bytes in the C locale.
pub fn length(value: &[u8], utf8: bool) -> usize {
    units(value, utf8).0.len()
}

#[cfg(test)]
mod tests {
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    use super::*;

    fn run<T>(future: impl Future<Output = T>) -> T {
        let mut future = pin!(future);
        match future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(value) => value,
            Poll::Pending => panic!("nothing here waits"),
        }
    }

    fn strip(
        value: &[u8],
        pattern: &Pattern,
        longest: bool,
        prefix: bool,
        extglob: bool,
        utf8: bool,
    ) -> Vec<u8> {
        let pause = &mut async || Ok(());
        run(super::strip(
            value, pattern, longest, prefix, extglob, utf8, pause,
        ))
        .unwrap()
    }

    #[allow(clippy::too_many_arguments)]
    fn replace(
        value: &[u8],
        pattern: &Pattern,
        replacement: &Replacement,
        all: bool,
        anchor: Option<&str>,
        extglob: bool,
        utf8: bool,
        room: Option<usize>,
    ) -> Option<Vec<u8>> {
        let pause = &mut async || Ok(());
        run(super::replace(
            value,
            pattern,
            replacement,
            all,
            anchor,
            extglob,
            utf8,
            room,
            pause,
        ))
        .unwrap()
    }

    fn recase(op: &str, value: &[u8], pattern: &Pattern, extglob: bool, utf8: bool) -> Vec<u8> {
        let pause = &mut async || Ok(());
        run(super::recase(op, value, pattern, extglob, utf8, pause)).unwrap()
    }

    fn pattern(live: &str, quoted: &str) -> Pattern {
        let mut pattern = Pattern::default();
        pattern.push(live.as_bytes(), false, true);
        pattern.push(quoted.as_bytes(), true, true);
        pattern
    }

    #[test]
    fn long_work_pauses_and_a_refused_pause_stops_it() {
        let value = vec![b'a'; 100_000];
        let p = pattern("+(a)", "");
        let mut pauses = 0;
        let counted = &mut async || {
            pauses += 1;
            Ok(())
        };
        let out = run(super::strip(&value, &p, true, true, true, false, counted)).unwrap();
        assert!(out.is_empty());
        assert!(pauses > 1);
        let mut pauses = 0;
        let counted = &mut async || {
            pauses += 1;
            Ok(())
        };
        let upper = run(super::recase(
            "^^",
            &value,
            &pattern("[a]", ""),
            false,
            false,
            counted,
        ));
        assert_eq!(upper.unwrap(), vec![b'A'; 100_000]);
        assert_eq!(pauses, 100_000 / RECASE_SLICE);
        let stopped = &mut async || Err(Fault::Memory);
        let replaced = run(super::replace(
            &value,
            &p,
            &Replacement::default(),
            true,
            None,
            true,
            false,
            None,
            stopped,
        ));
        assert!(replaced.is_err());
    }

    #[test]
    fn strips_prefixes_and_suffixes() {
        let p = pattern("*/", "");
        assert_eq!(strip(b"a/b/c", &p, false, true, false, true), b"b/c");
        assert_eq!(strip(b"a/b/c", &p, true, true, false, true), b"c");
        let p = pattern(".*", "");
        assert_eq!(strip(b"f.tar.gz", &p, false, false, false, true), b"f.tar");
        assert_eq!(strip(b"f.tar.gz", &p, true, false, false, true), b"f");
        let star = pattern("", "*");
        assert_eq!(strip(b"*x", &star, false, true, false, true), b"x");
        assert_eq!(strip(b"ax", &star, false, true, false, true), b"ax");
    }

    #[test]
    fn replaces_first_every_and_anchored() {
        let p = pattern("o", "");
        let text = |t: &str| Replacement {
            runs: vec![(t.as_bytes().to_vec(), false)],
            amp: true,
        };
        assert_eq!(
            replace(b"foo", &p, &text("0"), false, None, false, true, None).unwrap(),
            b"f0o"
        );
        assert_eq!(
            replace(b"foo", &p, &text("0"), true, None, false, true, None).unwrap(),
            b"f00"
        );
        assert_eq!(
            replace(b"oof", &p, &text("_"), false, Some("#"), false, true, None).unwrap(),
            b"_of"
        );
        assert_eq!(
            replace(b"foo", &p, &text("_"), false, Some("%"), false, true, None).unwrap(),
            b"fo_"
        );
        assert_eq!(
            replace(b"foo", &p, &text("<&>"), true, None, false, true, None).unwrap(),
            b"f<o><o>"
        );
        assert_eq!(
            replace(b"foo", &p, &text("<&>"), true, None, false, true, Some(4)),
            None
        );
        let quoted = Replacement {
            runs: vec![(b"&".to_vec(), true)],
            amp: true,
        };
        assert_eq!(
            replace(b"foo", &p, &quoted, false, None, false, true, None).unwrap(),
            b"f&o"
        );
    }

    #[test]
    fn characters_follow_the_locale() {
        let p = pattern("?", "");
        assert_eq!(strip("éx".as_bytes(), &p, false, true, false, true), b"x");
        assert_eq!(
            strip("éx".as_bytes(), &p, false, true, false, false),
            b"\xa9x"
        );
        assert_eq!(
            substring("héllo".as_bytes(), 1, Some(2), true),
            "él".as_bytes()
        );
        assert_eq!(length("héllo".as_bytes(), false), 6);
    }

    #[test]
    fn recases_matching_characters() {
        assert_eq!(
            recase("^", b"abc", &Pattern::default(), false, true),
            b"Abc"
        );
        assert_eq!(
            recase("^^", b"abc", &pattern("[ab]", ""), false, true),
            b"ABc"
        );
        assert_eq!(
            recase(",,", "ÀB".as_bytes(), &Pattern::default(), false, true),
            "àb".as_bytes()
        );
        assert_eq!(
            recase("^^", "é".as_bytes(), &Pattern::default(), false, false),
            "é".as_bytes()
        );
    }
}
