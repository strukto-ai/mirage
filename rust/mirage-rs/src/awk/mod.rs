//! awk as mawk 1.3.4 runs it, as mirage models it: the program compiles
//! to bytecode, and a machine with explicit stacks runs a bounded number
//! of steps per call, so the host can yield between any two. Every file
//! and command the program reaches is a request the host serves.

mod compile;
mod format;
mod io;
mod lexer;
mod parser;
mod text;
mod value;
mod vm;

#[cfg(test)]
mod tests;

use serde::Deserialize;

use crate::{Stream, StreamError, parse_config};

use self::compile::compile;
use self::parser::parse;
use self::text::unescape;
use self::vm::{Machine, Setup};

/// The steps one `drain` runs before the host may yield.
const STEPS: usize = 20_000;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    #[serde(deserialize_with = "crate::latin1")]
    program: Vec<u8>,
    /// The operands as typed, ARGV[1] onward.
    #[serde(default, deserialize_with = "crate::latin1_list")]
    operands: Vec<Vec<u8>>,
    /// The `-v` assignments, each `name=value` as typed.
    #[serde(default, deserialize_with = "crate::latin1_list")]
    assignments: Vec<Vec<u8>>,
    /// `-F`'s separator as typed.
    #[serde(default, deserialize_with = "crate::latin1_opt")]
    fs: Option<Vec<u8>>,
    /// The exported environment, each `name=value`.
    #[serde(default, deserialize_with = "crate::latin1_list")]
    environ: Vec<Vec<u8>>,
}

enum Awk {
    Running(Box<Machine>),
    /// A program awk refused to run: the message, then nothing.
    Refused(Vec<u8>),
}

fn pair(item: &[u8]) -> Option<(Vec<u8>, Vec<u8>)> {
    let eq = item.iter().position(|&c| c == b'=')?;
    Some((item[..eq].to_vec(), item[eq + 1..].to_vec()))
}

pub(crate) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    let program = match parse(&config.program) {
        Ok(program) => program,
        Err(mut message) => {
            message.push(b'\n');
            return Ok(Box::new(Awk::Refused(message)));
        }
    };
    let setup = Setup {
        operands: config.operands,
        assignments: config
            .assignments
            .iter()
            .filter_map(|item| pair(item))
            .map(|(name, value)| (name, unescape(&value)))
            .collect(),
        fs: config.fs.map(|fs| unescape(&fs)),
        environ: config
            .environ
            .iter()
            .filter_map(|item| pair(item))
            .collect(),
    };
    Ok(Box::new(Awk::Running(Box::new(Machine::new(
        compile(&program),
        setup,
    )))))
}

impl Stream for Awk {
    fn feed(&mut self, _input: &[u8], _out: &mut Vec<u8>) -> Result<(), StreamError> {
        Err(StreamError::new("awk reads its input through requests"))
    }

    fn finish(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if let Awk::Running(machine) = self {
            out.append(&mut machine.io.out);
        }
        Ok(())
    }

    fn busy(&self) -> bool {
        match self {
            Awk::Running(machine) => {
                machine.io.idle() && (!machine.done || machine.io.fatal.is_some())
            }
            Awk::Refused(_) => false,
        }
    }

    fn drain(&mut self, out: &mut Vec<u8>) -> Result<(), StreamError> {
        if let Awk::Running(machine) = self {
            machine.run(STEPS);
            out.append(&mut machine.io.out);
        }
        Ok(())
    }

    fn request(&mut self, data: &mut Vec<u8>) -> Option<Vec<u8>> {
        match self {
            Awk::Running(machine) => machine.io.take_request(data),
            Awk::Refused(_) => None,
        }
    }

    fn respond(
        &mut self,
        reply: &[u8],
        data: &[u8],
        _out: &mut Vec<u8>,
    ) -> Result<(), StreamError> {
        match self {
            Awk::Running(machine) => machine.io.answer(reply, data).map_err(StreamError::new),
            Awk::Refused(_) => Err(StreamError::new("no request is waiting")),
        }
    }

    fn status(&self) -> i32 {
        match self {
            Awk::Running(machine) => machine.status,
            Awk::Refused(_) => 2,
        }
    }

    fn take_stderr(&mut self, err: &mut Vec<u8>) {
        match self {
            Awk::Running(machine) => err.append(&mut machine.io.err),
            Awk::Refused(message) => err.append(message),
        }
    }
}
