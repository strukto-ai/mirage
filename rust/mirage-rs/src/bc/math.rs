use num_bigint::BigInt;
use num_traits::{One, Signed, ToPrimitive, Zero};

use super::common::{GlobalScale, MAX_WORKING_SCALE, MathFunction, NumericError};
use super::numbers::{
    Number, ensure_bits, integer_sqrt, normalize, power_ten, rescale, truncate_int,
};

fn atan_series(x: &BigInt, unit: &BigInt) -> BigInt {
    let square = x * x;
    let unit_square = unit * unit;
    let mut power = x.clone();
    let mut total = x.clone();
    let mut denominator = 3u64;
    while !power.is_zero() {
        power = -(&power * &square / &unit_square);
        let term = &power / denominator;
        if term.is_zero() {
            break;
        }
        total += term;
        denominator += 2;
    }
    total
}

fn pi(unit: &BigInt) -> BigInt {
    16u8 * atan_series(&(unit / 5u8), unit) - 4u8 * atan_series(&(unit / 239u16), unit)
}

fn atan(x: &BigInt, unit: &BigInt) -> BigInt {
    let negative = x.is_negative();
    let mut x = x.abs();
    let reflected = x > *unit;
    if reflected {
        x = unit * unit / &x;
    }
    let mut halvings = 0u32;
    while x > unit / 4u8 {
        x = &x * unit / (unit + integer_sqrt(&(unit * unit + &x * &x)));
        halvings += 1;
    }
    let mut result = atan_series(&x, unit) << halvings;
    if reflected {
        result = pi(unit) / 2u8 - result;
    }
    if negative { -result } else { result }
}

fn reduce_angle(x: &BigInt, unit: &BigInt) -> BigInt {
    let half_circle = pi(unit);
    let circle = &half_circle * 2u8;
    let mut x = x - (x / &circle) * &circle;
    if x > half_circle {
        x -= circle;
    } else if x < -half_circle {
        x += circle;
    }
    x
}

fn sin(x: &BigInt, unit: &BigInt) -> BigInt {
    let x = reduce_angle(x, unit);
    let square = &x * &x;
    let unit_square = unit * unit;
    let mut term = x.clone();
    let mut total = x;
    let mut index = 1u64;
    while !term.is_zero() {
        term = -(&term * &square / (&unit_square * (2 * index) * (2 * index + 1)));
        total += &term;
        index += 1;
    }
    total
}

fn cos(x: &BigInt, unit: &BigInt) -> BigInt {
    let x = reduce_angle(x, unit);
    let square = &x * &x;
    let unit_square = unit * unit;
    let mut term = unit.clone();
    let mut total = unit.clone();
    let mut index = 1u64;
    while !term.is_zero() {
        term = -(&term * &square / (&unit_square * (2 * index - 1) * (2 * index)));
        total += &term;
        index += 1;
    }
    total
}

fn log(x: &BigInt, unit: &BigInt) -> BigInt {
    let mut x = x.clone();
    let mut halvings = 0u32;
    while x < unit / 2u8 || x > unit * 2u8 {
        x = integer_sqrt(&(&x * unit));
        halvings += 1;
    }
    let z = (&x - unit) * unit / (&x + unit);
    let square = &z * &z;
    let unit_square = unit * unit;
    let mut power = z.clone();
    let mut total = z;
    let mut denominator = 3u64;
    while !power.is_zero() {
        power = &power * &square / &unit_square;
        let term = &power / denominator;
        if term.is_zero() {
            break;
        }
        total += term;
        denominator += 2;
    }
    total << (halvings + 1)
}

fn exp(x: &BigInt, unit: &BigInt) -> Result<BigInt, NumericError> {
    let negative = x.is_negative();
    let mut x = x.abs();
    let mut halvings = 0u32;
    while x > unit / 8u8 {
        x /= 2u8;
        halvings += 1;
    }
    let mut total = unit.clone();
    let mut term = unit.clone();
    let mut index = 1u64;
    while !term.is_zero() {
        term = &term * &x / (unit * index);
        total += &term;
        index += 1;
    }
    for _ in 0..halvings {
        ensure_bits(2 * total.bits())?;
        total = &total * &total / unit;
    }
    Ok(if negative { unit * unit / total } else { total })
}

