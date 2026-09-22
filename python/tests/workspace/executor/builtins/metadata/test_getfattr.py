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
from mirage.workspace.executor.builtins.metadata.getfattr import encode_value

# Every expectation below is what Debian's attr 2.5.2 printed for the
# same line in docker (debian:stable-slim).
USAGE = ("Usage: getfattr [-hRLP] [-n name|-d] [-e en] [-m pattern] path...\n"
         "Try `getfattr --help' for more information.\n")


async def _seeded() -> Workspace:
    ws = Workspace({"/r/": RAMVFS()}, mode=MountMode.WRITE)
    await ws.shell("mkdir /r/d && echo hi > /r/d/f && ln -s f /r/d/l")
    await ws.vfs.setxattr("/r/d/f", "user.b", b"two")
    await ws.vfs.setxattr("/r/d/f", "user.a", b"one")
    await ws.vfs.setxattr("/r/d/f", "user.nl", b"a\nb")
    await ws.vfs.setxattr("/r/d/f", "trusted.t", b"tee")
    return ws


async def _run(ws: Workspace, line: str) -> tuple[int, bytes, str]:
    r = await ws.shell(f"cd /r && {line}")
    return r.exit_code, await r.materialize_stdout(), await r.stderr_str()


@pytest.mark.parametrize("value, encoding, shown", [
    (b"one", None, b'"one"'),
    (b"", None, b'""'),
    (b"a\nb", None, b"0sYQpi"),
    (b"a\nb", "text", b'"a\\012b"'),
    (b"\nabcdefg", None, b'"\\012abcdefg"'),
    (b"abc\0", None, b'"abc"'),
    (b'"q"\\', None, b'"\\"q\\"\\\\"'),
    (b"caf\xc3\xa9", None, b"0sY2Fmw6k="),
    (b"hi", "hex", b"0x6869"),
    (b"", "base64", b"0s"),
])
def test_encode_value_matches_getfattr(value, encoding, shown):
    assert encode_value(value, encoding) == shown


@pytest.mark.asyncio
async def test_names_are_sorted_under_a_file_header():
    code, out, err = await _run(await _seeded(), "getfattr d/f")
    assert (code, err) == (0, "")
    assert out == b"# file: d/f\nuser.a\nuser.b\nuser.nl\n\n"


@pytest.mark.asyncio
async def test_dump_prints_values_and_hides_other_namespaces():
    _, out, _ = await _run(await _seeded(), "getfattr -d d/f")
    assert out == (b'# file: d/f\nuser.a="one"\nuser.b="two"\n'
                   b"user.nl=0sYQpi\n\n")
    _, every, _ = await _run(await _seeded(), "getfattr -d -m - d/f")
    assert b'trusted.t="tee"' in every


@pytest.mark.asyncio
async def test_name_and_only_values():
    ws = await _seeded()
    _, out, _ = await _run(ws, "getfattr -n user.a -e hex d/f")
    assert out == b"# file: d/f\nuser.a=0x6f6e65\n\n"
    _, bare, _ = await _run(ws, "getfattr -n user.a --only-values d/f")
    assert bare == b"one"


@pytest.mark.asyncio
async def test_a_missing_attribute_and_a_missing_file():
    ws = await _seeded()
    assert await _run(
        ws, "getfattr -n user.zz d/f") == (1, b"",
                                           "d/f: user.zz: No such attribute\n")
    assert await _run(ws, "getfattr -d d/nope") == (
        1, b"", "getfattr: d/nope: No such file or directory\n")


@pytest.mark.asyncio
async def test_h_reads_the_links_own_attributes():
    ws = await _seeded()
    _, followed, _ = await _run(ws, "getfattr -n user.a d/l")
    assert followed == b'# file: d/l\nuser.a="one"\n\n'
    assert await _run(ws, "getfattr -d -h d/l") == (0, b"", "")


@pytest.mark.asyncio
async def test_an_absolute_path_loses_its_leading_slash_in_the_header():
    ws = await _seeded()
    code, out, err = await _run(ws, "getfattr -n user.a /r/d/f")
    assert out == b'# file: r/d/f\nuser.a="one"\n\n'
    assert err == "getfattr: Removing leading '/' from absolute path names\n"
    _, kept, _ = await _run(ws, "getfattr -n user.a --absolute-names /r/d/f")
    assert kept.startswith(b"# file: /r/d/f\n")


@pytest.mark.asyncio
async def test_messages_name_an_absolute_path_as_typed():
    # No header is printed, so there is no note about stripping one.
    ws = await _seeded()
    assert await _run(ws, "getfattr -n user.zz /r/d/f") == (
        1, b"", "/r/d/f: user.zz: No such attribute\n")
    assert await _run(ws, "getfattr -n user.a /r/d/nope") == (
        1, b"", "getfattr: /r/d/nope: No such file or directory\n")


@pytest.mark.asyncio
async def test_an_empty_match_matches_every_name():
    _, out, _ = await _run(await _seeded(), "getfattr -m '' d/f")
    assert b"trusted.t\n" in out


@pytest.mark.asyncio
async def test_recursive_walk_reports_links_without_descending():
    _, out, _ = await _run(await _seeded(), "getfattr -R -n user.b d")
    assert out == (b'# file: d/f\nuser.b="two"\n\n'
                   b'# file: d/l\nuser.b="two"\n\n')


@pytest.mark.asyncio
@pytest.mark.parametrize("line, first", [
    ("getfattr", ""),
    ("getfattr -Z d/f", "getfattr: invalid option -- 'Z'\n"),
    ("getfattr -n", "getfattr: option requires an argument -- 'n'\n"),
    ("getfattr -e bogus -d d/f", ""),
])
async def test_usage_errors_exit_2_with_the_usage_block(line, first):
    assert await _run(await _seeded(), line) == (2, b"", first + USAGE)


@pytest.mark.asyncio
async def test_a_bad_match_pattern():
    assert await _run(await _seeded(), "getfattr -m '[' -d d/f") == (
        1, b"", 'getfattr: invalid regular expression "["\n')
