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

from typing import Any

from mirage.server.version.errors import NoSuchBranchError
from mirage.server.version.state_tree import (CONTROL_PREFIX, META_PATH,
                                              blob_to_meta, meta_to_blob,
                                              to_state, tree_inputs_from_state)
from mirage.server.version.store import VersionStore
from mirage.types import DriftPolicy, StateKey
from mirage.workspace.snapshot import (apply_state_dict, install_fingerprints,
                                       to_state_dict)


async def snapshot_tree_from_state(store: VersionStore,
                                   state: dict[str, Any]) -> bytes:
    entries, meta = tree_inputs_from_state(state)
    tree_entries: dict[str, bytes] = {}
    for path, data in entries.items():
        tree_entries[path] = await store.write_blob(data)
    tree_entries[META_PATH] = await store.write_blob(meta_to_blob(meta))
    return await store.write_tree(tree_entries)


async def commit(store: VersionStore,
                 ws,
                 branch: str = "main",
                 message: str = "") -> bytes:
    return await commit_state(store, await to_state_dict(ws), branch, message)


async def commit_state(store: VersionStore,
                       state: dict[str, Any],
                       branch: str = "main",
                       message: str = "") -> bytes:
    tree = await snapshot_tree_from_state(store, state)
    branches = await store.branches()
    parents: list[bytes] = []
    if branch in branches:
        parents = [await store.head(branch)]
    elif branches:
        raise NoSuchBranchError(branch)
    return await store.commit(tree, parents, branch, message)


async def branch(store: VersionStore,
                 name: str,
                 from_branch: str = "main") -> None:
    head = await store.head(from_branch)
    await store.set_branch(name, head)


async def read_version(
        store: VersionStore,
        version: bytes) -> tuple[dict[str, bytes], dict[str, Any]]:
    tree = (await store.read_commit(version)).tree
    contents = await store.read_tree(tree)
    meta_oid = contents.pop(META_PATH, None)
    meta = (blob_to_meta(await store.read_blob(meta_oid))
            if meta_oid is not None else {
                "mounts": []
            })
    entries: dict[str, bytes] = {}
    for path, oid in contents.items():
        entries[path] = await store.read_blob(oid)
    return entries, meta


async def resolve_ref(store: VersionStore, ref) -> bytes:
    if isinstance(ref, str):
        if ref in await store.branches():
            return await store.head(ref)
        return ref.encode()
    return ref


async def checkout(store: VersionStore,
                   ws,
                   ref,
                   drift_policy: DriftPolicy = DriftPolicy.STRICT) -> None:
    version = await resolve_ref(store, ref)
    entries, meta = await read_version(store, version)
    state = to_state(entries, meta)
    await ws._cache.clear()
    await apply_state_dict(ws, state)
    install_fingerprints(ws,
                         state.get(StateKey.FINGERPRINTS) or [], drift_policy)


def _strip_meta(changes: dict[str, list[str]]) -> dict[str, list[str]]:
    # File-level diff/status stay content-only: the control-plane
    # subtree changes on every command (history) and is surfaced by the
    # structured state_diff instead.
    return {
        kind: [p for p in paths if not p.startswith(CONTROL_PREFIX)]
        for kind, paths in changes.items()
    }


async def version_log(store: VersionStore,
                      branch: str) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for oid in await store.log(branch):
        commit_obj = await store.read_commit(oid)
        out.append({
            "id": oid.decode(),
            "message": commit_obj.message.decode(),
        })
    return out


async def version_diff(store: VersionStore, version_a: bytes,
                       version_b: bytes) -> dict[str, list[str]]:
    tree_a = (await store.read_commit(version_a)).tree
    tree_b = (await store.read_commit(version_b)).tree
    return _strip_meta(await store.diff(tree_a, tree_b))


async def diff_live_vs_ref(store: VersionStore, state: dict[str, Any],
                           ref) -> dict[str, list[str]]:
    live_tree = await snapshot_tree_from_state(store, state)
    version = await resolve_ref(store, ref)
    ref_tree = (await store.read_commit(version)).tree
    return _strip_meta(await store.diff(ref_tree, live_tree))


async def status_state(store: VersionStore,
                       state: dict[str, Any],
                       branch: str = "main") -> dict[str, list[str]]:
    live_tree = await snapshot_tree_from_state(store, state)
    if branch in await store.branches():
        head_tree = (await store.read_commit(await store.head(branch))).tree
    else:
        head_tree = await store.write_tree({})
    return _strip_meta(await store.diff(head_tree, live_tree))
