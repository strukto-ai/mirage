use num_bigint::BigInt;
use num_traits::{One, Zero};

use super::common::{
    BinaryOp, Builtin, GlobalScale, InputBase, MathFunction, NumericError, OutputBase, Warning,
};
use super::math::math;
use super::numbers::{Number, binary, builtin, power_ten, read_literal, rescale};
use super::render::render_number;

fn scale(value: u32) -> GlobalScale {
    GlobalScale::new(value).unwrap()
}
fn number(coefficient: i64, scale: u32) -> Number {
    Number {
        coefficient: coefficient.into(),
        scale,
    }
}
fn decimal(text: &str) -> Number {
    if let Some(unsigned) = text.strip_prefix('-') {
        return decimal(unsigned).negated();
    }
    read_literal(text, InputBase::new(10).unwrap()).unwrap()
}
fn display(number: &Number) -> String {
    render_number(number, OutputBase::new(10).unwrap()).unwrap()
}

#[test]
fn exact_power_preserves_original_result_scale() {
    for (base, exponent, expected) in [
        ("1.0", "1000000000000", "1.000"),
        ("-1.00", "1000000000001", "-1.000"),
        ("0.00", "1000000000000", "0"),
        ("0", "0", "1"),
        ("1.0", "-1000000000000", "1.000"),
        ("-1.00", "-1000000000001", "-1.000"),
        (".1", "1000000000000", "0"),
        (".10", "-2", "100.000"),
        ("1.2", "3", "1.728"),
        ("1.2", "-3", ".578"),
        ("-1.20", "-3", "-.578"),
    ] {
        let result = binary(
            BinaryOp::Pow,
            &decimal(base),
            &decimal(exponent),
            scale(3),
            &mut Vec::new(),
        )
        .unwrap();
        assert_eq!(display(&result), expected, "{base}^{exponent}");
    }
}

#[test]
fn powers_refuse_before_excessive_allocation() {
    for (base, exponent) in [
        ("2", "1000000".to_owned()),
        ("2", "-1000000".to_owned()),
        ("2", format!("1{}", "0".repeat(100))),
        ("2", format!("-1{}", "0".repeat(100))),
        (".1", "-10000000000000000000000000000000000".to_owned()),
    ] {
        assert_eq!(
            binary(
                BinaryOp::Pow,
                &decimal(base),
                &decimal(&exponent),
                scale(0),
                &mut Vec::new()
            ),
            Err(NumericError::ArithmeticLimit)
        );
    }
    let huge = Number {
        coefficient: BigInt::one() << 32768usize,
        scale: 0,
    };
    assert_eq!(
        binary(BinaryOp::Multiply, &huge, &huge, scale(0), &mut Vec::new()),
        Err(NumericError::ArithmeticLimit)
    );
    assert_eq!(rescale(&huge, 16000), Err(NumericError::ArithmeticLimit));
    assert_eq!(power_ten(65536), Err(NumericError::ArithmeticLimit));
    assert_eq!(power_ten(0).unwrap(), BigInt::one());
    assert_eq!(rescale(&number(1, 16000), 0).unwrap(), Number::integer(0));
}

#[test]
fn large_exact_literals_and_base_conversion_stay_bounded() {
    let large = decimal(&format!("1{}", "0".repeat(5000)));
    assert_eq!(
        builtin(Builtin::Length, &large, scale(0)).unwrap(),
        Number::integer(5001)
    );
    let fraction = decimal(&format!(".{}1", "0".repeat(15999)));
    assert_eq!(fraction, number(1, 16000));
    assert_eq!(
        read_literal(&"F".repeat(16000), InputBase::new(16).unwrap())
            .unwrap()
            .coefficient
            .bits(),
        64000
    );
    for text in ["1".repeat(16001), format!(".{}1", "0".repeat(16000))] {
        assert_eq!(
            read_literal(&text, InputBase::new(10).unwrap()),
            Err(NumericError::ArithmeticLimit)
        );
    }
    assert_eq!(
        read_literal(
            &format!(".{}", "F".repeat(16000)),
            InputBase::new(16).unwrap()
        ),
        Err(NumericError::ArithmeticLimit)
    );
}

#[test]
fn temporary_product_scale_may_exceed_retained_scale_limit() {
    let arg = number(1, 16000);
    assert_eq!(
        binary(BinaryOp::Multiply, &arg, &arg, scale(0), &mut Vec::new()).unwrap(),
        number(0, 16000)
    );
    assert_eq!(rescale(&number(0, 32000), 16000).unwrap(), number(0, 16000));
    assert_eq!(
        rescale(&number(0, 16384), 16384),
        Err(NumericError::ArithmeticLimit)
    );
}

