import dataclasses

import pytest

from mirage.core.awk.nodes import (ArrayRef, Field, Num, Program, RedirKind,
                                   RuleKind, Var)
from mirage.core.awk.parser import LVALUE_TYPES


def test_nodes_are_frozen_values():
    assert Var("x") == Var("x")
    with pytest.raises(dataclasses.FrozenInstanceError):
        Var("x").name = "y"  # type: ignore[misc]


def test_lvalues_are_the_three_assignable_shapes():
    assert isinstance(Var("x"), LVALUE_TYPES)
    assert isinstance(Field(Num(1.0)), LVALUE_TYPES)
    assert isinstance(ArrayRef("a", (Num(1.0), )), LVALUE_TYPES)
    assert not isinstance(Num(1.0), LVALUE_TYPES)


def test_kinds_spell_their_source_tokens():
    assert [k.value for k in RedirKind] == [">", ">>", "|"]
    assert RuleKind.BEGIN.value == "BEGIN"


def test_an_empty_program_has_no_rules_or_functions():
    assert Program() == Program((), {})
