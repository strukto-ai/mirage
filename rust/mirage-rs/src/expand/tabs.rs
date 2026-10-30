//! The `-t`/`--tabs` list expand and unexpand read, as GNU 9.7 reads it:
//! every occurrence in typed order adds to one list of stops, `/N` and `+N`
//! sizes past them, refused in the program's own name.

use super::Tabs;
use crate::{StreamError, quoted};

/// GNU refuses a stop at or past 2**63, quoting its digits as typed.
const TOO_LARGE: u64 = 1 << 63;

/// A value `give` refused; its line is in `TabList::problems`.
struct Refused;

/// What a size specifier (`/` or `+`) is, a byte of the value.
fn is_specifier(byte: u8) -> bool {
    byte == b'/' || byte == b'+'
}

/// `isblank` in the C locale: space and TAB separate numbers, nothing else.
fn is_blank(byte: u8) -> bool {
    byte == b' ' || byte == b'\t'
}

/// One digit run below 2**63, leading zeros and all.
fn decimal(digits: &[u8]) -> Option<u64> {
    digits
        .iter()
        .try_fold(0_u64, |value, digit| {
            value.checked_mul(10)?.checked_add(u64::from(digit - b'0'))
        })
        .filter(|&value| value < TOO_LARGE)
}

/// The list as the values read so far built it. The stops and the two
/// sizes carry over from one `-t` to the next; what one value is in the
/// middle of does not.
struct TabList<'a> {
    program: &'a str,
    stops: Vec<u64>,
    extend: u64,
    increment: u64,
    problems: Vec<String>,
}

impl TabList<'_> {
    fn problem(&mut self, line: impl AsRef<str>) {
        self.problems
            .push(format!("{}: {}", self.program, line.as_ref()));
    }

    fn invalid(&mut self, rest: &[u8]) {
        self.problem(format!(
            "tab size contains invalid character(s): '{}'",
            quoted(rest)
        ));
    }

    /// Settle one number of a value. A number led by `/` or `+` (or by one
    /// still waiting from earlier in the same value, `-t 1,+0,3` making 3
    /// the increment) sets that size, `/` winning when both lead it. A zero
    /// sets nothing and leaves the specifier waiting, so `-t +0,0,0` is the
    /// default 8. A size set twice is refused even by a zero; the other size
    /// only by a nonzero value; a plain number after a size in the same
    /// value names the specifier typed last (`-t /+4,2` names `+`).
    ///
    /// Returns the specifier that set a size in this value so far.
    fn give(
        &mut self,
        value: u64,
        waiting: &mut Vec<u8>,
        given: Option<u8>,
    ) -> Result<Option<u8>, Refused> {
        if waiting.is_empty() {
            if let Some(given) = given {
                self.problem(format!(
                    "'{}' specifier only allowed with the last value",
                    char::from(given)
                ));
                return Err(Refused);
            }
            self.stops.push(value);
            return Ok(given);
        }
        let size = if waiting.contains(&b'/') { b'/' } else { b'+' };
        let (this, other) = if size == b'/' {
            (self.extend, self.increment)
        } else {
            (self.increment, self.extend)
        };
        if this != 0 {
            self.problem(format!(
                "'{}' specifier only allowed with the last value",
                char::from(size)
            ));
            return Err(Refused);
        }
        if value == 0 {
            return Ok(given);
        }
        if other != 0 {
            self.problem("'/' specifier is mutually exclusive with '+'");
            return Err(Refused);
        }
        if size == b'/' {
            self.extend = value;
        } else {
            self.increment = value;
        }
        let named = waiting.last().copied();
        waiting.clear();
        Ok(named)
    }

    /// One number from its first digit to the next separator: where it
    /// ends, its value (`None` when a digit run was too large) and the
    /// specifiers misplaced inside it, or `None` when an invalid character
    /// ended the parse. A misplaced specifier or a too large run is
    /// reported and the scan goes on; the misplaced specifiers then lead
    /// the next number.
    fn number(&mut self, raw: &[u8], mut at: usize) -> Option<(usize, Option<u64>, Vec<u8>)> {
        let mut value = 0_u64;
        let mut oversized = false;
        let mut misplaced = Vec::new();
        while let Some(&byte) = raw.get(at).filter(|&&byte| byte != b',' && !is_blank(byte)) {
            if is_specifier(byte) {
                self.problem(format!(
                    "'{}' specifier not at start of number: '{}'",
                    char::from(byte),
                    quoted(&raw[at..])
                ));
                misplaced.push(byte);
                at += 1;
                continue;
            }
            if !byte.is_ascii_digit() {
                self.invalid(&raw[at..]);
                return None;
            }
            let run = at;
            while raw.get(at).is_some_and(u8::is_ascii_digit) {
                at += 1;
            }
            let digits = &raw[run..at];
            if decimal(digits).is_none() {
                self.problem(format!("tab stop is too large '{}'", quoted(digits)));
                oversized = true;
            }
            value = digits.iter().fold(value, |value, digit| {
                value
                    .saturating_mul(10)
                    .saturating_add(u64::from(digit - b'0'))
            });
        }
        Some((at, (!oversized).then_some(value), misplaced))
    }

    /// Read one value into the list: numbers split by commas and blanks,
    /// an empty element skipped. Any character other than a digit, a
    /// separator or a specifier ends the whole parse, quoting the rest of
    /// the value (`-t 1,x,0` reports 'x,0'). False when the parse ended.
    fn read(&mut self, raw: &[u8]) -> bool {
        let mut waiting = Vec::new();
        let mut given = None;
        let mut at = 0;
        while let Some(&byte) = raw.get(at) {
            if byte == b',' || is_blank(byte) {
                at += 1;
                continue;
            }
            if is_specifier(byte) {
                waiting.push(byte);
                at += 1;
                continue;
            }
            if !byte.is_ascii_digit() {
                self.invalid(&raw[at..]);
                return false;
            }
            let Some((end, value, misplaced)) = self.number(raw, at) else {
                return false;
            };
            at = end;
            if let Some(value) = value {
                match self.give(value, &mut waiting, given) {
                    Ok(named) => given = named,
                    Err(Refused) => return false,
                }
            }
            waiting.extend(misplaced);
        }
        true
    }
}

