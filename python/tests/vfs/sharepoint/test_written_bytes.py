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

from mirage.types import MountMode, ReadPolicy, ReadSpec
from mirage.vfs.registry import build_vfs
from mirage.workspace import Workspace
from tests.fixtures.msgraph_api import (
    DRIVE_ID,
    DRIVE_NAME,
    SITE_NAME,
    FakeGraph,
    serve,
)


def _ws(graph: FakeGraph, policy: ReadPolicy) -> Workspace:
    vfs = build_vfs(
        "sharepoint",
        {
            "access_token": "t",
            "graph_base_url": graph.url,
            "site": SITE_NAME,
            "drive": DRIVE_NAME,
        },
    )
    return Workspace(
        {"/m": (vfs, MountMode.WRITE)}, read=ReadSpec(policy=policy)
    )


async def _out(ws: Workspace, line: str) -> bytes:
    result = await ws.shell(line)
    out = await result.materialize_stdout()
    err = await result.stderr_str()
    assert (result.exit_code, err) == (0, ""), line
    return out


def _promote(path: str, data: bytes) -> bytes:
    return data + b"<promoted/>" if path.endswith(".docx") else data


@pytest.mark.asyncio
@pytest.mark.parametrize("policy", [ReadPolicy.BOUNDED, ReadPolicy.FRESH])
async def test_a_read_after_tee_serves_what_the_library_stored(policy):
    # Property promotion rewrites an uploaded Office file; the reply reports
    # the stored size, so the bytes tee sent are dropped and the next cat
    # downloads what the library holds.
    with serve(FakeGraph(drives={DRIVE_ID: {"a.docx": b"old\n"}})) as graph:
        graph.on_upload(_promote)
        ws = _ws(graph, policy)
        try:
            await _out(ws, "echo hi | tee /m/a.docx")
            before = graph.fetches()
            stored = graph.data(DRIVE_ID, "a.docx")
            assert stored == b"hi\n<promoted/>"
            assert await _out(ws, "cat /m/a.docx") == stored
            assert graph.fetches() - before == 1
        finally:
            await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("policy", [ReadPolicy.BOUNDED, ReadPolicy.FRESH])
async def test_a_file_stored_as_sent_stays_warm_after_tee(policy):
    # A plain file is not promoted: the reply agrees with the bytes sent
    # and carries the cTag a later stat reports, so the next cat downloads
    # nothing, under fresh too.
    with serve(FakeGraph(drives={DRIVE_ID: {"a.txt": b"old\n"}})) as graph:
        graph.on_upload(_promote)
        ws = _ws(graph, policy)
        try:
            await _out(ws, "echo hi | tee /m/a.txt")
            before = graph.fetches()
            assert await _out(ws, "cat /m/a.txt") == b"hi\n"
            assert graph.fetches() - before == 0
        finally:
            await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("policy", [ReadPolicy.BOUNDED, ReadPolicy.FRESH])
async def test_a_read_earlier_on_the_line_does_not_outlive_the_write(policy):
    # The read stamps the pre-write cTag; storing its bytes after the line
    # would serve "old" under bounded, and cost a download under fresh.
    with serve(FakeGraph(drives={DRIVE_ID: {"a.txt": b"old\n"}})) as graph:
        ws = _ws(graph, policy)
        try:
            await _out(ws, "cat /m/a.txt; echo hi | tee /m/a.txt")
            before = graph.fetches()
            assert await _out(ws, "cat /m/a.txt") == b"hi\n"
            assert graph.fetches() - before == 0
        finally:
            await ws.close()
