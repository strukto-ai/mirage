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

from mirage.process.handle import ProcessHandle
from mirage.process.types import ProcessInfo, ProcessState
from mirage.types import PathSpec


def _info() -> ProcessInfo:
    return ProcessInfo(
        pid=7,
        session_id="a",
        command="line",
        cwd=PathSpec.from_str_path("/"),
        started_at=0.0,
    )


@pytest.mark.asyncio
async def test_a_finished_runner_reports_its_code_and_its_pid():
    finished: list[int] = []

    async def run() -> int:
        return 3

    info = await ProcessHandle(_info(), run, finished.append).join()
    assert (info.state, info.exit_code, finished) == (
        ProcessState.EXITED,
        3,
        [7],
    )


@pytest.mark.asyncio
async def test_a_failing_runner_exits_1_with_its_failure():
    async def run() -> int:
        raise RuntimeError("boom")

    info = await ProcessHandle(_info(), run, lambda _pid: None).join()
    assert (info.exit_code, info.failure) == (1, "boom")


@pytest.mark.asyncio
async def test_terminate_asks_once_and_the_runner_exits_137():
    started = asyncio.Event()

    async def run() -> int:
        started.set()
        await asyncio.Event().wait()
        return 0

    handle = ProcessHandle(_info(), run, lambda _pid: None)
    await started.wait()
    assert handle.terminate() is True
    assert handle.terminate() is False
    info = await handle.join()
    assert (info.exit_code, info.cancellation_requested) == (137, True)
