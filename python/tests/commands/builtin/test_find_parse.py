import re
import time

import pytest

from mirage.commands.builtin.find_eval import (And, Empty, Name, Not, Or, Path,
                                               TrueNode, Type, eval_predicate)
from mirage.commands.builtin.find_parse import parse_find_expression
from mirage.commands.errors import FindParseError


def test_parse_not_name():
    expr = parse_find_expression(["-not", "-name", "*.txt"])
    assert expr.tree == Not(Name("*.txt"))


def test_parse_bang_name():
    expr = parse_find_expression(["!", "-name", "*.txt"])
    assert expr.tree == Not(Name("*.txt"))


def test_parse_or_names():
    expr = parse_find_expression(["-name", "a", "-o", "-name", "b"])
    assert expr.tree == Or([Name("a"), Name("b")])


def test_parse_implicit_and():
    expr = parse_find_expression(["-type", "d", "-name", "a"])
    assert expr.tree == And([Type("d"), Name("a")])


def test_parse_explicit_and():
    expr = parse_find_expression(["-type", "d", "-a", "-not", "-empty"])
    assert expr.tree == And([Type("d"), Not(Empty())])


def test_or_lower_precedence_than_and():
    expr = parse_find_expression(
        ["-name", "a", "-o", "-name", "b", "-name", "c"])
    assert expr.tree == Or([Name("a"), And([Name("b"), Name("c")])])


def test_grouping():
    expr = parse_find_expression(
        ["(", "-name", "a", "-o", "-name", "b", ")", "-type", "f"])
    assert expr.tree == And([Or([Name("a"), Name("b")]), Type("f")])


def test_iname_path_empty():
    assert parse_find_expression(["-iname", "*.TXT"]).tree == Name("*.TXT",
                                                                   icase=True)
    assert parse_find_expression(["-path", "*/x/*"]).tree == Path("*/x/*")
    assert parse_find_expression(["-empty"]).tree == Empty()


def test_globals_extracted_as_truenode():
    expr = parse_find_expression(
        ["-maxdepth", "2", "-mindepth", "1", "-name", "x"])
    assert expr.maxdepth == 2
    assert expr.mindepth == 1
    assert eval_predicate(expr.tree, _ent(name="x.foo")) is False
    assert eval_predicate(expr.tree, _ent(name="x")) is True


def test_depth_first_is_depth_or_delete():
    assert parse_find_expression(["-depth"]).depth_first is True
    assert parse_find_expression(["-delete"]).depth_first is True
    assert parse_find_expression(["-print"]).depth_first is False


def test_size_extracted_global():
    expr = parse_find_expression(["-size", "+50c"])
    assert expr.min_size == 51
    assert expr.max_size is None


def test_size_bounds_follow_gnu_strictness():
    expr = parse_find_expression(["-size", "+0c"])
    assert (expr.min_size, expr.max_size) == (1, None)
    expr = parse_find_expression(["-size", "-2c"])
    assert (expr.min_size, expr.max_size) == (None, 1)
    expr = parse_find_expression(["-size", "2c"])
    assert (expr.min_size, expr.max_size) == (2, 2)


def test_repeated_mtime_windows_merge_to_union():
    # `-mtime +0 -o -mtime -1` is a tautology in GNU; the flat window
    # must impose no bounds rather than keep only the last predicate.
    expr = parse_find_expression(["-mtime", "+0", "-o", "-mtime", "-1"])
    assert (expr.mtime_min, expr.mtime_max) == (None, None)
    expr = parse_find_expression(["-mtime", "-1"])
    assert expr.mtime_min is not None
    assert expr.mtime_max is None
    expr = parse_find_expression(["-mtime", "1", "-o", "-mtime", "3"])
    assert expr.mtime_min is not None
    assert expr.mtime_max is not None
    assert expr.mtime_max - expr.mtime_min == pytest.approx(3 * 86400, abs=1)


