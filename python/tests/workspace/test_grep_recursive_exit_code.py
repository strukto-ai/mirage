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

from mirage.resource.ram import RAMResource
from mirage.types import MountMode
from mirage.workspace import Workspace


def _build_ws() -> Workspace:
    r = RAMResource()
    r._store.dirs.add("/")
    r._store.dirs.add("/src")
    r._store.files["/src/a.js"] = b'legacyFetch("/api");\n'
    return Workspace({"/": (r, MountMode.WRITE)})


async def _run(cmd: str):
    ws = _build_ws()
    try:
        io = await ws.execute(cmd)
        stdout = await io.stdout_str()
        return io.exit_code, stdout
    finally:
        await ws.close()


def test_grep_r_src_returns_exit_0():
    code, out = asyncio.run(_run('grep -rEn "legacyFetch" /src'))
    assert code == 0
    assert "legacyFetch" in out


def test_grep_r_root_returns_exit_0_when_match_found():
    code, out = asyncio.run(_run('grep -rEn "legacyFetch" /'))
    assert code == 0
    assert "legacyFetch" in out


def test_grep_r_cwd_returns_exit_0_when_match_found():
    code, out = asyncio.run(_run('grep -rEn "legacyFetch" .'))
    assert code == 0
    assert "legacyFetch" in out


def test_grep_r_root_no_match_returns_exit_1():
    code, _ = asyncio.run(_run('grep -rEn "doesNotExistAnywhere" /'))
    assert code == 1


def test_grep_r_root_in_if_then():
    code, out = asyncio.run(
        _run('if grep -rEn "legacyFetch" /; then echo FOUND; fi'))
    assert "FOUND" in out


def test_grep_r_root_with_and():
    _, out = asyncio.run(_run('grep -rEn "legacyFetch" / && echo OK'))
    assert "OK" in out


def test_grep_r_root_with_or_does_not_run_right_arm():
    _, out = asyncio.run(
        _run('grep -rEn "legacyFetch" / || echo SHOULD_NOT_PRINT'))
    assert "SHOULD_NOT_PRINT" not in out
