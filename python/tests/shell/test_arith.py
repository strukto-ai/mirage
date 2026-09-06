import pytest

from mirage.shell.arith import evaluate_arith
from mirage.shell.errors import ArithError
from mirage.shell.types import ArithResult, ElementOps


def test_basic_precedence():
    assert evaluate_arith("1 + 2 * 3", {}).value == 7
    assert evaluate_arith("(1 + 2) * 3", {}).value == 9
    assert evaluate_arith("2 ** 3 ** 2", {}).value == 512


def test_trunc_division_and_mod_match_c():
    assert evaluate_arith("-7 / 2", {}).value == -3
    assert evaluate_arith("7 / -2", {}).value == -3
    assert evaluate_arith("-7 % 2", {}).value == -1
    assert evaluate_arith("7 % -2", {}).value == 1


def test_literals():
    assert evaluate_arith("0x10", {}).value == 16
    assert evaluate_arith("010", {}).value == 8
    with pytest.raises(ArithError):
        evaluate_arith("08", {})


def _writes(result: ArithResult) -> list[tuple[str, str | None, str]]:
    return [(w.name, w.key, w.value) for w in result.writes]


def test_assignment_and_updates():
    result = evaluate_arith("y = 3, y + 2", {})
    assert result.value == 5
    assert _writes(result) == [("y", None, "3")]
    result = evaluate_arith("v += 9", {"v": "1"})
    assert (result.value, _writes(result)) == (10, [("v", None, "10")])


def test_increment_decrement():
    result = evaluate_arith("i++", {})
    assert (result.value, _writes(result)) == (0, [("i", None, "1")])
    result = evaluate_arith("++i", {"i": "1"})
    assert (result.value, _writes(result)) == (2, [("i", None, "2")])
    result = evaluate_arith("i--", {"i": "5"})
    assert (result.value, _writes(result)) == (5, [("i", None, "4")])


def test_short_circuit_skips_side_effects():
    result = evaluate_arith("0 && (q = 7)", {})
    assert (result.value, result.writes) == (0, ())
    result = evaluate_arith("1 || (q = 7)", {})
    assert (result.value, result.writes) == (1, ())


def test_ternary_evaluates_taken_arm_only():
    result = evaluate_arith("1 ? (w = 4) : (w = 9)", {})
    assert (result.value, _writes(result)) == (4, [("w", None, "4")])
    assert evaluate_arith("5 > 3 ? 10 : 20", {}).value == 10


def test_variables_resolve_recursively():
    assert evaluate_arith("x + 1", {}).value == 1
    assert evaluate_arith("s * 2", {"s": "1+2"}).value == 6
    assert evaluate_arith("z + 1", {"z": ""}).value == 1


def test_logical_and_comparison_results_are_zero_or_one():
    assert evaluate_arith("3 && 4", {}).value == 1
    assert evaluate_arith("!5", {}).value == 0
    assert evaluate_arith("2 == 2", {}).value == 1
    assert evaluate_arith("2 != 2", {}).value == 0


def test_bitwise_and_shifts():
    assert evaluate_arith("6 & 3", {}).value == 2
    assert evaluate_arith("6 | 3", {}).value == 7
    assert evaluate_arith("6 ^ 3", {}).value == 5
    assert evaluate_arith("~0", {}).value == -1
    assert evaluate_arith("1 << 4", {}).value == 16
    assert evaluate_arith("-16 >> 2", {}).value == -4


def test_sixty_four_bit_wrap():
    assert evaluate_arith("(1 << 63) - 1 + 1", {}).value == -(1 << 63)


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
    result = evaluate_arith("", {})
    assert (result.value, result.writes) == (0, ())


def test_base_literals():
    assert evaluate_arith("16#ff", {}).value == 255
    assert evaluate_arith("2#101", {}).value == 5
    assert evaluate_arith("8#17", {}).value == 15
    assert evaluate_arith("36#z", {}).value == 35
    assert evaluate_arith("64#_", {}).value == 63
    assert evaluate_arith("16#a + 2#10", {}).value == 12


def test_base_literal_errors():
    with pytest.raises(ArithError):
        evaluate_arith("2#9", {})
    with pytest.raises(ArithError):
        evaluate_arith("65#1", {})


