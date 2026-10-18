use std::collections::BTreeMap;
use std::ops::ControlFlow;

use num_bigint::BigInt;
use num_traits::ToPrimitive;

use super::common::{BinaryOp, Budget, GlobalScale, InputBase, NumericError, OutputBase, Warning};
use super::compiler::{Call, Instruction, LocatedInstruction, Place, Program};
use super::math;
use super::numbers::{self, Number};
use super::render::{self, Output, OutputCursor};

pub(super) struct Vm {
    scale: GlobalScale,
    input_base: InputBase,
    output_base: OutputBase,
    last: Number,
    variables: BTreeMap<String, Number>,
    math_mode: bool,
    program: Vec<LocatedInstruction>,
    position: usize,
    stack: Vec<Number>,
    cursor: Option<OutputCursor>,
    folder: Output,
    aborted: bool,
    halted: bool,
}

impl Vm {
    pub(super) fn new(math_mode: bool, line_length: Option<&str>) -> Self {
        Self {
            scale: GlobalScale::new(if math_mode { 20 } else { 0 }).unwrap(),
            input_base: InputBase::new(10).unwrap(),
            output_base: OutputBase::new(10).unwrap(),
            last: Number::integer(0),
            variables: BTreeMap::new(),
            math_mode,
            program: Vec::new(),
            position: 0,
            stack: Vec::new(),
            cursor: None,
            folder: Output::new(line_length),
            aborted: false,
            halted: false,
        }
    }

    pub(super) fn start(&mut self, program: Program) {
        self.program = program.instructions;
        self.position = 0;
        self.aborted = program.quits;
        self.stack.clear();
    }

    pub(super) fn halted(&self) -> bool {
        self.halted
    }

    pub(super) fn busy(&self) -> bool {
        self.cursor.is_some() || self.position < self.program.len()
    }

    fn load(&self, place: &Place) -> Number {
        match place {
            Place::Scale => Number::integer(i64::from(self.scale.get())),
            Place::InputBase => Number::integer(i64::from(self.input_base.get())),
            Place::OutputBase => Number::integer(i64::from(self.output_base.get())),
            Place::Last => self.last.clone(),
            Place::Variable(name) => self
                .variables
                .get(name)
                .cloned()
                .unwrap_or_else(|| Number::integer(0)),
        }
    }

    fn store(&mut self, place: &Place, value: Number, warnings: &mut Vec<Warning>) -> Number {
        match place {
            Place::Scale => {
                let requested = numbers::truncate_int(&value);
                if requested < BigInt::from(0) {
                    warnings.push(Warning::NegativeScale);
                    self.scale = GlobalScale::new(0).unwrap();
                } else {
                    self.scale =
                        GlobalScale::new(requested.to_u32().unwrap_or(u32::MAX).min(100)).unwrap();
                }
            }
            Place::InputBase => {
                let requested = numbers::truncate_int(&value);
                let base = if requested < BigInt::from(2) {
                    warnings.push(Warning::InputBaseTooSmall);
                    2
                } else {
                    requested.to_u32().unwrap_or(u32::MAX).min(16)
                };
                self.input_base = InputBase::new(base).unwrap();
            }
            Place::OutputBase => {
                let requested = numbers::truncate_int(&value);
                let base = if requested < BigInt::from(2) {
                    warnings.push(Warning::OutputBaseTooSmall);
                    2
                } else {
                    requested.to_u32().unwrap_or(u32::MAX).min(999)
                };
                self.output_base = OutputBase::new(base).unwrap();
            }
            Place::Last => self.last = value,
            Place::Variable(name) => {
                self.variables.insert(name.clone(), value);
            }
        }
        self.load(place)
    }