/// Every `-t` value one line typed, in typed order, as one tab list. A
/// value that leaves any problem ends the parse there, every line of it
/// refused at once (`-t 4+ -t x` reports only the '+'). Once every value
/// reads, each stop is tested for zero before it is tested against the one
/// before it, so `-t 3,0` cannot be 0 and `-t 3,1,0` must be ascending.
pub(super) fn tab_list(program: &str, values: &[&[u8]]) -> Result<Tabs, StreamError> {
    let mut list = TabList {
        program,
        stops: Vec::new(),
        extend: 0,
        increment: 0,
        problems: Vec::new(),
    };
    for raw in values {
        if !list.read(raw) || !list.problems.is_empty() {
            return Err(StreamError::new(list.problems.join("\n")));
        }
    }
    let mut previous = 0;
    for &stop in &list.stops {
        if stop == 0 {
            return Err(StreamError::new(format!("{program}: tab size cannot be 0")));
        }
        if stop <= previous {
            return Err(StreamError::new(format!(
                "{program}: tab sizes must be ascending"
            )));
        }
        previous = stop;
    }
    Ok(Tabs {
        stops: list.stops,
        extend: list.extend,
        increment: list.increment,
    })
}

#[cfg(test)]
mod tests {
    use super::tab_list;

    fn read(values: &[&str]) -> Result<(Vec<u64>, u64, u64), String> {
        let values: Vec<&[u8]> = values.iter().map(|value| value.as_bytes()).collect();
        tab_list("expand", &values)
            .map(|tabs| (tabs.stops, tabs.extend, tabs.increment))
            .map_err(|refusal| {
                assert_eq!(refusal.status, 1);
                refusal.message
            })
    }

    fn refusal(values: &[&str]) -> String {
        read(values).expect_err("a refused tab list")
    }

