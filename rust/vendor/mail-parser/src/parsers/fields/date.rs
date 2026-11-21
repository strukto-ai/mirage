/*
 * SPDX-FileCopyrightText: 2020 Stalwart Labs LLC <hello@stalw.art>
 *
 * SPDX-License-Identifier: Apache-2.0 OR MIT
 */

use std::fmt;

use crate::{DateTime, HeaderValue, parsers::MessageStream};

pub static DOW: &[&str] = &["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
pub static MONTH: &[&str] = &[
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

impl DateTime {
    /// Parses an RFC822 date
    pub fn parse_rfc822(value: &str) -> Option<Self> {
        match MessageStream::new(value.as_bytes()).parse_date() {
            HeaderValue::DateTime(dt) => dt.into(),
            _ => None,
        }
    }

    /// Parses an RFC3339 date
    pub fn parse_rfc3339(value: &str) -> Option<Self> {
        // 2004 - 06 - 28 T 23 : 43 : 45 . 000 Z
        // 1969 - 02 - 13 T 23 : 32 : 00 - 03 : 30
        //   0     1    2    3    4    5    6    7

        let mut pos = 0;
        let mut parts = [0u32; 8];
        let mut parts_sizes = [
            4u32, // Year (0)
            2u32, // Month (1)
            2u32, // Day (2)
            2u32, // Hour (3)
            2u32, // Minute (4)
            2u32, // Second (5)
            2u32, // TZ Hour (6)
            2u32, // TZ Minute (7)
        ];
        let mut skip_digits = false;
        let mut is_plus = true;

        for ch in value.as_bytes() {
            match ch {
                b'0'..=b'9' if !skip_digits => {
                    if parts_sizes[pos] > 0 {
                        parts_sizes[pos] -= 1;
                        parts[pos] += (*ch - b'0') as u32 * u32::pow(10, parts_sizes[pos]);
                    } else {
                        return None;
                    }
                }
                b'-' => {
                    if pos <= 1 {
                        pos += 1;
                    } else if pos == 5 {
                        pos += 1;
                        is_plus = false;
                        skip_digits = false;
                    } else {
                        return None;
                    }
                }
                b'T' => {
                    if pos == 2 {
                        pos += 1;
                    } else {
                        return None;
                    }
                }
                b':' => {
                    if [3, 4, 6].contains(&pos) {
                        pos += 1;
                    } else {
                        return None;
                    }
                }
                b'+' => {
                    if pos == 5 {
                        pos += 1;
                        skip_digits = false;
                    } else {
                        return None;
                    }
                }
                b'.' => {
                    if pos == 5 {
                        skip_digits = true;
                    } else {
                        return None;
                    }
                }

                _ => (),
            }
        }

        if pos >= 5 {
            DateTime {
                year: parts[0] as u16,
                month: parts[1] as u8,
                day: parts[2] as u8,
                hour: parts[3] as u8,
                minute: parts[4] as u8,
                second: parts[5] as u8,
                tz_hour: parts[6] as u8,
                tz_minute: parts[7] as u8,
                tz_before_gmt: !is_plus,
            }
            .into()
        } else {
            None
        }
    }

    /// Return an RFC822 date
    pub fn to_rfc822(&self) -> String {
        format!(
            "{}, {} {} {:04} {:02}:{:02}:{:02} {}{:02}{:02}",
            DOW[self.day_of_week() as usize],
            self.day,
            MONTH
                .get(self.month.saturating_sub(1) as usize)
                .unwrap_or(&""),
            self.year,
            self.hour,
            self.minute,
            self.second,
            if self.tz_before_gmt && (self.tz_hour > 0 || self.tz_minute > 0) {
                "-"
            } else {
                "+"
            },
            self.tz_hour,
            self.tz_minute
        )
    }

    /// Returns an RFC3339 representation of the parsed RFC5322 datetime field
    pub fn to_rfc3339(&self) -> String {
        if self.tz_hour != 0 || self.tz_minute != 0 {
            format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{}{:02}:{:02}",
                self.year,
                self.month,
                self.day,
                self.hour,
                self.minute,
                self.second,
                if self.tz_before_gmt && (self.tz_hour > 0 || self.tz_minute > 0) {
                    "-"
                } else {
                    "+"
                },
                self.tz_hour,
                self.tz_minute
            )
        } else {
            format!(
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
                self.year, self.month, self.day, self.hour, self.minute, self.second,
            )
        }
    }

    /// Returns true if the date is valid
    pub fn is_valid(&self) -> bool {
        (0..=23).contains(&self.tz_hour)
            && (1900..=3000).contains(&self.year)
            && (0..=59).contains(&self.tz_minute)
            && (1..=12).contains(&self.month)
            && (1..=31).contains(&self.day)
            && (0..=23).contains(&self.hour)
            && (0..=59).contains(&self.minute)
            && (0..=59).contains(&self.second)
    }

    /// Returns the numbers of seconds since 1970-01-01T00:00:00Z (Unix epoch)
    /// or None if the date is invalid.
    pub fn to_timestamp(&self) -> i64 {
        self.to_timestamp_local()
            + ((self.tz_hour as i64 * 3600 + self.tz_minute as i64 * 60)
                * if self.tz_before_gmt { 1 } else { -1 })
    }

    /// Returns the numbers of seconds since 1970-01-01T00:00:00Z (Unix epoch) in local time
    /// or None if the date is invalid.
    pub fn to_timestamp_local(&self) -> i64 {
        // Ported from https://github.com/protocolbuffers/upb/blob/22182e6e/upb/json_decode.c#L982-L992
        let month = self.month as u32;
        let year_base = 4800; /* Before min year, multiple of 400. */
        let m_adj = month.wrapping_sub(3); /* March-based month. */
        let carry = i64::from(m_adj > month);
        let adjust = if carry > 0 { 12 } else { 0 };
        let y_adj = self.year as i64 + year_base - carry;
        let month_days = ((m_adj.wrapping_add(adjust)) * 62719 + 769) / 2048;
        let leap_days = y_adj / 4 - y_adj / 100 + y_adj / 400;
        (y_adj * 365 + leap_days + month_days as i64 + (self.day as i64 - 1) - 2472632) * 86400
            + self.hour as i64 * 3600
            + self.minute as i64 * 60
            + self.second as i64
    }

    /// Creates a DateTime object from a timestamp
    pub fn from_timestamp(timestamp: i64) -> Self {
        // Ported from http://howardhinnant.github.io/date_algorithms.html#civil_from_days
        let (z, seconds) = (
            (timestamp.div_euclid(86400)) + 719468,
            timestamp.rem_euclid(86400),
        );
        let era: i64 = (if z >= 0 { z } else { z - 146096 }) / 146097;
        let doe: u64 = (z - era * 146097) as u64; // [0, 146096]
        let yoe: u64 = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
        let y: i64 = (yoe as i64) + era * 400;
        let doy: u64 = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
        let mp = (5 * doy + 2) / 153; // [0, 11]
        let d: u64 = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
        let m: u64 = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
        let (h, mn, s) = (seconds / 3600, (seconds / 60) % 60, seconds % 60);

        DateTime {
            year: (y + i64::from(m <= 2)) as u16,
            month: m as u8,
            day: d as u8,
            hour: h as u8,
            minute: mn as u8,
            second: s as u8,
            tz_before_gmt: false,
            tz_hour: 0,
            tz_minute: 0,
        }
    }

    /// Returns the day of week where [0, 6] represents [Sun, Sat].
    pub fn day_of_week(&self) -> u8 {
        (((self.to_timestamp_local() as f64 / 86400.0).floor() as i64 + 4).rem_euclid(7)) as u8
    }

    /// Returns the julian day
    pub fn julian_day(&self) -> i64 {
        let day = self.day as i64;
        let (month, year) = if self.month > 2 {
            ((self.month - 3) as i64, self.year as i64)
        } else {
            ((self.month + 9) as i64, (self.year - 1) as i64)
        };

        let c = year / 100;
        c * 146097 / 4 + (year - c * 100) * 1461 / 4 + (month * 153 + 2) / 5 + day + 1721119
    }

    /// Converts the DateTime to the given timezone
    pub fn to_timezone(&self, tz: i64) -> DateTime {
        let mut dt = DateTime::from_timestamp(self.to_timestamp() + tz);
        dt.tz_before_gmt = tz < 0;
        let tz = tz.abs();
        dt.tz_hour = (tz / 3600) as u8;
        dt.tz_minute = ((tz % 3600) / 60) as u8;
        dt
    }
}

impl PartialOrd for DateTime {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for DateTime {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        match self.to_timestamp() - other.to_timestamp() {
            0 => std::cmp::Ordering::Equal,
            x if x > 0 => std::cmp::Ordering::Greater,
            _ => std::cmp::Ordering::Less,
        }
    }
}

impl fmt::Display for DateTime {
    fn fmt(&self, fmt: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt.write_str(&self.to_rfc3339())
    }
}

impl<'x> MessageStream<'x> {
    pub fn parse_date(&mut self) -> HeaderValue<'x> {
        let mut pos = 0;
        let mut parts = [0u32; 7];
        let mut parts_sizes = [
            2u32, // Day (0)
            2u32, // Month (1)
            4u32, // Year (2)
            2u32, // Hour (3)
            2u32, // Minute (4)
            2u32, // Second (5)
            4u32, // TZ (6)
        ];
        let mut month_hash: usize = 0;
        let mut month_pos: usize = 0;

        let mut is_plus = true;
        let mut is_new_token = true;
        let mut ignore = true;
        let mut comment_count = 0;

        while let Some(ch) = self.next() {
            let mut next_part = false;

            match ch {
                b'\n' => {
                    if self.try_next_is_space() {
                        if !is_new_token && !ignore && comment_count == 0 {
                            next_part = true;
                        } else {
                            continue;
                        }
                    } else {
                        break;
                    }
                }
                _ if comment_count > 0 => {
                    if *ch == b')' {
                        comment_count -= 1;
                    } else if *ch == b'(' {
                        comment_count += 1;
                    } else if *ch == b'\\' {
                        self.try_skip_char(b')');
                    }
                    continue;
                }
                b'0'..=b'9' => {
                    if pos < 7 && parts_sizes[pos] > 0 {
                        parts_sizes[pos] -= 1;
                        parts[pos] += (*ch - b'0') as u32 * u32::pow(10, parts_sizes[pos]);

                        ignore = false;
                    }
                    is_new_token = false;
                }
                b':' if !is_new_token && !ignore && (pos == 3 || pos == 4) => {
                    next_part = true;
                }
                b'+' => {
                    pos = 6;
                }
                b'-' => {
                    is_plus = false;
                    pos = 6;
                }
                b' ' | b'\t' if !is_new_token && !ignore => {
                    next_part = true;
                }
                b'a'..=b'z' | b'A'..=b'Z' => {
                    if pos == 1 {
                        if (1..=2).contains(&month_pos) {
                            month_hash += MONTH_HASH
                                [(if *ch <= b'Z' { *ch + 32 } else { *ch }) as usize]
                                as usize;
                        }
                        month_pos += 1;
                    }
                    if pos == 6 {
                        let mut buf = [*ch, 0, 0];
                        let zone = self.obs_zone(&mut buf);
                        is_plus = !zone.is_negative();
                        parts[pos] = 100 * zone.unsigned_abs();
                        parts_sizes[pos] = 0;
                        next_part = true;
                    }
                    is_new_token = false;
                }
                b'(' => {
                    comment_count += 1;
                    is_new_token = true;
                    continue;
                }
                b',' | b'\r' => (),
                b';' => {
                    // May be parsing Received field, reset state.
                    pos = 0;
                    parts = [0u32; 7];
                    parts_sizes = [
                        2u32, // Day (0)
                        2u32, // Month (1)
                        4u32, // Year (2)
                        2u32, // Hour (3)
                        2u32, // Minute (4)
                        2u32, // Second (5)
                        4u32, // TZ (6)
                    ];
                    month_hash = 0;
                    month_pos = 0;

                    is_plus = true;
                    is_new_token = true;
                    ignore = true;
                    continue;
                }
                _ => (),
            }

            if next_part {
                if pos < 7 && parts_sizes[pos] > 0 {
                    parts[pos] /= u32::pow(10, parts_sizes[pos]);
                }
                pos += 1;
                is_new_token = true;
            }
        }

        if pos >= 6 {
            let month: u8 = if month_pos == 3 {
                MONTH_MAP.get(month_hash).copied().unwrap_or(0)
            } else {
                parts[1] as u8
            };
            if !(1..=12).contains(&month) {
                return HeaderValue::Empty;
            }
            HeaderValue::DateTime(DateTime {
                year: if (0..=49).contains(&parts[2]) {
                    parts[2] + 2000
                } else if (50..=99).contains(&parts[2]) {
                    parts[2] + 1900
                } else {
                    parts[2]
                } as u16,
                month,
                day: parts[0] as u8,
                hour: parts[3] as u8,
                minute: parts[4] as u8,
                second: parts[5] as u8,
                tz_hour: ((parts[6] / 100) % 24) as u8,
                tz_minute: ((parts[6] % 100) % 60) as u8,
                tz_before_gmt: !is_plus,
            })
        } else {
            HeaderValue::Empty
        }
    }
    // 4.3 obsolete date and time
    fn obs_zone(&mut self, buf: &mut [u8; 3]) -> i32 {
        let mut i = 1;
        for &b in self.by_ref() {
            buf[i] = b;
            i += 1;
            if i == 3 {
                break;
            }
        }

        hashify::tiny_map! { buf.as_ref(),
            "EDT" => -4,
            "EST" => -5,
            "CDT" => -5,
            "CST" => -6,
            "MDT" => -6,
            "MST" => -7,
            "PDT" => -7,
            "PST" => -8,
        }
        .unwrap_or(0)
    }
}

