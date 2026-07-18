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

from mirage.workspace.mount.namespace.disk import DiskNamespaceStore


@pytest.mark.asyncio
async def test_nodes_roundtrip_with_quoted_paths(tmp_path):
    store = DiskNamespaceStore(str(tmp_path))
    await store.set("/link.txt", {"target": "/m/a.txt"})
    await store.set("/sub/deep.txt", {"mtime": 123})
    entries = await store.load()
    assert entries["/link.txt"] == {"target": "/m/a.txt"}
    assert entries["/sub/deep.txt"] == {"mtime": 123}
    assert (tmp_path / "namespace.json").is_file()
    await store.close()


@pytest.mark.asyncio
async def test_delete_and_replace_all(tmp_path):
    store = DiskNamespaceStore(str(tmp_path))
    await store.set("/a", {"mode": 1})
    await store.set("/b", {"mode": 2})
    await store.delete(["/a", "/missing"])
    assert set(await store.load()) == {"/b"}
    await store.replace_all({"/c": {"mode": 3}})
    assert set(await store.load()) == {"/c"}
    await store.close()


@pytest.mark.asyncio
async def test_user_roundtrip_and_clear(tmp_path):
    store = DiskNamespaceStore(str(tmp_path))
    assert await store.load_user() is None
    await store.set_user("agent_a")
    assert await store.load_user() == "agent_a"
    await store.set("/a", {"mode": 1})
    await store.clear()
    assert await store.load() == {}
    assert await store.load_user() is None
    await store.close()
