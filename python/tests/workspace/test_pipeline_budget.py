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

from mirage import MountMode, Workspace
from mirage.resource.ram import RAMResource


async def _slow_stdin():
    await asyncio.sleep(5)
    yield b"late\n"


async def _quick_stdin():
    yield b"hi\n"


async def _probed_stdin(flag):
    try:
        await asyncio.sleep(5)
        yield b"late\n"
    finally:
        flag["closed"] = True


async def _multiline_stdin():
    for i in range(1000):
        yield f"line{i}\n".encode()


def _ws():
    return Workspace({"/data": RAMResource()}, mode=MountMode.WRITE)


@pytest.mark.asyncio
async def test_pipeline_budget_bounds_slow_final_stage():
    ws = _ws()
    ws.get_session(ws.default_session_id).pipeline_timeout_seconds = 0.1
    r = await ws.execute("cat | cat", stdin=_slow_stdin())
    assert r.exit_code == 124
    assert "pipeline: timed out after 0.1s" in (await r.stderr_str())


@pytest.mark.asyncio
async def test_pipeline_without_budget_is_unbounded():
    ws = _ws()
    r = await ws.execute("cat | cat", stdin=_quick_stdin())
    assert r.exit_code == 0
    assert (await r.stdout_str()) == "hi\n"


@pytest.mark.asyncio
async def test_pipeline_budget_tears_down_upstream_producer():
    ws = _ws()
    ws.get_session(ws.default_session_id).pipeline_timeout_seconds = 0.1
    flag = {"closed": False}
    r = await ws.execute("cat | cat", stdin=_probed_stdin(flag))
    assert r.exit_code == 124
    assert flag["closed"]


@pytest.mark.asyncio
async def test_early_finish_reports_downstream_code_not_sigpipe():
    ws = _ws()
    session = ws.get_session(ws.default_session_id)
    session.shell_options["pipefail"] = True
    r = await ws.execute("cat | head -n1", stdin=_multiline_stdin())
    assert r.exit_code == 0
    assert (await r.stdout_str()) == "line0\n"
