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
import subprocess

import pytest

from mirage.server.registry import WorkspaceRegistry
from mirage.server.summary import (
    _describe_vfs,
    make_detail,
    make_stopped_detail,
)
from mirage.types import MountBackend, MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

ASTRAL = "\U00010400"


class _DescribedVFS(RAMVFS):
    def __init__(self, text: str) -> None:
        super().__init__()
        self.vfs_md = text


def test_short_vfs_md_is_returned_whole():
    assert _describe_vfs(_DescribedVFS("hello")) == "hello"
    assert _describe_vfs(_DescribedVFS("")) == ""


def test_budget_counts_code_points():
    # 40 ascii plus 45 Deseret letters is 85 code points and 130 UTF-16
    # units, so the typescript twin ellipsized a text this side leaves
    # whole -- and its cut landed inside the 40th surrogate pair.
    text = "a" * 40 + ASTRAL * 45
    assert _describe_vfs(_DescribedVFS(text)) == text


def test_ellipsizes_on_a_code_point_boundary():
    result = _describe_vfs(_DescribedVFS(ASTRAL * 130))
    assert result == ASTRAL * 119 + "…"
    assert len(result) == 120
    assert "�" not in result


def test_trailing_whitespace_is_dropped_before_the_ellipsis():
    text = "x" * 118 + "  " + "y" * 10
    assert _describe_vfs(_DescribedVFS(text)) == "x" * 118 + "…"


@pytest.mark.asyncio
async def test_in_flight_jobs_counts_only_running_jobs():
    registry = WorkspaceRegistry()
    entry = registry.add(Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE))
    runner = entry.runner
    try:
        await runner.call(runner.ws.shell("true &"))
        await runner.call(runner.ws.shell("sleep 30 &"))
        await asyncio.sleep(0.2)
        detail = await make_detail(entry, verbose=True)
        assert detail.internals is not None
        assert detail.internals.in_flight_jobs == 1
    finally:
        await registry.remove(entry.id)


@pytest.mark.asyncio
async def test_the_detail_is_read_on_the_workspace_loop(monkeypatch):
    registry = WorkspaceRegistry()
    entry = registry.add(Workspace({"/data": RAMVFS()}, mode=MountMode.WRITE))
    runner = entry.runner
    history = runner.ws.observer.command_events
    loops = []

    async def recording():
        loops.append(asyncio.get_running_loop())
        return await history()

    monkeypatch.setattr(runner.ws.observer, "command_events", recording)
    try:
        await make_detail(entry, verbose=True)
        assert loops == [runner.loop]
    finally:
        await registry.remove(entry.id)


class _FakeThread:
    def __init__(self):
        self.alive = True


@pytest.mark.asyncio
async def test_the_detail_names_each_mount_backend_and_mountpoint(monkeypatch):
    monkeypatch.setattr(
        "mirage.workspace.fuse.mount_background",
        lambda *_args, **_kwargs: _FakeThread(),
    )
    monkeypatch.setattr(subprocess, "run", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        "mirage.workspace.fuse.unmount_with_fusermount",
        lambda _mountpoint: None,
    )
    ws = Workspace(
        {"/data": RAMVFS(), "/notes": RAMVFS()}, mode=MountMode.WRITE
    )
    ws.add_fuse_mount("/data", "/tmp/mp-data")
    registry = WorkspaceRegistry()
    entry = registry.add(ws)
    try:
        detail = await make_detail(entry)
        got = {m.prefix: (m.backend, m.mountpoint) for m in detail.mounts}
        assert got["/data/"] == (MountBackend.FUSE, "/tmp/mp-data")
        assert got["/notes/"] == (MountBackend.WORKSPACE, None)
    finally:
        await registry.remove(entry.id)


def test_a_stopped_detail_names_the_backend_with_no_mountpoint():
    config = {
        "mounts": {
            "/data": {"vfs": "ram", "backend": "fuse", "mountpoint": "/x"},
            "/notes": {"vfs": "ram"},
        }
    }
    detail = make_stopped_detail("w", config, 0.0)
    got = {m.prefix: (m.backend, m.mountpoint) for m in detail.mounts}
    assert got == {
        "/data/": (MountBackend.FUSE, None),
        "/notes/": (MountBackend.WORKSPACE, None),
    }