#[test]
fn remainder_scale_growth_obeys_the_retained_limit() {
    let mut value = decimal(".1");
    let mut refused_at = None;
    for index in 1..=200 {
        let divisor = binary(
            BinaryOp::Multiply,
            &Number::integer(3),
            &value,
            scale(100),
            &mut Vec::new(),
        )
        .unwrap();
        match binary(
            BinaryOp::Remainder,
            &value,
            &divisor,
            scale(100),
            &mut Vec::new(),
        ) {
            Ok(next) => value = next,
            Err(error) => {
                assert_eq!(error, NumericError::ArithmeticLimit);
                refused_at = Some(index);
                break;
            }
        }
    }
    assert_eq!(refused_at, Some(164));
    assert_eq!(value, number(1, 16301));
}

#[test]
fn exponent_warning_survives_numeric_refusal() {
    let mut warnings = Vec::new();
    assert_eq!(
        binary(
            BinaryOp::Pow,
            &Number::integer(0),
            &decimal("-1.5"),
            scale(0),
            &mut warnings
        ),
        Err(NumericError::NegativePowerOfZero)
    );
    assert_eq!(warnings, [Warning::NonzeroExponentScale]);
    assert_eq!(
        binary(
            BinaryOp::Divide,
            &Number::integer(1),
            &Number::integer(0),
            scale(0),
            &mut Vec::new()
        ),
        Err(NumericError::DivideByZero)
    );
    assert_eq!(
        binary(
            BinaryOp::Remainder,
            &Number::integer(1),
            &Number::integer(0),
            scale(0),
            &mut Vec::new()
        ),
        Err(NumericError::ModuloByZero)
    );
    assert_eq!(
        builtin(Builtin::Sqrt, &Number::integer(-1), scale(0)),
        Err(NumericError::NegativeSquareRoot)
    );
}

#[test]
fn builtins_preserve_exact_scale_and_square_roots() {
    for (text, target, expected) in [
        ("0.000", 100, "0"),
        ("1.000", 100, "1"),
        ("2", 20, "1.41421356237309504880"),
        (".0004", 0, ".0200"),
    ] {
        assert_eq!(
            display(&builtin(Builtin::Sqrt, &decimal(text), scale(target)).unwrap()),
            expected
        );
    }
    assert_eq!(
        builtin(Builtin::Scale, &decimal(".0010"), scale(0)).unwrap(),
        Number::integer(4)
    );
    assert_eq!(
        builtin(Builtin::Length, &decimal(".0010"), scale(0)).unwrap(),
        Number::integer(4)
    );
    assert_eq!(
        binary(
            BinaryOp::Add,
            &decimal(".01"),
            &decimal(".010"),
            scale(0),
            &mut Vec::new()
        )
        .unwrap(),
        number(20, 3)
    );
    assert_eq!(
        binary(
            BinaryOp::Subtract,
            &decimal(".01"),
            &decimal(".010"),
            scale(0),
            &mut Vec::new()
        )
        .unwrap(),
        number(0, 3)
    );
}

#[test]
fn small_math_corrections_truncate_at_every_supported_test_scale() {
    for target in [0, 1, 20, 100] {
        for sign in [-1, 1] {
            for function in [MathFunction::Sin, MathFunction::Atan, MathFunction::Cos] {
                let result = math(function, &number(sign, target), scale(target)).unwrap();
                let expected = if function == MathFunction::Cos && target != 0 {
                    format!(".{}", "9".repeat(target as usize))
                } else {
                    "0".into()
                };
                assert_eq!(
                    display(&result),
                    expected,
                    "{function:?} {sign} scale {target}"
                );
            }
        }
    }
}