    #[test]
    fn reads_stops_and_both_sizes() {
        type Read<'a> = (&'a [&'a str], (&'a [u64], u64, u64));
        let cases: &[Read] = &[
            (&["4"], (&[4], 0, 0)),
            (&["+4"], (&[], 0, 4)),
            (&["/4"], (&[], 4, 0)),
            (&["04"], (&[4], 0, 0)),
            (&["2,/4"], (&[2], 4, 0)),
            (&["2,+4"], (&[2], 0, 4)),
            (&["/+4"], (&[], 4, 0)),
            (&["+/4"], (&[], 4, 0)),
            (&["1,,3"], (&[1, 3], 0, 0)),
            (&[" 2 , 4 , 6 "], (&[2, 4, 6], 0, 0)),
            (&["2\t4\t6"], (&[2, 4, 6], 0, 0)),
            (&["+0"], (&[], 0, 0)),
            (&["/0"], (&[], 0, 0)),
            (&["+0,0,0"], (&[], 0, 0)),
            (&["1,+0,3"], (&[1], 0, 3)),
            (&["5,/0,3"], (&[5], 3, 0)),
            (&["2,4", "6"], (&[2, 4, 6], 0, 0)),
            (&["+4", "2"], (&[2], 0, 4)),
            (&["2", "/4"], (&[2], 4, 0)),
            (&["4", ""], (&[4], 0, 0)),
            (&["+4", "/0"], (&[], 0, 4)),
            (&["9223372036854775807"], (&[9223372036854775807], 0, 0)),
            (
                &["9007199254740993,9007199254740995"],
                (&[9007199254740993, 9007199254740995], 0, 0),
            ),
        ];
        for &(values, (stops, extend, increment)) in cases {
            assert_eq!(
                read(values),
                Ok((stops.to_vec(), extend, increment)),
                "{values:?}"
            );
        }
        for empty in ["", ",", ",,", " ", "+", "/"] {
            assert_eq!(read(&[empty]), Ok((Vec::new(), 0, 0)), "{empty:?}");
        }
        assert_eq!(read(&[]), Ok((Vec::new(), 0, 0)));
    }

    #[test]
    fn reads_numbers_past_any_digit_limit() {
        let zeros = "0".repeat(5000);
        assert_eq!(read(&[&format!("{zeros}4")]), Ok((vec![4], 0, 0)));
        assert_eq!(read(&[&format!("2,/{zeros}4")]), Ok((vec![2], 4, 0)));
        let nines = "9".repeat(5000);
        assert_eq!(
            refusal(&[&nines]),
            format!("expand: tab stop is too large '{nines}'")
        );
    }

    #[test]
    fn refuses_every_list_gnu_refuses() {
        let cases = [
            ("0", "tab size cannot be 0"),
            ("00", "tab size cannot be 0"),
            ("0,0", "tab size cannot be 0"),
            ("0,3", "tab size cannot be 0"),
            ("3,0", "tab size cannot be 0"),
            ("1,2,0", "tab size cannot be 0"),
            ("0,+4", "tab size cannot be 0"),
            ("3,1", "tab sizes must be ascending"),
            ("3,3", "tab sizes must be ascending"),
            ("1,3,2", "tab sizes must be ascending"),
            ("3,1,0", "tab sizes must be ascending"),
            ("1,x", "tab size contains invalid character(s): 'x'"),
            ("1,3x", "tab size contains invalid character(s): 'x'"),
            ("1,-3", "tab size contains invalid character(s): '-3'"),
            ("-4", "tab size contains invalid character(s): '-4'"),
            ("abc", "tab size contains invalid character(s): 'abc'"),
            ("8x", "tab size contains invalid character(s): 'x'"),
            ("+x", "tab size contains invalid character(s): 'x'"),
            ("1_0", "tab size contains invalid character(s): '_0'"),
            ("0x10", "tab size contains invalid character(s): 'x10'"),
            ("1e3", "tab size contains invalid character(s): 'e3'"),
            ("1;3;5", "tab size contains invalid character(s): ';3;5'"),
            ("x,3,1", "tab size contains invalid character(s): 'x,3,1'"),
            ("1,x,0", "tab size contains invalid character(s): 'x,0'"),
            ("x0", "tab size contains invalid character(s): 'x0'"),
            ("x+", "tab size contains invalid character(s): 'x+'"),
            ("0,x", "tab size contains invalid character(s): 'x'"),
            ("3,1,x", "tab size contains invalid character(s): 'x'"),
            ("8\n", "tab size contains invalid character(s): '\\n'"),
            ("8\n4", "tab size contains invalid character(s): '\\n4'"),
            ("8\r", "tab size contains invalid character(s): '\\r'"),
            ("8\x0b", "tab size contains invalid character(s): '\\v'"),
            ("8\x0c", "tab size contains invalid character(s): '\\f'"),
            ("8\x07", "tab size contains invalid character(s): '\\a'"),
            ("8\x01", "tab size contains invalid character(s): '\\001'"),
            (
                "\u{663}",
                "tab size contains invalid character(s): '\\331\\243'",
            ),
            (
                "8\u{663}",
                "tab size contains invalid character(s): '\\331\\243'",
            ),
            (
                "1,é",
                "tab size contains invalid character(s): '\\303\\251'",
            ),
            (
                "99999999999999999999",
                "tab stop is too large '99999999999999999999'",
            ),
            (
                "1,99999999999999999999,0",
                "tab stop is too large '99999999999999999999'",
            ),
            (
                "9223372036854775808",
                "tab stop is too large '9223372036854775808'",
            ),
            (
                "1,00018446744073709551614",
                "tab stop is too large '00018446744073709551614'",
            ),
            ("+4,2", "'+' specifier only allowed with the last value"),
            ("+4,0", "'+' specifier only allowed with the last value"),
            ("/4,2", "'/' specifier only allowed with the last value"),
            ("/4,/0", "'/' specifier only allowed with the last value"),
            ("/+4,2", "'+' specifier only allowed with the last value"),
            ("/3,+4", "'/' specifier is mutually exclusive with '+'"),
            ("4+", "'+' specifier not at start of number: '+'"),
            ("4/", "'/' specifier not at start of number: '/'"),
            ("+4+5", "'+' specifier not at start of number: '+5'"),
            ("+4/5", "'/' specifier not at start of number: '/5'"),
        ];
        for (raw, expected) in cases {
            assert_eq!(refusal(&[raw]), format!("expand: {expected}"), "{raw:?}");
        }
    }

    #[test]
    fn a_misplaced_specifier_or_large_run_reports_and_scans_on() {
        let cases: [(&str, &[&str]); 8] = [
            (
                "99999999999999999999,x",
                &[
                    "tab stop is too large '99999999999999999999'",
                    "tab size contains invalid character(s): 'x'",
                ],
            ),
            (
                "4+x",
                &[
                    "'+' specifier not at start of number: '+x'",
                    "tab size contains invalid character(s): 'x'",
                ],
            ),
            (
                "4/x",
                &[
                    "'/' specifier not at start of number: '/x'",
                    "tab size contains invalid character(s): 'x'",
                ],
            ),
            (
                "4+,x",
                &[
                    "'+' specifier not at start of number: '+,x'",
                    "tab size contains invalid character(s): 'x'",
                ],
            ),
            (
                "4+5+6",
                &[
                    "'+' specifier not at start of number: '+5+6'",
                    "'+' specifier not at start of number: '+6'",
                ],
            ),
            (
                "1,2+x",
                &[
                    "'+' specifier not at start of number: '+x'",
                    "tab size contains invalid character(s): 'x'",
                ],
            ),
            ("4+5,6", &["'+' specifier not at start of number: '+5,6'"]),
            (
                "4+5,6,7",
                &[
                    "'+' specifier not at start of number: '+5,6,7'",
                    "'+' specifier only allowed with the last value",
                ],
            ),
        ];
        for (raw, lines) in cases {
            let expected: Vec<String> =
                lines.iter().map(|line| format!("expand: {line}")).collect();
            assert_eq!(refusal(&[raw]), expected.join("\n"), "{raw:?}");
        }
    }

    #[test]
    fn refuses_against_what_earlier_values_built() {
        let cases: [(&[&str], &str); 10] = [
            (&["6", "2,4"], "tab sizes must be ascending"),
            (&["2,4", "1"], "tab sizes must be ascending"),
            (&["4", "4"], "tab sizes must be ascending"),
            (&["0", "4"], "tab size cannot be 0"),
            (&["4", "0"], "tab size cannot be 0"),
            (&["4", "x"], "tab size contains invalid character(s): 'x'"),
            (
                &["+4", "+5"],
                "'+' specifier only allowed with the last value",
            ),
            (
                &["+4", "+0"],
                "'+' specifier only allowed with the last value",
            ),
            (
                &["/4", "/5"],
                "'/' specifier only allowed with the last value",
            ),
            (
                &["+4", "/3"],
                "'/' specifier is mutually exclusive with '+'",
            ),
        ];
        for (values, expected) in cases {
            assert_eq!(refusal(values), format!("expand: {expected}"), "{values:?}");
        }
        assert_eq!(
            refusal(&["4+", "x"]),
            "expand: '+' specifier not at start of number: '+'"
        );
    }

    #[test]
    fn names_the_program_that_reads_the_list() {
        let Err(refusal) = tab_list("unexpand", &[b"0"]) else {
            panic!("a zero tab size was read");
        };
        assert_eq!(refusal.message, "unexpand: tab size cannot be 0");
        let Err(refusal) = tab_list("unexpand", &[b"\xff"]) else {
            panic!("a raw byte was read");
        };
        assert_eq!(
            refusal.message,
            "unexpand: tab size contains invalid character(s): '\\377'"
        );
    }
}
