// Adapted from Oniguruma 6.9.10 (BSD-2-Clause), src/regexec.c, src/regerror.c and src/ascii.c. See licenses/third_party/oniguruma.txt.

/// ONIG_CALLOUT_MAX_ARGS_NUM.
pub(super) const MAX_ARGS: usize = 4;

/// ONIG_CALLOUT_DATA_SLOT_NUM, as far as the builtins use them.
const SLOTS: usize = 3;

const INVALID_CALLOUT_ARG: &str = "invalid callout arg";
const INVALID_CALLOUT_TAG: &str = "invalid callout tag name";
const INVALID_CALLOUT_BODY: &str = "invalid callout body";

/// What an argument of a builtin callout reads as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Type {
    Long,
    /// A number, or the tag of a callout whose counter it reads.
    LongOrTag,
    Char,
    Str,
}

#[derive(Debug)]
pub(super) enum Arg {
    Long(i64),
    Tag(String),
    Char(char),
    Str(String),
}

/// A counter a builtin compares or caps by: a number, or slot 0 of the
/// callout a tag named (its index once `resolve_tags` ran).
#[derive(Debug)]
pub(super) enum Operand {
    Value(i64),
    Tag(String),
    Of(usize),
}

#[derive(Debug)]
pub(super) enum Kind {
    /// `(?{...})`, which runs nothing: jq sets no callout function.
    Contents,
    Fail,
    Mismatch,
    Skip,
    Error(i64),
    Max {
        max: Operand,
        how: char,
    },
    Count {
        how: char,
        /// `(*TOTAL_COUNT)` keeps counting across match attempts.
        total: bool,
    },
    Cmp {
        left: Operand,
        op: String,
        right: Operand,
    },
}

#[derive(Debug)]
pub(super) struct Callout {
    pub(super) kind: Kind,
    pub(super) tag: Option<String>,
}

impl Callout {
    /// Whether the callout runs as matching passes it.
    pub(super) fn in_progress(&self) -> bool {
        !matches!(self.kind, Kind::Contents)
    }

    /// Whether the callout runs again as backtracking passes it.
    pub(super) fn in_retraction(&self) -> bool {
        matches!(self.kind, Kind::Max { .. } | Kind::Count { .. })
    }
}

/// A builtin callout name: its argument types, how many of them are
/// optional, and how its arguments make its kind.
pub(super) struct Builtin {
    pub(super) types: &'static [Type],
    pub(super) optional: usize,
    pub(super) build: fn(&[Arg]) -> Kind,
}

fn operand(arg: &Arg) -> Operand {
    match arg {
        Arg::Long(value) => Operand::Value(*value),
        Arg::Tag(tag) => Operand::Tag(tag.clone()),
        Arg::Char(_) | Arg::Str(_) => unreachable!("a counter is a number or a tag"),
    }
}

fn how(arg: Option<&Arg>, default: char) -> char {
    match arg {
        Some(Arg::Char(c)) => *c,
        Some(_) => unreachable!("a count type is a character"),
        None => default,
    }
}

fn build_fail(_: &[Arg]) -> Kind {
    Kind::Fail
}

fn build_mismatch(_: &[Arg]) -> Kind {
    Kind::Mismatch
}

fn build_skip(_: &[Arg]) -> Kind {
    Kind::Skip
}

fn build_error(args: &[Arg]) -> Kind {
    Kind::Error(match args.first() {
        Some(Arg::Long(code)) => *code,
        Some(_) => unreachable!("an error code is a number"),
        None => -3,
    })
}

fn build_max(args: &[Arg]) -> Kind {
    Kind::Max {
        max: operand(&args[0]),
        how: how(args.get(1), 'X'),
    }
}

fn build_count(args: &[Arg]) -> Kind {
    Kind::Count {
        how: how(args.first(), '>'),
        total: false,
    }
}

fn build_total_count(args: &[Arg]) -> Kind {
    Kind::Count {
        how: how(args.first(), '>'),
        total: true,
    }
}

fn build_cmp(args: &[Arg]) -> Kind {
    let Arg::Str(op) = &args[1] else {
        unreachable!("an operator is a string")
    };
    Kind::Cmp {
        left: operand(&args[0]),
        op: op.clone(),
        right: operand(&args[2]),
    }
}

