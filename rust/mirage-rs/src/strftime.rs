use serde::Deserialize;

use crate::{Stream, StreamError, parse_config};

const DAYS: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];
const MONTHS: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const MONTH_STARTS: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    year: i64,
    month: usize,
    day: i64,
    hour: i64,
    minute: i64,
    second: i64,
    nanosecond: u32,
    epoch: i64,
    offset: i64,
    zone: String,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    let leap = leap(config.year);
    let days = match config.month {
        2 => 28 + i64::from(leap),
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    };
    if !(1..=12).contains(&config.month)
        || !(1..=days).contains(&config.day)
        || !(0..=23).contains(&config.hour)
        || !(0..=59).contains(&config.minute)
        || !(0..=60).contains(&config.second)
        || config.nanosecond >= 1_000_000_000
        || config.year.unsigned_abs() > i32::MAX as u64 + 1900
        || config.offset.unsigned_abs() >= 86400
    {
        return Err(StreamError::new("strftime: invalid time fields"));
    }
    let ordinal = MONTH_STARTS[config.month - 1] + config.day + i64::from(leap && config.month > 2);
    let before = config.year - 1;
    let first =
        (before + before.div_euclid(4) - before.div_euclid(100) + before.div_euclid(400) + 1)
            .rem_euclid(7);
    let weekday = (first + ordinal - 1) % 7;
    let week = (ordinal + 9 - (weekday + 6) % 7) / 7;
    let (iso_year, iso_week) = if week == 0 {
        (config.year - 1, weeks(config.year - 1))
    } else if week > weeks(config.year) {
        (config.year + 1, 1)
    } else {
        (config.year, week)
    };
    Ok(Box::new(Strftime {
        config,
        ordinal,
        weekday,
        iso_year,
        iso_week,
        format: Vec::new(),
        finished: false,
    }))
}

fn leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn weeks(year: i64) -> i64 {
    let before = year - 1;
    let first =
        (before + before.div_euclid(4) - before.div_euclid(100) + before.div_euclid(400) + 1)
            .rem_euclid(7);
    if first == 4 || first == 3 && leap(year) {
        53
    } else {
        52
    }
}

struct Strftime {
    config: Config,
    ordinal: i64,
    weekday: i64,
    iso_year: i64,
    iso_week: i64,
    format: Vec<u8>,
    finished: bool,
}

impl Stream for Strftime {
    fn feed(&mut self, input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !self.finished {
            self.format.extend_from_slice(input);
        }
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if !std::mem::replace(&mut self.finished, true) {
            let format = std::mem::take(&mut self.format);
            self.render(&format, out)?;
        }
        Ok(())
    }
}

#[derive(Clone, Copy, Default)]
struct Flags {
    pad: Option<u8>,
    width: Option<usize>,
    upper: bool,
    swap: bool,
}

impl Flags {
    fn text(self, text: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let padding = if self.pad == Some(b'-') {
            0
        } else {
            self.width.unwrap_or(0).saturating_sub(text.len())
        };
        reserve(out, padding.saturating_add(text.len()))?;
        out.extend(std::iter::repeat_n(
            if matches!(self.pad, Some(b'0' | b'+')) {
                b'0'
            } else {
                b' '
            },
            padding,
        ));
        out.extend_from_slice(text);
        Ok(())
    }

    fn number(
        self,
        value: i64,
        natural: usize,
        space: bool,
        sign: bool,
        out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        let sign = if value < 0 {
            "-"
        } else if sign {
            "+"
        } else {
            ""
        };
        self.signed(sign, value.unsigned_abs(), natural, space, out)
    }

    fn signed(
        self,
        sign: &str,
        value: u64,
        natural: usize,
        space: bool,
        out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        let digits = value.to_string();
        let padding = if self.pad == Some(b'-') {
            0
        } else {
            self.width
                .unwrap_or(natural)
                .saturating_sub(digits.len() + sign.len())
        };
        reserve(out, padding.saturating_add(digits.len() + sign.len()))?;
        let spaces = self.pad == Some(b'_') || self.pad.is_none() && space;
        if spaces {
            out.extend(std::iter::repeat_n(b' ', padding));
        }
        out.extend_from_slice(sign.as_bytes());
        if !spaces {
            out.extend(std::iter::repeat_n(b'0', padding));
        }
        out.extend_from_slice(digits.as_bytes());
        Ok(())
    }
}

