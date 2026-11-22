//! The line diff git prints: Myers' algorithm, each changed run then placed
//! by the indentation heuristic `git diff` uses by default, reported as the
//! opcodes the hosts' patch, stat, `-G` and combined diff walk.
//!
//! The input is the old side's bytes followed by the new side's, `before`
//! bytes long and the rest; each side splits after every newline, which a
//! line keeps, as git's does. The output is one opcode a line, `tag i1 i2 j1
//! j2`, the tag one of `equal`, `replace`, `delete` and `insert`, the ranges
//! line indexes into the old and the new side.

use imara_diff::{Algorithm, Diff, InternedInput};
use serde::Deserialize;

use crate::{Stream, StreamError, parse_config};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    /// The bytes of the old side, which the input carries first.
    #[serde(deserialize_with = "crate::saturating_usize")]
    before: usize,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let Config { before } = parse_config(config)?;
    Ok(Box::new(LineDiff {
        before,
        held: Vec::new(),
    }))
}

struct LineDiff {
    before: usize,
    /// Both sides, as they arrive: a diff needs each whole.
    held: Vec<u8>,
}

impl Stream for LineDiff {
    fn feed(&mut self, input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.held.extend_from_slice(input);
        Ok(())
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if self.held.len() < self.before {
            return Err(StreamError::new("the input ends inside the old side"));
        }
        let (old, new) = self.held.split_at(self.before);
        let input = InternedInput::new(old, new);
        let mut diff = Diff::compute(Algorithm::Myers, &input);
        diff.postprocess_lines(&input);
        let (mut i, mut j) = (0, 0);
        for hunk in diff.hunks() {
            if hunk.before.start > i {
                opcode(out, "equal", i, hunk.before.start, j, hunk.after.start);
            }
            let tag = if hunk.is_pure_insertion() {
                "insert"
            } else if hunk.is_pure_removal() {
                "delete"
            } else {
                "replace"
            };
            opcode(
                out,
                tag,
                hunk.before.start,
                hunk.before.end,
                hunk.after.start,
                hunk.after.end,
            );
            (i, j) = (hunk.before.end, hunk.after.end);
        }
        let (last, other) = (len(&input.before), len(&input.after));
        if i < last {
            opcode(out, "equal", i, last, j, other);
        }
        Ok(())
    }
}

fn len<T>(tokens: &[T]) -> u32 {
    u32::try_from(tokens.len()).unwrap_or(u32::MAX)
}

fn opcode(out: &mut Vec<u8>, tag: &str, i1: u32, i2: u32, j1: u32, j2: u32) {
    out.extend_from_slice(format!("{tag} {i1} {i2} {j1} {j2}\n").as_bytes());
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(old: &str, new: &str) -> String {
        let config = format!("{{\"before\":{}}}", old.len());
        let mut stream = open(config.as_bytes()).unwrap();
        let mut out = Vec::new();
        stream.feed(old.as_bytes(), &mut out).unwrap();
        stream.feed(new.as_bytes(), &mut out).unwrap();
        stream.finish(&mut out).unwrap();
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn an_unchanged_side_is_one_equal_run() {
        assert_eq!(run("a\nb\n", "a\nb\n"), "equal 0 2 0 2\n");
        assert_eq!(run("", ""), "");
    }

    #[test]
    fn a_missing_last_newline_is_a_change() {
        assert_eq!(run("a\nb", "a\nb\n"), "equal 0 1 0 1\nreplace 1 2 1 2\n");
    }

    #[test]
    fn insertions_and_deletions_are_named_as_such() {
        assert_eq!(run("", "a\n"), "insert 0 0 0 1\n");
        assert_eq!(
            run("a\nb\nc\n", "a\nc\n"),
            "equal 0 1 0 1\ndelete 1 2 1 1\nequal 2 3 1 2\n"
        );
    }

    // The case a longest-block matcher gets wrong: the shared closing lines
    // stay unchanged and only the new function is added, as git prints it.
    #[test]
    fn a_new_function_leaves_the_shared_lines_alone() {
        let old = "def a():\n    \"\"\"A.\"\"\"\n    return 1\n";
        let new = "def a():\n    \"\"\"A.\"\"\"\n    return 1\n\n\ndef b():\n    \"\"\"B.\"\"\"\n    return 2\n";
        assert_eq!(run(old, new), "equal 0 3 0 3\ninsert 3 3 3 8\n");
    }

    #[test]
    fn a_short_input_is_refused() {
        let mut stream = open(b"{\"before\":5}").unwrap();
        let mut out = Vec::new();
        stream.feed(b"ab", &mut out).unwrap();
        assert!(stream.finish(&mut out).is_err());
    }
}