/// The builtin callout `name` names, as ascii.c registers them.
pub(super) fn builtin(name: &str) -> Option<&'static Builtin> {
    const FAIL: Builtin = Builtin {
        types: &[],
        optional: 0,
        build: build_fail,
    };
    const MISMATCH: Builtin = Builtin {
        types: &[],
        optional: 0,
        build: build_mismatch,
    };
    const SKIP: Builtin = Builtin {
        types: &[],
        optional: 0,
        build: build_skip,
    };
    const MAX: Builtin = Builtin {
        types: &[Type::LongOrTag, Type::Char],
        optional: 1,
        build: build_max,
    };
    const ERROR: Builtin = Builtin {
        types: &[Type::Long],
        optional: 1,
        build: build_error,
    };
    const COUNT: Builtin = Builtin {
        types: &[Type::Char],
        optional: 1,
        build: build_count,
    };
    const TOTAL_COUNT: Builtin = Builtin {
        types: &[Type::Char],
        optional: 1,
        build: build_total_count,
    };
    const CMP: Builtin = Builtin {
        types: &[Type::LongOrTag, Type::Str, Type::LongOrTag],
        optional: 0,
        build: build_cmp,
    };
    Some(match name {
        "FAIL" => &FAIL,
        "MISMATCH" => &MISMATCH,
        "SKIP" => &SKIP,
        "MAX" => &MAX,
        "ERROR" => &ERROR,
        "COUNT" => &COUNT,
        "TOTAL_COUNT" => &TOTAL_COUNT,
        "CMP" => &CMP,
        _ => return None,
    })
}

/// prs_long: a decimal with one leading sign, within i64.
fn long(text: &str) -> Option<i64> {
    let mut value: i64 = 0;
    let mut negative = false;
    for (i, c) in text.chars().enumerate() {
        if let Some(d) = c.to_digit(10) {
            value = value.checked_mul(10)?.checked_add(i64::from(d))?;
        } else if i == 0 && (c == '-' || c == '+') {
            negative = c == '-';
        } else {
            return None;
        }
    }
    Some(if negative { -value } else { value })
}

fn is_tag(text: &str) -> bool {
    !text.is_empty()
        && text.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !text.starts_with(|c: char| c.is_ascii_digit())
}

/// One argument read as `kind`; `chars` counts what it was written
/// with, `escapes` whether a backslash was.
pub(super) fn arg(
    kind: Type,
    text: &str,
    chars: usize,
    escapes: bool,
) -> Result<Arg, &'static str> {
    match kind {
        Type::Long => long(text).map(Arg::Long).ok_or(INVALID_CALLOUT_ARG),
        Type::LongOrTag => match long(text) {
            Some(value) => Ok(Arg::Long(value)),
            None if !escapes && is_tag(text) => Ok(Arg::Tag(text.to_string())),
            None => Err(INVALID_CALLOUT_TAG),
        },
        Type::Char => {
            if chars != 1 {
                return Err(INVALID_CALLOUT_ARG);
            }
            Ok(Arg::Char(text.chars().next().unwrap_or('\0')))
        }
        Type::Str => Ok(Arg::Str(text.to_string())),
    }
}

/// Points each tag argument at the callout it names.
pub(super) fn resolve_tags(
    mut callouts: Vec<Callout>,
    tags: &[(String, usize)],
) -> Result<Vec<Callout>, String> {
    let resolve = |operand: &mut Operand| -> Result<(), String> {
        if let Operand::Tag(tag) = operand {
            match tags.iter().find(|(known, _)| known == tag) {
                Some((_, index)) => *operand = Operand::Of(*index),
                None => return Err(INVALID_CALLOUT_TAG.into()),
            }
        }
        Ok(())
    };
    for callout in &mut callouts {
        match &mut callout.kind {
            Kind::Max { max, .. } => resolve(max)?,
            Kind::Cmp { left, right, .. } => {
                resolve(left)?;
                resolve(right)?;
            }
            _ => {}
        }
    }
    Ok(callouts)
}