fn reserve(out: &mut Vec<u8>, additional: usize) -> Result<(), StreamError> {
    out.try_reserve(additional)
        .map_err(|_| StreamError::new("strftime: output is too large"))
}

impl Strftime {
    // GNU date's formatter differs from libc's (used by jq): widths replace
    // numeric defaults, '-' suppresses text padding, and '+' signs years.
    fn render(&self, format: &[u8], out: &mut Vec<u8>) -> Result<(), StreamError> {
        let mut at = 0;
        while at < format.len() {
            let start = at;
            at += 1;
            if format[start] != b'%' {
                out.push(format[start]);
                continue;
            }
            if format.get(at) == Some(&b'%') {
                out.push(b'%');
                at += 1;
                continue;
            }
            let mut flags = Flags::default();
            while let Some(&flag) = format.get(at).filter(|f| b"-_0^#+".contains(f)) {
                match flag {
                    b'^' => flags.upper = true,
                    b'#' => flags.swap = true,
                    _ => flags.pad = Some(flag),
                }
                at += 1;
            }
            while let Some(&digit) = format.get(at).filter(|b| b.is_ascii_digit()) {
                flags.width = Some(
                    flags
                        .width
                        .unwrap_or(0)
                        .checked_mul(10)
                        .and_then(|n| n.checked_add(usize::from(digit - b'0')))
                        .ok_or_else(|| StreamError::new("strftime: field width is too large"))?,
                );
                at += 1;
            }
            let colon_start = at;
            while format.get(at) == Some(&b':') {
                at += 1;
            }
            let colons = at - colon_start;
            let modifier = format
                .get(at)
                .copied()
                .filter(|m| colons == 0 && matches!(m, b'E' | b'O'));
            at += usize::from(modifier.is_some());
            let code = format.get(at).copied();
            at += usize::from(code.is_some());
            // GNU date 9.7 keeps all nine digits for bare %-N; adding a
            // width or another flag makes '-' trim the trailing zeros.
            if &format[start..at] == b"%-N" {
                flags.pad = None;
            }
            let valid = code.is_some_and(|c| {
                if colons > 0 {
                    return c == b'z' && colons <= 3;
                }
                match modifier {
                    Some(b'E') => b"cCnpPqrRstTuxXyYzZ".contains(&c),
                    Some(b'O') => b"bBCdeghHIjklmMnNpPrRsStTuUVwWyzZG".contains(&c),
                    _ => true,
                }
            });
            if valid && self.conversion(code.unwrap(), modifier, colons, flags, out)? {
                continue;
            }
            // A refused percent conversion is itself the next literal percent.
            // Its width counts the prefix, leaving that last '%' outside it.
            let end = if code == Some(b'%') { at - 1 } else { at };
            let mut literal = format[start..end].to_vec();
            if flags.upper {
                literal.make_ascii_uppercase();
            }
            flags.text(&literal, out)?;
            if code == Some(b'%') {
                at -= 1;
            }
        }
        Ok(())
    }

