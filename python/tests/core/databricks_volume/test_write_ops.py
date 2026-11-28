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

import hashlib
import tracemalloc

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

import mirage.core.databricks_volume.write as write_module
from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.core.databricks_volume.create import create
from mirage.core.databricks_volume.unlink import unlink
from mirage.core.databricks_volume.write import write
from mirage.errors.types import FileTooLargeError
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.databricks_volume import DatabricksVolumeConfig
from tests.fixtures.databricks_volume import FILES


def _path(path: str) -> PathSpec:
    return PathSpec.from_str_path(path, mount_key(path, "/dbx"))


@pytest.mark.asyncio
async def test_write_new_file(accessor, volume, remote_root):
    await volume.mkdir(remote_root)
    await volume.run.record_requests()

    await write(accessor, _path("/dbx/new.txt"), b"hello")

    assert await volume.content(f"{remote_root}/new.txt") == b"hello"
    assert await volume.asked("PUT", FILES) == [f"{remote_root}/new.txt"]
    assert await volume.run.params("PUT", FILES) == [{"overwrite": "true"}]


@pytest.mark.asyncio
async def test_write_overwrites_existing_file(accessor, volume, remote_root):
    await volume.put(f"{remote_root}/new.txt", b"old")

    await write(accessor, _path("/dbx/new.txt"), b"new")

    assert await volume.content(f"{remote_root}/new.txt") == b"new"


@pytest.mark.asyncio
async def test_write_fails_when_parent_is_missing(
    accessor, volume, remote_root
):
    await volume.mkdir(remote_root)

    with pytest.raises(FileNotFoundError):
        await write(accessor, _path("/dbx/missing/new.txt"), b"x")


@pytest.mark.asyncio
async def test_write_fails_when_parent_is_file(accessor, volume, remote_root):
    await volume.put(f"{remote_root}/parent.txt", b"file")

    with pytest.raises(NotADirectoryError):
        await write(accessor, _path("/dbx/parent.txt/new.txt"), b"x")


@pytest.mark.asyncio
async def test_a_large_write_holds_a_bounded_amount_of_memory():
    received = hashlib.sha256()
    lengths: list[str] = []

    async def respond(request: web.Request) -> web.StreamResponse:
        if request.method == "PUT":
            lengths.append(request.headers["Content-Length"])
            async for piece in request.content.iter_chunked(65536):
                received.update(piece)
        return web.Response()

    app = web.Application()
    app.router.add_route("*", "/{tail:.*}", respond)
    block = b"x" * (1024 * 1024)

    async def source():
        for _ in range(64):
            yield block

    async with TestServer(app) as server:
        config = DatabricksVolumeConfig(
            catalog="main",
            schema="default",
            volume="files",
            host=str(server.make_url("")).rstrip("/"),
            token="secret",
        )
        async with DatabricksVolumeAccessor(config) as accessor:
            tracemalloc.start()
            try:
                await write(accessor, _path("/dbx/big.bin"), source())
                _, peak = tracemalloc.get_traced_memory()
            finally:
                tracemalloc.stop()
    assert lengths == [str(len(block) * 64)]
    assert received.hexdigest() == hashlib.sha256(block * 64).hexdigest()
    assert peak < 8 * 1024 * 1024


@pytest.mark.asyncio
async def test_a_write_past_the_put_cap_is_refused_before_any_request(
    accessor, volume, remote_root, monkeypatch
):
    await volume.mkdir(remote_root)
    await volume.run.record_requests()
    monkeypatch.setattr(write_module, "MAX_UPLOAD_SIZE", 4)

    with pytest.raises(FileTooLargeError) as caught:
        await write(accessor, _path("/dbx/big.bin"), b"12345")

    assert caught.value.filename == "/dbx/big.bin"
    assert await volume.run.requests() == []


@pytest.mark.asyncio
async def test_create_empty_file(accessor, volume, remote_root):
    await volume.mkdir(remote_root)

    await create(accessor, _path("/dbx/empty.txt"))

    assert await volume.content(f"{remote_root}/empty.txt") == b""


@pytest.mark.asyncio
async def test_create_fails_when_parent_is_missing(
    accessor, volume, remote_root
):
    await volume.mkdir(remote_root)

    with pytest.raises(FileNotFoundError):
        await create(accessor, _path("/dbx/missing/empty.txt"))


@pytest.mark.asyncio
async def test_unlink_file(accessor, volume, remote_root):
    await volume.put(f"{remote_root}/delete.txt", b"bye")
    await volume.run.record_requests()

    await unlink(accessor, _path("/dbx/delete.txt"))

    assert not await volume.has(f"{remote_root}/delete.txt")
    assert await volume.asked("DELETE", FILES) == [f"{remote_root}/delete.txt"]


@pytest.mark.asyncio
async def test_unlink_missing_file_raises_file_not_found(
    accessor, volume, remote_root
):
    await volume.mkdir(remote_root)

    with pytest.raises(FileNotFoundError):
        await unlink(accessor, _path("/dbx/missing.txt"))


@pytest.mark.asyncio
async def test_unlink_directory_raises_is_a_directory(
    accessor, volume, remote_root
):
    await volume.mkdir(f"{remote_root}/dir")

    with pytest.raises(IsADirectoryError):
        await unlink(accessor, _path("/dbx/dir"))


@pytest.mark.asyncio
async def test_file_mutation_paths_cannot_escape_root(
    accessor, volume, remote_root
):
    await volume.mkdir(remote_root)
    escaping = _path("/dbx/../escape.txt")

    with pytest.raises(ValueError):
        await write(accessor, escaping, b"x")
    with pytest.raises(ValueError):
        await create(accessor, escaping)
    with pytest.raises(ValueError):
        await unlink(accessor, escaping)
