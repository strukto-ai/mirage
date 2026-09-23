import pytest

from mirage.core.awk.errors import AwkSyntaxError
from mirage.core.awk.nodes import (Assign, Binary, Block, Compare, Concat, For,
                                   ForIn, Print, RuleKind, Unary, While)
from mirage.core.awk.parser import parse


def first_stmt(src: str):
    action = parse(src).rules[0].action
    assert action is not None
    return action.body[0]


def test_rule_kinds():
    rules = parse("BEGIN{}\n/a/\nNR==1,NR==2{print}\n{print}\nEND{}").rules
    assert [r.kind for r in rules] == [
        RuleKind.BEGIN, RuleKind.PATTERN, RuleKind.RANGE, RuleKind.ALWAYS,
        RuleKind.END
    ]
    assert rules[1].action is None


def test_for_header_keeps_its_semicolons():
    stmt = first_stmt("{for(i=1;i<NF;i++)x=x\"  \"}")
    assert isinstance(stmt, For)
    assert isinstance(stmt.cond, Compare)


def test_for_in_and_while_with_an_empty_body():
    assert isinstance(first_stmt("{for(k in a)print k}"), ForIn)
    loop = first_stmt("{while(i++<3);print i}")
    assert isinstance(loop, While)
    assert loop.body == Block(())


def test_concatenation_binds_looser_than_arithmetic():
    expr = first_stmt("{x = 1 \" \" 2+3}").expr
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


@pytest.mark.parametrize("src", [
    "{print $(}",
    "{if x print}",
    "{break}",
    "{return 1}",
    "{print",
    "/[/",
    "{x = }",
])
def test_syntax_errors(src):
    with pytest.raises(AwkSyntaxError):
        parse(src)
