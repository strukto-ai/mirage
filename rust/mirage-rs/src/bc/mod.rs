mod common;
mod compiler;
mod math;
mod numbers;
#[cfg(test)]
mod numeric_tests;
mod render;
mod source;
mod vm;

use crate::{Stream, StreamError, parse_config};
use common::{Budget, Config};
use compiler::{CompileResult, Compiler};
use source::{FrontEvent, FrontStep, Source};
use vm::Vm;

const ACTIONS_PER_CALL: u32 = 4096;

pub(super) fn open(config: &[u8]) -> Result<Box<dyn Stream>, StreamError> {
    let config: Config = parse_config(config)?;
    Ok(Box::new(Bc {
        source: Source::new(),
        compiler: None,
        vm: Vm::new(config.math_mode, config.line_length.as_deref()),
        stderr: Vec::new(),
        stopped: false,
        ended: false,
        needs_input: true,
    }))
}

struct Bc {
    source: Source,
    compiler: Option<Compiler>,
    vm: Vm,
    stderr: Vec<u8>,
    stopped: bool,
    ended: bool,
    needs_input: bool,
}

impl Bc {
    fn advance(&mut self, output: &mut Vec<u8>) {
        let mut budget = Budget::new(ACTIONS_PER_CALL);
        loop {
            if self.vm.busy() {
                self.vm.advance(&mut budget, output, &mut self.stderr);
                if self.vm.busy() {
                    return;
                }
                if self.vm.halted() {
                    self.stopped = true;
                }
            }
            if let Some(compiler) = &mut self.compiler {
                if !compiler.advance(&mut budget) {
                    return;
                }
                let result = self.compiler.take().expect("completed compiler").finish();
                match result {
                    CompileResult::Program(program) => {
                        self.stopped |= program.quits;
                        self.vm.start(program);
                    }
                    CompileResult::Refused { diagnostics, quits } => {
                        self.stopped |= quits;
                        for diagnostic in diagnostics {
                            self.stderr.extend_from_slice(diagnostic.as_bytes());
                        }
                    }
                }
                continue;
            }
            if self.stopped || self.ended {
                return;
            }
            match self.source.advance(&mut budget) {
                FrontStep::Pending => {
                    self.needs_input = false;
                    return;
                }
                FrontStep::NeedsInput => {
                    self.needs_input = true;
                    return;
                }
                FrontStep::Event(FrontEvent::Program(line)) => {
                    self.needs_input = false;
                    self.compiler = Some(Compiler::new(line));
                }
                FrontStep::Event(FrontEvent::EofInComment) => {
                    self.stderr
                        .extend_from_slice(b"EOF encountered in a comment.\n");
                    self.ended = true;
                }
                FrontStep::Event(FrontEvent::End) => self.ended = true,
            }
        }
    }
}

impl Stream for Bc {
    fn feed(&mut self, input: &[u8], output: &mut Vec<u8>) -> Result<(), StreamError> {
        if !self.stopped && !self.ended {
            self.source.feed(input);
            self.needs_input = false;
        }
        self.advance(output);
        Ok(())
    }

    fn finish(&mut self, output: &mut Vec<u8>) -> Result<(), StreamError> {
        self.source.finish();
        self.needs_input = false;
        self.advance(output);
        Ok(())
    }

    fn busy(&self) -> bool {
        self.vm.busy()
            || self.compiler.is_some()
            || (!self.stopped && !self.ended && !self.needs_input && self.source.busy())
    }

    fn drain(&mut self, output: &mut Vec<u8>) -> Result<(), StreamError> {
        self.advance(output);
        Ok(())
    }

    fn done(&self) -> bool {
        self.stopped || self.ended
    }

    fn take_stderr(&mut self, output: &mut Vec<u8>) {
        output.append(&mut self.stderr);
    }
}
