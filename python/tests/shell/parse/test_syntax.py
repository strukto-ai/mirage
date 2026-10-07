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
import json
from pathlib import Path

import pytest

from mirage.shell.bytes import decode_text
from mirage.shell.parse import (
    find_syntax_error,
    find_unterminated_backtick,
    parse,
    source_offsets,
)
from mirage.shell.parse.syntax import (
    ends_inside_construct,
    syntax_error_result,
)
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def test_partial_quoted_heredoc_end_is_not_syntax_error():
    root = parse("cat <<EN'D'\n$v\nEND")
    assert find_syntax_error(root) is None


@pytest.mark.parametrize(
    ("line", "unfinished"),
    [
        ("if true", True),
        ("case x", True),
        ("f() {", True),
        ("( ( echo a", True),
        ("echo a |", True),
        ("if true; then echo a; else", True),
        ("if then", False),
        ("if ;", False),
        ("if }", False),
        ("echo x (", False),
        ("( then", False),
        ("if true; then else", False),
        ("for i in 1; do ;", False),
    ],
)
def test_only_input_bash_took_whole_ends_inside_a_construct(line, unfinished):
    assert ends_inside_construct(parse(line)) is unfinished


def test_a_syntax_error_span_keeps_an_invalid_byte_as_typed():
    line = decode_text(b"[[ '\xff'")
    io = syntax_error_result(line, parse(line))
    assert io.exit_code == 2
    assert io.stderr == b"mirage: syntax error near '[[ '\xff''\n"


def test_syntax_error_after_deep_command_substitution():
    depth = 4096
    root = parse("echo " + "$(echo " * depth + "x" + ")" * depth + " (")
    assert find_syntax_error(root) == "("


@pytest.mark.parametrize(
    "command",
    [
        "echo `echo a",
        "echo \"`echo '`'`\"",
        "echo a`",
        "`",
    ],
)
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
    ],
)
def test_find_unterminated_backtick_accepts_balanced(command):
    assert find_unterminated_backtick(command) is None


@pytest.mark.parametrize(
    "bad_cmd",
    [
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
    ],
)
def test_find_syntax_error_detects_error_nodes(bad_cmd):
    ast = parse(bad_cmd)
    snippet = find_syntax_error(ast)
    assert snippet is not None, (
        f"expected syntax error for {bad_cmd!r}, got None"
    )


@pytest.mark.parametrize(
    "good_cmd",
    [
        "echo hi",
        "for x in a b; do echo $x; done",
        "if true; then echo y; fi",
        "cat /tmp/x | sort",
        "echo bg & echo fg",
        "echo a &",
        "echo a;",
        "case x in a) echo a;; esac",
        "case x in a) echo a;& b) echo b;;& c) echo c;; esac",
    ],
)
def test_find_syntax_error_returns_none_for_valid(good_cmd):
    assert find_syntax_error(parse(good_cmd)) is None


@pytest.mark.parametrize(
    "bad_cmd",
    [
        "if then fi",
        "echo (",
        "for x do done",
        ";s",
        "true;;s",
    ],
)
def test_execute_returns_clear_syntax_error(bad_cmd):
    ws = Workspace({"/data": RAMVFS()})
    io = asyncio.run(ws.shell(bad_cmd))
    assert io.exit_code == 2, (
        f"expected exit 2 for {bad_cmd!r}, got {io.exit_code}"
    )
    stderr = io.stderr or b""
    assert b"syntax error" in stderr, (
        f"expected 'syntax error' in stderr for {bad_cmd!r}, got {stderr!r}"
    )


@pytest.mark.parametrize(
    "bad_cmd, token",
    [
        (";s", ";"),
        ("| s", "|"),
        ("&& s", "&&"),
        ("echo a ; ; echo b", ";"),
        ("echo bg &; echo fg", ";"),
        ("true;;s", ";;"),
    ],
)
def test_stray_separator_is_a_syntax_error_and_nothing_runs(bad_cmd, token):
    ws = Workspace({"/data": RAMVFS()})
    io = asyncio.run(ws.shell(bad_cmd))
    assert io.exit_code == 2
    assert io.stderr == f"mirage: syntax error near '{token}'\n".encode()
    assert not io.stdout


@pytest.mark.parametrize(
    "bad_cmd",
    [
        "echo `echo a",
        "echo \"`echo '`'`\"",
    ],
)
def test_unterminated_backtick_is_a_syntax_error(bad_cmd):
    """tree-sitter parses these as complete; bash exits 2 and so do we."""
    ws = Workspace({"/data": RAMVFS()})
    io = asyncio.run(ws.shell(bad_cmd))
    assert io.exit_code == 2, (
        f"expected exit 2 for {bad_cmd!r}, got {io.exit_code}"
    )
    assert (
        io.stderr == b"mirage: unexpected EOF while looking for matching ``'\n"
    )


