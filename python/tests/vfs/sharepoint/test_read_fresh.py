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

from mirage.cache.file.config import CacheConfig
from mirage.types import MountMode, ReadPolicy, ReadSpec
from mirage.vfs.ram import RAMVFS
from mirage.vfs.registry import build_vfs
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from tests.fixtures.graph_drive import DRIVE_NAME, SITE_NAME, GraphDrive

OLD = b"version one\n"
NEW = b"version two, longer\n"
SCOPED = "/m/a.txt"
UNSCOPED = f"/m/{SITE_NAME}/{DRIVE_NAME}/a.txt"


def _vfs(drive: GraphDrive, scoped: bool = True):
    if scoped:
        return build_vfs("sharepoint", drive.config("sharepoint"))
    return build_vfs(
        "sharepoint",
        {"access_token": drive.token, "graph_base_url": drive.run.url},
    )


def _ws(vfs) -> Workspace:
    return Workspace(
        {
            "/m": Mount(
                vfs=vfs,
                mode=MountMode.WRITE,
                read=ReadSpec(policy=ReadPolicy.FRESH),
            ),
            "/r": (RAMVFS(), MountMode.WRITE),
        },
        cache=CacheConfig(),
    )


async def _out(ws: Workspace, line: str) -> bytes:
    result = await ws.shell(line)
    out = await result.materialize_stdout()
    err = await result.stderr_str()
    assert (result.exit_code, err) == (0, ""), line
    return out


async def _seeded(drive: GraphDrive) -> None:
    await drive.write("a.txt", OLD)
    await drive.run.record_requests()


# The unscoped mount resolves the site and drive out of the path on every
# operation, a different road to the same item than the scoped one.
ROWS = [
    pytest.param(True, "cat {v}", id="scoped-stream"),
    pytest.param(True, "cp {v} /r/x && cat /r/x", id="scoped-bytes"),
    pytest.param(False, "cat {v}", id="unscoped-stream"),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("scoped,line", ROWS)
async def test_a_write_between_the_token_and_the_bytes_is_refetched(
    sharepoint, scoped, line
):
    await _seeded(sharepoint)
    first = await sharepoint.ctag("a.txt")
    ws = _ws(_vfs(sharepoint, scoped))
    line = line.format(v=SCOPED if scoped else UNSCOPED)
    try:
        # The file changes after the bytes are taken and before they are
        # sent, so the read holds OLD while Graph already holds NEW. A
        # token read after the bytes would label OLD with NEW's cTag.
        await sharepoint.write_after_the_bytes("a.txt", NEW)
        assert await _out(ws, line) == OLD
        assert await sharepoint.ctag("a.txt") != first
        before = await sharepoint.fetches()
        assert await _out(ws, line) == NEW
        assert await sharepoint.fetches() - before == 1
        assert await sharepoint.reach() == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_listed_ctag_never_answers_for_a_changed_file(sharepoint):
    await _seeded(sharepoint)
    first = await sharepoint.ctag("a.txt")
    ws = _ws(_vfs(sharepoint))
    try:
        # The listing leaves the first cTag in the mount index. A probe
        # that trusted it would match the one the cache holds and serve OLD.
        await _out(ws, "ls /m")
        # The fixture held: the mount index answers a stat with that cTag
        # and no request of its own, so there is a stale row to trust.
        mount = ws.mount("/m")
        items = await sharepoint.count("item")
        listed = await mount.call("stat", "/m/a.txt", index=mount.index)
        assert (listed.fingerprint, await sharepoint.count("item")) == (
            first,
            items,
        )
        assert await _out(ws, f"cat {SCOPED}") == OLD
        await sharepoint.write("a.txt", NEW)
        assert await _out(ws, f"cat {SCOPED}") == NEW
        assert (
            await sharepoint.count("children"),
            await sharepoint.reach(children_allowed=1),
        ) == (1, [])
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_metadata_edit_does_not_refetch(sharepoint):
    await _seeded(sharepoint)
    ws = _ws(_vfs(sharepoint))
    try:
        await _out(ws, f"cat {SCOPED}")
        # A rename or a property edit moves the eTag and the stamp, never
        # the cTag, so the cached bytes are still current.
        await sharepoint.touch("a.txt")
        assert await _out(ws, f"cat {SCOPED}") == OLD
        assert await sharepoint.fetches() == 0
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("warm", [False, True])
async def test_hidden_unscoped_site_has_no_internal_name_alias(
    sharepoint, warm
):
    await _seeded(sharepoint)
    ws = _ws(_vfs(sharepoint, scoped=False))
    try:
        if warm:
            assert await _out(ws, f"cat {UNSCOPED}") == OLD
        ws.create_session(
            "hidden", profile={"paths": {"hide": [f"/m/{SITE_NAME}"]}}
        )
        token = await sharepoint.ctag("a.txt")
        await sharepoint.run.record_requests()
        alias = f"/m/{SITE_NAME.lower()}/{DRIVE_NAME}"
        for command in [
            f"cat {alias}/a.txt",
            f"echo changed > {alias}/a.txt",
        ]:
            result = await ws.shell(command, session_id="hidden")
            assert result.exit_code != 0, command
            assert OLD not in await result.materialize_stdout(), command
        listing = await ws.shell(f"ls {alias}", session_id="hidden")
        assert await listing.materialize_stdout() == b""
        assert await sharepoint.ctag("a.txt") == token
        assert await sharepoint.fetches() == 0
        assert await sharepoint.count("children") == 0
        assert await sharepoint.count("drives") == 0
        assert await _out(ws, f"cat {UNSCOPED}") == OLD
    finally:
        await ws.close()
