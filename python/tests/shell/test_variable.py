# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import pytest

from mirage.shell.variable import (ManagedRef, ShellVar, VarAttr, VarKind,
                                   attr_letters, attrs_from_letters, detach,
                                   stored_attrs, var_kind, with_attr,
                                   with_value)

# The order `declare -p` prints a cluster in, pinned against bash 5.2.37
# over all 72 ordered pairs of `a A i l n r t u x`. Stated here as a
# literal so it is asserted rather than assumed: `attr_letters` reads it
# off `VarAttr`'s declaration order, so appending a member in the wrong
# place silently reorders every `declare -p` line in the repo.
PRINT_ORDER = "inrtxlu"


def test_print_order_is_the_enum_declaration_order():
    assert "".join(a.value for a in VarAttr) == PRINT_ORDER


# (expected cluster, value, attributes) pinned against bash 5.2.37.
LETTER_CASES = [
    ("irx", "1", {VarAttr.EXPORT, VarAttr.READONLY, VarAttr.INTEGER}),
    ("Aiu", {}, {VarAttr.INTEGER, VarAttr.UPPER}),
    ("arx", [], {VarAttr.READONLY, VarAttr.EXPORT}),
    ("nrx", "a", {VarAttr.NAMEREF, VarAttr.READONLY, VarAttr.EXPORT}),
    ("xl", "z", {VarAttr.EXPORT, VarAttr.LOWER}),
    ("", "5", set()),
    # An unset variable still prints the attributes it carries, and no
    # `a`: `declare -i n` has no array letter until a value earns one.
    ("i", None, {VarAttr.INTEGER}),
]


@pytest.mark.parametrize("want,value,attrs", LETTER_CASES)
def test_attr_letters(want, value, attrs):
    assert attr_letters(ShellVar(value, frozenset(attrs))) == want


@pytest.mark.parametrize("want,value,attrs", LETTER_CASES)
def test_stored_attrs_drops_the_derived_kind_lead(want, value, attrs):
    assert stored_attrs(ShellVar(value, frozenset(attrs))) == want.lstrip("aA")


def test_attrs_from_letters_round_trips_stored_attrs():
    var = ShellVar("v", frozenset({VarAttr.EXPORT, VarAttr.READONLY}))
    assert attrs_from_letters(stored_attrs(var)) == var.attrs


def test_attrs_from_letters_ignores_a_letter_it_does_not_know():
    # The store is shared with the other language and with later
    # versions, so refusing to load a session because one letter is
    # unknown would lose far more than the letter.
    assert attrs_from_letters("xZ") == frozenset({VarAttr.EXPORT})
    assert attrs_from_letters("") == frozenset()


@pytest.mark.parametrize("value,kind", [
    ("x", VarKind.SCALAR),
    (None, VarKind.SCALAR),
    ([], VarKind.INDEXED),
    (["a"], VarKind.INDEXED),
    ({}, VarKind.ASSOC),
])
def test_var_kind_is_read_off_the_value(value, kind):
    assert var_kind(ShellVar(value)) == kind


def test_with_value_keeps_the_attributes():
    # Attributes belong to the name, not the value: `declare -i n; n=3`
    # stays an integer.
    var = ShellVar("1", frozenset({VarAttr.INTEGER}))
    assert with_value(var, "3") == ShellVar("3", frozenset({VarAttr.INTEGER}))


def test_with_attr_sets_and_clears_without_touching_the_value():
    var = ShellVar("v")
    marked = with_attr(var, VarAttr.EXPORT)
    assert marked == ShellVar("v", frozenset({VarAttr.EXPORT}))
    assert with_attr(marked, VarAttr.EXPORT,
                     False) == ShellVar("v", frozenset())
    # Clearing an attribute that was never set is a no-op, not an error:
    # `export -n NAME` on an unexported name exits 0 in bash.
    assert with_attr(var, VarAttr.EXPORT, False) == var


def test_the_record_is_frozen():
    var = ShellVar("v")
    with pytest.raises(Exception):
        var.value = "other"  # type: ignore[misc]


def test_managed_defaults_none():
    assert ShellVar("x").managed is None


def test_managed_ref_defaults_lazy_and_is_frozen():
    ref = ManagedRef(source="aws-sm", ref="prod/agent", key="TOKEN")
    assert ref.eager is False
    with pytest.raises(Exception):
        ref.key = "OTHER"  # type: ignore[misc]


def test_with_value_keeps_managed():
    # The fill step's write: fetching a value must not drop the pointer,
    # or a second fill pass could not tell a filled var from a plain one.
    ref = ManagedRef(source="aws-sm", ref="prod/agent", key="TOKEN")
    var = ShellVar(None, frozenset({VarAttr.EXPORT}), managed=ref)
    assert with_value(var, "tok").managed is ref


def test_detach():
    ref = ManagedRef(source="aws-sm", ref="prod/agent", key="TOKEN")
    var = ShellVar("tok", frozenset({VarAttr.EXPORT}), managed=ref)
    detached = detach(var)
    assert detached.managed is None
    assert detached.value == "tok"
    assert detached.attrs == var.attrs