@pytest.mark.parametrize(
    "command,expected",
    [
        # A trailing backslash continues the line; with nothing to continue
        # onto, bash drops it and runs the command.
        ("echo a\\", b"a\n"),
        ("echo \\", b"\n"),
        ("echo a\\\\", b"a\\\n"),
    ],
)
def test_trailing_backslash_is_a_line_continuation(command, expected):
    ws = Workspace({"/data": RAMVFS()})
    io = asyncio.run(ws.shell(command))
    assert io.exit_code == 0, (io.exit_code, io.stderr)
    assert io.stdout == expected


MISSING_QUOTE_CASES = json.loads(
    (
        Path(__file__).resolve().parents[4] / "integ/bash/syntax/quoting.json"
    ).read_text()
)["cases"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command",
    [
        case["command"]
        for case in MISSING_QUOTE_CASES
        if case["expect"]["exit"] == 2
    ],
)
async def test_missing_nested_quote_refuses_before_any_execution(command):
    ws = Workspace({"/data": RAMVFS()})
    try:
        io = await ws.shell(command)
        assert io.exit_code == 2
        assert await io.stdout_str() == ""
        stderr = await io.stderr_str()
        assert "unexpected EOF while looking for matching" in stderr
        check = await ws.shell("test -e /data/unexpected")
        assert check.exit_code == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "command,expected",
    [
        ('echo "it\'s fine"', "it's fine\n"),
        ("echo ok # unterminated '\"", "ok\n"),
        ("cat <<'EOF'\n'\"\nEOF", "'\"\n"),
        ("echo $'closed\\''", "closed'\n"),
    ],
)
async def test_literal_quotes_are_not_reported_as_unclosed(command, expected):
    ws = Workspace({"/data": RAMVFS()})
    try:
        io = await ws.shell(command)
        assert io.exit_code == 0
        assert await io.stdout_str() == expected
        assert await io.stderr_str() == ""
    finally:
        await ws.close()


@pytest.mark.parametrize(
    "command, word",
    [
        ("echo hi; fi", "fi"),
        ("done", "done"),
        ("then", "then"),
        ("esac", "esac"),
        ("}", "}"),
        ("]]", "]]"),
        ("in", "in"),
        ("! fi", "fi"),
        ("fi >/dev/null", "fi"),
        ("echo a | fi", "fi"),
        ("echo a && fi", "fi"),
        ("fi; done", "fi"),
        ("fi; for a in b; do done", "fi"),
        ("if x; then fi; for a in b; do done", "fi"),
    ],
)
def test_a_reserved_word_where_a_command_starts_is_a_syntax_error(
    command, word
):
    # Pinned against bash 5.2.37, which refuses the line at the word.
    assert find_syntax_error(parse(command)) == word


@pytest.mark.parametrize(
    "command",
    [
        '"fi"',
        "\\fi",
        "x=1 fi",
        ">/dev/null fi",
        "echo fi done then",
        "if true; then echo y; fi",
        "for x in a; do echo $x; done",
        "{ echo a; }",
        "case a in a) echo m;; esac",
    ],
)
def test_a_reserved_word_bash_reads_as_a_word_is_no_syntax_error(command):
    assert find_syntax_error(parse(command)) is None


@pytest.mark.parametrize(
    "command, alias, word",
    [
        ("fi", "fi", None),
        ("fi", "done", "fi"),
        ("( fi )", "fi", None),
        ("echo `fi`", "fi", None),
        ('echo "$(fi)"', "fi", "fi"),
        ("echo $( (fi) )", "fi", "fi"),
        ("echo <(fi)", "fi", "fi"),
    ],
)
def test_a_reserved_word_the_shell_expands_as_an_alias_is_a_command(
    command, alias, word
):
    # Pinned against bash 5.2.37, which takes the reserved word first
    # inside `$(...)` and a process substitution.
    assert find_syntax_error(parse(command), frozenset({alias})) == word


@pytest.mark.parametrize(
    "line, own, word",
    [
        ("echo F; fi", {"fi": (0, 10)}, "fi"),
        ("echo F; fi", {"fi": (0, 7)}, None),
        ("echo C; fi echo F", {"c": (0, 11), "fi": (11, 17)}, None),
        ("echo C; echo F; fi", {"c": (0, 8), "fi": (8, 18)}, "fi"),
        ("echo F \\\n; fi", {"fi": (0, 13)}, "fi"),
        ("echo F \\\n; fi", {"fi": (0, 10)}, None),
    ],
)
def test_an_alias_name_is_reserved_inside_its_own_text(line, own, word):
    # Pinned against bash 5.2.37: a name stays reserved only inside the
    # text its alias put there, a trailing blank's chained one included.
    # Spans are in the line as typed, which a continuation shifts.
    root = parse(line)
    offsets = source_offsets(line, root)
    assert find_syntax_error(root, frozenset(own), own, offsets) == word
