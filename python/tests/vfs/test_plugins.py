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
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio

from mirage import (
    BaseVFS,
    MountMode,
    PathSpec,
    SearchQuery,
    Workspace,
)
from mirage.accessor.ram import RAMAccessor
from mirage.commands.builtin.generic_bind.files import (
    command_files as files_of,
)
from mirage.commands.config import Context
from mirage.context import reset_mount_gate, set_mount_gate
from mirage.core.ram.read import read as ram_read
from mirage.core.ram.readdir import readdir as ram_readdir
from mirage.core.ram.stat import stat as ram_stat
from mirage.core.ram.write import write as ram_write
from mirage.io.stream import materialize
from mirage.types import FileStat
from mirage.utils.ranges import slice_window
from mirage.vfs.ram import RAMVFS
from mirage.vfs.ram.store import RAMStore
from tests.fixtures.mount_commands import command_files
from tests.fixtures.vfs_io import served

PATH = PathSpec(
    virtual="/nested/data/a.txt", directory="/nested/data", vfs_path="a.txt"
)


async def _streamed(ws: Workspace) -> bytes:
    """``PATH`` as a command streams it: through the dispatcher, the
    stored bytes, a VFS with no stream of its own read whole."""
    data, _ = await ws.dispatch("read", PATH, stream=True, filetype=None)
    return await materialize(data)


class Minimal(BaseVFS):
    """A plug-in VFS over the RAM store with only the required reads."""

    name = "custom"

    async def readdir(self, path: PathSpec) -> list[FileStat]:
        return await ram_readdir(self.accessor, path)

    async def read(
        self,
        path: PathSpec,
        offset: int = 0,
        size: int | None = None,
    ) -> bytes:
        data = await ram_read(self.accessor, path)
        return slice_window(data, offset, size)

    async def stat(self, path: PathSpec) -> FileStat:
        return await ram_stat(self.accessor, path)


class Writable(Minimal):
    writes = 0

    async def write(self, path: PathSpec, data: bytes) -> None:
        self.writes += 1
        await ram_write(self.accessor, path, data)


class Streaming(Minimal):
    reads_ranges = True

    async def read_stream(self, path: PathSpec) -> AsyncIterator[bytes]:
        for chunk in (b"hel", b"lo\n"):
            yield chunk


class Searchable(Minimal):
    async def search(
        self,
        path: PathSpec,
        query: SearchQuery,
    ) -> list[str] | None:
        return None


@pytest_asyncio.fixture
async def accessor():
    backend = RAMAccessor(RAMStore())
    await ram_write(backend, PATH, b"hello\n")
    return backend