static MONTH_HASH: &[u8] = &[
    31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31,
    31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31,
    31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31,
    31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31,
    31, 0, 14, 4, 31, 10, 31, 14, 31, 31, 31, 31, 4, 31, 10, 15, 15, 31, 5, 31, 0, 5, 15, 31, 31,
    0, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31,
    31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31,
    31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31,
    31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31,
    31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31,
    31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31, 31,
];

pub static MONTH_MAP: &[u8; 31] = &[
    5, 0, 0, 0, 10, 3, 0, 0, 0, 7, 1, 0, 0, 0, 12, 6, 0, 0, 0, 8, 4, 0, 0, 0, 2, 9, 0, 0, 0, 0, 11,
];

#[cfg(test)]
mod tests {
    use chrono::{FixedOffset, LocalResult, SecondsFormat, TimeZone, Utc};

    use crate::{
        DateTime,
        parsers::{MessageStream, fields::load_tests},
    };

    #[test]
    fn parse_dates() {
        for test in load_tests("date.json") {
            let datetime = MessageStream::new(test.header.as_bytes())
                .parse_date()
                .into_datetime();
            assert_eq!(datetime, test.expected, "failed for {:?}", test.header);

            match datetime {
                Some(datetime) if datetime.is_valid() => {
                    if let LocalResult::Single(chrono_datetime)
                    | LocalResult::Ambiguous(chrono_datetime, _) = FixedOffset::west_opt(
                        ((datetime.tz_hour as i32 * 3600i32) + datetime.tz_minute as i32 * 60)
                            * if datetime.tz_before_gmt { 1i32 } else { -1i32 },
                    )
                    .unwrap_or_else(|| FixedOffset::east_opt(0).unwrap())
                    .with_ymd_and_hms(
                        datetime.year as i32,
                        datetime.month as u32,
                        datetime.day as u32,
                        datetime.hour as u32,
                        datetime.minute as u32,
                        datetime.second as u32,
                    ) {
                        assert_eq!(
                            chrono_datetime.timestamp(),
                            datetime.to_timestamp(),
                            "{} -> {} ({}) -> {} ({})",
                            test.header.escape_debug(),
                            datetime.to_timestamp(),
                            Utc.timestamp_opt(datetime.to_timestamp(), 0)
                                .unwrap()
                                .to_rfc3339_opts(SecondsFormat::Secs, true),
                            chrono_datetime.timestamp(),
                            Utc.timestamp_opt(chrono_datetime.timestamp(), 0)
                                .unwrap()
                                .to_rfc3339_opts(SecondsFormat::Secs, true)
                        );
                        let ts = datetime.to_timestamp();
                        assert_eq!(DateTime::from_timestamp(ts).to_timestamp(), ts);
                    }
                }
                _ => {}
            }
        }
    }

    #[test]
    fn datetime_to_timezone() {
        let dt = DateTime::parse_rfc3339("2021-01-01T00:00:00Z").unwrap();

        for (tz, expected) in [
            (0i64, "2021-01-01T00:00:00Z"),
            (3600, "2021-01-01T01:00:00+01:00"),
            (-3600, "2020-12-31T23:00:00-01:00"),
            (19800, "2021-01-01T05:30:00+05:30"),
            (-12600, "2020-12-31T20:30:00-03:30"),
            (20700, "2021-01-01T05:45:00+05:45"),
            (16200, "2021-01-01T04:30:00+04:30"),
            (34200, "2021-01-01T09:30:00+09:30"),
            (-45900, "2020-12-31T11:15:00-12:45"),
        ] {
            let converted = dt.to_timezone(tz);
            assert_eq!(converted.to_rfc3339(), expected, "failed for tz {tz}");
            assert!(converted.is_valid(), "invalid datetime for tz {tz}");
            assert_eq!(
                converted.to_timestamp(),
                dt.to_timestamp(),
                "roundtrip failed for tz {tz}"
            );
        }
    }
}
