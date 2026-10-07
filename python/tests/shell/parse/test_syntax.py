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

import json
from pathlib import Path

import pytest

from mirage.shell.bytes import decode_text, encode_text
from mirage.shell.parse import check_syntax, syntax_error_result
from mirage.shell.parse.constants import MAX_NESTING
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

ROOT = Path(__file__).resolve().parents[4]
CORPUS = json.loads(
    (ROOT / "integ/fixtures/shell/bash_syntax.json").read_text()
)["lines"]


def read(line: str) -> tuple[int, str]:
    found = check_syntax(line)
    return (0, "") if found is None else (found.status, found.message)


def test_every_line_reads_as_bash_reads_it():
    # integ/fixtures/shell/bash_syntax.json is pinned against bash by
    # scripts/pin_bash_syntax.py, which also fuzzes the reader against it;
    # the TypeScript suite (packages/core/src/shell/parse/syntax.test.ts)
    # reads the same rows.
    assert [
        row["line"]
        for row in CORPUS
        if read(row["line"]) != (row["status"], row["stderr"])
    ] == []


@pytest.mark.parametrize(
    ("raw", "stderr"),
    [
        (b"echo (\xff", b"mirage: syntax error near '\xff'\n"),
        (
            b"[[ '\xff'",
            b"mirage: unexpected token `newline', conditional binary "
            b"operator expected\nmirage: syntax error near ''\xff''\n",
        ),
    ],
)
def test_a_diagnostic_keeps_an_invalid_byte_as_typed(raw, stderr):
    found = check_syntax(decode_text(raw))
    assert found is not None
    assert raw[found.span.start : found.span.end] == encode_text(
        found.offending
    )
    assert syntax_error_result(found).stderr == stderr


def test_a_line_nested_past_the_reader_is_refused_at_the_next_opener():
    # bash refuses a line nested past its own reader at the opener it can
    # no longer take (thousands deep there), so nothing on the line runs.
    deep = "echo " + "$(echo " * 4096 + "x" + ")" * 4096 + "; fi"
    found = check_syntax(deep)
    assert found is not None and found.offending == "$("
    assert (
        check_syntax("{ " * MAX_NESTING + "a; " + "} " * MAX_NESTING) is None
    )
    found = check_syntax("{ " * (MAX_NESTING + 1) + "a; " + "} " * MAX_NESTING)
    assert found is not None and found.offending == "{"


def test_a_substitution_is_read_once_however_often_its_word_is():
    assert check_syntax("x=$(" * 40 + "echo hi" + ")" * 40) is None


@pytest.mark.parametrize(
    ("command", "alias", "word"),
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
    found = check_syntax(command, frozenset({alias}))
    assert (found and found.offending) == word


@pytest.mark.parametrize(
    ("line", "own", "word"),
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
    found = check_syntax(line, frozenset(own), own)
    assert (found and found.offending) == word


MISSING_QUOTE_CASES = json.loads(
    (ROOT / "integ/bash/syntax/quoting.json").read_text()
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