/// What a callout decided.
pub(super) enum Outcome {
    Success,
    Fail,
    /// The whole match attempt fails, with no backtracking.
    Mismatch,
    Error(&'static str),
}

/// One callout's data across a search (CalloutData): the attempt it was
/// last touched in, and its slots.
#[derive(Clone, Default)]
pub(super) struct Data {
    last: u64,
    slots: [Option<i64>; SLOTS],
}

/// The callout state of one search.
#[derive(Default)]
pub(super) struct State {
    pub(super) data: Vec<Data>,
    /// match_at_call_counter: the attempt now running.
    pub(super) attempt: u64,
    /// Where `(*SKIP)` moved the next start to.
    pub(super) skip: usize,
}

impl State {
    /// onig_check_callout_data_and_clear_old_values.
    fn clear_old(&mut self, num: usize) {
        let data = &mut self.data[num];
        if data.last != self.attempt {
            *data = Data::default();
            data.last = self.attempt;
        }
    }

    fn get(&mut self, num: usize, slot: usize, clear: bool) -> Option<i64> {
        if clear {
            self.clear_old(num);
        }
        self.data[num].slots[slot]
    }

    fn set(&mut self, num: usize, slot: usize, value: i64) {
        let data = &mut self.data[num];
        data.slots[slot] = Some(value);
        data.last = self.attempt;
    }

    fn operand(&mut self, operand: &Operand) -> i64 {
        match operand {
            Operand::Value(value) => *value,
            Operand::Of(num) => self.get(*num, 0, true).unwrap_or(0),
            Operand::Tag(_) => unreachable!("tags are resolved after parsing"),
        }
    }

