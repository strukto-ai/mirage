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

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from mirage.cache.file.config import CacheConfig
from mirage.context import session_context as caller
from mirage.core.onedrive.read import read
from mirage.core.onedrive.stream import read_stream
from mirage.observe.context import RecordingScope
from mirage.types import MountMode, PathSpec, ReadPolicy, ReadSpec
from mirage.vfs.ram import RAMVFS
from mirage.vfs.registry import build_vfs
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from tests.fixtures.graph_drive import GraphDrive

OLD = b"version one\n"
NEW = b"version two, longer\n"
CAT = "cat /m/a.txt"
CP = "cp /m/a.txt /r/x && cat /r/x"


def _vfs(drive: GraphDrive):
    return build_vfs("onedrive", drive.config("onedrive"))


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


def _spec(path: str) -> PathSpec:
    return PathSpec(
        virtual="/" + path, directory="/", vfs_path=path, raw_path="/" + path
    )


async def _seeded(drive: GraphDrive, **files: bytes) -> None:
    for path, data in files.items():
        await drive.write(path, data)
    await drive.run.record_requests()


@pytest.mark.asyncio
@pytest.mark.parametrize("line", [CAT, CP], ids=["stream", "bytes"])
async def test_a_write_between_the_token_and_the_bytes_is_refetched(
    onedrive, line
):
    await _seeded(onedrive, **{"a.txt": OLD})
    first = await onedrive.ctag("a.txt")
    ws = _ws(_vfs(onedrive))
    try:
        # The file changes after the bytes are taken and before they are
        # sent, so the read holds OLD while Graph already holds NEW. A
        # token read after the bytes would label OLD with NEW's cTag.
        await onedrive.write_after_the_bytes("a.txt", NEW)
        assert await _out(ws, line) == OLD
        assert await onedrive.ctag("a.txt") != first
        before = await onedrive.fetches()
        assert await _out(ws, line) == NEW
        assert await onedrive.fetches() - before == 1
        assert await onedrive.reach() == []
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_unrecorded_read_fetches_the_bare_item_then_its_bytes(
    onedrive,
):
    await _seeded(onedrive, **{"a.txt": OLD})
    vfs = _vfs(onedrive)
    try:
        data = await read(vfs.accessor, _spec("a.txt"))
    finally:
        await vfs.accessor.close()
    assert data == OLD
    # No version history: the revision only matters to a snapshot, and only
    # a recorded read can land in one.
    assert await onedrive.log() == [
        ("item", "a.txt", ""),
        ("download", "a.txt", ""),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("slot", ["bytes", "stream"])
async def test_a_recorded_read_keeps_the_revision_snapshots_pin(
    onedrive, slot
):
    await _seeded(onedrive, **{"a.txt": OLD})
    await _seeded(onedrive, **{"a.txt": NEW})
    vfs = _vfs(onedrive)
    scope = RecordingScope()
    try:
        if slot == "bytes":
            data = await read(vfs.accessor, _spec("a.txt"))
        else:
            data = b"".join(
                [c async for c in read_stream(vfs.accessor, _spec("a.txt"))]
            )
    finally:
        scope.close()
        await vfs.accessor.close()
    assert data == NEW
    assert await onedrive.queries("item") == ["$expand=versions"]
    assert [(r.fingerprint, r.revision) for r in scope.records] == [
        (await onedrive.ctag("a.txt"), "2.0")
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("pin,expected", [("1.0", OLD), ("9.0", None)])
async def test_a_pinned_read_gets_that_versions_bytes(onedrive, pin, expected):
    await _seeded(onedrive, **{"a.txt": OLD})
    await _seeded(onedrive, **{"a.txt": NEW})
    vfs = _vfs(onedrive)
    token = caller.bind_caller(
        caller.current_caller().changed({"revisions": {"/a.txt": pin}})
    )
    try:
        if expected is None:
            with pytest.raises(FileNotFoundError):
                await read(vfs.accessor, _spec("a.txt"))
            data = None
        else:
            data = await read(vfs.accessor, _spec("a.txt"))
    finally:
        caller.reset_caller(token)
        await vfs.accessor.close()
    # A snapshot pin reads the version it names, straight from its content
    # route, even after a rewrite; a version the item never had is absent.
    assert data == expected
    assert [name for name, _, _ in await onedrive.log()] == [
        "item",
        "version_content",
    ]


# Measured on the first green run, then pinned. The listing makes every
# ordinary stat an index hit, so what is left is the reconcile probe: a
# command pays it at its first lookup of the operand its line names, and
# the cache gate reuses it. A warm read downloads nothing and lists
# nothing.
WARM = [
    (CAT, 1),
    ("cat /m/a.txt | head -c 1", 1),
    ("cp /m/a.txt /r/a.txt", 1),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("line,items", WARM)
async def test_a_warm_fresh_read_costs_one_item_per_probe(
    onedrive, line, items
):
    await _seeded(onedrive, **{"a.txt": OLD})
    ws = _ws(_vfs(onedrive))
    try:
        await _out(ws, "ls /m")
        await _out(ws, CAT)
        await onedrive.run.record_requests()
        await _out(ws, line)
        assert (
            await onedrive.count("item"),
            await onedrive.fetches(),
            await onedrive.count("children"),
        ) == (items, 0, 0)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_ranged_read_stamps_the_whole_items_ctag(onedrive):
    await _seeded(onedrive, **{"a.txt": OLD})
    vfs = _vfs(onedrive)
    scope = RecordingScope()
    try:
        data = await read(vfs.accessor, _spec("a.txt"), offset=2, size=3)
    finally:
        scope.close()
        await vfs.accessor.close()
    assert data == OLD[2:5]
    assert [r.fingerprint for r in scope.records] == [
        await onedrive.ctag("a.txt")
    ]
    assert (
        await onedrive.count("download"),
        await onedrive.count("content"),
    ) == (1, 0)


@pytest.mark.asyncio
async def test_a_listed_ctag_never_answers_for_a_changed_file(onedrive):
    await _seeded(onedrive, **{"a.txt": OLD})
    first = await onedrive.ctag("a.txt")
    ws = _ws(_vfs(onedrive))
    try:
        # The listing leaves the first cTag in the mount index. A probe
        # that trusted it would match the one the cache holds and serve OLD.
        await _out(ws, "ls /m")
        # The fixture held: the mount index answers a stat with that cTag
        # and no request of its own, so there is a stale row to trust.
        mount = ws.mount("/m")
        items = await onedrive.count("item")
        listed = await mount.call("stat", "/m/a.txt", index=mount.index)
        assert (listed.fingerprint, await onedrive.count("item")) == (
            first,
            items,
        )
        assert await _out(ws, CAT) == OLD
        await onedrive.write("a.txt", NEW)
        assert await _out(ws, CAT) == NEW
        assert (
            await onedrive.count("children"),
            await onedrive.reach(children_allowed=1),
        ) == (1, [])
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("streamed", [False, True])
async def test_an_entry_point_read_stamps_its_ctag(onedrive, streamed):
    await _seeded(onedrive, **{"a.txt": OLD})
    ws = _ws(_vfs(onedrive))
    try:
        if streamed:
            stream = await ws.vfs.read("/m/a.txt", stream=True)
            data = b"".join([chunk async for chunk in stream])
        else:
            data = await ws.vfs.read("/m/a.txt")
        assert data == OLD
        before = await onedrive.fetches()
        assert await _out(ws, CAT) == OLD
        assert await onedrive.fetches() == before
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_metadata_edit_does_not_refetch(onedrive):
    await _seeded(onedrive, **{"a.txt": OLD})
    ws = _ws(_vfs(onedrive))
    try:
        await _out(ws, CAT)
        # A rename or a property edit moves the eTag and the stamp, never
        # the cTag, so the cached bytes are still current.
        await onedrive.touch("a.txt")
        assert await _out(ws, CAT) == OLD
        assert await onedrive.fetches() == 0
    finally:
        await ws.close()


def _bounded_ws(vfs) -> Workspace:
    return Workspace(
        {
            "/m": Mount(
                vfs=vfs,
                mode=MountMode.WRITE,
                read=ReadSpec(policy=ReadPolicy.BOUNDED, ttl=600),
            ),
        },
        cache=CacheConfig(),
    )


@pytest.mark.asyncio
async def test_a_relist_that_drops_a_file_cleans_up_its_bytes_and_overlay(
    onedrive,
):
    # A re-list is the backend's own answer, so a file it no longer names
    # loses what mirage kept for it: the cached bytes and the chmod overlay.
    # Asserted right after the `ls`, before anything reads the path, since
    # a stat of it would reach the per-file cleanup on its own.
    await _seeded(onedrive, **{"a.txt": OLD, "b.txt": b"bravo\n"})
    ws = _bounded_ws(_vfs(onedrive))
    try:
        assert await _out(ws, "ls /m") == b"a.txt\nb.txt\n"
        assert await _out(ws, "cat /m/a.txt") == OLD
        await ws.namespace.set_attrs("/m/a.txt", mode=0o600)
        assert await ws.cache.exists("/m/a.txt")
        await onedrive.remove("a.txt")
        await ws._registry.mount_for("/m/a.txt").index.invalidate()
        assert await _out(ws, "ls /m") == b"b.txt\n"
        assert ws.namespace.meta_for("/m/a.txt") is None
        assert not await ws.cache.exists("/m/a.txt")
        result = await ws.shell("stat /m/a.txt")
        assert result.exit_code == 1
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_under_fresh_the_next_command_relists_and_cleans_up(onedrive):
    # No ttl to wait out: the next command re-lists, and that re-list is
    # what finds the file gone.
    await _seeded(onedrive, **{"a.txt": OLD, "b.txt": b"bravo\n"})
    ws = _ws(_vfs(onedrive))
    try:
        assert await _out(ws, "ls /m") == b"a.txt\nb.txt\n"
        assert await _out(ws, "cat /m/a.txt") == OLD
        await ws.namespace.set_attrs("/m/a.txt", mode=0o600)
        await onedrive.remove("a.txt")
        assert await _out(ws, "ls /m") == b"b.txt\n"
        assert ws.namespace.meta_for("/m/a.txt") is None
        assert not await ws.cache.exists("/m/a.txt")
    finally:
        await ws.close()


@asynccontextmanager
async def _folding(drive: GraphDrive) -> AsyncIterator[str]:
    """A Graph in front of ``drive``'s run that matches paths in any case,
    as the real service does, and yield its origin.

    The path an item URL names (``root:/{path}:``) is lowercased on its way
    to the fake, whose names are lowercase already: the fake itself
    matches case exactly. A download URL the fake mints points at the fake.

    Args:
        drive (GraphDrive): the drive the requests go on to.
    """
    async with aiohttp.ClientSession(auto_decompress=False) as http:

        async def forward(request: web.Request) -> web.Response:
            path = request.path_qs
            if "root:/" in path:
                head, relative = path.split("root:/", 1)
                item, colon, rest = relative.partition(":")
                path = head + "root:/" + item.lower() + colon + rest
            headers = {
                key: value
                for key, value in request.headers.items()
                if key.lower() not in ("host", "content-length")
            }
            async with http.request(
                request.method,
                drive.run.url + path,
                headers=headers,
                data=await request.read(),
            ) as resp:
                kept = {
                    key: value
                    for key, value in resp.headers.items()
                    if key.lower() == "content-type"
                }
                return web.Response(
                    status=resp.status, body=await resp.read(), headers=kept
                )

        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", forward)
        server = TestServer(app)
        await server.start_server()
        try:
            yield str(server.make_url("")).rstrip("/")
        finally:
            await server.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["onedrive", "sharepoint"])
async def test_hidden_case_aliases_are_refused_over_a_folding_service(
    onedrive, sharepoint, provider
):
    drive: GraphDrive = onedrive if provider == "onedrive" else sharepoint
    await drive.write("secret.txt", b"secret")
    await drive.write("vault/private.txt", b"private")
    async with _folding(drive) as folded:
        config = drive.config(provider, graph_base_url=folded)
        ws = Workspace({"/m": (build_vfs(provider, config), MountMode.WRITE)})
        try:
            assert (
                await ws.shell("cat /m/secret.txt /m/vault/private.txt")
            ).exit_code == 0
            ws.create_session(
                "hidden",
                profile={"paths": {"hide": ["/m/secret.txt", "/m/vault"]}},
            )
            token = await drive.ctag("secret.txt")
            await drive.run.record_requests()
            for command in [
                "cat /m/SECRET.txt",
                "cat /m/Vault/private.txt",
                "ls /m/Vault",
                "echo changed > /m/SECRET.txt",
                "echo changed > /m/Vault/new.txt",
            ]:
                result = await ws.shell(command, session_id="hidden")
                assert result.exit_code != 0, command
                assert b"secret" not in await result.materialize_stdout(), (
                    command
                )
            assert await drive.ctag("secret.txt") == token
            assert not any(
                name in ("upload", "download", "content", "version_content")
                for name, _, _ in await drive.log()
            )
        finally:
            await ws.close()