fn log_domain_value(scale: u32) -> Result<Number, NumericError> {
    let unit = power_ten(scale)?;
    ensure_bits(2 * unit.bits())?;
    Ok(Number {
        coefficient: (1u8 - &unit) * unit,
        scale,
    })
}

struct Interval {
    lower: Number,
    upper: Number,
    lower_open: bool,
    upper_open: bool,
}

fn endpoint_candidate(
    endpoint: &Number,
    opened: bool,
    lower: bool,
    scale: u32,
) -> Result<BigInt, NumericError> {
    let mut result = rescale(endpoint, scale)?.coefficient;
    let on_grid = endpoint.scale <= scale
        || (&endpoint.coefficient % power_ten(endpoint.scale - scale)?).is_zero();
    if opened && on_grid {
        if lower && endpoint.coefficient.is_negative() {
            result += 1u8;
        } else if !lower && endpoint.coefficient.is_positive() {
            result -= 1u8;
        }
    }
    Ok(result)
}

fn settle_interval(interval: &Interval, scale: u32) -> Result<Option<Number>, NumericError> {
    let lower = endpoint_candidate(&interval.lower, interval.lower_open, true, scale)?;
    let upper = endpoint_candidate(&interval.upper, interval.upper_open, false, scale)?;
    Ok((lower == upper).then_some(Number {
        coefficient: lower,
        scale,
    }))
}

fn small_result(
    function: MathFunction,
    arg: &Number,
    scale: u32,
) -> Result<Option<Number>, NumericError> {
    if !matches!(
        function,
        MathFunction::Sin | MathFunction::Atan | MathFunction::Cos
    ) {
        return Ok(None);
    }
    let magnitude = arg.coefficient.abs();
    let digits = magnitude.to_str_radix(10);
    let tiny = if let Some(shift) = arg.scale.checked_sub(scale) {
        digits.len() <= shift as usize
            || (digits.len() == shift as usize + 1 && magnitude == power_ten(shift)?)
    } else {
        false
    };
    if tiny {
        let coefficient = if function == MathFunction::Cos {
            power_ten(scale)? - 1u8
        } else {
            BigInt::zero()
        };
        return Ok(Some(Number { coefficient, scale }));
    }
    if (digits.len() > arg.scale as usize && !(magnitude.is_one() && arg.scale == 0))
        || arg.scale > MAX_WORKING_SCALE / 3
    {
        return Ok(None);
    }
    let order = if function == MathFunction::Cos { 2 } else { 3 };
    let endpoint_scale = order * arg.scale;
    ensure_bits(u64::from(order) * magnitude.bits() + 4)?;
    let power = magnitude.pow(order);
    let divisor = if function == MathFunction::Cos {
        2u8
    } else if function == MathFunction::Sin {
        6u8
    } else {
        3u8
    };
    let correction = &power / divisor;
    let remainder = &power % divisor;
    let upper = if function == MathFunction::Cos {
        power_ten(endpoint_scale)?
    } else {
        magnitude * power_ten(endpoint_scale - arg.scale)?
    };
    let lower = &upper - correction - u8::from(!remainder.is_zero());
    let interval = if function != MathFunction::Cos && arg.coefficient.is_negative() {
        Interval {
            lower: Number {
                coefficient: -upper,
                scale: endpoint_scale,
            },
            upper: Number {
                coefficient: -lower,
                scale: endpoint_scale,
            },
            lower_open: true,
            upper_open: remainder.is_zero(),
        }
    } else {
        Interval {
            lower: Number {
                coefficient: lower,
                scale: endpoint_scale,
            },
            upper: Number {
                coefficient: upper,
                scale: endpoint_scale,
            },
            lower_open: remainder.is_zero(),
            upper_open: true,
        }
    };
    settle_interval(&interval, scale)
}