@pytest.mark.asyncio
async def test_minimal_reads_serve_shell_streams_and_dispatch(accessor):
    vfs = Minimal(accessor=accessor)
    ws = Workspace({"/nested/data": vfs}, mode=MountMode.READ)
    try:
        for line, expected in [
            ("cat /nested/data/*.txt", "hello\n"),
            ("grep hello /nested/data/a.txt", "hello\n"),
            ("gzip -c /nested/data/a.txt | gunzip", "hello\n"),
        ]:
            result = await ws.shell(line)
            assert await result.stdout_str() == expected
            assert result.exit_code == 0
        assert (await ws.stat(PATH.virtual)).size == 6
        data, _ = await ws.dispatch("read", PATH, offset=1, size=3)
        assert data == b"ell"
        assert await _streamed(ws) == b"hello\n"
        refused = await ws.shell("rm /nested/data/a.txt")
        assert refused.exit_code == 1
        assert await refused.stderr_str() == (
            "rm: cannot remove '/nested/data/a.txt': Read-only file system\n"
        )
        assert "write" not in served(vfs)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_existence_falls_back_to_stat_only_for_absence(accessor):
    vfs = Minimal(accessor=accessor)
    ws = Workspace({"/nested/data": vfs})
    try:
        token = set_mount_gate("/nested/data/", MountMode.READ)
        try:
            exists = files_of(Context(vfs=command_files(ws))).exists
        finally:
            reset_mount_gate(token)
        assert await exists(PATH)
        missing = PathSpec.from_str_path("/nested/data/missing")
        assert not await exists(missing)
        vfs.stat = AsyncMock(side_effect=PermissionError("denied"))  # type: ignore[method-assign]
        with pytest.raises(PermissionError, match="denied"):
            await exists(PathSpec.from_str_path("/nested/data/other"))
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_native_reads_do_not_enable_writes(accessor):
    vfs = Streaming(accessor=accessor)
    vfs.read = AsyncMock(return_value=b"ell")  # type: ignore[method-assign]
    ws = Workspace({"/nested/data": vfs})
    try:
        data, _ = await ws.dispatch("read", PATH, offset=1, size=3)
        assert data == b"ell"
        window = vfs.read.await_args.kwargs
        assert (window["offset"], window["size"]) == (1, 3)
        assert await _streamed(ws) == b"hello\n"
        assert vfs.read.await_count == 1
        assert "write" not in served(vfs)
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", [MountMode.READ, MountMode.WRITE])
async def test_write_capability_obeys_mount_mode(accessor, mode):
    vfs = Writable(accessor=accessor)
    ws = Workspace({"/nested/data": vfs}, mode=mode)
    try:
        result = await ws.shell("echo changed > /nested/data/a.txt")
        assert (result.exit_code == 0) == (mode == MountMode.WRITE)
        assert vfs.writes == (2 if mode == MountMode.WRITE else 0)
        refused = await ws.shell("rm /nested/data/a.txt")
        reason = (
            "Read-only file system"
            if mode == MountMode.READ
            else "Operation not supported"
        )
        assert await refused.stderr_str() == (
            f"rm: cannot remove '/nested/data/a.txt': {reason}\n"
        )
        assert "write" in served(vfs)
        assert "unlink" not in served(vfs)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_search_errors_do_not_turn_into_fallback_reads(accessor):
    vfs = Searchable(accessor=accessor)
    vfs.files_containing = AsyncMock(  # type: ignore[method-assign]
        side_effect=PermissionError("search refused")
    )
    vfs.read = AsyncMock(wraps=vfs.read)  # type: ignore[method-assign]
    ws = Workspace({"/nested/data": vfs})
    try:
        result = await ws.shell("grep -r hello /nested/data")
        assert result.exit_code != 0
        assert "search refused" in await result.stderr_str()
        vfs.read.assert_not_awaited()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_grep_and_rg_never_ask_the_search_commands_search(accessor):
    vfs = Searchable(accessor=accessor)
    vfs.search = AsyncMock(return_value=["deployment 42"])  # type: ignore[method-assign]
    query = SearchQuery(
        "recent deployments",
        options={"limit": 20, "filters": {"project": "backend"}},
    )
    assert await vfs.search(PATH, query) == ["deployment 42"]
    vfs.search.assert_awaited_once_with(PATH, query)
    vfs.search.reset_mock()
    ws = Workspace({"/nested/data": vfs})
    try:
        for command in ("grep", "rg"):
            result = await ws.shell(f"{command} hello {PATH.virtual}")
            assert result.exit_code == 0
            assert await result.stdout_str() == "hello\n"
        vfs.search.assert_not_awaited()
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_option_routes_a_write_off_a_mount_without_one(accessor):
    # Typed on a mount that cannot write, the output option names one that
    # can, and the serving mount's facts decide.
    ws = Workspace(
        {"/nested/data": Minimal(accessor=accessor), "/ram": RAMVFS()},
        mode=MountMode.WRITE,
    )
    try:
        await ws.shell("cd /nested/data")
        result = await ws.shell("shuf -i 1-1 --output=/ram/out")
        assert result.exit_code == 0, await result.stderr_str()
        assert await (await ws.shell("cat /ram/out")).stdout_str() == "1\n"
    finally:
        await ws.close()
