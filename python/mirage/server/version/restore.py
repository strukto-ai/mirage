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

from mirage.server.version.api import read_version, resolve_ref
from mirage.server.version.state_tree import CATEGORIES, to_state
from mirage.server.version.store import VersionStore
from mirage.types import DriftPolicy, MountKey, ResourceStateKey, StateKey
from mirage.utils.path import norm
from mirage.workspace.snapshot import (apply_state_dict, install_fingerprints,
                                       to_state_dict)


def _selected_file(path: str, wanted: list[str]) -> bool:
    p = norm(path)
    for want in wanted:
        w = norm(want)
        if p == w or p.startswith(w + "/"):
            return True
    return False


def _merge_mount_files(live_mount: dict[str, Any], target_mount: dict[str,
                                                                      Any],
                       prefix: str, wanted: list[str]) -> None:
    live_state = live_mount[MountKey.RESOURCE_STATE]
    target_files = target_mount[MountKey.RESOURCE_STATE].get(
        ResourceStateKey.FILES, {})
    files = dict(live_state.get(ResourceStateKey.FILES, {}))
    base = prefix.rstrip("/")
    for rel in set(files) | set(target_files):
        full = f"{base}{rel}"
        if not _selected_file(full, wanted):
            continue
        if rel in target_files:
            files[rel] = target_files[rel]
        else:
            files.pop(rel, None)
    live_state[ResourceStateKey.FILES] = files


async def restore(
        store: VersionStore,
        ws,
        ref,
        *,
        paths: list[str] | None = None,
        categories: list[str] | None = None,
        drift_policy: DriftPolicy = DriftPolicy.STRICT) -> dict[str, Any]:
    """Surgical restore: whole world, chosen categories, or chosen paths.

    Scope rules: no arguments = the whole world (checkout semantics);
    ``categories`` picks a subset of files/sessions/namespace/history and
    leaves the live state of the others untouched; ``paths`` restores
    only the matching files (a path selects itself or its subtree) and
    implies the files category alone. Restoring sessions re-applies
    their mount grants exactly like any other state; compare two
    versions with :func:`state_diff` to see grant changes up front.
    """
    if paths is not None and categories is not None:
        raise ValueError("restore takes paths= or categories=, not both")
    for category in categories or []:
        if category not in CATEGORIES:
            raise ValueError(f"unknown category {category!r}; expected one of "
                             f"{', '.join(CATEGORIES)}")
    version = await resolve_ref(store, ref)
    entries, meta = await read_version(store, version)
    target = to_state(entries, meta)
    live = await to_state_dict(ws)
    selected = (set(categories) if categories is not None else
                {"files"} if paths is not None else set(CATEGORIES))

    merged = dict(target)
    if "sessions" not in selected:
        merged[StateKey.SESSIONS] = live.get(StateKey.SESSIONS) or []
        merged[StateKey.DEFAULT_SESSION_ID] = live.get(
            StateKey.DEFAULT_SESSION_ID)
    if "namespace" not in selected:
        merged[StateKey.NODES] = live.get(StateKey.NODES) or {}
    if "history" not in selected:
        merged[StateKey.HISTORY] = live.get(StateKey.HISTORY) or []
    if "files" not in selected:
        merged[StateKey.MOUNTS] = live.get(StateKey.MOUNTS) or []
    elif paths is not None:
        target_by_prefix = {
            m[MountKey.PREFIX]: m
            for m in target.get(StateKey.MOUNTS) or []
        }
        merged[StateKey.MOUNTS] = live.get(StateKey.MOUNTS) or []
        for mount in merged[StateKey.MOUNTS]:
            prefix = mount[MountKey.PREFIX]
            if prefix in target_by_prefix:
                _merge_mount_files(mount, target_by_prefix[prefix], prefix,
                                   paths)

    await ws._cache.clear()
    await apply_state_dict(ws, merged)
    if "files" in selected and paths is None:
        install_fingerprints(ws,
                             target.get(StateKey.FINGERPRINTS) or [],
                             drift_policy)
    return {
        "version": version.decode(),
        "categories": sorted(selected),
        "paths": paths,
    }
