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

from mirage import MountMode, RAMResource, Workspace
from mirage.types import FileStat, FileType
from mirage.workspace.executor.find_refs import resolve_newer_refs
from mirage.workspace.mount import MountRegistry


async def _stat(virtual: str) -> FileStat | None:
    if virtual == "/w/ref":
        return FileStat(name="ref",
                        type=FileType.FILE,
                        modified="2020-01-01T00:00:00+00:00")
    return None


def _registry() -> MountRegistry:
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    return ws._registry


@pytest.mark.asyncio
async def test_newer_is_rewritten_to_newermt():
    tokens = ["-newer", "ref", "-name", "x", "-newer", "/w/ref"]
    rewritten, err = await resolve_newer_refs(tokens, ["ref", "/w/ref"],
                                              _registry(), "/w", _stat)
    assert err is None
    assert rewritten == [
        "-newermt", "2020-01-01T00:00:00+00:00", "-name", "x", "-newermt",
        "2020-01-01T00:00:00+00:00"
    ]


@pytest.mark.asyncio
async def test_missing_reference_is_gnu_error():
    tokens = ["-newer", "nope"]
    rewritten, err = await resolve_newer_refs(tokens, ["nope"], _registry(),
                                              "/w", _stat)
    assert rewritten == tokens
    assert err == b"find: 'nope': No such file or directory\n"


async def _out(ws: Workspace, line: str) -> tuple[str, str, int]:
    r = await ws.execute(line, session_id="s")
    return await r.stdout_str(), await r.stderr_str(), r.exit_code


@pytest.mark.asyncio
async def test_newer_and_newermt_in_the_shell():
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    ws.create_session("s")
    await ws.execute(
        "mkdir -p /w/d/sub; printf a > /w/d/a.txt; printf bb > /w/d/b.txt; "
        "printf x > /w/d/sub/c.txt; touch -d '2020-01-01 00:00:00' "
        "/w/d/a.txt; cd /w",
        session_id="s")
    assert await _out(
        ws,
        "find d -newer d/a.txt | sort") == ("d\nd/b.txt\nd/sub\nd/sub/c.txt\n",
                                            "", 0)
    assert await _out(
        ws,
        "find d -newer nope") == ("",
                                  "find: 'nope': No such file or directory\n",
                                  1)
    assert await _out(ws, "find d -newermt 2099-01-01") == ("", "", 0)
    assert await _out(ws,
                      'find d -newermt 2020-01-01 -name "*.txt" | sort') == (
                          "d/b.txt\nd/sub/c.txt\n", "", 0)
    assert await _out(
        ws, r'find d -newer d/a.txt -name "*.txt" -exec cat {} \;') == ("bbx",
                                                                        "", 0)
    assert await _out(ws, "find -newer d/a.txt | sort") == (
        ".\n./d\n./d/b.txt\n./d/sub\n./d/sub/c.txt\n", "", 0)


@pytest.mark.asyncio
async def test_a_link_reference_is_read_by_the_link_policy():
    # GNU find 4.9: -P (the default) compares against a symlink's own
    # mtime, -H and -L against its target's; a dangling reference is its
    # own row under every policy; a loop is an ordinary reference under
    # -P and a refusal when followed.
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    ws.create_session("s")
    await ws.execute(
        "mkdir -p /w/d; printf t > /w/target; printf c > /w/d/cand; cd /w; "
        "touch -d '2020-01-01 00:00:00' target; "
        "touch -d '2021-01-01 00:00:00' d/cand; "
        "touch -d '2019-01-01 00:00:00' d; "
        "ln -s target link; touch -h -d '2022-01-01 00:00:00' link; "
        "ln -s nowhere dangling; touch -h -d '2020-06-01 00:00:00' dangling; "
        "ln -s loop1 loop2; ln -s loop2 loop1; "
        "touch -h -d '2022-01-01 00:00:00' loop1",
        session_id="s")
    assert await _out(ws, "find d -newer link") == ("", "", 0)
    assert await _out(ws, "find -L d -newer link") == ("d/cand\n", "", 0)
    assert await _out(ws, "find -H d -newer link") == ("d/cand\n", "", 0)
    assert await _out(ws, "find -L -P d -newer link") == ("", "", 0)
    assert await _out(ws, "find d -newer dangling") == ("d/cand\n", "", 0)
    assert await _out(ws, "find -L d -newer dangling") == ("d/cand\n", "", 0)
    assert await _out(ws, "find d -newer loop1") == ("", "", 0)
    assert await _out(ws, "find -L d -newer loop1") == (
        "", "find: 'loop1': Too many levels of symbolic links\n", 1)


@pytest.mark.asyncio
async def test_repeated_newer_references_intersect():
    # GNU find 4.9: `-newer old -newer new` keeps only what is newer
    # than both references.
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    ws.create_session("s")
    await ws.execute(
        "printf o > /w/old; printf c > /w/cand; printf n > /w/new; cd /w; "
        "touch -d '2020-01-01 00:00:00' old; "
        "touch -d '2021-01-01 00:00:00' cand; "
        "touch -d '2022-01-01 00:00:00' new",
        session_id="s")
    assert await _out(ws, "find cand -newer old -newer new") == ("", "", 0)
    assert await _out(ws, "find cand -newer new -newer old") == ("", "", 0)
    assert await _out(ws, "find cand -newer old") == ("cand\n", "", 0)
    assert await _out(
        ws, "find cand -newermt 2020-06-01 -newermt 2021-06-01") == ("", "", 0)
