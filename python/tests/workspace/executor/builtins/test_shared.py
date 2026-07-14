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

from dataclasses import replace

import pytest

from mirage.io import IOResult
from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace
from mirage.workspace.executor.builtins.shared import (  # yapf: disable
    abs_path, expand_operands, fail, finish, ok, operand_text, split_flags,
    split_value_flags)


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
    io = IOResult(writes={"/data/f.txt": b""})
    out, result_io, node = finish("touch", [], io=io)
    assert out is None
    assert result_io.exit_code == 0
    assert result_io.writes == {"/data/f.txt": b""}
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


def test_split_flags_collects_known():
    flags, operands = split_flags(["-sf", "a", "b"], "sfnv")
    assert flags == {"s", "f"}
    assert operands == ["a", "b"]


def test_split_flags_unknown_becomes_operand():
    flags, operands = split_flags(["-q", "a"], "sfnv")
    assert flags == set()
    assert operands == ["-q", "a"]


def test_split_flags_double_dash_ends_parsing():
    flags, operands = split_flags(["-s", "--", "-f"], "sfnv")
    assert flags == {"s"}
    assert operands == ["-f"]


def test_split_value_flags_detached_value():
    flags, values, operands, bad = split_value_flags(
        ["-c", "-t", "202601021530", "f.txt"], "acmh", "tdr")
    assert bad is None
    assert flags == {"c"}
    assert values == {"t": "202601021530"}
    assert operands == ["f.txt"]


def test_split_value_flags_attached_value():
    _flags, values, operands, bad = split_value_flags(["-t202601021530", "f"],
                                                      "acmh", "tdr")
    assert bad is None
    assert values == {"t": "202601021530"}
    assert operands == ["f"]


def test_split_value_flags_reports_unknown():
    _flags, _values, _operands, bad = split_value_flags(["-q", "f"], "Rvf", "")
    assert bad == "q"


@pytest.mark.asyncio
async def test_expand_operands_globs():
    ws = Workspace({"/data": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute("echo a > /data/a.txt && echo b > /data/b.txt")
    namespace = ws._namespace
    glob_spec = replace(PathSpec.from_str_path("/data/*.txt"),
                        pattern="*.txt",
                        resolved=False)
    expanded = await expand_operands(namespace, [glob_spec, "/data/c.md"])
    virtuals = sorted(p.virtual for p in expanded)
    assert virtuals == ["/data/a.txt", "/data/b.txt", "/data/c.md"]