def test_size_rounds_up_to_unit():
    # GNU -size -1k keeps only empty files; 1k keeps 1..1024 bytes;
    # +1k excludes a file of exactly 1024 bytes.
    expr = parse_find_expression(["-size", "-1k"])
    assert (expr.min_size, expr.max_size) == (None, 0)
    expr = parse_find_expression(["-size", "1k"])
    assert (expr.min_size, expr.max_size) == (1, 1024)
    expr = parse_find_expression(["-size", "+1k"])
    assert (expr.min_size, expr.max_size) == (1025, None)


def test_empty_expression_is_true():
    assert parse_find_expression([]).tree == TrueNode()


def test_unknown_predicate_raises():
    with pytest.raises(FindParseError):
        parse_find_expression(["-bogus"])
    with pytest.raises(FindParseError):
        parse_find_expression(["-regex", ".*"])


def test_unbalanced_paren_raises():
    with pytest.raises(FindParseError):
        parse_find_expression(["(", "-name", "a"])


@pytest.mark.parametrize("tokens", [
    ["-maxdepth", "abc"],
    ["-maxdepth", "12abc"],
    ["-mindepth", "x"],
    ["-mindepth", "2x"],
    ["-size", ""],
    ["-size", "abc"],
    ["-size", "12ab"],
    ["-mtime", ""],
    ["-mtime", "3x"],
])
def test_invalid_numeric_arg_raises_find_parse_error(tokens):
    with pytest.raises(FindParseError):
        parse_find_expression(tokens)


def _ent(name="a", kind="f"):
    from mirage.commands.builtin.find_eval import FindEntry
    return FindEntry(key="/" + name, name=name, kind=kind, depth=1)


@pytest.mark.parametrize("tokens", [
    ["-boguspredicate"],
    ["-regex", ".*deep.*"],
    ["-perm", "644"],
    ["-prune"],
    ["-nam", "*.txt"],
])
def test_unsupported_predicate_raises(tokens):
    with pytest.raises(FindParseError):
        parse_find_expression(tokens)


@pytest.mark.parametrize("ftype", ["b", "c", "d", "p", "f", "l", "s"])
def test_valid_type_letters_accepted(ftype):
    assert parse_find_expression(["-type", ftype]).tree == Type(ftype)


@pytest.mark.parametrize("ftype", ["x", "z", "dir"])
def test_invalid_type_letter_raises(ftype):
    with pytest.raises(FindParseError):
        parse_find_expression(["-type", ftype])


def test_deeply_nested_expression_raises_not_recursion_error():
    tokens = ["("] * 500 + ["-name", "x"] + [")"] * 500
    with pytest.raises(FindParseError):
        parse_find_expression(tokens)


def test_deeply_nested_not_raises_not_recursion_error():
    tokens = ["-not"] * 500 + ["-name", "x"]
    with pytest.raises(FindParseError):
        parse_find_expression(tokens)


@pytest.mark.parametrize("tokens,op", [
    (["!"], "!"),
    (["-not"], "-not"),
    (["-name", "a", "!"], "!"),
    (["-name", "a", "-not"], "-not"),
    (["!", "!"], "!"),
    (["-name", "a", "-a"], "-a"),
    (["-name", "a", "-and"], "-and"),
    (["-name", "a", "-o"], "-o"),
    (["-name", "a", "-or"], "-or"),
])
def test_operator_with_nothing_after_it_names_the_operator(tokens, op):
    # GNU findutils 4.10.0, pinned on debian:stable-slim. Reachable only
    # since `!` became an expression token: a dangling `!` used to be a
    # start point, so find printed the whole tree and blamed a missing
    # path instead.
    with pytest.raises(FindParseError,
                       match=f"^find: expected an expression after '{op}'$"):
        parse_find_expression(tokens)


