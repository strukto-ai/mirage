use regex_syntax::hir::{self, Hir, Repetition};

use super::class::Members;
use super::parse::{Ast, Look, Unit};

/// A parsed expression as regex-syntax's HIR, which the automata compile.
/// Outside a UTF-8 locale classes and case folding are ASCII's; in one
/// they are Unicode's, and a set or `.` matches whole characters, so it
/// never matches a byte that is no part of one.
pub(crate) struct Lower {
    pub(crate) ignore_case: bool,
    pub(crate) utf8: bool,
    /// The byte records end at, which nothing matches, so one search can
    /// run over many records at once; None for one subject.
    pub(crate) terminator: Option<u8>,
    /// Multi-line matching: `^` and `$` match at the edges of each line,
    /// and neither `.` nor a negated set matches a newline.
    pub(crate) multiline: bool,
    /// sed -z: multi-line matching takes a NUL for the line's end, and
    /// `.` and a negated set leave out the NUL as well as the newline.
    pub(crate) nul_lines: bool,
    /// `.` leaves out the NUL byte, as regcomp's syntax has it.
    pub(crate) dot_skips_nul: bool,
}

impl Lower {
    pub(crate) fn pattern(&self, ast: &Ast, word: bool, line: bool) -> Hir {
        wrap(self.ast(ast), word, line)
    }

    fn ast(&self, ast: &Ast) -> Hir {
        match ast {
            Ast::Empty => Hir::empty(),
            Ast::Unit(unit) => self.unit(*unit),
            Ast::Any => {
                let mut any = Members::any(self.utf8);
                if self.dot_skips_nul {
                    any.without(0);
                }
                self.members(any, true)
            }
            Ast::Set(set) => self.members(
                Members::of(set, self.utf8, self.ignore_case),
                set.negated && set.bracket,
            ),
            Ast::Look(look) => Hir::look(self.look(*look)),
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
        if self.terminator.is_some_and(|t| ordinal == u32::from(t)) {
            return Hir::fail();
        }
        if self.ignore_case {
            return Members::folded(unit, self.utf8).hir();
        }
        match unit {
            Unit::Char(c) if self.utf8 => Hir::literal(c.encode_utf8(&mut [0; 4]).as_bytes()),
            _ => Hir::literal([u8::try_from(ordinal).unwrap_or(0)]),
        }
    }

    /// A set less the terminator, and under multi-line matching less the
    /// newline when it is `.` or negated.
    fn members(&self, mut members: Members, excludes_newline: bool) -> Hir {
        if let Some(terminator) = self.terminator {
            members.without(terminator);
        }
        if self.multiline && excludes_newline {
            members.without(b'\n');
            if self.nul_lines {
                members.without(0);
            }
        }
        members.hir()
    }

    fn look(&self, look: Look) -> hir::Look {
        let lines = self.terminator.is_some() || self.multiline;
        match look {
            Look::Start if lines => hir::Look::StartLF,
            Look::End | Look::GroupedEnd if lines => hir::Look::EndLF,
            Look::SubjectStart if self.terminator.is_some() => hir::Look::StartLF,
            Look::SubjectEnd if self.terminator.is_some() => hir::Look::EndLF,
            Look::Start | Look::SubjectStart => hir::Look::Start,
            Look::End | Look::GroupedEnd | Look::SubjectEnd => hir::Look::End,
            Look::Word => hir::Look::WordAscii,
            Look::NotWord => hir::Look::WordAsciiNegate,
            Look::WordStart => hir::Look::WordStartAscii,
            Look::WordEnd => hir::Look::WordEndAscii,
        }
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
