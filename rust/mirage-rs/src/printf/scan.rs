use super::{Input, hex, number};

pub(super) struct NumberValue {
    pub integer: i128,
    pub float: f64,
    pub read: usize,
    pub erange: bool,
}

enum Phase {
    Space,
    Start,
    Integer,
    Mantissa,
    Power,
    NanTag { read: usize },
}

pub(super) struct NumberScan {
    integer: bool,
    signed: bool,
    at: usize,
    phase: Phase,
    negative: bool,
    base: u32,
    value: u128,
    fraction: usize,
    dot: bool,
    kept: Vec<u8>,
    significant: usize,
    sticky: bool,
    power_negative: bool,
    power: i64,
}

impl NumberScan {
    pub fn new(integer: bool, signed: bool) -> Self {
        Self {
            integer,
            signed,
            at: 0,
            phase: Phase::Space,
            negative: false,
            base: 10,
            value: 0,
            fraction: 0,
            dot: false,
            kept: Vec::new(),
            significant: 0,
            sticky: false,
            power_negative: false,
            power: 0,
        }
    }

    fn result(&self, read: usize) -> NumberValue {
        if self.integer {
            let limit = if self.signed {
                i64::MAX as u128 + u128::from(self.negative)
            } else {
                u64::MAX as u128
            };
            let n = self.value.min(limit);
            let integer = if self.signed {
                if self.negative {
                    -(n as i128)
                } else {
                    n as i128
                }
            } else if self.value > limit {
                u64::MAX as i128
            } else if self.negative {
                (0u64.wrapping_sub(n as u64)) as i128
            } else {
                n as i128
            };
            NumberValue {
                integer,
                float: integer as f64,
                read,
                erange: self.value > limit,
            }
        } else {
            let mut token = Vec::new();
            if self.negative {
                token.push(b'-');
            }
            if self.base == 16 {
                token.extend_from_slice(b"0x");
            }
            if self.kept.is_empty() {
                token.push(b'0');
            } else {
                token.extend_from_slice(&self.kept);
            }
            let dropped = self.significant.saturating_sub(self.kept.len());
            let mut exponent = if self.power_negative {
                -self.power
            } else {
                self.power
            };
            let multiplier = if self.base == 16 { 4 } else { 1 };
            exponent = exponent
                .saturating_sub((self.fraction as i64).saturating_mul(multiplier))
                .saturating_add((dropped as i64).saturating_mul(multiplier));
            if self.sticky {
                token.push(b'1');
                exponent = exponent.saturating_sub(multiplier);
            }
            token.push(if self.base == 16 { b'p' } else { b'e' });
            token.extend_from_slice(exponent.to_string().as_bytes());
            let (float, _, erange) = number::parse_float(&token);
            NumberValue {
                integer: 0,
                float,
                read,
                erange,
            }
        }
    }

    fn special(&self, raw: &Input, at: usize, word: &[u8]) -> bool {
        word.iter()
            .enumerate()
            .all(|(i, b)| raw.get(at + i).is_some_and(|v| v.eq_ignore_ascii_case(b)))
    }