#[test]
fn math_quantum_boundaries_match_both_previous_hosts() {
    for target in [0, 1, 20, 100] {
        for sign in [-1, 1] {
            for (coefficient, extra) in [(0, 0), (1, 1), (999, 3), (1001, 3), (2, 0)] {
                let arg = number(sign * coefficient, target + extra);
                for function in [MathFunction::Sin, MathFunction::Atan, MathFunction::Cos] {
                    let expected = if coefficient == 0 {
                        if function == MathFunction::Cos {
                            power_ten(target).unwrap()
                        } else {
                            BigInt::zero()
                        }
                    } else if function == MathFunction::Cos {
                        if target == 0 {
                            BigInt::zero()
                        } else {
                            power_ten(target).unwrap() - 1u8
                        }
                    } else if coefficient == 2 {
                        BigInt::from(
                            sign * if target == 0 {
                                i64::from(function == MathFunction::Atan)
                            } else {
                                1
                            },
                        )
                    } else if coefficient == 1001 && target >= 20 {
                        BigInt::from(sign)
                    } else {
                        BigInt::zero()
                    };
                    assert_eq!(
                        math(function, &arg, scale(target)).unwrap().coefficient,
                        expected,
                        "{function:?} {arg:?} target {target}"
                    );
                }
            }
        }
        let expected = if target == 0 {
            BigInt::zero()
        } else {
            power_ten(target).unwrap() - 1u8
        };
        assert_eq!(
            math(MathFunction::Exp, &number(-1, target), scale(target))
                .unwrap()
                .coefficient,
            expected
        );
        let arg = Number {
            coefficient: power_ten(target).unwrap() + 1u8,
            scale: target,
        };
        assert!(
            math(MathFunction::Log, &arg, scale(target))
                .unwrap()
                .is_zero()
        );
    }
}

#[test]
fn identities_and_tiny_values_precede_working_precision_planning() {
    for function in [MathFunction::Sin, MathFunction::Cos, MathFunction::Atan] {
        let expected = if function == MathFunction::Cos {
            power_ten(100).unwrap() - 1u8
        } else {
            BigInt::zero()
        };
        assert_eq!(
            math(function, &number(1, 16000), scale(100))
                .unwrap()
                .coefficient,
            expected
        );
    }
    for function in [
        MathFunction::Sin,
        MathFunction::Cos,
        MathFunction::Atan,
        MathFunction::Log,
        MathFunction::Exp,
    ] {
        let arg = if function == MathFunction::Log {
            Number {
                coefficient: power_ten(5000).unwrap(),
                scale: 5000,
            }
        } else {
            number(0, 16000)
        };
        let expected = if matches!(function, MathFunction::Cos | MathFunction::Exp) {
            power_ten(100).unwrap()
        } else {
            BigInt::zero()
        };
        assert_eq!(
            math(function, &arg, scale(100)).unwrap().coefficient,
            expected
        );
    }
}

#[test]
fn math_working_precision_is_bounded() {
    for (function, coefficient_scale, arg_scale) in [
        (MathFunction::Sin, 1499, 1500),
        (MathFunction::Cos, 2099, 2100),
        (MathFunction::Log, 2300, 2300),
        (MathFunction::Exp, 5000, 0),
    ] {
        let coefficient =
            power_ten(coefficient_scale).unwrap() + u8::from(function != MathFunction::Exp);
        assert_eq!(
            math(
                function,
                &Number {
                    coefficient,
                    scale: arg_scale
                },
                scale(100)
            ),
            Err(NumericError::ArithmeticLimit)
        );
    }
}

#[test]
fn logarithm_preserves_small_input_precision() {
    for (coefficient, arg_scale, expected) in [
        (
            1,
            20,
            "-460517018598809136803598290936872841520220297725754595206665580193514521935470496047199441017919659668",
        ),
        (
            1,
            40,
            "-921034037197618273607196581873745683040440595451509190413331160387029043870940992094398882035839319336",
        ),
        (
            46511,
            48,
            "-997766403409746616629445553439376448559279753222656842613015918479959801357470111011200235139937215531",
        ),
    ] {
        assert_eq!(
            math(
                MathFunction::Log,
                &number(coefficient, arg_scale),
                scale(100)
            )
            .unwrap()
            .coefficient
            .to_string(),
            expected
        );
    }
}

#[test]
fn radix_rendering_preserves_character_and_grouped_digit_forms() {
    for (input, base, expected) in [
        ("255", 16, "FF"),
        ("16", 17, " 16"),
        (".5", 2, ".1000"),
        ("-10.5", 16, "-A.8"),
        (".5", 100, ".50"),
    ] {
        assert_eq!(
            render_number(&decimal(input), OutputBase::new(base).unwrap()).unwrap(),
            expected
        );
    }
}

#[test]
fn large_exp_preserves_all_result_digits() {
    assert_eq!(
        math(MathFunction::Exp, &Number::integer(1000), scale(100))
            .unwrap()
            .coefficient
            .to_string(),
        "1970071114017046993888879352243323125316937985323845789952802991385063850782441193474978076563026889930963817987520226935982981730544612899232627836601528252323205351695845667561922715676027880714224668263140068551685086534979416603160453678179380929052997285801328699458564702865343759004565643555891562204223202605188261122886383583722487247252145061504188819374941008712642322484363157605603774399306239597058441895090500470742175682267578083308102070668818911968536445918206584929433885943734416066833995904928281627706135987730904"
    );
}
