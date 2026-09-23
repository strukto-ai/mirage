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

from mirage import MountMode, Workspace
from mirage.vfs.ram import RAMVFS
from mirage.workspace.executor.builtins.metadata.setfattr import decode_value

# Every expectation below is what Debian's attr 2.5.2 did for the same
# line in docker (debian:stable-slim).
USAGE = ("Usage: setfattr {-n name} [-v value] [-h] file...\n"
         "       setfattr {-x name} [-h] file...\n"
         "Try `setfattr --help' for more information.\n")


async def _ws() -> Workspace:
    ws = Workspace({"/r/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("echo hi > /r/f && ln -s f /r/l")
    return ws


async def _run(ws: Workspace, line: str) -> tuple[int, str]:
    r = await ws.shell(f"cd /r && {line}")
    return r.exit_code, await r.stderr_str()


@pytest.mark.parametrize("typed, stored", [
    ("two", b"two"),
    ("0x6869", b"hi"),
    ("0X6869", b"hi"),
    ("0saGk=", b"hi"),
    ("0S aGk=", b"hi"),
    ('"q v"', b"q v"),
    ('"a\\"b"', b'a"b'),
    ("a\\\\b", b"a\\b"),
    ("a\\012b", b"a\nb"),
    ("\\141", b"a"),
    ("a\\qb", b"a\\qb"),
    ('"unterminated', b'"unterminated'),
    ("0x", b"0x"),
])
def test_decode_value_matches_setfattr(typed, stored):
    assert decode_value(typed) == stored


@pytest.mark.parametrize("typed", ["0x6", "0xzz", "0s!!!"])
def test_malformed_encodings_are_refused(typed):
    assert decode_value(typed) is None


@pytest.mark.asyncio
async def test_set_then_remove():
    ws = await _ws()
    assert await _run(ws, "setfattr -n user.a -v one f") == (0, "")
    assert await ws.vfs.getxattr("/r/f", "user.a") == b"one"
    assert await _run(ws, "setfattr -n user.empty f") == (0, "")
    assert await ws.vfs.getxattr("/r/f", "user.empty") == b""
    assert await _run(ws, "setfattr -x user.a f") == (0, "")
    assert await _run(
        ws, "setfattr -x user.a f") == (1, "setfattr: f: No such attribute\n")


@pytest.mark.asyncio
async def test_h_writes_the_link_itself():
    ws = await _ws()
    assert await _run(ws, "setfattr -h -n user.own -v o l") == (0, "")
    assert await ws.vfs.listxattr("/r/l", nofollow=True) == ["user.own"]
    assert await ws.vfs.listxattr("/r/f") == []


@pytest.mark.asyncio
async def test_a_missing_file_is_reported_and_the_rest_written():
    ws = await _ws()
    assert await _run(ws, "setfattr -n user.a -v 1 nope f") == (
        1, "setfattr: nope: No such file or directory\n")
    assert await ws.vfs.getxattr("/r/f", "user.a") == b"1"


@pytest.mark.asyncio
async def test_bad_input_encoding():
    assert await _run(
        await _ws(),
        "setfattr -n user.a -v 0x6 f") == (1, "bad input encoding\n")


@pytest.mark.asyncio
@pytest.mark.parametrize("line, first", [
    ("setfattr f", ""),
    ("setfattr -n user.a -x user.b f", ""),
    ("setfattr -x user.a -v q f", ""),
    ("setfattr -n user.a", ""),
    ("setfattr -n user.a -v",
     "setfattr: option requires an argument -- 'v'\n"),
])
async def test_usage_errors_exit_2_with_the_usage_block(line, first):
    assert await _run(await _ws(), line) == (2, first + USAGE)
