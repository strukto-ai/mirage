//! The shell's evaluator, which both hosts run: it holds a session's
//! variables and asks its host for what lies outside them, the policy gate
//! a session write clears first of all.

pub mod brace;
pub mod codec;
pub mod escapes;
pub mod expand;
pub mod host;
pub mod job;
pub mod listing;
pub mod parameter;
pub mod pattern;
pub mod quote;
pub mod shell;
pub mod task;
pub mod write;

use crate::arith;

/// What a statement's expansions leave for its stderr, in order: a line
/// worded as bash words it, which the statement prefixes with the builtin
/// it names (`bash: declare: ...`), or bytes passed through as they are.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Diagnostic {
    Text(Vec<u8>),
    Bytes(Vec<u8>),
}

/// How an evaluation unwinds where no status answers it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Signal {
    /// The shell ends with `status`; a subshell or a forked stage around
    /// it reports `contained` instead (127 for a fatal expansion error at
    /// top level, 1 from a subshell).
    Exit {
        status: i32,
        stderr: Vec<u8>,
        contained: i32,
    },
    /// bash discards the rest of the line, which then reads `$?` as 1; a
    /// subshell around it ends with `contained`.
    Discard { stderr: Vec<u8>, contained: i32 },
}

impl Signal {
    /// `set -u` reading a name no variable holds, in the shell's `voice`.
    pub fn unbound(voice: &[u8], name: &str) -> Self {
        Signal::Exit {
            status: 127,
            stderr: voiced(voice, &format!("{name}: unbound variable\n")),
            contained: 1,
        }
    }

    /// A readonly name written where no status answers it: one in a
    /// subscript or an `-i` value (`fatal`) ends the shell with 1, any
    /// other discards the line, as `$((R=3))` does.
    pub fn readonly(voice: &[u8], name: &str, fatal: bool) -> Self {
        let stderr = voiced(voice, &format!("{name}: readonly variable\n"));
        if fatal {
            Signal::Exit {
                status: 1,
                stderr,
                contained: 1,
            }
        } else {
            Signal::Discard {
                stderr,
                contained: 1,
            }
        }
    }

    /// An arithmetic error where no status answers it, `lead` naming the
    /// command it belongs to unless it was in a subscript, which bash
    /// names by the subscript alone.
    pub fn arith(voice: &[u8], error: &arith::Error, lead: &str, fatal: bool) -> Self {
        let subscript = matches!(
            error,
            arith::Error::Arith {
                subscript: true,
                ..
            }
        );
        let lead = if lead.is_empty() || subscript {
            String::new()
        } else {
            format!("{lead}: ")
        };
        let mut stderr = voiced(voice, &lead);
        stderr.extend_from_slice(&arith_line(error));
        stderr.push(b'\n');
        if fatal || subscript {
            Signal::Exit {
                status: 1,
                stderr,
                contained: 1,
            }
        } else {
            Signal::Discard {
                stderr,
                contained: 1,
            }
        }
    }
}

/// A diagnostic of the shell's own, led by its `voice` (`bash: line 3: `).
pub fn voiced(voice: &[u8], message: &str) -> Vec<u8> {
    [voice, message.as_bytes()].concat()
}

/// An arithmetic error as bash words it: the expression, what went wrong,
/// and the error token when bash names one.
pub fn arith_line(error: &arith::Error) -> Vec<u8> {
    match error {
        arith::Error::Arith {
            reason,
            expression,
            token,
            ..
        } => {
            let mut line = expression.clone();
            if !line.is_empty() {
                line.extend_from_slice(b": ");
            }
            line.extend_from_slice(reason.as_bytes());
            if let Some(token) = token {
                line.extend_from_slice(b" (error token is \"");
                line.extend_from_slice(token);
                line.extend_from_slice(b"\")");
            }
            line
        }
        arith::Error::Readonly { name, .. } => format!("{name}: readonly variable").into_bytes(),
        arith::Error::Unbound(name) => format!("{name}: unbound variable").into_bytes(),
        arith::Error::Halt { .. } => Vec::new(),
    }
}
