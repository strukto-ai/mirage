use regex_syntax::hir::{
    self, Class as HirClass, ClassBytes, ClassBytesRange, ClassUnicode, ClassUnicodeRange, Hir,
    Repetition,
};

use super::parse::{Ast, Item, Look, Set, Unit};

/// A parsed expression as regex-syntax's HIR, which the automata compile.
/// Classes, word characters and case folding are ASCII's in every locale;
/// under UTF-8 a set or `.` matches whole characters, so it never matches
/// a byte that is no part of one. Nothing matches the record terminator,
/// so one search can run over many records at once.
pub(crate) struct Lower {
    pub(crate) ignore_case: bool,
    pub(crate) utf8: bool,
    pub(crate) terminator: u8,
}

/// Inclusive ordinal ranges, each a code point under UTF-8 and a byte
/// otherwise.
type Ranges = Vec<(u32, u32)>;

fn swap_case(ranges: &mut Ranges) {
    let mut extra = Vec::new();
    for &(low, high) in ranges.iter() {
        for (from, to, shift) in [(0x41u32, 0x5Au32, 0x20i32), (0x61, 0x7A, -0x20)] {
            let (a, b) = (low.max(from), high.min(to));
            if a <= b {
                extra.push((a.wrapping_add_signed(shift), b.wrapping_add_signed(shift)));
            }
        }
    }
    ranges.extend(extra);
}

impl Lower {
    pub(crate) fn pattern(&self, ast: &Ast, word: bool, line: bool) -> Hir {
        wrap(self.ast(ast), word, line)
    }

    fn ast(&self, ast: &Ast) -> Hir {
        match ast {
            Ast::Empty => Hir::empty(),
            Ast::Unit(unit) => self.unit(*unit),
            Ast::Any => self.class(Vec::new(), true),
            Ast::Set(set) => self.set(set),
            Ast::Look(look) => Hir::look(look_of(*look)),
            Ast::Group(_, inner) => self.ast(inner),
            // A pattern with one goes to the backtracker instead.
            Ast::Backref(_) => Hir::fail(),
            Ast::Repeat(inner, min, max) => Hir::repetition(Repetition {
                min: *min,
                max: *max,
                greedy: true,
                sub: Box::new(self.ast(inner)),
            }),
            Ast::Concat(items) => Hir::concat(items.iter().map(|item| self.ast(item)).collect()),
            Ast::Alternate(items) => {
                Hir::alternation(items.iter().map(|item| self.ast(item)).collect())
            }
        }
    }

    fn unit(&self, unit: Unit) -> Hir {
        let ordinal = unit.ordinal();
        if ordinal == u32::from(self.terminator) {
            return Hir::fail();
        }
        if self.ignore_case && unit.ascii().is_some_and(|b| b.is_ascii_alphabetic()) {
            return self.class(vec![(ordinal, ordinal)], false);
        }
        match unit {
            Unit::Char(c) if self.utf8 => Hir::literal(c.encode_utf8(&mut [0; 4]).as_bytes()),
            _ => Hir::literal([u8::try_from(ordinal).unwrap_or(0)]),
        }
    }

    fn set(&self, set: &Set) -> Hir {
        let mut ranges = Ranges::new();
        for item in &set.items {
            match item {
                // Under UTF-8 a stray byte in a set matches nothing.
                Item::Unit(Unit::Byte(_)) if self.utf8 => {}
                Item::Unit(unit) => ranges.push((unit.ordinal(), unit.ordinal())),
                Item::Range(low, high) => ranges.push((low.ordinal(), high.ordinal())),
                Item::Class(class) => ranges.extend(
                    class
                        .ranges()
                        .iter()
                        .map(|&(low, high)| (u32::from(low), u32::from(high))),
                ),
            }
        }
        self.class(ranges, set.negated)
    }

    /// The class of `ranges`, folded under -i and then negated, less the
    /// terminator.
    fn class(&self, mut ranges: Ranges, negated: bool) -> Hir {
        if self.ignore_case {
            swap_case(&mut ranges);
        }
        let terminator = u32::from(self.terminator);
        if self.utf8 {
            let mut class = ClassUnicode::new(ranges.into_iter().filter_map(|(low, high)| {
                Some(ClassUnicodeRange::new(
                    char::from_u32(low)?,
                    char::from_u32(high)?,
                ))
            }));
            if negated {
                class.negate();
            }
            let stop = char::from(self.terminator);
            class.difference(&ClassUnicode::new([ClassUnicodeRange::new(stop, stop)]));
            Hir::class(HirClass::Unicode(class))
        } else {
            let byte = |n: u32| u8::try_from(n.min(0xFF)).unwrap_or(0xFF);
            let mut class = ClassBytes::new(
                ranges
                    .into_iter()
                    .filter(|&(low, _)| low <= 0xFF)
                    .map(|(low, high)| ClassBytesRange::new(byte(low), byte(high))),
            );
            if negated {
                class.negate();
            }
            let stop = byte(terminator);
            class.difference(&ClassBytes::new([ClassBytesRange::new(stop, stop)]));
            Hir::class(HirClass::Bytes(class))
        }
    }
}

fn look_of(look: Look) -> hir::Look {
    match look {
        Look::Start => hir::Look::StartLF,
        Look::End => hir::Look::EndLF,
        Look::Word => hir::Look::WordAscii,
        Look::NotWord => hir::Look::WordAsciiNegate,
        Look::WordStart => hir::Look::WordStartAscii,
        Look::WordEnd => hir::Look::WordEndAscii,
    }
}

/// -x spans the whole record; -w wants no word character on either side
/// of the match, which an empty match at a record's edge satisfies.
pub(crate) fn wrap(body: Hir, word: bool, line: bool) -> Hir {
    let (open, close) = if line {
        (hir::Look::StartLF, hir::Look::EndLF)
    } else if word {
        (hir::Look::WordStartHalfAscii, hir::Look::WordEndHalfAscii)
    } else {
        return body;
    };
    Hir::concat(vec![Hir::look(open), body, Hir::look(close)])
}
