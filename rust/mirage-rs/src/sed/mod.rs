//! sed as GNU sed 4.9 runs it, as mirage models it: the script compiles
//! with GNU's diagnostics, and a machine runs it a bounded number of
//! steps per call, every input and every file it reads or writes a
//! request the host serves.

mod exec;
mod io;
mod script;
mod text;

#[cfg(test)]
mod tests;

use serde::Deserialize;

use crate::request::Opening;
use crate::{Stream, StreamError, parse_config};

use self::exec::{Machine, Options};
use self::io::Input;
use self::script::{Piece, compile};

/// The steps one `drain` runs before the host may yield.
const STEPS: usize = 20_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PieceConfig {
    #[serde(deserialize_with = "crate::latin1")]
    text: Vec<u8>,
    /// A -f file's name, for its diagnostics; none for an -e expression.
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    file: Option<Vec<u8>>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    /// The -e expressions and -f files, in the order given.
    pieces: Vec<PieceConfig>,
    #[serde(default)]
    extended: bool,
    #[serde(default)]
    utf8: bool,
    /// -n.
    #[serde(default)]
    quiet: bool,
    /// -s.
    #[serde(default)]
    separate: bool,
    /// -i.
    #[serde(default)]
    in_place: bool,
    /// -l.
    #[serde(default = "line_length")]
    line_length: i64,
    /// The inputs as `F` names them, each the operand at its place; none
    /// reads standard input.
    #[serde(default, deserialize_with = "crate::latin1_list")]
    inputs: Vec<Vec<u8>>,
    /// Under -i, each input's path.
    #[serde(default, deserialize_with = "crate::latin1_list")]
    paths: Vec<Vec<u8>>,
    /// What the names a script writes to resolve against.
    #[serde(default, deserialize_with = "crate::latin1")]
    cwd: Vec<u8>,
}

fn line_length() -> i64 {
    70
}

struct Sed {
    machine: Machine,
    /// Whether the script names a `w` file, refused or not.
    writes: bool,
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    let pieces = config
        .pieces
        .into_iter()
        .map(|piece| Piece {
            text: piece.text,
            file: piece.file,
        })
        .collect();
    let (machine, writes) = match compile(pieces, config.extended, config.utf8) {
        Ok(program) => {
            let writes = !program.wfiles.is_empty();
            let mut inputs: Vec<Input> = config
                .inputs
                .into_iter()
                .enumerate()
                .map(|(at, name)| Input {
                    name,
                    opening: Opening::Operand(at + 1),
                })
                .collect();
            if inputs.is_empty() && !config.in_place {
                inputs.push(Input {
                    name: b"-".to_vec(),
                    opening: Opening::Name,
                });
            }
            let opts = Options {
                quiet: config.quiet,
                separate: config.separate,
                in_place: config.in_place,
                line_length: config.line_length,
                utf8: config.utf8,
                cwd: config.cwd,
            };
            (Machine::new(program, opts, inputs, config.paths), writes)
        }
        Err((refusal, wfiles)) => {
            let writes = !wfiles.is_empty();
            (Machine::refusing(refusal, wfiles, config.cwd), writes)
        }
    };
    Ok(Box::new(Sed { machine, writes }))
}

impl Stream for Sed {
    fn feed(&mut self, _input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("sed reads its input through requests"))
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.machine.hand_on(out);
        Ok(())
    }

    fn busy(&self) -> bool {
        self.machine.io.idle() && (!self.machine.done() || !self.machine.out.is_empty())
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        self.machine.run(STEPS);
        self.machine.hand_on(out);
        Ok(())
    }

    fn cancel(&mut self) -> bool {
        self.machine.cancel()
    }

    fn status(&self) -> i32 {
        self.machine.status()
    }

    fn metadata(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(if self.writes {
            b"{\"writes\":true}"
        } else {
            b"{\"writes\":false}"
        });
    }

    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        self.machine.take_stderr(err);
    }

    fn request(&mut self, data: &mut Vec<u8>) -> Option<Vec<u8>> {
        self.machine.io.take(data)
    }

    fn respond(
        &mut self,
        reply: &[u8],
        data: &[u8],
        _out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        self.machine.answer(reply, data).map_err(StreamError::new)
    }
}
