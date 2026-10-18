use num_bigint::BigInt;
use num_traits::{One, Signed, ToPrimitive, Zero};

use super::common::{
    BinaryOp, Builtin, GlobalScale, InputBase, MAX_COEFFICIENT_BITS, MAX_LITERAL_DIGITS,
    NumericError, Warning,
};

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct Number {
    pub(super) coefficient: BigInt,
    pub(super) scale: u32,
}

impl Number {
    pub(super) fn integer(value: i64) -> Self {
        Self {
            coefficient: value.into(),
            scale: 0,
        }
    }

    pub(super) fn is_zero(&self) -> bool {
        self.coefficient.is_zero()
    }

    pub(super) fn negated(&self) -> Self {
        Self {
            coefficient: -&self.coefficient,
            scale: self.scale,
        }
    }
}

pub(super) fn ensure_bits(bits: u64) -> Result<(), NumericError> {
    if bits > MAX_COEFFICIENT_BITS {
        Err(NumericError::ArithmeticLimit)
    } else {
        Ok(())
    }
}

pub(super) fn power_ten(exponent: u32) -> Result<BigInt, NumericError> {
    ensure_bits(4 * u64::from(exponent) + 1)?;
    Ok(BigInt::from(10).pow(exponent))
}

pub(super) fn shift_decimal(value: &BigInt, shift: i64) -> Result<BigInt, NumericError> {
    if value.is_zero() {
        return Ok(BigInt::zero());
    }
    if shift >= 0 {
        let shift = u32::try_from(shift).map_err(|_| NumericError::ArithmeticLimit)?;
        ensure_bits(value.bits() + 4 * u64::from(shift))?;
        return Ok(value * power_ten(shift)?);
    }
    if shift.unsigned_abs() >= value.bits() {
        return Ok(BigInt::zero());
    }
    let shift = u32::try_from(shift.unsigned_abs()).map_err(|_| NumericError::ArithmeticLimit)?;
    Ok(value / power_ten(shift)?)
}

pub(super) fn normalize(num: &Number) -> Number {
    if num.is_zero() {
        return Number::integer(0);
    }
    let mut result = num.clone();
    while result.scale != 0 && (&result.coefficient % 10u8).is_zero() {
        result.coefficient /= 10u8;
        result.scale -= 1;
    }
    result
}

fn multiply(a: &BigInt, b: &BigInt) -> Result<BigInt, NumericError> {
    if a.is_zero() || b.is_zero() {
        return Ok(BigInt::zero());
    }
    ensure_bits(a.bits() + b.bits())?;
    Ok(a * b)
}

pub(super) fn rescale(num: &Number, scale: u32) -> Result<Number, NumericError> {
    ensure_bits(4 * u64::from(scale) + 1)?;
    Ok(Number {
        coefficient: shift_decimal(&num.coefficient, i64::from(scale) - i64::from(num.scale))?,
        scale,
    })
}

pub(super) fn truncate_int(num: &Number) -> BigInt {
    if u64::from(num.scale) >= num.coefficient.bits() {
        BigInt::zero()
    } else {
        &num.coefficient / BigInt::from(10).pow(num.scale)
    }
}

pub(super) fn read_literal(text: &str, base: InputBase) -> Result<Number, NumericError> {
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    let digits = whole
        .len()
        .checked_add(fraction.len())
        .ok_or(NumericError::ArithmeticLimit)?;
    if digits > MAX_LITERAL_DIGITS {
        return Err(NumericError::ArithmeticLimit);
    }
    ensure_bits(4 * digits as u64 + 1)?;
    let scale = fraction.len() as u32;
    let radix = base.get();
    let mut numerator = BigInt::zero();
    for (index, part) in [whole, fraction].into_iter().enumerate() {
        let clamp = index == 1 || whole.len() > 1;
        for byte in part.bytes() {
            let digit = match byte {
                b'0'..=b'9' => u32::from(byte - b'0'),
                _ => u32::from(byte - b'A') + 10,
            };
            numerator = numerator * radix + if clamp { digit.min(radix - 1) } else { digit };
        }
    }
    if radix == 10 {
        return Ok(Number {
            coefficient: numerator,
            scale,
        });
    }
    ensure_bits(u64::from(32 - radix.leading_zeros()) * u64::from(scale) + 1)?;
    let denominator = BigInt::from(radix).pow(scale);
    Ok(Number {
        coefficient: shift_decimal(&numerator, i64::from(scale))? / denominator,
        scale,
    })
}

fn divide(a: &Number, b: &Number, scale: u32) -> Result<Number, NumericError> {
    if b.is_zero() {
        return Err(NumericError::DivideByZero);
    }
    let left = normalize(a);
    let right = normalize(b);
    let shift = i64::from(right.scale) + i64::from(scale) - i64::from(left.scale);
    let numerator = shift_decimal(&left.coefficient, shift.max(0))?;
    let denominator = shift_decimal(&right.coefficient, (-shift).max(0))?;
    Ok(Number {
        coefficient: numerator / denominator,
        scale,
    })
}

fn modulo(a: &Number, b: &Number, scale: u32) -> Result<Number, NumericError> {
    if b.is_zero() {
        return Err(NumericError::ModuloByZero);
    }
    let quotient = divide(a, b, scale)?;
    let product_scale = scale
        .checked_add(b.scale)
        .ok_or(NumericError::ArithmeticLimit)?;
    let result_scale = a.scale.max(product_scale);
    let left = rescale(a, result_scale)?;
    let product = rescale(
        &Number {
            coefficient: multiply(&quotient.coefficient, &b.coefficient)?,
            scale: product_scale,
        },
        result_scale,
    )?;
    ensure_bits(left.coefficient.bits().max(product.coefficient.bits()) + 1)?;
    Ok(Number {
        coefficient: left.coefficient - product.coefficient,
        scale: result_scale,
    })
}

