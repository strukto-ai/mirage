/// One unit of a pattern or subject: a character, or a byte that is no
/// part of one (every byte is a unit of its own outside a UTF-8 locale).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Unit {
    Char(char),
    Byte(u8),
}

impl Unit {
    /// The unit's ordinal for ranges: a code point, or a byte's value.
    pub(crate) fn ordinal(self) -> u32 {
        match self {
            Unit::Char(c) => u32::from(c),
            Unit::Byte(b) => u32::from(b),
        }
    }

    pub(crate) fn ascii(self) -> Option<u8> {
        match self {
            Unit::Char(c) if c.is_ascii() => u8::try_from(c).ok(),
            Unit::Byte(b) if b.is_ascii() => Some(b),
            _ => None,
        }
    }

    fn is(self, c: u8) -> bool {
        self.ascii() == Some(c)
    }
}

/// The units of `bytes`: characters under UTF-8, with a byte no character
/// owns kept as itself; bytes otherwise.
pub(crate) fn units(bytes: &[u8], utf8: bool) -> Vec<Unit> {
    if !utf8 {
        return bytes.iter().map(|&b| Unit::Byte(b)).collect();
    }
    let mut out = Vec::with_capacity(bytes.len());
    let mut rest = bytes;
    while !rest.is_empty() {
        match std::str::from_utf8(rest) {
            Ok(text) => {
                out.extend(text.chars().map(Unit::Char));
                break;
            }
            Err(err) => {
                let (valid, after) = rest.split_at(err.valid_up_to());
                out.extend(
                    std::str::from_utf8(valid)
                        .unwrap_or_default()
                        .chars()
                        .map(Unit::Char),
                );
                let bad = err.error_len().unwrap_or(after.len());
                out.extend(after[..bad].iter().map(|&b| Unit::Byte(b)));
                rest = &after[bad..];
            }
        }
    }
    out
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Class {
    Alnum,
    Alpha,
    Blank,
    Cntrl,
    Digit,
    Graph,
    Lower,
    Print,
    Punct,
    Space,
    Upper,
    Xdigit,
}

impl Class {
    fn named(name: &[Unit]) -> Option<Class> {
        let name: Vec<u8> = name.iter().map(|u| u.ascii()).collect::<Option<_>>()?;
        Some(match name.as_slice() {
            b"alnum" => Class::Alnum,
            b"alpha" => Class::Alpha,
            b"blank" => Class::Blank,
            b"cntrl" => Class::Cntrl,
            b"digit" => Class::Digit,
            b"graph" => Class::Graph,
            b"lower" => Class::Lower,
            b"print" => Class::Print,
            b"punct" => Class::Punct,
            b"space" => Class::Space,
            b"upper" => Class::Upper,
            b"xdigit" => Class::Xdigit,
            _ => return None,
        })
    }

    /// The class's ASCII members as inclusive byte ranges. Classes are the
    /// C locale's in a UTF-8 locale too.
    pub(crate) fn ranges(self) -> &'static [(u8, u8)] {
        match self {
            Class::Alnum => &[(b'0', b'9'), (b'A', b'Z'), (b'a', b'z')],
            Class::Alpha => &[(b'A', b'Z'), (b'a', b'z')],
            Class::Blank => &[(b'\t', b'\t'), (b' ', b' ')],
            Class::Cntrl => &[(0, 0x1F), (0x7F, 0x7F)],
            Class::Digit => &[(b'0', b'9')],
            Class::Graph => &[(b'!', b'~')],
            Class::Lower => &[(b'a', b'z')],
            Class::Print => &[(b' ', b'~')],
            Class::Punct => &[(b'!', b'/'), (b':', b'@'), (b'[', b'`'), (b'{', b'~')],
            Class::Space => &[(b'\t', b'\r'), (b' ', b' ')],
            Class::Upper => &[(b'A', b'Z')],
            Class::Xdigit => &[(b'0', b'9'), (b'A', b'F'), (b'a', b'f')],
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) enum Item {
    Unit(Unit),
    Range(Unit, Unit),
    Class(Class),
}

/// A bracket expression, or one of the escapes that stand for one.
#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) struct Set {
    pub(crate) negated: bool,
    pub(crate) items: Vec<Item>,
}

impl Set {
    /// `\w`: the underscore is the unit the subject holds, a character
    /// under UTF-8 and a byte otherwise.
    fn word(negated: bool, utf8: bool) -> Set {
        let underscore = if utf8 {
            Unit::Char('_')
        } else {
            Unit::Byte(b'_')
        };
        Set {
            negated,
            items: vec![Item::Class(Class::Alnum), Item::Unit(underscore)],
        }
    }

    fn space(negated: bool) -> Set {
        Set {
            negated,
            items: vec![Item::Class(Class::Space)],
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Look {
    /// `^`, and `` \` ``: the start of the record.
    Start,
    /// `$`, and `\'`: the end of the record.
    End,
    Word,
    NotWord,
    WordStart,
    WordEnd,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub(crate) enum Ast {
    Empty,
    Unit(Unit),
    Any,
    Set(Set),
    Look(Look),
    Group(usize, Box<Ast>),
    Backref(usize),
    Repeat(Box<Ast>, u32, Option<u32>),
    Concat(Vec<Ast>),
    Alternate(Vec<Ast>),
}

impl Ast {
    pub(crate) fn has_backref(&self) -> bool {
        match self {
            Ast::Backref(_) => true,
            Ast::Group(_, inner) | Ast::Repeat(inner, _, _) => inner.has_backref(),
            Ast::Concat(items) | Ast::Alternate(items) => items.iter().any(Ast::has_backref),
            _ => false,
        }
    }
}

// The refusals, worded as GNU grep prints them after `grep: `.
pub(crate) const UNMATCHED_OPEN: &str = "Unmatched ( or \\(";
pub(crate) const UNMATCHED_CLOSE: &str = "Unmatched ) or \\)";
pub(crate) const UNMATCHED_BRACE: &str = "Unmatched \\{";
pub(crate) const UNMATCHED_BRACKET: &str = "Unmatched [, [^, [:, [., or [=";
pub(crate) const INVALID_PATTERN: &str = "Invalid regular expression";
pub(crate) const TRAILING_BACKSLASH: &str = "Trailing backslash";
pub(crate) const BAD_CLASS: &str = "Invalid character class name";
pub(crate) const BAD_COLLATION: &str = "Invalid collation character";
pub(crate) const BAD_INTERVAL: &str = "Invalid content of \\{\\}";
pub(crate) const BAD_BACKREF: &str = "Invalid back reference";
pub(crate) const BAD_RANGE: &str = "Invalid range end";
pub(crate) const TOO_BIG: &str = "Regular expression too big";
pub(crate) const COLON_CLASS: &str = "character class syntax is [[:space:]], not [:space:]";
/// GNU's refusal of a pattern nested past what its stack holds (grep 3.11
/// takes 5,000 nested groups and refuses 20,000).
pub(crate) const STACK_OVERFLOW: &str = "stack overflow";

/// The deepest a pattern's groups, alternatives and repetitions may nest,
/// regex-syntax's own default: every walk of the tree, ours and the
/// automata compiler's, recurses, and a wasm build has a 1 MiB stack.
const NEST_LIMIT: usize = 250;

fn nested(depth: usize) -> Result<usize, &'static str> {
    if depth > NEST_LIMIT {
        Err(STACK_OVERFLOW)
    } else {
        Ok(depth)
    }
}

/// The largest count an interval takes.
const DUP_MAX: u32 = 0x7FFF;

pub(crate) struct Parsed {
    pub(crate) ast: Ast,
    /// How -o reads an extended expression when that differs from how
    /// lines are selected. GNU 3.11 reads three constructs two ways:
    /// selecting lines it drops a leading interval whole, closes a group
    /// right after a dropped operator, and lets an operator make an
    /// anchor optional; for -o (and for refusing the pattern) it drops a
    /// leading `{` alone, takes that `)` as a literal, and ignores an
    /// operator on an anchor. So `{1}a` prints `1}a`, `(?)` is
    /// `Unmatched ( or \(`, and `a$*` selects `ab` but prints nothing
    /// from it.
    pub(crate) extents: Option<Ast>,
    /// What GNU grep warns about the expression, without `grep: warning: `.
    pub(crate) warnings: Vec<&'static str>,
}

/// Parse one expression of a pattern list: POSIX basic or extended, with
/// the extensions grep reads (`\w \W \s \S \b \B \< \> \` \'`,
/// back-references in both dialects, `\| \+ \?` in a basic one and `{,n}`
/// intervals). Where a dialect leaves a construct open, the choice is the
/// one GNU grep 3.11 shows.
pub(crate) fn parse(pattern: &[u8], extended: bool, utf8: bool) -> Result<Parsed, &'static str> {
    let units = units(pattern, utf8);
    let mut parser = Parser::new(&units, extended, utf8, false);
    let ast = parser.whole()?;
    let extents = if extended {
        let printed = Parser::new(&units, extended, utf8, true).whole()?;
        (printed != ast).then_some(printed)
    } else {
        None
    };
    Ok(Parsed {
        ast,
        extents,
        warnings: parser.warnings,
    })
}

/// A fixed string's units, each one matched as itself.
pub(crate) fn literal(pattern: &[u8], utf8: bool) -> Ast {
    let mut items: Vec<Ast> = units(pattern, utf8).into_iter().map(Ast::Unit).collect();
    match items.len() {
        0 => Ast::Empty,
        1 => items.pop().unwrap_or(Ast::Empty),
        _ => Ast::Concat(items),
    }
}

enum Interval {
    Valid {
        min: u32,
        max: Option<u32>,
        end: usize,
    },
    Literal,
}

struct Parser<'a> {
    units: &'a [Unit],
    pos: usize,
    extended: bool,
    utf8: bool,
    /// Read the expression as -o does (see `Parsed::extents`).
    as_printed: bool,
    groups: usize,
    closed: Vec<bool>,
    // A group an earlier alternative of an open alternation holds: a
    // back-reference cannot reach it until the alternation ends.
    hidden: Vec<bool>,
    depth: usize,
    warnings: Vec<&'static str>,
}

impl<'a> Parser<'a> {
    fn new(units: &'a [Unit], extended: bool, utf8: bool, as_printed: bool) -> Self {
        Parser {
            units,
            pos: 0,
            extended,
            utf8,
            as_printed,
            groups: 0,
            closed: vec![false],
            hidden: vec![false],
            depth: 0,
            warnings: Vec::new(),
        }
    }

    fn whole(&mut self) -> Result<Ast, &'static str> {
        let (ast, _) = self.alternation()?;
        if self.pos < self.units.len() {
            // Only a basic `\)` with no group open stops the top level early.
            return Err(UNMATCHED_CLOSE);
        }
        Ok(ast)
    }

    fn peek(&self, at: usize) -> Option<Unit> {
        self.units.get(at).copied()
    }

    fn is(&self, at: usize, c: u8) -> bool {
        self.peek(at).is_some_and(|u| u.is(c))
    }

    fn escaped(&self, at: usize, c: u8) -> bool {
        self.is(at, b'\\') && self.is(at + 1, c)
    }

    fn at_alternation(&self) -> bool {
        if self.extended {
            self.is(self.pos, b'|')
        } else {
            self.escaped(self.pos, b'|')
        }
    }

    fn at_close(&self) -> bool {
        if self.depth == 0 {
            return false;
        }
        if self.extended {
            self.is(self.pos, b')')
        } else {
            self.escaped(self.pos, b')')
        }
    }

    /// An alternation and how deep its tree goes, as every parsing step
    /// below returns.
    fn alternation(&mut self) -> Result<(Ast, usize), &'static str> {
        let before = self.groups;
        let mut hid = Vec::new();
        let (first, mut depth) = self.branch()?;
        let mut branches = vec![first];
        while self.at_alternation() {
            self.pos += if self.extended { 1 } else { 2 };
            for group in before + 1..=self.groups {
                if !self.hidden[group] {
                    self.hidden[group] = true;
                    hid.push(group);
                }
            }
            let (branch, deep) = self.branch()?;
            branches.push(branch);
            depth = depth.max(deep);
        }
        for group in hid {
            self.hidden[group] = false;
        }
        Ok(if branches.len() == 1 {
            (branches.pop().unwrap_or(Ast::Empty), depth)
        } else {
            (Ast::Alternate(branches), nested(depth + 1)?)
        })
    }

    fn branch(&mut self) -> Result<(Ast, usize), &'static str> {
        let mut items: Vec<Ast> = Vec::new();
        let mut depth = 1;
        // As -o reads it, a `)` right after a dropped operator is text.
        let mut literal_close = false;
        while self.pos < self.units.len() && !self.at_alternation() {
            if std::mem::take(&mut literal_close) && self.is(self.pos, b')') {
                self.pos += 1;
                items.push(Ast::Unit(self.units[self.pos - 1]));
                continue;
            }
            if self.at_close() {
                break;
            }
            if !self.extended && self.escaped(self.pos, b')') {
                return Err(UNMATCHED_CLOSE);
            }
            // Nothing to repeat: the branch's start, or only anchors
            // before (a basic expression's `^` alone).
            let bare = if self.extended {
                items.iter().all(|item| matches!(item, Ast::Look(_)))
            } else {
                items.is_empty() || items.last() == Some(&Ast::Look(Look::Start))
            };
            if bare {
                let at = self.pos;
                if self.leading_operator()? {
                    literal_close = self.as_printed && !self.is(at, b'{');
                    continue;
                }
            }
            let (atom, deep) = self.atom(items.is_empty(), bare)?;
            // A leading anchor leaves the operator after it to the next
            // round, which finds nothing to repeat.
            let leading = bare
                && match atom {
                    Ast::Look(Look::Start) => true,
                    Ast::Look(_) => self.extended,
                    _ => false,
                };
            let (atom, deep) = if leading {
                (atom, deep)
            } else {
                self.operators(atom, deep)?
            };
            items.push(atom);
            depth = depth.max(deep);
        }
        Ok(match items.len() {
            0 => (Ast::Empty, 1),
            1 => (items.pop().unwrap_or(Ast::Empty), depth),
            _ => (Ast::Concat(items), nested(depth + 1)?),
        })
    }

    /// A repetition operator with nothing before it. An extended one is
    /// dropped with GNU's warning; a basic one is a literal, which
    /// `atom` reads. True when one was dropped.
    fn leading_operator(&mut self) -> Result<bool, &'static str> {
        if !self.extended {
            return Ok(false);
        }
        let Some(unit) = self.peek(self.pos) else {
            return Ok(false);
        };
        let warning = match unit.ascii() {
            Some(b'*') => "* at start of expression",
            Some(b'+') => "+ at start of expression",
            Some(b'?') => "? at start of expression",
            Some(b'{') if self.as_printed => {
                self.pos += 1;
                return Ok(true);
            }
            Some(b'{') => match self.extended_interval(self.pos)? {
                Interval::Valid { end, .. } => {
                    self.warnings.push("{...} at start of expression");
                    self.pos = end;
                    return Ok(true);
                }
                Interval::Literal => return Ok(false),
            },
            _ => return Ok(false),
        };
        self.warnings.push(warning);
        self.pos += 1;
        Ok(true)
    }

    /// One atom; `first` when it starts its branch, `bare` when nothing
    /// before it can be repeated.
    fn atom(&mut self, first: bool, bare: bool) -> Result<(Ast, usize), &'static str> {
        let unit = self.units[self.pos];
        self.pos += 1;
        let Some(c) = unit.ascii() else {
            return Ok((Ast::Unit(unit), 1));
        };
        Ok(match c {
            b'.' => (Ast::Any, 1),
            b'[' => (Ast::Set(self.bracket()?), 1),
            b'\\' => return self.escape(bare),
            b'(' if self.extended => self.group()?,
            b'^' if self.extended || first => (Ast::Look(Look::Start), 1),
            b'$' if self.extended || self.basic_end() => (Ast::Look(Look::End), 1),
            _ => (Ast::Unit(unit), 1),
        })
    }

    // A basic `$` anchors only at the end of its branch.
    fn basic_end(&self) -> bool {
        self.pos == self.units.len() || self.escaped(self.pos, b')') || self.escaped(self.pos, b'|')
    }

    fn group(&mut self) -> Result<(Ast, usize), &'static str> {
        self.groups += 1;
        let index = self.groups;
        self.closed.push(false);
        self.hidden.push(false);
        self.depth += 1;
        // Refused before the parse recurses any deeper.
        nested(self.depth)?;
        let (inner, depth) = self.alternation()?;
        self.depth -= 1;
        let closed = if self.extended {
            self.is(self.pos, b')')
        } else {
            self.escaped(self.pos, b')')
        };
        if !closed {
            return Err(UNMATCHED_OPEN);
        }
        self.pos += if self.extended { 1 } else { 2 };
        self.closed[index] = true;
        Ok((Ast::Group(index, Box::new(inner)), nested(depth + 1)?))
    }

    fn escape(&mut self, bare: bool) -> Result<(Ast, usize), &'static str> {
        let Some(unit) = self.peek(self.pos) else {
            return Err(TRAILING_BACKSLASH);
        };
        self.pos += 1;
        let Some(c) = unit.ascii() else {
            return Ok((Ast::Unit(unit), 1));
        };
        if c == b'(' && !self.extended {
            return self.group();
        }
        Ok((
            match c {
                // Basic operators with nothing to repeat are their literals.
                b'{' | b'}' | b'+' | b'?' if !self.extended && bare => Ast::Unit(unit),
                b'1'..=b'9' => {
                    let n = usize::from(c - b'0');
                    if n > self.groups || !self.closed[n] || self.hidden[n] {
                        return Err(BAD_BACKREF);
                    }
                    Ast::Backref(n)
                }
                b'w' => Ast::Set(Set::word(false, self.utf8)),
                b'W' => Ast::Set(Set::word(true, self.utf8)),
                b's' => Ast::Set(Set::space(false)),
                b'S' => Ast::Set(Set::space(true)),
                b'b' => Ast::Look(Look::Word),
                b'B' => Ast::Look(Look::NotWord),
                b'<' => Ast::Look(Look::WordStart),
                b'>' => Ast::Look(Look::WordEnd),
                b'`' => Ast::Look(Look::Start),
                b'\'' => Ast::Look(Look::End),
                _ => Ast::Unit(unit),
            },
            1,
        ))
    }

    fn operators(&mut self, mut atom: Ast, mut depth: usize) -> Result<(Ast, usize), &'static str> {
        loop {
            let (min, max, width) = if self.is(self.pos, b'*') {
                (0, None, 1)
            } else if self.extended {
                match self.peek(self.pos).and_then(Unit::ascii) {
                    Some(b'+') => (1, None, 1),
                    Some(b'?') => (0, Some(1), 1),
                    Some(b'{') => match self.extended_interval(self.pos)? {
                        Interval::Valid { min, max, end } => (min, max, end - self.pos),
                        Interval::Literal => return Ok((atom, depth)),
                    },
                    _ => return Ok((atom, depth)),
                }
            } else if self.escaped(self.pos, b'+') {
                (1, None, 2)
            } else if self.escaped(self.pos, b'?') {
                (0, Some(1), 2)
            } else if self.escaped(self.pos, b'{') {
                let (min, max, end) = self.basic_interval(self.pos + 2)?;
                (min, max, end - self.pos)
            } else {
                return Ok((atom, depth));
            };
            self.pos += width;
            // As -o reads it, an operator leaves an anchor as it was.
            if !(self.as_printed && matches!(atom, Ast::Look(_))) {
                depth = nested(depth + 1)?;
                atom = Ast::Repeat(Box::new(atom), min, max);
            }
        }
    }

    fn digits(&self, mut at: usize) -> (Option<u32>, usize) {
        let mut value: Option<u32> = None;
        while let Some(d) = self
            .peek(at)
            .and_then(Unit::ascii)
            .filter(u8::is_ascii_digit)
        {
            let next = value
                .unwrap_or(0)
                .saturating_mul(10)
                .saturating_add(u32::from(d - b'0'));
            value = Some(next.min(DUP_MAX + 1));
            at += 1;
        }
        (value, at)
    }

    fn bounds(
        min: Option<u32>,
        max: Option<u32>,
        comma: bool,
    ) -> Result<(u32, Option<u32>), &'static str> {
        let low = min.unwrap_or(0);
        let high = if comma { max } else { Some(low) };
        if high.is_some_and(|high| high < low) {
            return Err(BAD_INTERVAL);
        }
        if low > DUP_MAX || high.is_some_and(|high| high > DUP_MAX) {
            return Err(TOO_BIG);
        }
        Ok((low, high))
    }

    /// An extended `{`: an interval, a literal brace (an unfinished or
    /// malformed one), or a refusal.
    fn extended_interval(&self, at: usize) -> Result<Interval, &'static str> {
        let start = at + 1;
        match self.peek(start).and_then(Unit::ascii) {
            Some(b'}') => return Err(BAD_INTERVAL),
            Some(c) if c.is_ascii_digit() || c == b',' => {}
            _ => return Ok(Interval::Literal),
        }
        let (min, mut at) = self.digits(start);
        let comma = self.is(at, b',');
        let mut max = None;
        if comma {
            (max, at) = self.digits(at + 1);
        }
        match self.peek(at).and_then(Unit::ascii) {
            Some(b'}') => {
                let (min, max) = Self::bounds(min, max, comma)?;
                Ok(Interval::Valid {
                    min,
                    max,
                    end: at + 1,
                })
            }
            Some(b',') => Err(BAD_INTERVAL),
            _ => Ok(Interval::Literal),
        }
    }

    /// A basic `\{`'s bounds, from the unit after it to its `\}`.
    fn basic_interval(&self, start: usize) -> Result<(u32, Option<u32>, usize), &'static str> {
        let (min, mut at) = self.digits(start);
        let comma = self.is(at, b',');
        let mut max = None;
        if comma {
            (max, at) = self.digits(at + 1);
        }
        if at >= self.units.len() || (self.is(at, b'\\') && at + 1 >= self.units.len()) {
            return Err(UNMATCHED_BRACE);
        }
        if !self.escaped(at, b'}') || (min.is_none() && !comma) {
            return Err(BAD_INTERVAL);
        }
        let (min, max) = Self::bounds(min, max, comma)?;
        Ok((min, max, at + 2))
    }

    fn bracket(&mut self) -> Result<Set, &'static str> {
        let negated = self.is(self.pos, b'^');
        if negated {
            self.pos += 1;
        }
        if self.pos >= self.units.len() {
            return Err(INVALID_PATTERN);
        }
        let content = self.pos;
        let mut items = Vec::new();
        let mut first = true;
        loop {
            let Some(unit) = self.peek(self.pos) else {
                return Err(UNMATCHED_BRACKET);
            };
            if unit.is(b']') && !first {
                break;
            }
            first = false;
            let (start, ends) = self.element()?;
            if self.is(self.pos, b'-') && self.peek(self.pos + 1).is_some_and(|u| !u.is(b']')) {
                let (Item::Unit(low), true) = (start, ends) else {
                    return Err(BAD_RANGE);
                };
                self.pos += 1;
                let (Item::Unit(high), true) = self.element()? else {
                    return Err(BAD_RANGE);
                };
                if low.ordinal() > high.ordinal() {
                    return Err(BAD_RANGE);
                }
                if self.is(self.pos, b'-') && self.peek(self.pos + 1).is_some_and(|u| !u.is(b']')) {
                    return Err(BAD_RANGE);
                }
                items.push(Item::Range(self.endpoint(low), self.endpoint(high)));
            } else {
                items.push(start);
            }
        }
        let body = &self.units[content..self.pos];
        if body.len() >= 2 && body[0].is(b':') && body[body.len() - 1].is(b':') {
            return Err(COLON_CLASS);
        }
        self.pos += 1;
        Ok(Set { negated, items })
    }

    /// One bracket member: a unit, `[:class:]`, `[=u=]` or `[.u.]`, and
    /// whether it can end a range, which `[=u=]` cannot (`[[=a=]-z]` is
    /// refused where `[[.a.]-z]` is not).
    fn element(&mut self) -> Result<(Item, bool), &'static str> {
        let Some(unit) = self.peek(self.pos) else {
            return Err(UNMATCHED_BRACKET);
        };
        if unit.is(b'[') {
            if let Some(kind) = self.peek(self.pos + 1).and_then(Unit::ascii) {
                if matches!(kind, b':' | b'=' | b'.') {
                    let open = self.pos + 2;
                    let close = (open..self.units.len().saturating_sub(1))
                        .find(|&at| self.units[at].is(kind) && self.units[at + 1].is(b']'))
                        .ok_or(UNMATCHED_BRACKET)?;
                    let name = &self.units[open..close];
                    self.pos = close + 2;
                    return match kind {
                        b':' => Class::named(name)
                            .map(|class| (Item::Class(class), false))
                            .ok_or(BAD_CLASS),
                        _ if name.len() == 1 => Ok((Item::Unit(name[0]), kind == b'.')),
                        _ => Err(BAD_COLLATION),
                    };
                }
            }
        }
        self.pos += 1;
        Ok((Item::Unit(unit), true))
    }

    /// A range endpoint: under UTF-8 a byte that is no part of a character
    /// stands for the code point of its value there (GNU 3.11 matches `é`
    /// with `[\xe0-\xea]`), where as a member of its own it matches
    /// nothing (`[\xe9]` does not match `é`, nor `[\xff]` the byte).
    fn endpoint(&self, unit: Unit) -> Unit {
        match unit {
            Unit::Byte(b) if self.utf8 => Unit::Char(char::from(b)),
            unit => unit,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ere(pattern: &str) -> Result<Ast, &'static str> {
        parse(pattern.as_bytes(), true, false).map(|p| p.ast)
    }

    fn bre(pattern: &str) -> Result<Ast, &'static str> {
        parse(pattern.as_bytes(), false, false).map(|p| p.ast)
    }

    fn lit(c: char) -> Ast {
        Ast::Unit(Unit::Byte(c as u8))
    }

    #[test]
    fn refusals_carry_gnus_wording() {
        let cases: [(&str, bool, &str); 20] = [
            ("(a", true, UNMATCHED_OPEN),
            ("\\(a", false, UNMATCHED_OPEN),
            ("a\\)", false, UNMATCHED_CLOSE),
            ("a\\{1", false, UNMATCHED_BRACE),
            ("a\\{x\\}", false, BAD_INTERVAL),
            ("a{2,1}", true, BAD_INTERVAL),
            ("a{}", true, BAD_INTERVAL),
            ("a{1,2,3}", true, BAD_INTERVAL),
            ("a{32768}", true, TOO_BIG),
            ("[", false, INVALID_PATTERN),
            ("[^", true, INVALID_PATTERN),
            ("[a", true, UNMATCHED_BRACKET),
            ("[[:foo:]]", true, BAD_CLASS),
            ("[[.ab.]]", true, BAD_COLLATION),
            ("[z-a]", true, BAD_RANGE),
            ("[a-c-e]", false, BAD_RANGE),
            ("[[=a=]-z]", false, BAD_RANGE),
            ("[a-[=b=]]", true, BAD_RANGE),
            ("(a)x|y\\1", true, BAD_BACKREF),
            ("[:alpha:]", true, COLON_CLASS),
        ];
        for (pattern, extended, want) in cases {
            let got = parse(pattern.as_bytes(), extended, false).err();
            assert_eq!(got, Some(want), "{pattern}");
        }
        assert_eq!(parse(b"a\\", true, false).err(), Some(TRAILING_BACKSLASH));
    }

    #[test]
    fn basic_operators_with_nothing_to_repeat_are_literals() {
        assert_eq!(bre("*a"), Ok(Ast::Concat(vec![lit('*'), lit('a')])));
        assert_eq!(
            bre("\\{1\\}"),
            Ok(Ast::Concat(vec![lit('{'), lit('1'), lit('}')]))
        );
        assert_eq!(
            bre("^*"),
            Ok(Ast::Concat(vec![Ast::Look(Look::Start), lit('*')]))
        );
        assert_eq!(
            bre("a^b"),
            Ok(Ast::Concat(vec![lit('a'), lit('^'), lit('b')]))
        );
        assert_eq!(
            bre("a$b"),
            Ok(Ast::Concat(vec![lit('a'), lit('$'), lit('b')]))
        );
    }

    #[test]
    fn extended_leading_operators_are_dropped_with_a_warning() {
        let parsed = parse(b"*a", true, false).unwrap();
        assert_eq!(parsed.ast, lit('a'));
        assert_eq!(parsed.warnings, ["* at start of expression"]);
        let parsed = parse(b"{1}a", true, false).unwrap();
        assert_eq!(parsed.ast, lit('a'));
        assert_eq!(parsed.warnings, ["{...} at start of expression"]);
        assert_eq!(ere("{"), Ok(lit('{')));
    }

    #[test]
    fn a_malformed_extended_interval_is_a_literal_brace() {
        for pattern in ["a{1", "a{1,", "a{x}", "a{1x}", "a{1;2}"] {
            let ast = ere(pattern).unwrap();
            assert!(
                matches!(ast, Ast::Concat(ref items) if items[1] == lit('{')),
                "{pattern}"
            );
        }
        assert_eq!(
            ere("a{,2}"),
            Ok(Ast::Repeat(Box::new(lit('a')), 0, Some(2)))
        );
    }

    #[test]
    fn a_back_reference_sees_only_its_own_branch() {
        assert!(ere("(a)(b|\\1)").is_ok());
        assert!(ere("((a)|b)\\2").is_ok());
        assert_eq!(ere("((a)|\\2)"), Err(BAD_BACKREF));
        assert_eq!(ere("\\1"), Err(BAD_BACKREF));
    }

    #[test]
    fn bracket_edges() {
        let set = |items: Vec<Item>| {
            Ok(Ast::Set(Set {
                negated: false,
                items,
            }))
        };
        let b = |c: char| Unit::Byte(c as u8);
        assert_eq!(
            ere("[]a]"),
            set(vec![Item::Unit(b(']')), Item::Unit(b('a'))])
        );
        assert_eq!(ere("[]-a]"), set(vec![Item::Range(b(']'), b('a'))]));
        assert_eq!(
            ere("[a-]"),
            set(vec![Item::Unit(b('a')), Item::Unit(b('-'))])
        );
        assert_eq!(ere("[%--]"), set(vec![Item::Range(b('%'), b('-'))]));
        assert_eq!(ere("[[.-.]-0]"), set(vec![Item::Range(b('-'), b('0'))]));
        assert_eq!(ere("[a-[.z.]]"), set(vec![Item::Range(b('a'), b('z'))]));
        assert_eq!(
            ere("[[=a=]-]"),
            set(vec![Item::Unit(b('a')), Item::Unit(b('-'))])
        );
        assert_eq!(ere("[\\]"), set(vec![Item::Unit(b('\\'))]));
    }
}
