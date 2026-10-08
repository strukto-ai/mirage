import pytest

from mirage.core.awk.errors import AwkSyntaxError
from mirage.core.awk.nodes import (
    Assign,
    Binary,
    Block,
    Compare,
    Concat,
    For,
    ForIn,
    Getline,
    GetlineKind,
    Print,
    RedirKind,
    RuleKind,
    Str,
    Unary,
    Var,
    While,
)
from mirage.core.awk.parser import parse


def first_stmt(src: str):
    action = parse(src).rules[0].action
    assert action is not None
    return action.body[0]


def test_rule_kinds():
    rules = parse("BEGIN{}\n/a/\nNR==1,NR==2{print}\n{print}\nEND{}").rules
    assert [r.kind for r in rules] == [
        RuleKind.BEGIN,
        RuleKind.PATTERN,
        RuleKind.RANGE,
        RuleKind.ALWAYS,
        RuleKind.END,
    ]
    assert rules[1].action is None


def test_for_header_keeps_its_semicolons():
    stmt = first_stmt('{for(i=1;i<NF;i++)x=x"  "}')
    assert isinstance(stmt, For)
    assert isinstance(stmt.cond, Compare)


def test_for_in_and_while_with_an_empty_body():
    assert isinstance(first_stmt("{for(k in a)print k}"), ForIn)
    loop = first_stmt("{while(i++<3);print i}")
    assert isinstance(loop, While)
    assert loop.body == Block(())


def test_concatenation_binds_looser_than_arithmetic():
    expr = first_stmt('{x = 1 " " 2+3}').expr
    assert isinstance(expr, Assign)
    assert isinstance(expr.value, Concat)
    assert isinstance(expr.value.right, Binary)


def test_unary_minus_binds_looser_than_power():
    expr = first_stmt("{x = -2^2}").expr.value
    assert isinstance(expr, Unary)
    assert isinstance(expr.operand, Binary)


def test_print_redirect_is_not_a_comparison():
    stmt = first_stmt('{print a, b > "/dev/stderr"}')
    assert isinstance(stmt, Print)
    assert len(stmt.args) == 2
    assert stmt.redirect is not None
    grouped = first_stmt("{print (a > b)}")
    assert isinstance(grouped.args[0], Compare)


def test_functions_are_collected():
    program = parse("function f(a, b) { return a+b } {print f(1,2)}")
    assert program.functions["f"].params == ("a", "b")


@pytest.mark.parametrize(
    "src",
    [
        "{print $(}",
        "{if x print}",
        "{break}",
        "{return 1}",
        "{print",
        "/[/",
        "{x = }",
    ],
)
def test_syntax_errors(src):
    with pytest.raises(AwkSyntaxError):
        parse(src)


@pytest.mark.parametrize(
    "src,message",
    [
        (
            'BEGIN{match("a",\n/a/,\nm)}',
            "awk: syntax error at ',': expected ')'",
        ),
        ('BEGIN{match("a")}', "awk: syntax error at ')': expected ','"),
        ("BEGIN{match()}", "awk: syntax error at ')': expected an expression"),
        ("BEGIN{sub(/a/)}", "awk: syntax error at ')': expected ','"),
        (
            'BEGIN{gsub(/a/, "b", x, y)}',
            "awk: syntax error at ',': expected ')'",
        ),
        (
            'BEGIN{print length("a", "b")}',
            "awk: syntax error at ',': expected ')'",
        ),
        ("BEGIN{print substr}", "awk: syntax error at '}': expected '('"),
        (
            'BEGIN{print substr("abc")}',
            "awk: not enough arguments in call to substr: 1 (need 2)",
        ),
        (
            "BEGIN{print rand(1)}",
            "awk: too many arguments in call to rand: 1 (maximum 0)",
        ),
        (
            "BEGIN{print sprintf()}",
            "awk: not enough arguments in call to sprintf: 0 (need 1)",
        ),
        (
            "BEGIN{print atan2(1, 2, 3)}",
            "awk: too many arguments in call to atan2: 3 (maximum 2)",
        ),
    ],
)
def test_builtin_argument_counts(src, message):
    with pytest.raises(AwkSyntaxError) as raised:
        parse(src)
    assert str(raised.value) == message


@pytest.mark.parametrize(
    "src,count",
    [
        ("BEGIN{print length}", 0),
        ("BEGIN{print length()}", 0),
        ('BEGIN{print split("a b", x, " ")}', 3),
        ('BEGIN{print sprintf("%s %s %s", 1, 2, 3)}', 4),
        ("BEGIN{print srand()}", 0),
        ("BEGIN{print fflush()}", 0),
    ],
)
def test_builtin_argument_counts_in_bounds(src, count):
    assert len(first_stmt(src).args[0].args) == count


def test_getline_file_is_a_primary():
    expr = first_stmt('{x = getline line < "a" "b"}').expr.value
    assert isinstance(expr, Concat)
    assert isinstance(expr.left, Getline)
    assert expr.left.kind is GetlineKind.FILE
    assert expr.left.source == Str("a")


def test_getline_file_result_compares_unparenthesised():
    loop = first_stmt("{while (getline line < f > 0) n++}")
    assert isinstance(loop.cond, Compare)
    assert isinstance(loop.cond.left, Getline)
    assert loop.cond.left.target == Var("line")


def test_command_of_an_input_pipe_is_a_primary():
    expr = first_stmt('{x = "echo " "hi" | getline}').expr.value
    assert isinstance(expr, Concat)
    assert expr.left == Str("echo ")
    assert isinstance(expr.right, Getline)
    assert expr.right.kind is GetlineKind.CMD
    assert expr.right.source == Str("hi")
    summed = first_stmt('{x = 1 + "cmd" | getline}').expr.value
    assert isinstance(summed, Binary)
    assert isinstance(summed.right, Getline)


def test_input_pipe_result_takes_operators_after_it():
    cmp = first_stmt('{x = "cmd" | getline line > 0}').expr.value
    assert isinstance(cmp, Compare)
    assert cmp.left == Getline(GetlineKind.CMD, Var("line"), Str("cmd"))


def test_print_pipe_stays_an_output_pipe():
    stmt = first_stmt('{print "x" | "cat"}')
    assert isinstance(stmt, Print)
    assert stmt.redirect is not None
    assert stmt.redirect.kind is RedirKind.PIPE
