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
from typing import Any

from mirage.types import CacheKey, MountKey, ResourceStateKey, StateKey
from mirage.workspace.snapshot.tar_io import _json_default
from mirage.workspace.snapshot.utils import FORMAT_VERSION

# The control-plane subtree: everything about the workspace that is
# not file content lives under one reserved directory, so a commit is
# the WHOLE world (files + sessions + namespace + history) while file
# paths stay clean. Cache stays out: it is derived and rebuildable.
CONTROL_PREFIX = ".mirage/"
META_PATH = ".mirage/meta.json"
SESSIONS_PATH = ".mirage/sessions.json"
NAMESPACE_PATH = ".mirage/namespace.json"
# History mirrors the live ObserverStore layout: one append-only jsonl
# per session, merged on read by stable timestamp sort (the events()
# contract). A session that ran nothing since the last commit keeps an
# identical blob, so it dedups in the content-addressed store.
HISTORY_PREFIX = ".mirage/history/"

# The four restorable categories of a whole-world version.
CATEGORIES = ("files", "sessions", "namespace", "history")


def _is_reserved(tree_path: str) -> bool:
    return tree_path.startswith(CONTROL_PREFIX)


def _history_entries(events: list[dict[str, Any]]) -> dict[str, bytes]:
    by_session: dict[str, list[str]] = {}
    for e in events:
        session = e.get("session") or "default"
        by_session.setdefault(session,
                              []).append(json.dumps(e, default=_json_default))
    return {
        f"{HISTORY_PREFIX}{session}.jsonl":
        ("\n".join(lines) + "\n").encode("utf-8")
        for session, lines in by_session.items()
    }


def _history_from_entries(entries: dict[str, bytes]) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for tree_path in sorted(entries):
        if not tree_path.startswith(HISTORY_PREFIX):
            continue
        events.extend(
            json.loads(line)
            for line in entries[tree_path].decode("utf-8").splitlines()
            if line)
    events.sort(key=lambda e: e.get("timestamp", 0))
    return events


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


def meta_to_blob(meta: dict[str, Any]) -> bytes:
    return json.dumps(meta, default=_json_default).encode("utf-8")


def blob_to_meta(data: bytes) -> dict[str, Any]:
    return json.loads(data.decode("utf-8"))


def tree_inputs_from_state(
        state: dict[str, Any]) -> tuple[dict[str, bytes], dict[str, Any]]:
    entries: dict[str, bytes] = {}
    mounts_meta: list[dict[str, Any]] = []
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
    entries[SESSIONS_PATH] = meta_to_blob({
        "sessions":
        state.get(StateKey.SESSIONS) or [],
    })
    entries[NAMESPACE_PATH] = meta_to_blob({
        "nodes": state.get(StateKey.NODES) or {},
    })
    entries.update(_history_entries(state.get(StateKey.HISTORY) or []))
    meta = {
        "mounts": mounts_meta,
        "config": config,
        "fingerprints": state.get(StateKey.FINGERPRINTS) or [],
    }
    return entries, meta


def to_state(entries: dict[str, bytes], meta: dict[str,
                                                   Any]) -> dict[str, Any]:
    mounts: list[dict[str, Any]] = []
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
    sessions_blob = entries.get(SESSIONS_PATH)
    sessions = (blob_to_meta(sessions_blob).get("sessions", [])
                if sessions_blob is not None else [])
    namespace_blob = entries.get(NAMESPACE_PATH)
    nodes = (blob_to_meta(namespace_blob).get("nodes", {})
             if namespace_blob is not None else {})
    history = _history_from_entries(entries)
    return {
        StateKey.VERSION: FORMAT_VERSION,
        StateKey.MIRAGE_VERSION: config.get(StateKey.MIRAGE_VERSION,
                                            "unknown"),
        StateKey.MOUNTS: mounts,
        StateKey.SESSIONS: sessions,
        StateKey.DEFAULT_SESSION_ID: config.get(StateKey.DEFAULT_SESSION_ID),
        StateKey.DEFAULT_AGENT_ID: config.get(StateKey.DEFAULT_AGENT_ID),
        StateKey.CURRENT_AGENT_ID: config.get(StateKey.CURRENT_AGENT_ID),
        StateKey.CACHE: {
            CacheKey.LIMIT: config.get(CacheKey.LIMIT, "512MB"),
            CacheKey.MAX_DRAIN_BYTES: config.get(CacheKey.MAX_DRAIN_BYTES),
            CacheKey.ENTRIES: [],
        },
        StateKey.HISTORY: history,
        StateKey.JOBS: [],
        StateKey.FINGERPRINTS: meta.get("fingerprints", []),
        StateKey.NODES: nodes,
        StateKey.LIVE_ONLY_MOUNTS: [],
    }
