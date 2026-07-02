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

from mirage.core.redis.rename import rename
from mirage.core.redis.set_attrs import set_attrs
from mirage.core.redis.stat import stat
from mirage.core.redis.unlink import unlink
from mirage.types import PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(resource_path=path.strip("/"),
                    virtual=path,
                    directory=path)


@pytest.mark.asyncio
async def test_set_attrs_fields_reported_by_stat(store):
    await store.store.set_file("/f.txt", b"hello")
    await set_attrs(store,
                    _spec("/f.txt"),
                    mode=0o601,
                    uid=500,
                    gid="dev",
                    atime="2026-01-02T00:00:00+00:00")
    result = await stat(store, _spec("/f.txt"))
    assert result.mode == 0o601
    assert result.uid == 500
    assert result.gid == "dev"
    assert result.atime == "2026-01-02T00:00:00+00:00"


@pytest.mark.asyncio
async def test_set_attrs_mtime_updates_modified(store):
    await store.store.set_file("/f.txt", b"hello")
    await set_attrs(store, _spec("/f.txt"), mtime="2026-03-04T12:00:00+00:00")
    result = await stat(store, _spec("/f.txt"))
    assert result.modified == "2026-03-04T12:00:00+00:00"


@pytest.mark.asyncio
async def test_set_attrs_missing_raises(store):
    with pytest.raises(FileNotFoundError):
        await set_attrs(store, _spec("/nope.txt"), mode=0o644)


@pytest.mark.asyncio
async def test_unlink_drops_attrs(store):
    await store.store.set_file("/f.txt", b"hello")
    await set_attrs(store, _spec("/f.txt"), mode=0o600)
    await unlink(store, _spec("/f.txt"))
    await store.store.set_file("/f.txt", b"recreated")
    result = await stat(store, _spec("/f.txt"))
    assert result.mode is None


@pytest.mark.asyncio
async def test_rename_moves_attrs(store):
    await store.store.set_file("/f.txt", b"hello")
    await set_attrs(store, _spec("/f.txt"), mode=0o600, uid=500)
    await rename(store, _spec("/f.txt"), _spec("/g.txt"))
    result = await stat(store, _spec("/g.txt"))
    assert result.mode == 0o600
    assert result.uid == 500
    assert await store.store.get_attrs("/f.txt") == {}