    fn conversion(
        &self,
        code: u8,
        modifier: Option<u8>,
        colons: usize,
        flags: Flags,
        out: &mut Vec<u8>,
    ) -> Result<bool, StreamError> {
        let c = &self.config;
        let hour12 = if c.hour % 12 == 0 { 12 } else { c.hour % 12 };
        if code == b'z' {
            self.offset(colons, flags, out)?;
            return Ok(true);
        }
        if code == b'N' {
            let digits = format!("{:09}", c.nanosecond);
            let width = flags.width.unwrap_or(9);
            let digits = &digits[..width.min(9)];
            let trimmed = if matches!(flags.pad, Some(b'-' | b'_')) {
                digits.trim_end_matches('0')
            } else {
                digits
            };
            let kept = trimmed.len().max(usize::from(width > 0));
            let width = if flags.pad == Some(b'-') { kept } else { width };
            reserve(out, width)?;
            out.extend_from_slice(&digits.as_bytes()[..kept]);
            out.extend(std::iter::repeat_n(
                if flags.pad == Some(b'_') { b' ' } else { b'0' },
                width.saturating_sub(kept),
            ));
            return Ok(true);
        }
        let numeric = match code {
            b'C' => Some((
                if modifier == Some(b'E') {
                    c.year.div_euclid(100)
                } else {
                    c.year / 100
                },
                2,
                false,
            )),
            b'd' | b'e' => Some((c.day, 2, code == b'e')),
            b'g' => Some((
                if modifier.is_some() {
                    self.iso_year.rem_euclid(100)
                } else {
                    self.iso_year.abs() % 100
                },
                2,
                false,
            )),
            b'G' => Some((self.iso_year, 4, false)),
            b'H' | b'k' => Some((c.hour, 2, code == b'k')),
            b'I' | b'l' => Some((hour12, 2, code == b'l')),
            b'j' => Some((self.ordinal, 3, false)),
            b'm' => Some((c.month as i64, 2, false)),
            b'M' => Some((c.minute, 2, false)),
            b'q' => Some(((c.month as i64 - 1) / 3 + 1, 1, false)),
            b'S' => Some((c.second, 2, false)),
            b's' => Some((c.epoch, 1, false)),
            b'u' => Some(((self.weekday + 6) % 7 + 1, 1, false)),
            b'U' => Some(((self.ordinal + 6 - self.weekday) / 7, 2, false)),
            b'V' => Some((self.iso_week, 2, false)),
            b'w' => Some((self.weekday, 1, false)),
            b'W' => Some(((self.ordinal + 6 - (self.weekday + 6) % 7) / 7, 2, false)),
            b'y' => Some((
                if modifier.is_some() {
                    c.year.rem_euclid(100)
                } else {
                    c.year.abs() % 100
                },
                2,
                false,
            )),
            b'Y' => Some((c.year, 4, false)),
            _ => None,
        };
        if let Some((value, natural, space)) = numeric {
            let natural =
                if modifier.is_some() && (b"CY".contains(&code) || code == b'G' && value >= 0) {
                    1
                } else {
                    natural
                };
            let plus = flags.pad == Some(b'+')
                && b"CGYyg".contains(&code)
                && (value >= 10i64.pow(natural as u32) || flags.width.is_some_and(|w| w > natural));
            if code == b'C' && c.year < 0 && value == 0 {
                flags.signed("-", 0, natural, space, out)?;
            } else {
                flags.number(value, natural, space, plus, out)?;
            }
            return Ok(true);
        }
        let composite = match code {
            b'c' => Some(b"%a %b %e %H:%M:%S %-Y".as_slice()),
            b'x' => Some(b"%m/%d/%Oy".as_slice()),
            b'r' => Some(b"%I:%M:%S %p".as_slice()),
            b'R' => Some(b"%H:%M".as_slice()),
            b'T' | b'X' => Some(b"%H:%M:%S".as_slice()),
            _ => None,
        };
        let mut text = if code == b'D' {
            let mut date = Vec::new();
            self.render(b"%m/%d/", &mut date)?;
            Flags {
                width: None,
                ..flags
            }
            .number(c.year.abs() % 100, 2, false, false, &mut date)?;
            date
        } else if code == b'F' {
            let mut date = Vec::new();
            let width = flags
                .width
                .map(|w| w.saturating_sub(6))
                .unwrap_or(if flags.pad.is_none() { 4 } else { 0 });
            let year_flags = Flags {
                pad: flags.pad,
                width: Some(if flags.pad == Some(b'_') { 0 } else { width }),
                ..Flags::default()
            };
            let plus = flags.pad == Some(b'+') || flags.pad.is_none() && flags.width.is_none();
            year_flags.number(
                c.year,
                0,
                false,
                plus && (c.year > 9999 || width > 4),
                &mut date,
            )?;
            self.render(b"-%m-%d", &mut date)?;
            if flags.pad != Some(b'_') {
                out.extend(date);
                return Ok(true);
            }
            date
        } else if let Some(format) = composite {
            let mut text = Vec::new();
            self.render(format, &mut text)?;
            text
        } else {
            match code {
                b'a' => DAYS[self.weekday as usize].as_bytes()[..3].to_vec(),
                b'A' => DAYS[self.weekday as usize].as_bytes().to_vec(),
                b'b' | b'h' => MONTHS[c.month - 1].as_bytes()[..3].to_vec(),
                b'B' => MONTHS[c.month - 1].as_bytes().to_vec(),
                b'n' => vec![b'\n'],
                b't' => vec![b'\t'],
                b'p' => if c.hour < 12 { b"AM" } else { b"PM" }.to_vec(),
                b'P' => if c.hour < 12 { b"am" } else { b"pm" }.to_vec(),
                b'Z' => c.zone.as_bytes().to_vec(),
                _ => return Ok(false),
            }
        };
        if flags.swap && b"pZ".contains(&code) {
            text.make_ascii_lowercase();
        } else if flags.upper && code != b'P' || flags.swap && b"aAbBh".contains(&code) {
            text.make_ascii_uppercase();
        }
        flags.text(&text, out)?;
        Ok(true)
    }

