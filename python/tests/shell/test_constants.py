from mirage.shell.constants import BUILTIN_GROUP, GRAMMAR_BUILTINS, GROUP_TIER
from mirage.shell.types import BuiltinGroup, BuiltinTier, ShellBuiltin


def test_tier_members_are_builtins():
    assert all(isinstance(b, ShellBuiltin) for b in GRAMMAR_BUILTINS)


def test_tier_values():
    assert BuiltinTier.GRAMMAR == "grammar"
    assert BuiltinTier.TOOL == "tool"
    assert ShellBuiltin.CD in GRAMMAR_BUILTINS
    assert ShellBuiltin.PYTHON3 not in GRAMMAR_BUILTINS


def test_group_rows_cover_every_builtin():
    assert set(BUILTIN_GROUP) == set(ShellBuiltin)
    assert all(isinstance(g, BuiltinGroup) for g in BUILTIN_GROUP.values())


def test_every_group_has_a_tier_and_a_member():
    assert set(GROUP_TIER) == set(BuiltinGroup)
    assert set(BUILTIN_GROUP.values()) == set(BuiltinGroup)


def test_tier_sets_derive_from_the_group_rows():
    for builtin, group in BUILTIN_GROUP.items():
        tier = GROUP_TIER[group]
        assert (builtin in GRAMMAR_BUILTINS) == (tier is BuiltinTier.GRAMMAR)


def test_group_values():
    assert BuiltinGroup.WORKING_DIRECTORY == "working-directory"
    assert BUILTIN_GROUP[ShellBuiltin.CD] is BuiltinGroup.WORKING_DIRECTORY
    assert BUILTIN_GROUP[ShellBuiltin.KILL] is BuiltinGroup.JOB_CONTROL
    assert GROUP_TIER[BuiltinGroup.JOB_CONTROL] is BuiltinTier.TOOL
    assert GROUP_TIER[BuiltinGroup.OUTPUT] is BuiltinTier.GRAMMAR
