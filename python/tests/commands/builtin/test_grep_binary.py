from dataclasses import dataclass

from mirage.commands.builtin.grep_select import WalkFilters
from mirage.commands.builtin.types import RegexSyntax
from mirage.commands.builtin.utils.constants import GREP_STDIN_LABEL


@dataclass(frozen=True, slots=True)
class GrepFlags:
    """Parsed grep flags (TS FlagSet parity); the complete set grep honors."""

    ignore_case: bool
    invert: bool

import pytest

from mirage.commands.builtin.generic.grep import parse_flags
from mirage.commands.builtin.grep_binary import group_line, name_end, valid_utf8
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView


def _flags(**flags):
    return parse_flags(FlagView(flags, spec=SPECS["grep"]), False)


@pytest.mark.parametrize(
    "flags, line",
    [
        ({}, b""),
        ({"after_context": "0"}, b"--\n"),
        ({"context": "1", "group_separator": "=="}, b"==\n"),
        ({"context": "1", "no_group_separator": True}, b""),
        ({"context": "1", "count": True}, b""),
    ],
)
def test_groups_are_separated_only_where_lines_print_with_context(flags, line):
    # grep 3.11: -A0 still separates groups; -c prints no lines to separate.
    assert group_line(_flags(**flags)) == line


def test_a_listed_name_ends_in_nul_under_z():
    assert name_end(_flags()) == b"\n"
    assert name_end(_flags(null=True)) == b"\0"


def test_a_stray_byte_is_not_utf8():
    assert valid_utf8("é".encode())
    assert not valid_utf8(b"a\xffb")
