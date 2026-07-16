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

from mirage.workspace.session.ram import RAMSessionStore


@pytest.mark.asyncio
async def test_set_load_roundtrip():
    store = RAMSessionStore()
    await store.set("s1", {"session_id": "s1", "cwd": "/a", "env": {}})
    await store.set(
        "s2", {
            "session_id": "s2",
            "cwd": "/",
            "env": {
                "K": "v"
            },
            "mount_modes": {
                "/data": "read"
            }
        })
    entries = await store.load()
    assert entries["s1"]["cwd"] == "/a"
    assert entries["s2"]["mount_modes"] == {"/data": "read"}


@pytest.mark.asyncio
async def test_load_returns_copies():
    store = RAMSessionStore()
    await store.set("s1", {"session_id": "s1", "cwd": "/"})
    entries = await store.load()
    entries["s1"]["cwd"] = "/mutated"
    again = await store.load()
    assert again["s1"]["cwd"] == "/"


@pytest.mark.asyncio
async def test_delete_and_replace_all():
    store = RAMSessionStore()
    await store.set("a", {"session_id": "a"})
    await store.set("b", {"session_id": "b"})
    await store.delete(["a", "missing"])
    assert set(await store.load()) == {"b"}
    await store.replace_all({"c": {"session_id": "c"}})
    assert set(await store.load()) == {"c"}


@pytest.mark.asyncio
async def test_clear():
    store = RAMSessionStore()
    await store.set("a", {"session_id": "a"})
    await store.clear()
    assert await store.load() == {}
    await store.close()