    fn execute(
        &mut self,
        instruction: Instruction,
        warnings: &mut Vec<Warning>,
    ) -> Result<(), RuntimeError> {
        match instruction {
            Instruction::Literal(text) => self
                .stack
                .push(numbers::read_literal(&text, self.input_base)?),
            Instruction::Load(place) => self.stack.push(self.load(&place)),
            Instruction::Negate => {
                let value = self.stack.pop().expect("compiled unary operand");
                self.stack.push(value.negated());
            }
            Instruction::Binary(operation) => {
                let right = self.stack.pop().expect("compiled right operand");
                let left = self.stack.pop().expect("compiled left operand");
                self.stack.push(numbers::binary(
                    operation, &left, &right, self.scale, warnings,
                )?);
            }
            Instruction::Store(place) => {
                let value = self.stack.pop().expect("compiled assignment operand");
                let stored = self.store(&place, value, warnings);
                self.stack.push(stored);
            }
            Instruction::CompoundStore(place, operation) => {
                let right = self.stack.pop().expect("compiled compound operand");
                let left = self.load(&place);
                let value = numbers::binary(operation, &left, &right, self.scale, warnings)?;
                let stored = self.store(&place, value, warnings);
                self.stack.push(stored);
            }
            Instruction::Step(place, delta, postfix) => {
                let old = self.load(&place);
                let value = numbers::binary(
                    BinaryOp::Add,
                    &old,
                    &Number::integer(delta),
                    self.scale,
                    warnings,
                )?;
                let stored = self.store(&place, value, warnings);
                self.stack.push(if postfix { old } else { stored });
            }
            Instruction::Call(call) => {
                let argument = self.stack.pop().expect("compiled function argument");
                let value = match call {
                    Call::Builtin(function) => numbers::builtin(function, &argument, self.scale)?,
                    Call::Math(function) if self.math_mode => {
                        math::math(function, &argument, self.scale)?
                    }
                    Call::Math(function) => {
                        let name = match function {
                            super::common::MathFunction::Sin => "s",
                            super::common::MathFunction::Cos => "c",
                            super::common::MathFunction::Atan => "a",
                            super::common::MathFunction::Log => "l",
                            super::common::MathFunction::Exp => "e",
                        };
                        return Err(RuntimeError::Undefined(name.to_owned()));
                    }
                    Call::Undefined(name) => return Err(RuntimeError::Undefined(name)),
                };
                self.stack.push(value);
            }
            Instruction::Drop => {
                self.stack.pop().expect("compiled discarded value");
            }
            Instruction::Emit => {
                let number = self.stack.pop().expect("compiled emitted value");
                self.last = number;
                self.cursor = Some(OutputCursor::new(render::render_number(
                    &self.last,
                    self.output_base,
                )?));
            }
            Instruction::Text(text) => self.cursor = Some(OutputCursor::new(text)),
            Instruction::Newline => self.cursor = Some(OutputCursor::new("\n".to_owned())),
            Instruction::Halt => {
                self.halted = true;
                self.aborted = true;
            }
        }
        Ok(())
    }

    pub(super) fn advance(
        &mut self,
        budget: &mut Budget,
        output: &mut Vec<u8>,
        errors: &mut Vec<u8>,
    ) {
        loop {
            if let Some(cursor) = &mut self.cursor {
                if let ControlFlow::Break(()) = self.folder.advance(cursor, budget, output) {
                    self.cursor = None;
                } else {
                    return;
                }
            }
            if self.position >= self.program.len() || !budget.take() {
                return;
            }
            let located = &mut self.program[self.position];
            debug_assert!(located.line > 0, "source lines start at one");
            let instruction = std::mem::replace(&mut located.operation, Instruction::Drop);
            self.position += 1;
            if self.aborted {
                continue;
            }
            let mut warnings = Vec::new();
            let result = self.execute(instruction, &mut warnings);
            for warning in warnings {
                diagnostic(errors, "warning", warning.reason());
            }
            if let Err(error) = result {
                let reason = match error {
                    RuntimeError::Numeric(error) => error.reason().to_owned(),
                    RuntimeError::Undefined(name) => format!("Function {name} not defined."),
                };
                diagnostic(errors, "error", &reason);
                self.aborted = true;
                self.stack.clear();
            }
        }
    }
}

enum RuntimeError {
    Numeric(NumericError),
    Undefined(String),
}

impl From<NumericError> for RuntimeError {
    fn from(value: NumericError) -> Self {
        Self::Numeric(value)
    }
}

fn diagnostic(output: &mut Vec<u8>, kind: &str, reason: &str) {
    output.extend_from_slice(format!("Runtime {kind} (func=(main), adr=3): {reason}\n").as_bytes());
}
