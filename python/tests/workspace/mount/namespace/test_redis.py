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
import uuid

import pytest
import pytest_asyncio

from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace import Workspace
from mirage.workspace.mount.namespace.redis import RedisNamespaceStore
from mirage.workspace.mount.namespace.store import NamespaceStore

REDIS_URL = os.environ.get("REDIS_URL")

pytestmark = pytest.mark.skipif(REDIS_URL is None,
                                reason="REDIS_URL not configured")


@pytest.fixture
def prefix() -> str:
    return f"mirage:test:namespace:{uuid.uuid4().hex[:8]}:"


@pytest_asyncio.fixture
async def store(prefix):
    s = RedisNamespaceStore(url=REDIS_URL, key_prefix=prefix)
    yield s
    await s.clear()
    await s.close()


@pytest.mark.asyncio
async def test_set_load_roundtrip(store):
    await store.set("/data/f.txt", {"mode": 0o601, "uid": 500})
    await store.set("/data/link", {"target": "/t1", "mtime": 1.0})
    entries = await store.load()
    assert entries["/data/f.txt"] == {"mode": 0o601, "uid": 500}
    assert entries["/data/link"] == {"target": "/t1", "mtime": 1.0}


@pytest.mark.asyncio
async def test_delete_and_replace_all(store):
    await store.set("/a", {"mode": 1})
    await store.set("/b", {"mode": 2})
    await store.delete(["/a", "/missing"])
    assert set(await store.load()) == {"/b"}
    await store.replace_all({"/c": {"mode": 3}})
    assert await store.load() == {"/c": {"mode": 3}}
    await store.replace_all({})
    assert await store.load() == {}


@pytest.mark.asyncio
async def test_clear_empties_table(store):
    await store.set("/a", {"mode": 1})
    await store.clear()
    assert await store.load() == {}


def test_redis_store_subclasses_namespace_store():
    assert issubclass(RedisNamespaceStore, NamespaceStore)


class _OverlayRAMResource(RAMResource):
    """RAM resource with the native setattr op stripped, standing in for
    an API backend that has no attribute slot."""

    def __init__(self) -> None:
        super().__init__()
        self._ops_list = [ro for ro in self._ops_list if ro.name != "setattr"]


@pytest.mark.asyncio
async def test_namespace_survives_workspace_restart(prefix):
    ws = Workspace({"/data": _OverlayRAMResource()},
                   mode=MountMode.WRITE,
                   namespace_store=RedisNamespaceStore(url=REDIS_URL,
                                                       key_prefix=prefix))
    await ws.execute("echo alpha > /data/f.txt")
    await ws.execute("chmod 601 /data/f.txt && chown 500:dev /data/f.txt")
    await ws.execute("ln -s /data/f.txt /data/link")
    await ws.close()

    reborn = Workspace({"/data": _OverlayRAMResource()},
                       mode=MountMode.WRITE,
                       namespace_store=RedisNamespaceStore(url=REDIS_URL,
                                                           key_prefix=prefix))
    await reborn.execute("echo alpha > /data/f.txt")
    st, _ = await reborn.dispatch("stat",
                                  PathSpec.from_str_path("/data/f.txt"))
    assert st.mode == 0o601
    assert st.uid == 500
    assert st.gid == "dev"
    result = await reborn.execute("readlink /data/link")
    assert (await result.stdout_str()) == "/data/f.txt\n"
    store = RedisNamespaceStore(url=REDIS_URL, key_prefix=prefix)
    await store.clear()
    await store.close()
    await reborn.close()
