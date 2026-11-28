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

import os

import pytest
import pytest_asyncio

from mirage.accessor.redis import RedisAccessor
from mirage.core.redis.stat import stat
from mirage.types import ContentType, FileType, PathSpec
from mirage.vfs.redis.store import RedisStore

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def accessor(redis_prefix):
    s = RedisStore(url=REDIS_URL, key_prefix=redis_prefix)
    await s.clear()
    await s.add_dir("/")
    await s.add_dir("/sub")
    await s.set_file("/hello.txt", b"hello world")
    await s.set_file("/data.json", b'{"key": "value"}')
    await s.set_file("/img.png", b"\x89PNG")
    a = RedisAccessor(s)
    yield a
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_stat_root(accessor):
    result = await stat(
        accessor, PathSpec(vfs_path="", virtual="/", directory="/")
    )
    assert result.type == FileType.DIRECTORY
    assert result.name == "/"


@pytest.mark.asyncio
async def test_stat_file(accessor):
    result = await stat(
        accessor,
        PathSpec(
            vfs_path="hello.txt", virtual="/hello.txt", directory="/hello.txt"
        ),
    )
    assert result.name == "hello.txt"
    assert result.size == 11
    assert result.content == ContentType.TEXT


@pytest.mark.asyncio
async def test_stat_directory(accessor):
    result = await stat(
        accessor, PathSpec(vfs_path="sub", virtual="/sub", directory="/sub")
    )
    assert result.type == FileType.DIRECTORY
    assert result.name == "sub"
    assert result.size is None


@pytest.mark.asyncio
async def test_stat_not_found(accessor):
    with pytest.raises(FileNotFoundError):
        await stat(
            accessor,
            PathSpec(vfs_path="nope", virtual="/nope", directory="/nope"),
        )


@pytest.mark.asyncio
async def test_stat_json_file(accessor):
    result = await stat(
        accessor,
        PathSpec(
            vfs_path="data.json", virtual="/data.json", directory="/data.json"
        ),
    )
    assert result.content == ContentType.JSON
    assert result.size == 16


@pytest.mark.asyncio
async def test_stat_image_file(accessor):
    result = await stat(
        accessor,
        PathSpec(vfs_path="img.png", virtual="/img.png", directory="/img.png"),
    )
    assert result.content == ContentType.IMAGE_PNG


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "virtual, kind, size",
    [
        ("/hello.txt", FileType.FILE, len(b"hello world")),
        ("/sub", FileType.DIRECTORY, None),
    ],
)
async def test_stat_asks_what_is_at_a_path_in_one_pipeline(
    redis_prefix, monkeypatch, virtual, kind, size
):
    # Whether a directory or a file is at the path, and the fields kept
    # under its name, go out in one pipeline and nothing on its own: one
    # round trip on one of the pool's connections. A pool of one refuses
    # a second connection rather than wait for it, so a stat that asked
    # them at once, each on a connection of its own, would fail there.
    joiner = "&" if "?" in REDIS_URL else "?"
    store = RedisStore(
        url=f"{REDIS_URL}{joiner}max_connections=1", key_prefix=redis_prefix
    )
    await store.clear()
    await store.add_dir("/sub")
    await store.set_file("/hello.txt", b"hello world")
    client = store._client
    sent = {"pipelines": 0, "commands": 0}
    pipeline, command = client.pipeline, client.execute_command

    def counted_pipeline(*args, **kwargs):
        sent["pipelines"] += 1
        return pipeline(*args, **kwargs)

    async def counted_command(*args, **kwargs):
        sent["commands"] += 1
        return await command(*args, **kwargs)

    monkeypatch.setattr(client, "pipeline", counted_pipeline)
    monkeypatch.setattr(client, "execute_command", counted_command)
    try:
        path = PathSpec(
            vfs_path=virtual[1:], virtual=virtual, directory=virtual
        )
        result = await stat(RedisAccessor(store), path)
        assert (result.type, result.size) == (kind, size)
        assert sent == {"pipelines": 1, "commands": 0}
    finally:
        monkeypatch.undo()
        await store.clear()
        await store.close()
