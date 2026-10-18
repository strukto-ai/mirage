#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum BinaryOp {
    Add,
    Subtract,
    Multiply,
    Divide,
    Remainder,
    Pow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Builtin {
    Sqrt,
    Length,
    Scale,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum MathFunction {
    Sin,
    Cos,
    Atan,
    Log,
    Exp,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum NumericError {
    ArithmeticLimit,
    DivideByZero,
    ModuloByZero,
    NegativePowerOfZero,
    NegativeSquareRoot,
}

impl NumericError {
    pub(super) fn reason(self) -> &'static str {
        match self {
            Self::ArithmeticLimit => "Arithmetic limit exceeded",
            Self::DivideByZero => "Divide by zero",
            Self::ModuloByZero => "Modulo by zero",
            Self::NegativePowerOfZero => "divide by zero",
            Self::NegativeSquareRoot => "Square root of a negative number",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Warning {
    NonzeroExponentScale,
    NegativeScale,
    InputBaseTooSmall,
    OutputBaseTooSmall,
}

impl Warning {
    pub(super) fn reason(self) -> &'static str {
        match self {
            Self::NonzeroExponentScale => "non-zero scale in exponent",
            Self::NegativeScale => "negative scale, set to 0",
            Self::InputBaseTooSmall => "ibase too small, set to 2",
            Self::OutputBaseTooSmall => "obase too small, set to 2",
        }
    }
}

macro_rules! register_type {
    ($name:ident, $storage:ty, $min:literal, $max:literal) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub(super) struct $name($storage);

        impl $name {
            pub(super) fn new(value: u32) -> Option<Self> {
                if ($min..=$max).contains(&value) {
                    Some(Self(value as $storage))
                } else {
                    None
                }
            }

            pub(super) const fn get(self) -> u32 {
                self.0 as u32
            }
        }
    };
}

register_type!(GlobalScale, u8, 0, 100);
register_type!(InputBase, u8, 2, 16);
register_type!(OutputBase, u16, 2, 999);

pub(super) const MAX_COEFFICIENT_BITS: u64 = 65_536;
pub(super) const MAX_LITERAL_DIGITS: usize = 16_000;
pub(super) const MAX_WORKING_SCALE: u32 = 4_096;

pub(super) struct Budget {
    remaining: u32,
}

impl Budget {
    pub(super) fn new(actions: u32) -> Self {
        Self { remaining: actions }
    }

    pub(super) fn take(&mut self) -> bool {
        if self.remaining == 0 {
            false
        } else {
            self.remaining -= 1;
            true
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Config {
    #[serde(default)]
    pub(super) math_mode: bool,
    #[serde(default)]
    pub(super) line_length: Option<String>,
}
