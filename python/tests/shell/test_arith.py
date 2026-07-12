import pytest

from mirage.shell.arith import evaluate_arith
from mirage.shell.errors import ArithError


def test_basic_precedence():
    assert evaluate_arith("1 + 2 * 3", {})[0] == 7
    assert evaluate_arith("(1 + 2) * 3", {})[0] == 9
    assert evaluate_arith("2 ** 3 ** 2", {})[0] == 512


def test_trunc_division_and_mod_match_c():
    assert evaluate_arith("-7 / 2", {})[0] == -3
    assert evaluate_arith("7 / -2", {})[0] == -3
    assert evaluate_arith("-7 % 2", {})[0] == -1
    assert evaluate_arith("7 % -2", {})[0] == 1


def test_literals():
    assert evaluate_arith("0x10", {})[0] == 16
    assert evaluate_arith("010", {})[0] == 8
    with pytest.raises(ArithError):
        evaluate_arith("08", {})


def test_assignment_and_updates():
    value, updates = evaluate_arith("y = 3, y + 2", {})
    assert value == 5
    assert updates == {"y": "3"}
    value, updates = evaluate_arith("v += 9", {"v": "1"})
    assert (value, updates) == (10, {"v": "10"})


def test_increment_decrement():
    value, updates = evaluate_arith("i++", {})
    assert (value, updates) == (0, {"i": "1"})
    value, updates = evaluate_arith("++i", {"i": "1"})
    assert (value, updates) == (2, {"i": "2"})
    value, updates = evaluate_arith("i--", {"i": "5"})
    assert (value, updates) == (5, {"i": "4"})


def test_short_circuit_skips_side_effects():
    value, updates = evaluate_arith("0 && (q = 7)", {})
    assert (value, updates) == (0, {})
    value, updates = evaluate_arith("1 || (q = 7)", {})
    assert (value, updates) == (1, {})


def test_ternary_evaluates_taken_arm_only():
    value, updates = evaluate_arith("1 ? (w = 4) : (w = 9)", {})
    assert (value, updates) == (4, {"w": "4"})
    assert evaluate_arith("5 > 3 ? 10 : 20", {})[0] == 10


def test_variables_resolve_recursively():
    assert evaluate_arith("x + 1", {})[0] == 1
    assert evaluate_arith("s * 2", {"s": "1+2"})[0] == 6
    assert evaluate_arith("z + 1", {"z": ""})[0] == 1


def test_logical_and_comparison_results_are_zero_or_one():
    assert evaluate_arith("3 && 4", {})[0] == 1
    assert evaluate_arith("!5", {})[0] == 0
    assert evaluate_arith("2 == 2", {})[0] == 1
    assert evaluate_arith("2 != 2", {})[0] == 0


def test_bitwise_and_shifts():
    assert evaluate_arith("6 & 3", {})[0] == 2
    assert evaluate_arith("6 | 3", {})[0] == 7
    assert evaluate_arith("6 ^ 3", {})[0] == 5
    assert evaluate_arith("~0", {})[0] == -1
    assert evaluate_arith("1 << 4", {})[0] == 16
    assert evaluate_arith("-16 >> 2", {})[0] == -4


def test_sixty_four_bit_wrap():
    assert evaluate_arith("(1 << 63) - 1 + 1", {})[0] == -(1 << 63)


def test_errors():
    with pytest.raises(ArithError):
        evaluate_arith("1 / 0", {})
    with pytest.raises(ArithError):
        evaluate_arith("2 ** -1", {})
    with pytest.raises(ArithError):
        evaluate_arith("1 +", {})
    with pytest.raises(ArithError):
        evaluate_arith("@", {})
    with pytest.raises(ArithError):
        evaluate_arith("r + 1", {"r": "r + 1"})


def test_empty_expression_is_zero():
    assert evaluate_arith("", {}) == (0, {})
