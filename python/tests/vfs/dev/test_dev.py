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

from mirage import Mount, Workspace
from mirage.cache.index import IndexConfig
from mirage.commands.cli.types import CLI, CLIHandler
from mirage.commands.spec.types import CommandSpec
from mirage.context import reset_current_session, set_current_session
from mirage.io.types import IOResult
from mirage.vfs.dev.dev import DevVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace.session.session import SessionState


@pytest.mark.asyncio
async def test_process_substitution_is_private_to_its_session():
    ready, release = asyncio.Event(), asyncio.Event()

    async def hold(inv):
        ready.set()
        await release.wait()
        return None, IOResult()

    ws = Workspace({"/data": RAMVFS()}, mode="exec")
    ws.create_session("owner")
    ws.create_session("peer")
    ws.register_cli(
        "hold",
        CLI(spec=CommandSpec(name="hold"), handlers={"": CLIHandler(fn=hold)}),
    )
    owner = asyncio.create_task(
        ws.shell(
            'consume() { ls /dev/fd >/dev/null; hold; cat "$1"; }; '
            "consume <(echo private)",
            session_id="owner",
        )
    )
    try:
        await asyncio.wait_for(ready.wait(), timeout=5)
        for command in [
            "cat /dev/fd/63",
            "stat /dev/fd/63",
            "ls /dev/fd",
            "echo corrupt > /dev/fd/63",
            "rm /dev/fd/63",
            "mkdir -p /dev/fd/63",
            "mv /dev/fd /dev/stolen",
        ]:
            result = await ws.shell(command, session_id="peer")
            assert result.exit_code != 0, command
            assert b"private" not in (result.stdout or b"")
        result = await ws.shell("cat <(echo peer)", session_id="peer")
        assert result.stdout == b"peer\n"
        release.set()
        result = await owner
        assert result.exit_code == 0
        assert result.stdout == b"private\n"
        result = await ws.shell("ls /dev", session_id="owner")
        assert b"fd" not in (result.stdout or b"")
    finally:
        release.set()
        await owner
        await ws.close()


@pytest.mark.asyncio
async def test_process_substitution_cleanup_preserves_reused_descriptor():
    old_ready, old_release = asyncio.Event(), asyncio.Event()
    new_ready, new_release = asyncio.Event(), asyncio.Event()

    async def hold_old(inv):
        old_ready.set()
        await old_release.wait()
        return None, IOResult()

    async def hold_new(inv):
        new_ready.set()
        await new_release.wait()
        return None, IOResult()

    ws = Workspace({"/data": RAMVFS()}, mode="exec")
    ws.create_session("owner")
    ws.create_session("peer")
    ws.register_cli(
        "hold-old",
        CLI(
            spec=CommandSpec(name="hold-old"),
            handlers={"": CLIHandler(fn=hold_old)},
        ),
    )
    ws.register_cli(
        "hold-new",
        CLI(
            spec=CommandSpec(name="hold-new"),
            handlers={"": CLIHandler(fn=hold_new)},
        ),
    )
    owner = asyncio.create_task(
        ws.shell(
            'consume() { echo "$1"; rm "$1"; hold-old; }; consume <(echo old)',
            session_id="owner",
        )
    )
    peer = None
    try:
        await asyncio.wait_for(old_ready.wait(), timeout=5)
        peer = asyncio.create_task(
            ws.shell(
                'consume() { echo "$1"; hold-new; cat "$1"; }; '
                "consume <(echo new)",
                session_id="peer",
            )
        )
        await asyncio.wait_for(new_ready.wait(), timeout=5)
        old_release.set()
        old_result = await owner
        assert old_result.exit_code == 0
        assert old_result.stdout == b"/dev/fd/63\n"
        new_release.set()
        new_result = await peer
        assert new_result.exit_code == 0
        assert new_result.stdout == b"/dev/fd/63\nnew\n"
        assert (await ws.shell("ls /dev/fd", session_id="peer")).exit_code != 0
    finally:
        old_release.set()
        new_release.set()
        await owner
        if peer is not None:
            await peer
        await ws.close()


def test_stale_allocation_cannot_write_or_release_reused_input():
    dev = DevVFS()
    token = set_current_session(SessionState(session_id="owner"))
    try:
        path, old_allocation = dev.allocate_input()
        del dev._store.files[path[4:]]
        new_path, new_allocation = dev.allocate_input()
        assert new_path == path
        dev.set_input(new_path, new_allocation, b"new")
        dev._store.modified[path[4:]] = "2026-09-23T00:00:00Z"
        dev._store.attrs[path[4:]] = {"mode": 0o600}
        with pytest.raises(FileNotFoundError):
            dev.set_input(path, old_allocation, b"stale")
        dev.release_input(path, old_allocation)
        assert dev._store.files[path[4:]] == b"new"
        assert dev._store.modified[path[4:]] == "2026-09-23T00:00:00Z"
        assert dev._store.attrs[path[4:]] == {"mode": 0o600}
        dev.release_input(new_path, new_allocation)
        dev.release_input(new_path, new_allocation)
        assert path[4:] not in dev._store.files
        assert path[4:] not in dev._store.modified
        assert path[4:] not in dev._store.attrs
    finally:
        reset_current_session(token)


@pytest.mark.asyncio
@pytest.mark.parametrize("configured", [False, True])
async def test_alternate_dev_mount_does_not_cache_session_descriptors(
    configured,
):
    dev = DevVFS()
    ws = Workspace(
        {
            "/devices": Mount(dev, index=IndexConfig(ttl=120))
            if configured
            else dev
        },
        index=IndexConfig(ttl=600),
    )
    owner = ws.create_session("owner")
    ws.create_session("peer")
    token = set_current_session(owner)
    try:
        path, allocation = dev.allocate_input()
        dev.set_input(path, allocation, b"private")
    finally:
        reset_current_session(token)
    try:
        result = await ws.shell("ls /devices/fd", session_id="owner")
        assert result.exit_code == 0
        assert await result.stdout_str() == "63\n"
        result = await ws.shell("ls /devices/fd", session_id="peer")
        assert "63" not in await result.stdout_str()
        assert result.exit_code != 0
    finally:
        await ws.close()
