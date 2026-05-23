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

import json

from mirage.types import CacheKey, MountKey, ResourceStateKey, StateKey
from mirage.workspace.snapshot.state import to_state_dict
from mirage.workspace.snapshot.tar_io import _json_default
from mirage.workspace.snapshot.utils import FORMAT_VERSION

META_PATH = ".mirage-meta.json"
CACHE_PREFIX = ".mirage-cache/"


def _is_reserved(tree_path: str) -> bool:
    return tree_path == META_PATH or tree_path.startswith(CACHE_PREFIX)


def _tree_path(prefix: str, rel: str) -> str:
    p = prefix.strip("/")
    r = rel.lstrip("/")
    return f"{p}/{r}" if p else r


def _rel_path(prefix: str, tree_path: str) -> str:
    p = prefix.strip("/")
    rest = tree_path[len(p) + 1:] if p else tree_path
    return "/" + rest


def _belongs(tree_prefix: str, tree_path: str) -> bool:
    if not tree_prefix:
        return True
    return tree_path == tree_prefix or tree_path.startswith(tree_prefix + "/")


def meta_to_blob(meta: dict) -> bytes:
    return json.dumps(meta, default=_json_default).encode("utf-8")


def blob_to_meta(data: bytes) -> dict:
    return json.loads(data.decode("utf-8"))


def to_tree_inputs(ws) -> tuple[dict[str, bytes], dict]:
    return tree_inputs_from_state(to_state_dict(ws))


def tree_inputs_from_state(state: dict) -> tuple[dict[str, bytes], dict]:
    entries: dict[str, bytes] = {}
    mounts_meta: list[dict] = []
    for mount in state[StateKey.MOUNTS]:
        prefix = mount[MountKey.PREFIX]
        resource_state = dict(mount[MountKey.RESOURCE_STATE])
        files = resource_state.pop(ResourceStateKey.FILES, {})
        for rel, data in files.items():
            entries[_tree_path(prefix, rel)] = data
        mounts_meta.append({
            MountKey.INDEX:
            mount[MountKey.INDEX],
            MountKey.PREFIX:
            prefix,
            MountKey.MODE:
            mount[MountKey.MODE],
            MountKey.CONSISTENCY:
            mount[MountKey.CONSISTENCY],
            MountKey.RESOURCE_CLASS:
            mount[MountKey.RESOURCE_CLASS],
            MountKey.RESOURCE_STATE:
            resource_state,
        })
    cache = state[StateKey.CACHE]
    config = {
        StateKey.MIRAGE_VERSION: state[StateKey.MIRAGE_VERSION],
        StateKey.DEFAULT_SESSION_ID: state[StateKey.DEFAULT_SESSION_ID],
        StateKey.DEFAULT_AGENT_ID: state[StateKey.DEFAULT_AGENT_ID],
        StateKey.CURRENT_AGENT_ID: state[StateKey.CURRENT_AGENT_ID],
        CacheKey.LIMIT: cache[CacheKey.LIMIT],
        CacheKey.MAX_DRAIN_BYTES: cache[CacheKey.MAX_DRAIN_BYTES],
    }
    cache_meta: list[dict] = []
    for i, entry in enumerate(cache[CacheKey.ENTRIES]):
        ref = f"{CACHE_PREFIX}{i}"
        entries[ref] = entry[CacheKey.DATA]
        cache_meta.append({
            CacheKey.KEY: entry[CacheKey.KEY],
            CacheKey.FINGERPRINT: entry.get(CacheKey.FINGERPRINT),
            CacheKey.TTL: entry.get(CacheKey.TTL),
            CacheKey.CACHED_AT: entry.get(CacheKey.CACHED_AT),
            CacheKey.SIZE: entry.get(CacheKey.SIZE),
            "ref": ref,
        })
    meta = {
        "mounts": mounts_meta,
        "config": config,
        "cache": cache_meta,
        "fingerprints": state.get(StateKey.FINGERPRINTS) or [],
        "sessions": state.get(StateKey.SESSIONS) or [],
    }
    return entries, meta


def to_state(entries: dict[str, bytes], meta: dict) -> dict:
    mounts: list[dict] = []
    for mount in meta["mounts"]:
        prefix = mount[MountKey.PREFIX]
        tree_prefix = prefix.strip("/")
        resource_state = dict(mount[MountKey.RESOURCE_STATE])
        files: dict[str, bytes] = {}
        for tree_path, data in entries.items():
            if _is_reserved(tree_path):
                continue
            if _belongs(tree_prefix, tree_path):
                files[_rel_path(prefix, tree_path)] = data
        resource_state[ResourceStateKey.FILES] = files
        mounts.append({
            MountKey.INDEX: mount[MountKey.INDEX],
            MountKey.PREFIX: prefix,
            MountKey.MODE: mount[MountKey.MODE],
            MountKey.CONSISTENCY: mount[MountKey.CONSISTENCY],
            MountKey.RESOURCE_CLASS: mount[MountKey.RESOURCE_CLASS],
            MountKey.RESOURCE_STATE: resource_state,
        })
    config = meta.get("config", {})
    cache_entries: list[dict] = []
    for c in meta.get("cache", []):
        cache_entries.append({
            CacheKey.KEY: c[CacheKey.KEY],
            CacheKey.DATA: entries[c["ref"]],
            CacheKey.FINGERPRINT: c.get(CacheKey.FINGERPRINT),
            CacheKey.TTL: c.get(CacheKey.TTL),
            CacheKey.CACHED_AT: c.get(CacheKey.CACHED_AT),
            CacheKey.SIZE: c.get(CacheKey.SIZE),
        })
    return {
        StateKey.VERSION:
        FORMAT_VERSION,
        StateKey.MIRAGE_VERSION:
        config.get(StateKey.MIRAGE_VERSION, "unknown"),
        StateKey.MOUNTS:
        mounts,
        StateKey.SESSIONS:
        meta.get("sessions", []),
        StateKey.DEFAULT_SESSION_ID:
        config.get(StateKey.DEFAULT_SESSION_ID, "default"),
        StateKey.DEFAULT_AGENT_ID:
        config.get(StateKey.DEFAULT_AGENT_ID, "default"),
        StateKey.CURRENT_AGENT_ID:
        config.get(StateKey.CURRENT_AGENT_ID, "default"),
        StateKey.CACHE: {
            CacheKey.LIMIT: config.get(CacheKey.LIMIT, "512MB"),
            CacheKey.MAX_DRAIN_BYTES: config.get(CacheKey.MAX_DRAIN_BYTES),
            CacheKey.ENTRIES: cache_entries,
        },
        StateKey.HISTORY:
        None,
        StateKey.JOBS: [],
        StateKey.FINGERPRINTS:
        meta.get("fingerprints", []),
        StateKey.LIVE_ONLY_MOUNTS: [],
    }