@pytest.mark.parametrize("tokens,op", [
    (["(", "!", ")"], "!"),
    (["(", "-not", ")"], "-not"),
    (["(", "-name", "a", "-a", ")"], "-a"),
    (["(", "-name", "a", "-and", ")"], "-and"),
    (["(", "-name", "a", "-o", ")"], "-o"),
    (["(", "-name", "a", "-or", ")"], "-or"),
])
def test_operator_closed_by_paren_names_both(tokens, op):
    with pytest.raises(
            FindParseError,
            match=f"^find: expected an expression between '{op}' and '\\)'$"):
        parse_find_expression(tokens)


def test_printf_stores_format():
    expr = parse_find_expression(["-printf", "%p\\n"])
    assert expr.printf == "%p\\n"


def test_printf_missing_argument():
    with pytest.raises(FindParseError, match="missing argument to '-printf'"):
        parse_find_expression(["-printf"])


def test_printf_combines_with_tests():
    expr = parse_find_expression(["-name", "*.txt", "-printf", "%f\\n"])
    assert expr.printf == "%f\\n"


def test_exec_per_match_and_batched():
    from mirage.commands.builtin.types import ExecAction
    expr = parse_find_expression(
        ["-name", "*.txt", "-exec", "echo", "got", "{}", ";"])
    assert expr.execs == [ExecAction(("echo", "got", "{}"), batch=False)]
    # The action is a TrueNode in the tree, as every action is.
    assert expr.tree == And([Name("*.txt"), TrueNode()])
    expr = parse_find_expression(["-exec", "echo", "{}", "+"])
    assert expr.execs == [ExecAction(("echo", "{}"), batch=True)]


@pytest.mark.parametrize("tokens,message", [
    (["-exec"], "find: missing argument to `-exec'"),
    (["-exec", ";"], "find: missing argument to `-exec'"),
    (["-exec", "echo", "{}"], "find: missing argument to `-exec'"),
    (["-exec", "echo", "{}", "x", "+"], "find: missing argument to `-exec'"),
    (["-exec", "echo", "x{}y", "+"
      ], "find: In '-exec ... {} +' the '{}' must appear by itself, but you "
     "specified 'x{}y'"),
    (["-exec", "echo", "{}", "{}", "+"
      ], "find: Only one instance of {} is supported with -exec ... +"),
    (["-name", "a", "-o", "-exec", "echo", "{}", ";"
      ], "find: -exec is supported only in a top-level -a chain, not under "
     "-o, ! or parentheses"),
    (["!", "-exec", "false", ";"
      ], "find: -exec is supported only in a top-level -a chain, not under "
     "-o, ! or parentheses"),
    (["(", "-exec", "false", ";", ")"
      ], "find: -exec is supported only in a top-level -a chain, not under "
     "-o, ! or parentheses"),
    (["-exec", "false", "{}", ";", "-o", "-print"
      ], "find: -exec is supported only in a top-level -a chain, not under "
     "-o, ! or parentheses"),
    (["-exec", "echo", "{}", ";", "-printf", "%p"
      ], "find: -exec cannot be combined with -printf"),
    (["-newermt", "nope"],
     "find: I cannot figure out how to interpret 'nope' as a date or time"),
    (["-newer"], "find: missing argument to '-newer'"),
])
def test_exec_and_newer_refusals(tokens, message):
    with pytest.raises(FindParseError, match=re.escape(message)):
        parse_find_expression(tokens)


def test_exec_allowed_after_a_parenthesized_or():
    expr = parse_find_expression([
        "(", "-name", "a", "-o", "-name", "b", ")", "-exec", "echo", "{}", ";"
    ])
    assert len(expr.execs) == 1
    assert expr.tree == And([Or([Name("a"), Name("b")]), TrueNode()])


def test_actions_are_recorded_in_order():
    from mirage.commands.builtin.types import ExecAction, RowAction
    expr = parse_find_expression(
        ["-delete", "-exec", "echo", "{}", ";", "-print0", "-ls", "-print"])
    assert expr.actions == [
        RowAction("delete"),
        ExecAction(("echo", "{}")),
        RowAction("print0"),
        RowAction("ls"),
        RowAction("print"),
    ]


