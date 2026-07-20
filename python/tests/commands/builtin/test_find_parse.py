import pytest

from mirage.commands.builtin.find_eval import (And, Empty, Name, Not, Or, Path,
                                               TrueNode, Type, eval_predicate)
from mirage.commands.builtin.find_parse import (FindParseError,
                                                parse_find_expression)


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
    ["-mindepth", "x"],
    ["-size", ""],
    ["-size", "abc"],
    ["-mtime", ""],
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
    ["-newer", "data/a.txt"],
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
