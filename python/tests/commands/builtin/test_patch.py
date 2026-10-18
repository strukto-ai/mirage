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

from mirage.commands.builtin.generic import patch as patch_module
from mirage.commands.builtin.generic.patch import patch_generic
from mirage.commands.config import Context
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from tests.fixtures.driver_ops import ops


def _ws(**files):
    mem = RAMVFS()
    for path, data in files.items():
        asyncio.run(ops(mem).write(PathSpec.from_str_path(path), data=data))
    return Workspace(
        {"/data": (mem, MountMode.WRITE)},
        mode=MountMode.WRITE,
    )


def _run_raw(ws, cmd, cwd="/", stdin=None):
    ws._cwd = cwd
    io = asyncio.run(ws.shell(cmd, stdin=stdin))
    return io.stdout, io


def _bytes(stdout):
    if stdout is None:
        return b""
    if isinstance(stdout, bytes):
        return stdout
    return b"".join(asyncio.run(_collect(stdout)))


async def _collect(ait):
    return [chunk async for chunk in ait]


def test_patch_apply():
    ws = _ws(**{"/hello.txt": b"hello\nworld\n"})
    diff_text = (
        "--- a/hello.txt\n"
        "+++ b/hello.txt\n"
        "@@ -1,2 +1,2 @@\n"
        " hello\n"
        "-world\n"
        "+universe\n"
    )
    _run_raw(ws, "patch -p1", cwd="/data", stdin=diff_text.encode())
    stdout, _ = _run_raw(ws, "cat /data/hello.txt")
    assert b"universe" in _bytes(stdout)


def test_patch_i():
    diff_text = (
        "--- a/hello.txt\n"
        "+++ b/hello.txt\n"
        "@@ -1,2 +1,2 @@\n"
        " hello\n"
        "-world\n"
        "+universe\n"
    )
    ws = _ws(
        **{"/hello.txt": b"hello\nworld\n", "/fix.patch": diff_text.encode()}
    )
    _run_raw(ws, "patch -p1 -i /data/fix.patch", cwd="/data")
    stdout, _ = _run_raw(ws, "cat /data/hello.txt")
    assert b"universe" in _bytes(stdout)


def test_patch_N():
    diff_text = (
        "--- a/hello.txt\n"
        "+++ b/hello.txt\n"
        "@@ -1,2 +1,2 @@\n"
        " hello\n"
        "-world\n"
        "+universe\n"
    )
    ws = _ws(**{"/hello.txt": b"hello\nuniverse\n"})
    _run_raw(ws, "patch -p1 -N", cwd="/data", stdin=diff_text.encode())
    stdout, _ = _run_raw(ws, "cat /data/hello.txt")
    assert b"universe" in _bytes(stdout)


def test_patch_creates_a_missing_file():
    diff_text = "--- a/new.txt\n+++ b/new.txt\n@@ -0,0 +1 @@\n+fresh\n"
    ws = _ws()
    stdout, io = _run_raw(
        ws, "patch -p1", cwd="/data", stdin=diff_text.encode()
    )
    assert _bytes(stdout) == b"patching file new.txt\n"
    assert io.exit_code == 0
    stdout, _ = _run_raw(ws, "cat /data/new.txt")
    assert _bytes(stdout) == b"fresh\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", ["", "/data", "/nested/data"])
@pytest.mark.parametrize("source", ["stdin", "operand", "input"])
async def test_patch_preserves_virtual_paths_for_mounted_io(prefix, source):
    patch_data = (
        b"--- a/hello.txt\n+++ b/hello.txt\n@@ -1,2 +1,2 @@\n"
        b" hello\n-world\n+universe\n"
    )
    files = {"hello.txt": b"hello\nworld\n", "fix.diff": patch_data}
    seen = []

    async def read(path):
        assert path.virtual == prefix + "/" + path.vfs_path
        seen.append(path.vfs_path)
        return files[path.vfs_path]

    async def write(path, data):
        assert path.virtual == prefix + "/" + path.vfs_path
        files[path.vfs_path] = data

    input_path = PathSpec.from_str_path(prefix + "/fix.diff", "fix.diff")
    orig_path = PathSpec.from_str_path(prefix + "/hello.txt", "hello.txt")
    flags = {"p": "1"}
    if source == "input":
        flags["i"] = input_path
    ctx = Context(
        flags=flags,
        mount_prefix=prefix,
        stdin=patch_data if source == "stdin" else None,
    )
    operands = [orig_path, input_path] if source == "operand" else []
    await patch_generic(operands, [], ctx, read, write, True)
    assert "hello.txt" in seen
    assert files["hello.txt"] == b"hello\nuniverse\n"


_PREFIX = [f"p{k}" for k in range(100_000)]


def _needle(body):
    return patch_module._needle_of(patch_module._Hunk(1, 1, "", tuple(body)))


def _counting_sits(monkeypatch):
    calls = []
    real = patch_module._sits

    def counted(*args):
        calls.append(args[2])
        return real(*args)

    monkeypatch.setattr(patch_module, "_sits", counted)
    return calls


def test_patch_tries_an_end_held_hunk_at_one_line(monkeypatch):
    calls = _counting_sits(monkeypatch)
    needle = _needle([" a", " b", " c", "-d", "+D"])
    lines = [*_PREFIX, "a", "b", "c", "d"]
    assert patch_module._seek(lines, needle, 0, 0, 0) == 100_000
    assert calls == [100_000]


def test_patch_tries_a_start_held_hunk_at_one_line(monkeypatch):
    calls = _counting_sits(monkeypatch)
    needle = _needle(["-x", "+X", " a", " b", " c"])
    lines = [*_PREFIX, "x", "a", "b", "c"]
    for fuzz in range(3):
        assert patch_module._seek(lines, needle, fuzz, 0, 0) is None
    assert calls == [0, 0, 0]


def test_patch_knows_every_line_the_search_reaches():
    for expected in range(-6, 12):
        for used in range(8):
            for last in range(-3, 12):
                reached = set(patch_module._tries(expected, used, last))
                for at in range(-14, 16):
                    assert patch_module._is_tried(
                        at, expected, used, last
                    ) == (at in reached)


def test_patch_places_an_end_held_hunk_after_a_long_prefix():
    text = "".join(f"{line}\n" for line in [*_PREFIX, "a", "b", "c", "d"])
    ws = _ws(**{"/f": text.encode()})
    diff_text = "--- f\n+++ f\n@@ -1,4 +1,4 @@\n a\n b\n c\n-d\n+D\n"
    stdout, io = _run_raw(ws, "patch", cwd="/data", stdin=diff_text.encode())
    assert _bytes(stdout) == (
        b"patching file f\nHunk #1 succeeded at 100001 (offset 100000 lines).\n"
    )
    assert io.exit_code == 0