    pub fn step(&mut self, raw: &Input) -> Option<NumberValue> {
        match self.phase {
            Phase::Space => {
                if raw
                    .get(self.at)
                    .is_some_and(|b| b" \t\n\x0b\x0c\r".contains(&b))
                {
                    self.at += 1;
                } else {
                    self.phase = Phase::Start;
                }
            }
            Phase::Start => {
                if matches!(raw.get(self.at), Some(b'+' | b'-')) {
                    self.negative = raw.get(self.at) == Some(b'-');
                    self.at += 1;
                }
                if !self.integer && self.special(raw, self.at, b"inf") {
                    self.at += if self.special(raw, self.at, b"infinity") {
                        8
                    } else {
                        3
                    };
                    return Some(NumberValue {
                        integer: 0,
                        float: if self.negative {
                            f64::NEG_INFINITY
                        } else {
                            f64::INFINITY
                        },
                        read: self.at,
                        erange: false,
                    });
                }
                if !self.integer && self.special(raw, self.at, b"nan") {
                    self.at += 3;
                    if raw.get(self.at) == Some(b'(') {
                        let read = self.at;
                        self.at += 1;
                        self.phase = Phase::NanTag { read };
                    } else {
                        return Some(self.nan(self.at));
                    }
                    return None;
                }
                if raw.get(self.at) == Some(b'0') {
                    let marker = raw.get(self.at + 1);
                    let hex_start = raw.get(self.at + 2).is_some_and(|b| hex(b).is_some())
                        || (!self.integer
                            && raw.get(self.at + 2) == Some(b'.')
                            && raw.get(self.at + 3).is_some_and(|b| hex(b).is_some()));
                    if matches!(marker, Some(b'x' | b'X')) && hex_start {
                        self.base = 16;
                        self.at += 2;
                    } else if self.integer
                        && matches!(marker, Some(b'b' | b'B'))
                        && matches!(raw.get(self.at + 2), Some(b'0' | b'1'))
                    {
                        self.base = 2;
                        self.at += 2;
                    } else if self.integer {
                        self.base = 8;
                    }
                }
                let valid = raw
                    .get(self.at)
                    .is_some_and(|b| hex(b).is_some_and(|n| n < self.base))
                    || (!self.integer
                        && raw.get(self.at) == Some(b'.')
                        && raw
                            .get(self.at + 1)
                            .is_some_and(|b| hex(b).is_some_and(|n| n < self.base)));
                if !valid {
                    return Some(NumberValue {
                        integer: 0,
                        float: 0.0,
                        read: 0,
                        erange: false,
                    });
                }
                self.phase = if self.integer {
                    Phase::Integer
                } else {
                    Phase::Mantissa
                };
            }
            Phase::Integer => {
                if let Some(n) = raw.get(self.at).and_then(hex).filter(|n| *n < self.base) {
                    self.value = self
                        .value
                        .saturating_mul(self.base as u128)
                        .saturating_add(n as u128)
                        .min(u64::MAX as u128 + 1);
                    self.at += 1;
                } else {
                    return Some(self.result(self.at));
                }
            }
            Phase::Mantissa => {
                if let Some(n) = raw.get(self.at).and_then(hex).filter(|n| *n < self.base) {
                    if self.dot {
                        self.fraction += 1;
                    }
                    if n != 0 || self.significant != 0 {
                        self.significant += 1;
                        let limit = if self.base == 16 { 32 } else { 12000 };
                        if self.kept.len() < limit {
                            self.kept.push(raw.get(self.at).expect("digit"));
                        } else {
                            self.sticky |= n != 0;
                        }
                    }
                    self.at += 1;
                } else if !self.dot && raw.get(self.at) == Some(b'.') {
                    self.dot = true;
                    self.at += 1;
                } else {
                    let marker = if self.base == 16 { b'p' } else { b'e' };
                    let next = self.at
                        + 1
                        + usize::from(matches!(raw.get(self.at + 1), Some(b'+' | b'-')));
                    if raw
                        .get(self.at)
                        .is_some_and(|b| b.eq_ignore_ascii_case(&marker))
                        && raw.get(next).is_some_and(|b| b.is_ascii_digit())
                    {
                        self.power_negative = raw.get(self.at + 1) == Some(b'-');
                        self.at = next;
                        self.phase = Phase::Power;
                    } else {
                        return Some(self.result(self.at));
                    }
                }
            }
            Phase::Power => {
                if let Some(b @ b'0'..=b'9') = raw.get(self.at) {
                    self.power = (self.power * 10 + (b - b'0') as i64).min(1_000_000_000);
                    self.at += 1;
                } else {
                    return Some(self.result(self.at));
                }
            }
            Phase::NanTag { read } => match raw.get(self.at) {
                Some(b')') => return Some(self.nan(self.at + 1)),
                Some(b) if b.is_ascii_alphanumeric() || b == b'_' => self.at += 1,
                _ => return Some(self.nan(read)),
            },
        }
        None
    }

    fn nan(&self, read: usize) -> NumberValue {
        NumberValue {
            integer: 0,
            float: if self.negative { -f64::NAN } else { f64::NAN },
            read,
            erange: false,
        }
    }
}
