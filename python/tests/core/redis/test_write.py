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
from mirage.core.redis.write import write_bytes
from mirage.resource.redis.store import RedisStore
from mirage.types import PathSpec

REDIS_URL = os.environ.get("REDIS_URL", "")
pytestmark = pytest.mark.skipif(not REDIS_URL, reason="REDIS_URL not set")


@pytest_asyncio.fixture()
async def accessor():
    s = RedisStore(url=REDIS_URL, key_prefix="test:write:")
    await s.clear()
    await s.add_dir("/")
    await s.add_dir("/sub")
    a = RedisAccessor(s)
    yield a
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_write_bytes(accessor):
    await write_bytes(
        accessor,
        PathSpec(resource_path="hello.txt",
                 virtual="/hello.txt",
                 directory="/hello.txt"), b"hello")
    assert await accessor.store.get_file("/hello.txt") == b"hello"
    assert await accessor.store.get_modified("/hello.txt") is not None


@pytest.mark.asyncio
async def test_write_bytes_overwrite(accessor):
    await write_bytes(
        accessor,
        PathSpec(resource_path="file.txt",
                 virtual="/file.txt",
                 directory="/file.txt"), b"first")
    await write_bytes(
        accessor,
        PathSpec(resource_path="file.txt",
                 virtual="/file.txt",
                 directory="/file.txt"), b"second")
    assert await accessor.store.get_file("/file.txt") == b"second"


@pytest.mark.asyncio
async def test_write_bytes_parent_not_found():
    s = RedisStore(url=REDIS_URL, key_prefix="test:write:p:")
    await s.clear()
    await s.add_dir("/")
    a = RedisAccessor(s)
    # The operand is what a GNU stderr line names, so the error carries the
    # virtual path, not the internal "parent does not exist" phrasing.
    with pytest.raises(FileNotFoundError, match="/no/parent/file.txt"):
        await write_bytes(
            a,
            PathSpec(resource_path="no/parent/file.txt",
                     virtual="/no/parent/file.txt",
                     directory="/no/parent/file.txt"), b"data")
    assert not await s.has_file("/no/parent/file.txt")
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_write_bytes_under_a_plain_file_is_not_a_directory():
    s = RedisStore(url=REDIS_URL, key_prefix="test:write:nd:")
    await s.clear()
    await s.add_dir("/")
    await s.set_file("/plain", b"x")
    a = RedisAccessor(s)
    with pytest.raises(NotADirectoryError):
        await write_bytes(
            a,
            PathSpec(resource_path="plain/file.txt",
                     virtual="/plain/file.txt",
                     directory="/plain/file.txt"), b"data")
    assert not await s.has_file("/plain/file.txt")
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_write_bytes_deep_under_a_plain_file_is_not_a_directory():
    s = RedisStore(url=REDIS_URL, key_prefix="test:write:ndd:")
    await s.clear()
    await s.add_dir("/")
    await s.set_file("/plain", b"x")
    a = RedisAccessor(s)
    with pytest.raises(NotADirectoryError):
        await write_bytes(
            a,
            PathSpec(resource_path="plain/sub/file.txt",
                     virtual="/plain/sub/file.txt",
                     directory="/plain/sub/file.txt"), b"data")
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_write_bytes_to_subdir(accessor):
    await write_bytes(
        accessor,
        PathSpec(resource_path="sub/file.txt",
                 virtual="/sub/file.txt",
                 directory="/sub/file.txt"), b"nested data")
    assert await accessor.store.get_file("/sub/file.txt") == b"nested data"


@pytest.mark.asyncio
async def test_write_bytes_root_parent():
    s = RedisStore(url=REDIS_URL, key_prefix="test:write:r:")
    await s.clear()
    await s.add_dir("/")
    a = RedisAccessor(s)
    await write_bytes(
        a,
        PathSpec(resource_path="root_file.txt",
                 virtual="/root_file.txt",
                 directory="/root_file.txt"), b"root")
    assert await s.get_file("/root_file.txt") == b"root"
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_write_bytes_sets_modified(accessor):
    await write_bytes(
        accessor,
        PathSpec(resource_path="file.txt",
                 virtual="/file.txt",
                 directory="/file.txt"), b"data")
    assert await accessor.store.get_modified("/file.txt") is not None


@pytest.mark.asyncio
async def test_write_bytes_modified_uses_z_suffix(accessor):
    await write_bytes(
        accessor,
        PathSpec(resource_path="file.txt",
                 virtual="/file.txt",
                 directory="/file.txt"), b"data")
    modified = await accessor.store.get_modified("/file.txt")
    assert modified is not None
    assert modified.endswith("Z")
    assert "+00:00" not in modified
