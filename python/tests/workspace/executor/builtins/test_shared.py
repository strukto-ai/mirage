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

import errno
from dataclasses import replace

import pytest

from mirage.io import IOResult
from mirage.io.types import CountedRun
from mirage.policy import PolicyDenied
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.builtins.constants import IDENTIFIER_RE
from mirage.workspace.executor.builtins.shared import (
    abs_path,
    count_operand,
    expand_operands,
    fail,
    finish,
    is_count_word,
    is_valid_name,
    ok,
    operand_text,
    readonly_refusal,
    record_delimiter,
    refusal,
    require_view,
    split_value_flags,
)
from mirage.workspace.session import SessionState
from mirage.workspace.session.state import session_view


def test_ok_triple():
    out, io, node = ok("ln", b"x\n")
    assert out == b"x\n"
    assert io.exit_code == 0
    assert node.command == "ln"
    assert node.exit_code == 0
    assert node.stderr == b""


def test_fail_triple():
    out, io, node = fail("chmod", "chmod: missing operand\n", 2)
    assert out is None
    assert io.exit_code == 2
    assert io.stderr == b"chmod: missing operand\n"
    assert node.exit_code == 2
    assert node.stderr == b"chmod: missing operand\n"


def test_finish_no_errors_keeps_io():
    io = IOResult(counted_runs=[CountedRun((1,), "/data/f.txt")])
    out, result_io, node = finish("touch", [], io=io)
    assert out is None
    assert result_io.exit_code == 0
    assert result_io.counted_runs == [CountedRun((1,), "/data/f.txt")]
    assert node.exit_code == 0
    assert node.stderr == b""


def test_finish_joins_errors():
    _out, io, node = finish("chown", ["a\n", "b\n"])
    assert io.exit_code == 1
    assert io.stderr == b"a\nb\n"
    assert node.stderr == b"a\nb\n"


def test_operand_text():
    assert operand_text(PathSpec.from_str_path("/data/644")) == "/data/644"
    assert operand_text("644") == "644"


def test_abs_path():
    spec = PathSpec.from_str_path("/data/f.txt")
    assert abs_path(spec, "/tmp") == "/data/f.txt"
    assert abs_path("f.txt", "/data") == "/data/f.txt"


def test_split_value_flags_detached_value():
    flags, values, operands, bad = split_value_flags(
        ["-c", "-t", "202601021530", "f.txt"], "acmh", "tdr"
    )
    assert bad is None
    assert flags == {"c"}
    assert values == {"t": "202601021530"}
    assert operands == ["f.txt"]


def test_split_value_flags_attached_value():
    _flags, values, operands, bad = split_value_flags(
        ["-t202601021530", "f"], "acmh", "tdr"
    )
    assert bad is None
    assert values == {"t": "202601021530"}
    assert operands == ["f"]


def test_split_value_flags_reports_unknown():
    _flags, _values, _operands, bad = split_value_flags(["-q", "f"], "Rvf", "")
    assert bad == "q"


@pytest.mark.asyncio
async def test_expand_operands_globs():
    ws = Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo a > /data/a.txt && echo b > /data/b.txt")
    namespace = ws._namespace
    glob_spec = replace(
        PathSpec.from_str_path("/data/*.txt"), pattern="*.txt", resolved=False
    )
    expanded = await expand_operands(namespace, [glob_spec, "/data/c.md"])
    virtuals = sorted(p.virtual for p in expanded)
    assert virtuals == ["/data/a.txt", "/data/b.txt", "/data/c.md"]


def test_require_view_returns_the_threaded_view():
    session = SessionState(session_id="s1")
    view = session_view(session)
    assert require_view(view) is view


def test_require_view_refuses_a_missing_view():
    with pytest.raises(RuntimeError, match="gated session view"):
        require_view(None)


def test_refusal_speaks_in_the_builtins_voice():
    exc = PolicyDenied(errno.EACCES, "X: refused", "X")
    out, io, node = refusal("export", exc)
    assert out is None
    assert io.exit_code == 1
    assert io.stderr == f"{exc.strerror}\n".encode()
    assert node.command == "export"
    assert node.stderr == io.stderr


def test_readonly_refusal_names_the_variable():
    out, io, node = readonly_refusal("read", "X")
    assert out is None
    assert io.exit_code == 1
    assert io.stderr == b"bash: X: readonly variable\n"
    assert node.command == "read"


def test_is_valid_name():
    assert is_valid_name("_x9")
    assert not is_valid_name("9x")
    assert not is_valid_name("a-b")
    assert not is_valid_name("")
    assert IDENTIFIER_RE.fullmatch("abc") is not None


def test_is_count_word():
    assert is_count_word("3")
    assert is_count_word("-3")
    assert is_count_word("+3")
    assert not is_count_word("x")
    assert not is_count_word("-")


# bash 5.2 stops `read -d` and `mapfile -d` at the first byte of the
# argument, not its first character. Mirrored in shared.test.ts.
@pytest.mark.parametrize(
    "text,delimiter",
    [
        (None, b"\n"),
        ("", b"\0"),
        (":", b":"),
        ("ab", b"a"),
        (chr(0xDCFF), b"\xff"),
        ("\u00e9", b"\xc3"),
    ],
)
def test_record_delimiter_is_the_first_byte(text, delimiter):
    assert record_delimiter(text) == delimiter


@pytest.mark.parametrize(
    "text,count",
    [
        ("0", 0),
        ("12", 12),
        ("", None),
        ("-1", None),
        ("+3", None),
        (" 3", None),
        (chr(0x663), None),
        (chr(0xB2), None),
    ],
)
def test_count_operand_takes_ascii_digits_only(text, count):
    assert count_operand(text) == count