def test_newer_records_the_reference_and_newermt_a_strict_bound():
    from mirage.commands.builtin.find_parse import strictly_after
    expr = parse_find_expression(["-newer", "d/a.txt", "-name", "*.txt"])
    assert expr.newer == ["d/a.txt"]
    assert expr.mtime_min is None
    expr = parse_find_expression(["-newermt", "2020-01-01"])
    assert expr.mtime_min == strictly_after(1577836800.0)
    assert expr.mtime_min > 1577836800.0
    assert expr.mtime_max is None


def test_exec_spans_cover_the_action_words():
    from mirage.commands.builtin.find_parse import exec_spans
    argv = [
        "/d", "-exec", "echo", "{}", ";", "-name", "x", "-exec", "a", "{}",
        "+", "-print"
    ]
    assert exec_spans(argv) == [(1, 4), (7, 10)]
    assert exec_spans(["-exec", "a", "b"]) == [(0, 2)]
    assert exec_spans(["-name", "x"]) == []


@pytest.mark.parametrize("operand,seconds", [('yesterday', 86400),
                                             ('24 hours ago', 86400),
                                             ('now', 0)])
def test_newermt_accepts_relative_dates(operand, seconds):
    before = time.time()
    expr = parse_find_expression(['-newermt', operand])
    assert before - seconds <= expr.mtime_min <= time.time() - seconds


def test_newermt_accepts_an_epoch_timestamp():
    expr = parse_find_expression(['-newermt', '@1700000000'])
    assert 1700000000 < expr.mtime_min < 1700000000.001


@pytest.mark.parametrize('action', [
    ['-exec', 'echo', '{}', ';'],
    ['-exec', 'echo', '{}', '+'],
    ['-print'],
    ['-delete'],
    ['-printf', '%p'],
])
@pytest.mark.parametrize('test', [
    ['-name', '*.txt'],
    ['-type', 'f'],
    ['-size', '+1c'],
    ['-newermt', 'yesterday'],
    ['-newer', 'ref'],
    ['-empty'],
    ['!', '-name', '*.txt'],
    ['(', '-name', '*.txt', ')'],
])
def test_predicate_after_action_is_refused(action, test):
    with pytest.raises(FindParseError,
                       match='tests after actions are not supported'):
        parse_find_expression(action + test)


@pytest.mark.parametrize("action", [
    ["-print"],
    ["-print0"],
    ["-ls"],
    ["-delete"],
    ["-printf", "%p"],
])
@pytest.mark.parametrize("position", ["left", "right", "not", "group"])
def test_row_actions_refuse_detachment_from_the_predicate(action, position):
    expressions = {
        "left": [*action, "-o", "-print"],
        "right": ["-name", "keep", "-o", *action],
        "not": ["!", *action],
        "group": ["(", *action, ")"],
    }
    with pytest.raises(FindParseError, match="supported only in a top-level"):
        parse_find_expression(expressions[position])
    parse_find_expression(
        ["(", "-name", "a", "-o", "-name", "b", ")", *action])


@pytest.mark.parametrize("value", [
    "2026-02-31",
    "2025-02-29",
    "2026-04-31",
    "2026-00-01",
    "2026-13-01",
    "2026-01-00",
    "2026-01-32",
    "2026-02-31T12:00:00Z",
    "2026-02-31 1 day",
    "2026-01-01T24:00:00",
    "2026-01-01T12:60:00",
])
def test_newermt_rejects_invalid_calendar_fields(value):
    with pytest.raises(FindParseError, match="I cannot figure out"):
        parse_find_expression(["-newermt", value])


