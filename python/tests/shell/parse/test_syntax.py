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

import asyncio

import pytest

from mirage.resource.ram import RAMResource
from mirage.shell.parse import (find_syntax_error, find_unterminated_backtick,
                                parse)
from mirage.workspace import Workspace


def test_partial_quoted_heredoc_end_is_not_syntax_error():
    root = parse("cat <<EN'D'\n$v\nEND")
    assert find_syntax_error(root) is None


@pytest.mark.parametrize("command", [
    "echo `echo a",
    "echo \"`echo '`'`\"",
    "echo a`",
    "`",
])
def test_find_unterminated_backtick_flags_open_region(command):
    assert find_unterminated_backtick(command) is not None


@pytest.mark.parametrize(
    "command",
    [
        "echo `echo a`",
        "echo `echo a` `echo b`",
        # Single quotes protect a backtick, double quotes do not.
        "echo '`'",
        'echo "`echo a`"',
        'echo "\\`"',
        # Only a backslash escapes inside the region.
        "echo `echo \\`nested\\``",
        "echo a",
        "cat <<EOF\nplain\nEOF",
    ])
def test_find_unterminated_backtick_accepts_balanced(command):
    assert find_unterminated_backtick(command) is None


@pytest.mark.parametrize("bad_cmd", [
    "if then fi",
    "echo (",
    "for x do done",
    "for",
    "if",
    "if; fi",
    'echo "unterm',
    ";s",
    "| s",
    "&& s",
    "& s",
    "echo a ; ; echo b",
    "echo bg &; echo fg",
    "true;;s",
    "echo a ;& echo b",
])
def test_find_syntax_error_detects_error_nodes(bad_cmd):
    ast = parse(bad_cmd)
    snippet = find_syntax_error(ast)
    assert snippet is not None, (
        f"expected syntax error for {bad_cmd!r}, got None")


@pytest.mark.parametrize("good_cmd", [
    "echo hi",
    "for x in a b; do echo $x; done",
    "if true; then echo y; fi",
    "cat /tmp/x | sort",
    "echo bg & echo fg",
    "echo a &",
    "echo a;",
    "case x in a) echo a;; esac",
    "case x in a) echo a;& b) echo b;;& c) echo c;; esac",
])
def test_find_syntax_error_returns_none_for_valid(good_cmd):
    assert find_syntax_error(parse(good_cmd)) is None


@pytest.mark.parametrize("bad_cmd", [
    "if then fi",
    "echo (",
    "for x do done",
    ";s",
    "true;;s",
])
def test_execute_returns_clear_syntax_error(bad_cmd):
    ws = Workspace({"/data": RAMResource()})
    io = asyncio.run(ws.execute(bad_cmd))
    assert io.exit_code == 2, (
        f"expected exit 2 for {bad_cmd!r}, got {io.exit_code}")
    stderr = io.stderr or b""
    assert b"syntax error" in stderr, (
        f"expected 'syntax error' in stderr for {bad_cmd!r}, got {stderr!r}")


@pytest.mark.parametrize("bad_cmd, token", [
    (";s", ";"),
    ("| s", "|"),
    ("&& s", "&&"),
    ("echo a ; ; echo b", ";"),
    ("echo bg &; echo fg", ";"),
    ("true;;s", ";;"),
])
def test_stray_separator_is_a_syntax_error_and_nothing_runs(bad_cmd, token):
    ws = Workspace({"/data": RAMResource()})
    io = asyncio.run(ws.execute(bad_cmd))
    assert io.exit_code == 2
    assert io.stderr == f"mirage: syntax error near '{token}'\n".encode()
    assert not io.stdout


@pytest.mark.parametrize("bad_cmd", [
    "echo `echo a",
    "echo \"`echo '`'`\"",
])
def test_unterminated_backtick_is_a_syntax_error(bad_cmd):
    """tree-sitter parses these as complete; bash exits 2 and so do we."""
    ws = Workspace({"/data": RAMResource()})
    io = asyncio.run(ws.execute(bad_cmd))
    assert io.exit_code == 2, (
        f"expected exit 2 for {bad_cmd!r}, got {io.exit_code}")
    assert b"syntax error" in (io.stderr or b"")


@pytest.mark.parametrize(
    "command,expected",
    [
        # A trailing backslash continues the line; with nothing to continue
        # onto, bash drops it and runs the command.
        ("echo a\\", b"a\n"),
        ("echo \\", b"\n"),
        ("echo a\\\\", b"a\\\n"),
    ])
def test_trailing_backslash_is_a_line_continuation(command, expected):
    ws = Workspace({"/data": RAMResource()})
    io = asyncio.run(ws.execute(command))
    assert io.exit_code == 0, (io.exit_code, io.stderr)
    assert io.stdout == expected