def _fake_elements():
    store = {("m", "a"): "7", ("arr", "1"): "20"}
    cell = []

    def resolve(name, subscript, env):
        if name == "m":
            return subscript.strip("\"'")
        result = evaluate_arith(subscript, env, elements=cell[0])
        return str(result.value)

    def read(name, key):
        return store.get((name, key))

    ops = ElementOps(resolve=resolve, read=read, is_assoc=lambda n: n == "m")
    cell.append(ops)
    return ops


def test_element_reads_and_writes():
    ops = _fake_elements()
    result = evaluate_arith("m[a] + arr[0+1]", {}, elements=ops)
    assert result.value == 27
    result = evaluate_arith("m[k] = 5, m[k] + 1", {}, elements=ops)
    assert result.value == 6
    assert _writes(result) == [("m", "k", "5")]


def test_writes_keep_evaluation_order_across_kinds():
    # A bare name aliases element 0, so `a[0]=1, a=2` must land a=2
    # last and `a=2, a[0]=1` must land a[0]=1 last; a target written
    # twice is recorded once, at its last write.
    ops = _fake_elements()
    result = evaluate_arith("arr[0] = 1, arr = 2", {}, elements=ops)
    assert _writes(result) == [("arr", "0", "1"), ("arr", None, "2")]
    result = evaluate_arith("arr = 2, arr[0] = 1", {}, elements=ops)
    assert _writes(result) == [("arr", None, "2"), ("arr", "0", "1")]
    result = evaluate_arith("arr = 1, arr[0] = 2, arr = 3", {}, elements=ops)
    assert _writes(result) == [("arr", "0", "2"), ("arr", None, "3")]


def test_element_incr_decr_and_quoted_key():
    ops = _fake_elements()
    result = evaluate_arith("m[a]++", {}, elements=ops)
    assert result.value == 7
    assert result.writes[0].value == "8"
    result = evaluate_arith('m["a"] - 1', {}, elements=ops)
    assert result.value == 6


def test_element_without_ops_is_syntax_error():
    with pytest.raises(ArithError):
        evaluate_arith("a[0]", {})


def test_element_nested_brackets_tokenize():
    ops = _fake_elements()
    result = evaluate_arith("arr[arr[1] - 19]", {}, elements=ops)
    assert result.value == 20


def test_dynamic_reader_is_asked_first_and_told_of_every_write():
    # A dynamic name's reader answers before the pending assignments and
    # the environment, and hears each scalar assignment as it is made,
    # nested evaluations included, so it can act on it at once.
    events: list[tuple[str, str]] = []

    def read(name: str) -> str | None:
        return "7" if name == "D" else None

    def wrote(name: str, value: str) -> None:
        events.append((name, value))

    result = evaluate_arith("D=42, x=D, y", {"y": "D+1"},
                            read_var=read,
                            wrote_var=wrote)
    assert result.value == 8
    assert events == [("D", "42"), ("x", "7")]
    assert [(w.name, w.value) for w in result.writes] == [("D", "42"),
                                                          ("x", "7")]


def test_compound_assignment_reads_the_target_before_the_right_side():
    # bash 5.2: `RANDOM=42, RANDOM-=RANDOM` is the first draw minus the
    # second, so a dynamic name is read for the target first.
    draws = iter(["17772", "26794"])
    result = evaluate_arith("D-=D", {}, read_var=lambda n: next(draws))
    assert result.value == -9022


def test_a_variable_evaluated_as_an_expression_shares_the_record():
    # bash: `x='y=5'; $((x))` leaves y at 5, and the nested read sees the
    # pending updates of the expression around it.
    result = evaluate_arith("x, y + 1", {"x": "y=5"})
    assert result.value == 6
    assert [(w.name, w.value) for w in result.writes] == [("y", "5")]
    result = evaluate_arith("y=1, x, y", {"x": "y+=1"})
    assert result.value == 2
    assert [(w.name, w.value) for w in result.writes] == [("y", "2")]


def test_an_indexed_subscript_evaluates_in_the_expression_record():
    # bash: `a[5]=7; $((a[x=5] + x))` is 12 and leaves x at 5; the
    # subscript's assignment is seen by the rest of the expression and
    # recorded with it.
    result = evaluate_arith("arr[x=1] + x", {}, elements=_fake_elements())
    assert result.value == 21
    assert [(w.name, w.key, w.value)
            for w in result.writes] == [("x", None, "1")]
    # An associative subscript stays a key, never an expression.
    result = evaluate_arith("m[a] + 1", {}, elements=_fake_elements())
    assert result.value == 8 and result.writes == ()
