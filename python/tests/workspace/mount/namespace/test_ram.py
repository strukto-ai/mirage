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

from mirage.workspace.mount.namespace.ram import RAMNamespaceStore
from mirage.workspace.mount.namespace.store import NamespaceStore


@pytest.mark.asyncio
async def test_set_load_roundtrip():
    store = RAMNamespaceStore()
    await store.set("/data/f.txt", {"mode": 0o601, "uid": 500})
    await store.set("/data/link", {"target": "/t1", "mtime": 1.0})
    entries = await store.load()
    assert entries == {
        "/data/f.txt": {
            "mode": 0o601,
            "uid": 500
        },
        "/data/link": {
            "target": "/t1",
            "mtime": 1.0
        },
    }


@pytest.mark.asyncio
async def test_set_overwrites_entry():
    store = RAMNamespaceStore()
    await store.set("/data/f.txt", {"mode": 0o600, "mtime": 1.0})
    await store.set("/data/f.txt", {"mode": 0o601})
    assert (await store.load())["/data/f.txt"] == {"mode": 0o601}


@pytest.mark.asyncio
async def test_delete_batch():
    store = RAMNamespaceStore()
    await store.set("/a", {"mode": 1})
    await store.set("/b", {"mode": 2})
    await store.set("/c", {"mode": 3})
    await store.delete(["/a", "/c", "/missing"])
    assert set(await store.load()) == {"/b"}


@pytest.mark.asyncio
async def test_replace_all_overwrites_table():
    store = RAMNamespaceStore()
    await store.set("/old", {"mode": 1})
    await store.replace_all({"/new": {"mode": 2}})
    assert await store.load() == {"/new": {"mode": 2}}
    await store.replace_all({})
    assert await store.load() == {}


@pytest.mark.asyncio
async def test_clear_empties_table():
    store = RAMNamespaceStore()
    await store.set("/a", {"mode": 1})
    await store.clear()
    assert await store.load() == {}
    await store.close()


@pytest.mark.asyncio
async def test_load_returns_copies():
    store = RAMNamespaceStore()
    await store.set("/a", {"mode": 1})
    entries = await store.load()
    entries["/a"]["mode"] = 999
    assert (await store.load())["/a"]["mode"] == 1


@pytest.mark.asyncio
async def test_user_roundtrip():
    store = RAMNamespaceStore()
    assert await store.load_user() is None
    await store.set_user("alice")
    assert await store.load_user() == "alice"


@pytest.mark.asyncio
async def test_user_survives_replace_all_but_not_clear():
    store = RAMNamespaceStore()
    await store.set_user("alice")
    await store.replace_all({"/a": {"mode": 1}})
    assert await store.load_user() == "alice"
    await store.clear()
    assert await store.load_user() is None


def test_ram_store_subclasses_namespace_store():
    assert issubclass(RAMNamespaceStore, NamespaceStore)
    assert isinstance(RAMNamespaceStore(), NamespaceStore)