    /// Runs callout `num` at `pos`, in retraction when backtracking
    /// passes it again.
    pub(super) fn run(
        &mut self,
        callouts: &[Callout],
        num: usize,
        pos: usize,
        retraction: bool,
    ) -> Outcome {
        match &callouts[num].kind {
            Kind::Contents => Outcome::Success,
            Kind::Fail => Outcome::Fail,
            Kind::Mismatch => Outcome::Mismatch,
            Kind::Skip => {
                if pos > self.skip {
                    self.skip = pos;
                }
                Outcome::Success
            }
            Kind::Error(code) => match *code {
                -1 => Outcome::Mismatch,
                code if code >= 0 || needs_param(code) => Outcome::Error(INVALID_CALLOUT_BODY),
                code => Outcome::Error(message(code)),
            },
            Kind::Max { max, how } => {
                self.clear_old(num);
                let mut value = self.get(num, 0, true).unwrap_or(0);
                let max = self.operand(max);
                if !matches!(how, '>' | 'X' | '<') {
                    return Outcome::Error(INVALID_CALLOUT_ARG);
                }
                if retraction {
                    if *how == '<' {
                        if value >= max {
                            return Outcome::Fail;
                        }
                        value += 1;
                    } else if *how == 'X' {
                        value -= 1;
                    }
                } else if *how != '<' {
                    if value >= max {
                        return Outcome::Fail;
                    }
                    value += 1;
                }
                self.set(num, 0, value);
                Outcome::Success
            }
            Kind::Count { how, total } => {
                if !total {
                    self.clear_old(num);
                }
                if !matches!(how, '>' | 'X' | '<') {
                    return Outcome::Error(INVALID_CALLOUT_ARG);
                }
                let mut value = self.get(num, 0, false).unwrap_or(0);
                let slot = if retraction {
                    match how {
                        '<' => value += 1,
                        'X' => value -= 1,
                        _ => {}
                    }
                    2
                } else {
                    if *how != '<' {
                        value += 1;
                    }
                    1
                };
                self.set(num, 0, value);
                let passes = self.get(num, slot, false).unwrap_or(0) + 1;
                self.set(num, slot, passes);
                Outcome::Success
            }
            Kind::Cmp { left, op, right } => {
                let lv = self.operand(left);
                let rv = self.operand(right);
                let code = match self.get(num, 0, true) {
                    Some(code) => code,
                    None => {
                        let Some(code) = comparison(op) else {
                            return Outcome::Error(INVALID_CALLOUT_ARG);
                        };
                        self.set(num, 0, code);
                        code
                    }
                };
                let holds = match code {
                    0 => lv == rv,
                    1 => lv != rv,
                    2 => lv < rv,
                    3 => lv > rv,
                    4 => lv <= rv,
                    _ => lv >= rv,
                };
                if holds {
                    Outcome::Success
                } else {
                    Outcome::Fail
                }
            }
        }
    }
}

/// `(*CMP)`'s operator as onig_builtin_cmp numbers it.
fn comparison(op: &str) -> Option<i64> {
    let mut chars = op.chars();
    let c1 = chars.next()?;
    let c2 = chars.next();
    if chars.next().is_some() {
        return None;
    }
    Some(match (c1, c2) {
        ('=', Some('=')) => 0,
        ('!', Some('=')) => 1,
        ('<', None) => 2,
        ('>', None) => 3,
        ('<', Some('=')) => 4,
        ('>', Some('=')) => 5,
        _ => return None,
    })
}

/// onig_is_error_code_needs_param.
fn needs_param(code: i64) -> bool {
    matches!(code, -220..=-215 | -223)
}

/// onig_error_code_to_str for a code `(*ERROR{n})` raises.
fn message(code: i64) -> &'static str {
    match code {
        -2 => "no support in this configuration",
        -3 => "abort",
        -5 => "fail to memory allocation",
        -6 => "undefined type (bug)",
        -11 => "internal parser error (bug)",
        -12 => "stack error (bug)",
        -13 => "undefined bytecode (bug)",
        -14 => "unexpected bytecode (bug)",
        -15 => "match-stack limit over",
        -16 => "parse depth limit over",
        -17 => "retry-limit-in-match over",
        -18 => "retry-limit-in-search over",
        -19 => "subexp-call-limit-in-search over",
        -21 => "default multibyte-encoding is not set",
        -22 => "can't convert to wide-char on specified multibyte-encoding",
        -23 => "fail to initialize",
        -30 => "invalid argument",
        -100 => "end pattern at left brace",
        -101 => "end pattern at left bracket",
        -102 => "empty char-class",
        -103 => "premature end of char-class",
        -104 => "end pattern at escape",
        -105 => "end pattern at meta",
        -106 => "end pattern at control",
        -108 => "invalid meta-code syntax",
        -109 => "invalid control-code syntax",
        -110 => "char-class value at end of range",
        -111 => "char-class value at start of range",
        -112 => "unmatched range specifier in char-class",
        -113 => "target of repeat operator is not specified",
        -114 => "target of repeat operator is invalid",
        -115 => "nested repeat operator",
        -116 => "unmatched close parenthesis",
        -117 => "end pattern with unmatched parenthesis",
        -118 => "end pattern in group",
        -119 => "undefined group option",
        -120 => "invalid group option",
        -121 => "invalid POSIX bracket type",
        -122 => "invalid pattern in look-behind",
        -123 => "invalid repeat range {lower,upper}",
        -200 => "too big number",
        -201 => "too big number for repeat range",
        -202 => "upper is smaller than lower in repeat range",
        -203 => "empty range in char class",
        -204 => "mismatch multibyte code length in char-class range",
        -205 => "too many multibyte code ranges are specified",
        -206 => "too short multibyte code string",
        -207 => "too big backref number",
        -208 => "invalid backref number/name",
        -209 => "numbered backref/call is not allowed. (use name)",
        -210 => "too many captures",
        -212 => "too long wide-char value",
        -213 => "undefined operator",
        -214 => "group name is empty",
        -221 => "never ending recursion",
        -222 => "group number is too big for capture history",
        -224 => "invalid if-else syntax",
        -225 => "invalid absent group pattern",
        -226 => "invalid absent group generator pattern",
        -227 => "invalid callout pattern",
        -228 => "invalid callout name",
        -229 => "undefined callout name",
        -230 => INVALID_CALLOUT_BODY,
        -231 => INVALID_CALLOUT_TAG,
        -232 => INVALID_CALLOUT_ARG,
        -400 => "invalid code point value",
        -401 => "too big wide-char value",
        -402 => "not supported encoding combination",
        -403 => "invalid combination of options",
        -406 => "very inefficient pattern",
        -500 => "library is not initialized",
        _ => "undefined error code",
    }
}