fn power(
    a: &Number,
    b: &Number,
    scale: u32,
    warnings: &mut Vec<Warning>,
) -> Result<Number, NumericError> {
    let exponent = truncate_int(b);
    if b.scale != 0 {
        warnings.push(Warning::NonzeroExponentScale);
    }
    if exponent.is_zero() {
        return Ok(Number::integer(1));
    }
    let negative = exponent.is_negative();
    let result_scale = if negative {
        scale
    } else {
        (BigInt::from(a.scale) * &exponent)
            .min(BigInt::from(scale.max(a.scale)))
            .to_u32()
            .ok_or(NumericError::ArithmeticLimit)?
    };
    let base = normalize(a);
    if base.is_zero() {
        return if negative {
            Err(NumericError::NegativePowerOfZero)
        } else {
            Ok(Number {
                coefficient: BigInt::zero(),
                scale: result_scale,
            })
        };
    }
    let magnitude = exponent.abs();
    if base.coefficient.abs().is_one() {
        let sign = if base.coefficient.is_negative() && (&magnitude % 2u8).is_one() {
            -1
        } else {
            1
        };
        let shift = BigInt::from(result_scale) - BigInt::from(base.scale) * exponent;
        let coefficient = if shift.is_negative() {
            BigInt::zero()
        } else {
            shift_decimal(
                &BigInt::from(sign),
                shift.to_i64().ok_or(NumericError::ArithmeticLimit)?,
            )?
        };
        return Ok(Number {
            coefficient,
            scale: result_scale,
        });
    }
    let magnitude = magnitude.to_u32().ok_or(NumericError::ArithmeticLimit)?;
    ensure_bits(base.coefficient.bits() * u64::from(magnitude))?;
    let raw_scale = base
        .scale
        .checked_mul(magnitude)
        .ok_or(NumericError::ArithmeticLimit)?;
    ensure_bits(4 * u64::from(raw_scale) + 1)?;
    let value = Number {
        coefficient: base.coefficient.pow(magnitude),
        scale: raw_scale,
    };
    if negative {
        divide(&Number::integer(1), &value, result_scale)
    } else {
        rescale(&value, result_scale)
    }
}

pub(super) fn binary(
    op: BinaryOp,
    a: &Number,
    b: &Number,
    scale: GlobalScale,
    warnings: &mut Vec<Warning>,
) -> Result<Number, NumericError> {
    let scale = scale.get();
    match op {
        BinaryOp::Add | BinaryOp::Subtract => {
            let target = a.scale.max(b.scale);
            let left = rescale(a, target)?.coefficient;
            let right = rescale(b, target)?.coefficient;
            ensure_bits(left.bits().max(right.bits()) + 1)?;
            Ok(Number {
                coefficient: if op == BinaryOp::Add {
                    left + right
                } else {
                    left - right
                },
                scale: target,
            })
        }
        BinaryOp::Multiply => {
            let raw_scale = a
                .scale
                .checked_add(b.scale)
                .ok_or(NumericError::ArithmeticLimit)?;
            let value = Number {
                coefficient: multiply(&a.coefficient, &b.coefficient)?,
                scale: raw_scale,
            };
            rescale(&value, raw_scale.min(scale.max(a.scale).max(b.scale)))
        }
        BinaryOp::Divide => divide(a, b, scale),
        BinaryOp::Remainder => modulo(a, b, scale),
        BinaryOp::Pow => power(a, b, scale, warnings),
    }
}

pub(super) fn integer_sqrt(value: &BigInt) -> BigInt {
    if value < &BigInt::from(2) {
        return value.clone();
    }
    let mut root = BigInt::one() << value.bits().div_ceil(2);
    loop {
        let next = (&root + value / &root) / 2u8;
        if next >= root {
            return root;
        }
        root = next;
    }
}

pub(super) fn builtin(
    function: Builtin,
    arg: &Number,
    scale: GlobalScale,
) -> Result<Number, NumericError> {
    match function {
        Builtin::Length => Ok(Number {
            coefficient: arg
                .coefficient
                .abs()
                .to_str_radix(10)
                .len()
                .max(arg.scale as usize)
                .into(),
            scale: 0,
        }),
        Builtin::Scale => Ok(Number {
            coefficient: arg.scale.into(),
            scale: 0,
        }),
        Builtin::Sqrt => sqrt(arg, scale.get()),
    }
}

fn sqrt(arg: &Number, scale: u32) -> Result<Number, NumericError> {
    if arg.coefficient.is_negative() {
        return Err(NumericError::NegativeSquareRoot);
    }
    if arg.is_zero() {
        return Ok(Number::integer(0));
    }
    let base = normalize(arg);
    if base == Number::integer(1) {
        return Ok(base);
    }
    let target = scale.max(arg.scale);
    let value = shift_decimal(
        &base.coefficient,
        2 * i64::from(target) - i64::from(base.scale),
    )?;
    Ok(Number {
        coefficient: integer_sqrt(&value),
        scale: target,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shifts_division_and_sqrt_refuse_before_oversized_allocation() {
        let huge = Number {
            coefficient: BigInt::one() << 32768usize,
            scale: 0,
        };
        assert_eq!(
            divide(&huge, &Number::integer(1), 16000),
            Err(NumericError::ArithmeticLimit)
        );
        assert_eq!(
            sqrt(&Number::integer(2), 16000),
            Err(NumericError::ArithmeticLimit)
        );
        assert_eq!(
            shift_decimal(&BigInt::one(), i64::MIN).unwrap(),
            BigInt::zero()
        );
    }
}