    fn offset(&self, colons: usize, flags: Flags, out: &mut Vec<u8>) -> Result<(), StreamError> {
        let total = self.config.offset.unsigned_abs();
        let sign = if self.config.offset < 0 { "-" } else { "+" };
        let hours = total / 3600;
        let minutes = total / 60 % 60;
        let seconds = total % 60;
        if colons == 0 {
            return flags.signed(sign, hours * 100 + minutes, 5, false, out);
        }
        let tail = if colons == 1 || colons == 3 && minutes != 0 && seconds == 0 {
            format!(":{minutes:02}")
        } else if colons == 2 || seconds != 0 {
            format!(":{minutes:02}:{seconds:02}")
        } else {
            String::new()
        };
        let hours_flags = Flags {
            width: flags.width.map(|w| w.saturating_sub(tail.len())),
            ..flags
        };
        hours_flags.signed(sign, hours, 3, false, out)?;
        out.extend_from_slice(tail.as_bytes());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use crate::open;

    fn moment() -> Value {
        json!({"year": 2026, "month": 1, "day": 1, "hour": 0, "minute": 0,
            "second": 1, "nanosecond": 123456000, "epoch": 1767225601,
            "offset": 0, "zone": "UTC"})
    }

    fn render(config: &Value, format: &[u8]) -> Vec<u8> {
        let mut stream = open("strftime", config.to_string().as_bytes()).unwrap();
        let mut out = Vec::new();
        for byte in format.chunks(1) {
            stream.feed(byte, &mut out).unwrap();
        }
        assert!(out.is_empty());
        stream.finish(&mut out).unwrap();
        let expected = out.clone();
        stream.finish(&mut out).unwrap();
        stream.feed(b"ignored", &mut out).unwrap();
        stream.finish(&mut out).unwrap();
        assert_eq!(out, expected);
        out
    }

    #[test]
    fn directives_and_refused_modifiers_match_gnu_date_9_7() {
        assert_eq!(render(&moment(), "%^d|%#d|%^C|%#P|%Ea|%EY|%Ob|%OC|%6Q|%06Q|%6%|%06%|%::::z|%:%z|%E|%O|%12|%%N".as_bytes()), "01|01|20|am|%Ea|2026|Jan|20|   %6Q|00%06Q|    %6%|000%06%|%::::z|%:+0000|%E|%O|        %12|%N".as_bytes());
    }

    #[test]
    fn gregorian_years_and_iso_weeks_do_not_depend_on_host_date_libraries() {
        for (year, month, day, hour, minute, second, expected) in [
            (
                1,
                1,
                1,
                0,
                0,
                0,
                "0001|0001|01|01|001|00|01|Mon|0001-01-01|01/01/01|01/01/01|Mon Jan  1 00:00:00 1",
            ),
            (
                0,
                1,
                1,
                0,
                0,
                0,
                "0000|-001|01|52|001|00|00|Sat|0000-01-01|01/01/00|01/01/00|Sat Jan  1 00:00:00 0",
            ),
            (
                -1,
                1,
                1,
                0,
                0,
                0,
                "-001|-002|02|53|001|00|00|Fri|-001-01-01|01/01/01|01/01/99|Fri Jan  1 00:00:00 -1",
            ),
            (
                10026,
                9,
                3,
                5,
                7,
                9,
                "10026|10026|26|36|246|35|35|Thu|+10026-09-03|09/03/26|09/03/26|Thu Sep  3 05:07:09 10026",
            ),
            (
                2017,
                1,
                1,
                0,
                0,
                0,
                "2017|2016|16|52|001|01|00|Sun|2017-01-01|01/01/17|01/01/17|Sun Jan  1 00:00:00 2017",
            ),
            (
                2021,
                1,
                1,
                0,
                0,
                0,
                "2021|2020|20|53|001|00|00|Fri|2021-01-01|01/01/21|01/01/21|Fri Jan  1 00:00:00 2021",
            ),
        ] {
            let mut config = moment();
            for (key, value) in [
                ("year", year),
                ("month", month),
                ("day", day),
                ("hour", hour),
                ("minute", minute),
                ("second", second),
            ] {
                config[key] = json!(value);
            }
            assert_eq!(
                render(&config, "%Y|%G|%g|%V|%j|%U|%W|%a|%F|%D|%x|%c".as_bytes()),
                expected.as_bytes(),
                "{year}-{month}-{day}"
            );
        }
    }

    #[test]
    fn nanosecond_padding_and_bare_dash_follow_gnu() {
        let format = b"%N|%-N|%--N|%_N|%-12N|%_12N|%3N|%12N";
        assert_eq!(
            render(&moment(), format),
            b"123456000|123456000|123456|123456   |123456|123456      |123|123456000000"
        );
        let mut config = moment();
        config["nanosecond"] = json!(0);
        assert_eq!(
            render(&config, format),
            b"000000000|000000000|0|0        |0|0           |000|000000000000"
        );
    }

    #[test]
    fn numeric_and_composite_padding_have_different_width_rules() {
        assert_eq!(render(&moment(), b"%1d|%3d|%-3d|%_3d|%+6Y|%_+5Y|%+_5Y|%12F|%+12F|%12D|%012D|%^c"),
            b"1|001|1|  1|+02026|+2026| 2026|002026-01-01|+02026-01-01|    01/01/26|000001/01/26|THU JAN  1 00:00:01 2026");
    }

    #[test]
    fn offsets_and_negative_epochs_pad_after_the_sign() {
        let mut config = moment();
        config["offset"] = json!(19800);
        config["epoch"] = json!(-1);
        assert_eq!(
            render(&config, b"%z|%:z|%::z|%:::z|%-z|%_z|%8:z|%_8:z|%3s|%_3s"),
            b"+0530|+05:30|+05:30:00|+05:30|+530| +530|+0005:30|   +5:30|-01| -1"
        );
        config["offset"] = json!(-1800);
        assert_eq!(
            render(&config, b"%z|%-z|%_z|%-:z|%_:::z"),
            b"-0030|-30|  -30|-0:30| -0:30"
        );
        config["offset"] = json!(3661);
        assert_eq!(
            render(&config, b"%z|%:z|%::z|%:::z"),
            b"+0101|+01:01|+01:01:01|+01:01:01"
        );
    }

    #[test]
    fn format_bytes_survive_chunk_boundaries() {
        let format = [b"\xff\xef\xbb\xbf".as_slice(), "😀%Y".as_bytes()].concat();
        let expected = [b"\xff\xef\xbb\xbf".as_slice(), "😀2026".as_bytes()].concat();
        assert_eq!(render(&moment(), &format), expected);
    }

    #[test]
    fn invalid_fields_and_overflowing_widths_fail() {
        for (key, value) in [
            ("month", 0),
            ("day", 32),
            ("hour", 24),
            ("minute", 60),
            ("second", 61),
            ("nanosecond", 1000000000),
            ("offset", 86400),
            ("unknown", 1),
        ] {
            let mut config = moment();
            config[key] = json!(value);
            assert!(
                open("strftime", config.to_string().as_bytes()).is_err(),
                "{key}"
            );
        }
        let mut config = moment();
        config["month"] = json!(2);
        config["day"] = json!(29);
        assert!(open("strftime", config.to_string().as_bytes()).is_err());
        let mut stream = open("strftime", moment().to_string().as_bytes()).unwrap();
        stream
            .feed(b"%1844674407370955161600Y", &mut Vec::new())
            .unwrap();
        assert!(stream.finish(&mut Vec::new()).is_err());
    }
}
