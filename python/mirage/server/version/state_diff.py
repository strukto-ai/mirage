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

from mirage.server.version.api import read_version, resolve_ref, version_diff
from mirage.server.version.state_tree import to_state
from mirage.server.version.store import VersionStore
from mirage.types import SessionKey, StateKey


def _dict_delta(before: dict[str, Any], after: dict[str,
                                                    Any]) -> dict[str, Any]:
    added = {k: after[k] for k in after.keys() - before.keys()}
    deleted = {k: before[k] for k in before.keys() - after.keys()}
    modified = {
        k: {
            "from": before[k],
            "to": after[k]
        }
        for k in before.keys() & after.keys() if before[k] != after[k]
    }
    return {"added": added, "deleted": deleted, "modified": modified}


def _is_empty(delta: dict[str, Any]) -> bool:
    return not (delta["added"] or delta["deleted"] or delta["modified"])


def _session_delta(before: dict[str, Any], after: dict[str,
                                                       Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    env = _dict_delta(
        before.get(SessionKey.ENV) or {},
        after.get(SessionKey.ENV) or {})
    if not _is_empty(env):
        out["env"] = env
    grants = _dict_delta(
        before.get("mount_modes") or {},
        after.get("mount_modes") or {})
    if not _is_empty(grants):
        out["mount_modes"] = grants
    if before.get(SessionKey.CWD) != after.get(SessionKey.CWD):
        out["cwd"] = {
            "from": before.get(SessionKey.CWD),
            "to": after.get(SessionKey.CWD),
        }
    return out


def _sessions_diff(before: list[dict[str, Any]],
                   after: list[dict[str, Any]]) -> dict[str, Any]:
    a = {s[SessionKey.SESSION_ID]: s for s in before}
    b = {s[SessionKey.SESSION_ID]: s for s in after}
    modified = {}
    for sid in a.keys() & b.keys():
        delta = _session_delta(a[sid], b[sid])
        if delta:
            modified[sid] = delta
    return {
        "added": sorted(b.keys() - a.keys()),
        "deleted": sorted(a.keys() - b.keys()),
        "modified": modified,
    }


def _commands_between(history_a: list[dict[str, Any]],
                      history_b: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The command trail from state A to state B: events in B's history
    that A does not already contain (identity by full event content, so
    replays and clears stay honest)."""
    seen = {tuple(sorted(e.items())) for e in history_a}
    return [e for e in history_b if tuple(sorted(e.items())) not in seen]


async def state_diff(store: VersionStore, ref_a, ref_b) -> dict[str, Any]:
    """The structured difference, category by category, between two versions.

    The judge's evidence surface: files (content), sessions (env
    references, mount grants with from/to, cwd), namespace nodes
    (symlinks and overlays), and the commands that ran between the two
    states. Wire shape is plain snake_case JSON, agent-legible by
    design.
    """
    version_a = await resolve_ref(store, ref_a)
    version_b = await resolve_ref(store, ref_b)
    entries_a, meta_a = await read_version(store, version_a)
    entries_b, meta_b = await read_version(store, version_b)
    state_a = to_state(entries_a, meta_a)
    state_b = to_state(entries_b, meta_b)

    sessions = _sessions_diff(
        state_a.get(StateKey.SESSIONS) or [],
        state_b.get(StateKey.SESSIONS) or [])
    namespace = _dict_delta(
        state_a.get(StateKey.NODES) or {},
        state_b.get(StateKey.NODES) or {})
    commands = _commands_between(
        state_a.get(StateKey.HISTORY) or [],
        state_b.get(StateKey.HISTORY) or [])
    return {
        "files": await version_diff(store, version_a, version_b),
        "sessions": sessions,
        "namespace": namespace,
        "commands": commands,
    }
