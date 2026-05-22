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

from mirage.workspace.version.mapping import (META_PATH, meta_to_blob,
                                              to_tree_inputs)
from mirage.workspace.version.store import VersionStore


async def snapshot_tree(store: VersionStore, ws) -> bytes:
    entries, meta = to_tree_inputs(ws)
    tree_entries: dict[str, bytes] = {}
    for path, data in entries.items():
        tree_entries[path] = await store.write_blob(data)
    tree_entries[META_PATH] = await store.write_blob(meta_to_blob(meta))
    return await store.write_tree(tree_entries)


async def commit(store: VersionStore,
                 ws,
                 branch: str = "main",
                 message: str = "") -> bytes:
    tree = await snapshot_tree(store, ws)
    parents: list[bytes] = []
    if branch in await store.branches():
        parents = [await store.head(branch)]
    return await store.commit(tree, parents, branch, message)
