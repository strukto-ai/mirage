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


async def _workspace_at(cwd: str) -> Workspace:
    ws = Workspace({"/": RAMResource()}, mode=MountMode.WRITE)
    await ws.execute(f"mkdir -p {cwd}")
    await ws.execute(f"cd {cwd}")
    return ws


@pytest.mark.asyncio
async def test_redirect_bare_target_resolves_against_cwd():
    # A redirect target is a path by definition: `> BARE` must write
    # cwd/BARE even though the bare word would classify as text.
    ws = await _workspace_at("/data")
    await ws.execute("echo hi > BARE")
    io = await ws.execute("cat /data/BARE")
    assert (io.stdout or b"") == b"hi\n"


@pytest.mark.asyncio
async def test_redirect_extensionless_relative_target():
    ws = await _workspace_at("/data")
    await ws.execute("mkdir -p /data/sub")
    await ws.execute("echo hi > sub/OUT")
    io = await ws.execute("cat /data/sub/OUT")
    assert (io.stdout or b"") == b"hi\n"


@pytest.mark.asyncio
async def test_redirect_append_relative_target():
    ws = await _workspace_at("/data")
    await ws.execute("echo one > LOG")
    await ws.execute("echo two >> LOG")
    io = await ws.execute("cat /data/LOG")
    assert (io.stdout or b"") == b"one\ntwo\n"


@pytest.mark.asyncio
async def test_redirect_stdin_relative_source():
    ws = await _workspace_at("/data")
    await ws.execute("echo hi > IN")
    io = await ws.execute("wc -l < IN")
    assert (io.stdout or b"").strip() == b"1"


@pytest.mark.asyncio
async def test_redirect_absolute_target_unchanged():
    ws = await _workspace_at("/data")
    await ws.execute("echo hi > /data/ABS")
    io = await ws.execute("cat /data/ABS")
    assert (io.stdout or b"") == b"hi\n"
