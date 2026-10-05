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

from mirage.commands.builtin.generic.crossmount.relay.mv import run_mv
from mirage.io.types import IOResult
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import eacces, enoent


@pytest.mark.asyncio
@pytest.mark.parametrize("blocked_op", ["read", "write"])
async def test_cancelled_move_preserves_sources_and_stops_dispatch(blocked_op):
    entered = asyncio.Event()
    pending = asyncio.Event()
    calls: list[tuple[str, str]] = []

    async def dispatch(op, path, **kwargs):
        calls.append((op, path.virtual))
        if op == blocked_op:
            entered.set()
            await pending.wait()
        if op == "stat":
            if path.virtual in {"/a/one", "/a/two"}:
                return FileStat(name="source", type=FileType.FILE), IOResult()
            if path.virtual == "/b":
                return FileStat(name="b", type=FileType.DIRECTORY), IOResult()
            raise enoent(path)
        if op == "read":
            return b"payload", IOResult()
        return None, IOResult()

    scopes = [PathSpec.from_str_path(p) for p in ("/a/one", "/a/two", "/b")]
    task = asyncio.create_task(run_mv(scopes, {}, dispatch))
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not any(op in {"unlink", "rmdir"} for op, _ in calls)
        assert ("read", "/a/two") not in calls
        assert ("write", "/b/two") not in calls
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.asyncio
async def test_failed_destination_write_preserves_move_source():
    calls: list[tuple[str, str]] = []

    async def dispatch(op, path, **kwargs):
        calls.append((op, path.virtual))
        if op == "stat":
            if path.virtual == "/a/one":
                return FileStat(name="one", type=FileType.FILE), IOResult()
            if path.virtual == "/b":
                return FileStat(name="b", type=FileType.DIRECTORY), IOResult()
            raise enoent(path)
        if op == "read":
            return b"payload", IOResult()
        if op == "write":
            raise eacces(path)
        return None, IOResult()

    scopes = [PathSpec.from_str_path(p) for p in ("/a/one", "/b/one")]
    _, io = await run_mv(scopes, {}, dispatch)
    assert io.exit_code == 1
    assert ("write", "/b/one") in calls
    assert not any(op in {"unlink", "rmdir"} for op, _ in calls)