@pytest.mark.parametrize(
    "tokens, message",
    [(['-newer', 'ref', '-o', '-name', 'keep'
       ], 'find: -newer is supported only in a top-level -a chain, '
      'not under -o, ! or parentheses'),
     (['-name', 'keep', '-o', '-newer', 'ref'
       ], 'find: -newer is supported only in a top-level -a chain, '
      'not under -o, ! or parentheses'),
     (['!', '-newer', 'ref'
       ], 'find: -newer is supported only in a top-level -a chain, '
      'not under -o, ! or parentheses'),
     (['(', '-newer', 'ref', ')'
       ], 'find: -newer is supported only in a top-level -a chain, '
      'not under -o, ! or parentheses'),
     (['-newermt', '2000-01-01', '-o', '-name', 'keep'
       ], 'find: -newermt is supported only in a top-level -a chain, '
      'not under -o, ! or parentheses'),
     (['-name', 'keep', '-o', '-newermt', '2000-01-01'
       ], 'find: -newermt is supported only in a top-level -a chain, '
      'not under -o, ! or parentheses'),
     (['!', '-newermt', '2000-01-01'
       ], 'find: -newermt is supported only in a top-level -a chain, '
      'not under -o, ! or parentheses'),
     (['(', '-newermt', '2000-01-01', ')'
       ], 'find: -newermt is supported only in a top-level -a chain, '
      'not under -o, ! or parentheses'),
     (['-printf', '%p\\n', '-exec', 'true', '{}', ';'
       ], 'find: -exec cannot be combined with -printf'),
     (['-exec', 'true', '{}', ';', '-printf', '%p\\n'
       ], 'find: -exec cannot be combined with -printf'),
     (['-printf', '%p\\n', '-print'
       ], 'find: -printf cannot be combined with other actions'),
     (['-print', '-printf', '%p\\n'
       ], 'find: -printf cannot be combined with other actions'),
     (['-printf', '%p\\n', '-print0'
       ], 'find: -printf cannot be combined with other actions'),
     (['-print0', '-printf', '%p\\n'
       ], 'find: -printf cannot be combined with other actions'),
     (['-printf', '%p\\n', '-ls'
       ], 'find: -printf cannot be combined with other actions'),
     (['-ls', '-printf', '%p\\n'
       ], 'find: -printf cannot be combined with other actions'),
     (['-printf', '%p\\n', '-delete'
       ], 'find: -printf cannot be combined with other actions'),
     (['-delete', '-printf', '%p\\n'
       ], 'find: -printf cannot be combined with other actions'),
     (['-printf', '%p', '-printf', '%f'
       ], 'find: multiple -printf actions are not supported')])
def test_newer_placement_and_mixed_printf_refusals(tokens, message):
    with pytest.raises(FindParseError) as exc:
        parse_find_expression(tokens)
    assert str(exc.value) == message


def test_top_level_windows_intersect_and_or_windows_widen():
    # GNU: every test in the implicit -a chain must hold, so `-newermt a
    # -newermt b` keeps what is newer than both and `-mtime +2 -mtime
    # -1` keeps nothing; under -o the flat window can only widen.
    later = parse_find_expression(["-newermt", "2021-06-01"]).mtime_min
    for order in (["2020-06-01", "2021-06-01"], ["2021-06-01", "2020-06-01"]):
        expr = parse_find_expression(
            ["-newermt", order[0], "-newermt", order[1]])
        assert (expr.mtime_min, expr.mtime_max) == (later, None)
    expr = parse_find_expression(["-mtime", "+2", "-mtime", "-1"])
    assert expr.mtime_min is not None and expr.mtime_max is not None
    assert expr.mtime_min > expr.mtime_max
    both = parse_find_expression(["-mtime", "-1", "-mtime", "-3"])
    either = parse_find_expression(["-mtime", "-1", "-o", "-mtime", "-3"])
    assert both.mtime_min - either.mtime_min == pytest.approx(2 * 86400, abs=2)
    assert (both.mtime_max, either.mtime_max) == (None, None)