fn working_scale(function: MathFunction, arg: &Number, scale: u32) -> Result<u32, NumericError> {
    let input_scale = u64::from(arg.scale);
    let mut working = u64::from(scale.max(arg.scale)) + 16;
    match function {
        MathFunction::Sin | MathFunction::Atan => {
            working = working.max(3 * input_scale + 16);
        }
        MathFunction::Cos => {
            working = working.max(2 * input_scale + 16);
        }
        MathFunction::Exp | MathFunction::Log => {
            working = working.max(2 * input_scale + 16);
        }
    }
    if function == MathFunction::Log {
        working = working.max(u64::from(scale) + input_scale + 16);
    }
    if matches!(function, MathFunction::Sin | MathFunction::Cos) {
        working +=
            (arg.coefficient.abs().to_str_radix(10).len() as u64).saturating_sub(input_scale);
    } else if function == MathFunction::Exp {
        let integer = truncate_int(arg).abs();
        if integer > BigInt::from(2 * MAX_WORKING_SCALE) {
            return Err(NumericError::ArithmeticLimit);
        }
        working += integer.to_u64().ok_or(NumericError::ArithmeticLimit)? / 2;
    }
    if working > u64::from(MAX_WORKING_SCALE) {
        return Err(NumericError::ArithmeticLimit);
    }
    ensure_bits(4 * working * 3 + 128)?;
    Ok(working as u32)
}

pub(super) fn math(
    function: MathFunction,
    arg: &Number,
    scale: GlobalScale,
) -> Result<Number, NumericError> {
    let scale = scale.get();
    if arg.is_zero() {
        if function == MathFunction::Log {
            return log_domain_value(scale);
        }
        let coefficient = if matches!(function, MathFunction::Cos | MathFunction::Exp) {
            power_ten(scale)?
        } else {
            BigInt::zero()
        };
        return Ok(Number { coefficient, scale });
    }
    let arg = normalize(arg);
    if function == MathFunction::Log {
        if arg == Number::integer(1) {
            return Ok(Number {
                coefficient: BigInt::zero(),
                scale,
            });
        }
        if arg.coefficient.is_negative() {
            return log_domain_value(scale);
        }
    }
    if function == MathFunction::Exp && truncate_int(&arg) < -BigInt::from(3 * (scale + 16)) {
        return Ok(Number {
            coefficient: BigInt::zero(),
            scale,
        });
    }
    if let Some(settled) = small_result(function, &arg, scale)? {
        return Ok(settled);
    }
    let working = working_scale(function, &arg, scale)?;
    let unit = power_ten(working)?;
    let value = rescale(&arg, working)?.coefficient;
    ensure_bits(value.bits() + unit.bits() + 2)?;
    let coefficient = match function {
        MathFunction::Sin => sin(&value, &unit),
        MathFunction::Cos => cos(&value, &unit),
        MathFunction::Atan => atan(&value, &unit),
        MathFunction::Log => log(&value, &unit),
        MathFunction::Exp => exp(&value, &unit)?,
    };
    rescale(
        &Number {
            coefficient,
            scale: working,
        },
        scale,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_endpoints_settle_on_the_correct_side_of_the_grid() {
        for sign in [-1, 1] {
            let (lower, upper) = if sign > 0 { (9, 10) } else { (-10, -9) };
            let mut interval = Interval {
                lower: Number::integer(lower),
                upper: Number::integer(upper),
                lower_open: sign < 0,
                upper_open: sign > 0,
            };
            assert_eq!(
                settle_interval(&interval, 0).unwrap(),
                Some(Number::integer(sign * 9))
            );
            interval.lower_open = false;
            interval.upper_open = false;
            assert_eq!(settle_interval(&interval, 0).unwrap(), None);
            interval = Interval {
                lower: Number {
                    coefficient: if sign > 0 { 91 } else { -99 }.into(),
                    scale: 1,
                },
                upper: Number {
                    coefficient: if sign > 0 { 99 } else { -91 }.into(),
                    scale: 1,
                },
                lower_open: true,
                upper_open: true,
            };
            assert_eq!(
                settle_interval(&interval, 0).unwrap(),
                Some(Number::integer(sign * 9))
            );
        }
    }
}
