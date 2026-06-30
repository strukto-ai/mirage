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

from mirage.types import (CacheKey, JobKey, MountKey, ResourceName,
                          ResourceStateKey, StateKey)
from mirage.workspace.snapshot.utils import BLOB_REF_KEY, is_safe_blob_path


class _BlobAllocator:
    """Mints unique blob filenames per category and collects their bytes.

    `alloc("_cache") -> "_cache/0.bin"` on first call, "_cache/1.bin"
    next, and so on. The category prefix is just for uniqueness; the
    real tar path is decided by the caller and stored in `blobs`.
    """

    def __init__(self) -> None:
        self.blobs: dict[str, bytes] = {}
        self._counters: dict[str, int] = {}

    def alloc(self, category: str) -> str:
        i = self._counters.get(category, 0)
        self._counters[category] = i + 1
        return f"{category}/{i}.bin"


def split_manifest_and_blobs(state: dict) -> tuple[dict, dict[str, bytes]]:
    a = _BlobAllocator()

    manifest: dict = {
        StateKey.VERSION: state[StateKey.VERSION],
        StateKey.MIRAGE_VERSION: state[StateKey.MIRAGE_VERSION],
        StateKey.DEFAULT_SESSION_ID: state[StateKey.DEFAULT_SESSION_ID],
        StateKey.DEFAULT_AGENT_ID: state[StateKey.DEFAULT_AGENT_ID],
        StateKey.CURRENT_AGENT_ID: state[StateKey.CURRENT_AGENT_ID],
        StateKey.SESSIONS: state[StateKey.SESSIONS],
        StateKey.HISTORY: _history_to_manifest(state.get(StateKey.HISTORY), a),
        StateKey.MOUNTS: [],
        StateKey.CACHE: {
            CacheKey.LIMIT:
            state[StateKey.CACHE][CacheKey.LIMIT],
            CacheKey.MAX_DRAIN_BYTES:
            state[StateKey.CACHE][CacheKey.MAX_DRAIN_BYTES],
            CacheKey.ENTRIES: [],
        },
        StateKey.JOBS: [],
        StateKey.FINGERPRINTS: state.get(StateKey.FINGERPRINTS) or [],
        StateKey.LIVE_ONLY_MOUNTS: state.get(StateKey.LIVE_ONLY_MOUNTS) or [],
        StateKey.SYMLINKS: state.get(StateKey.SYMLINKS) or {},
    }

    for m in state[StateKey.MOUNTS]:
        manifest[StateKey.MOUNTS].append(_mount_to_manifest(m, a))

    for entry in state[StateKey.CACHE][CacheKey.ENTRIES]:
        e = dict(entry)
        if isinstance(e.get(CacheKey.DATA), bytes):
            tar_path = "cache/blobs/" + a.alloc("_cache")
            a.blobs[tar_path] = e[CacheKey.DATA]
            e[CacheKey.DATA] = {BLOB_REF_KEY: tar_path}
        manifest[StateKey.CACHE][CacheKey.ENTRIES].append(e)

    for job in state.get(StateKey.JOBS, []):
        j = dict(job)
        for f in (JobKey.STDOUT, JobKey.STDERR):
            data = j.get(f)
            if isinstance(data, bytes) and data:
                tar_path = "jobs/blobs/" + a.alloc("_jobs")
                a.blobs[tar_path] = data
                j[f] = {BLOB_REF_KEY: tar_path}
            elif isinstance(data, bytes):
                j[f] = ""  # empty bytes -> empty string (JSON-safe)
        manifest[StateKey.JOBS].append(j)

    return manifest, a.blobs


def _mount_to_manifest(mount: dict, a: _BlobAllocator) -> dict:
    idx = mount[MountKey.INDEX]
    ps = dict(mount[MountKey.RESOURCE_STATE])
    ptype = ps.get(ResourceStateKey.TYPE, "")
    files = ps.get(ResourceStateKey.FILES, {})
    if ptype == ResourceName.RAM:
        ps[ResourceStateKey.FILES] = _stash_blobs(
            files, a, f"_ram{idx}", tar_dir=f"mounts/{idx}/files")
    elif ptype == ResourceName.DISK:
        # tree-preserving: real files at their relative paths
        new_files: dict[str, dict] = {}
        for rel, data in files.items():
            tar_path = f"mounts/{idx}/files/{rel}"
            a.blobs[tar_path] = data
            new_files[rel] = {BLOB_REF_KEY: tar_path}
        ps[ResourceStateKey.FILES] = new_files
    elif ptype == ResourceName.REDIS:
        ps[ResourceStateKey.FILES] = _stash_blobs(files,
                                                  a,
                                                  f"_redis{idx}",
                                                  tar_dir=f"mounts/{idx}/data")
    return {
        **{
            k: v
            for k, v in mount.items() if k != MountKey.RESOURCE_STATE
        }, MountKey.RESOURCE_STATE: ps
    }


def _stash_blobs(files: dict, a: _BlobAllocator, category: str,
                 tar_dir: str) -> dict:
    """Replace each {key: bytes} with {key: {__file: tar-path}}."""
    out: dict[str, dict] = {}
    for k, data in files.items():
        slot = a.alloc(category).split("/")[-1]
        tar_path = f"{tar_dir}/{slot}"
        a.blobs[tar_path] = data
        out[k] = {BLOB_REF_KEY: tar_path}
    return out


def _history_to_manifest(records, a: _BlobAllocator):
    if records is None:
        return None
    out = []
    for r in records:
        rd = dict(r)
        for f in ("stdout", "stdin", "stderr"):
            data = rd.get(f)
            if isinstance(data, bytes) and data:
                tar_path = "history/blobs/" + a.alloc("_history")
                a.blobs[tar_path] = data
                rd[f] = {BLOB_REF_KEY: tar_path}
            elif isinstance(data, bytes):
                rd[f] = ""  # empty bytes -> empty string
        if "tree" in rd:
            rd["tree"] = _node_to_manifest(rd["tree"], a)
        out.append(rd)
    return out


def _node_to_manifest(node, a: _BlobAllocator):
    if not isinstance(node, dict):
        return node
    out = dict(node)
    data = out.get("stderr")
    if isinstance(data, bytes) and data:
        tar_path = "history/blobs/" + a.alloc("_history")
        a.blobs[tar_path] = data
        out["stderr"] = {BLOB_REF_KEY: tar_path}
    elif isinstance(data, bytes):
        out["stderr"] = ""  # empty bytes -> empty string
    if "children" in out:
        out["children"] = [_node_to_manifest(c, a) for c in out["children"]]
    return out


def resolve_manifest(manifest: dict, blob_reader) -> dict:
    return _resolve(manifest, blob_reader)


def _resolve(node, blob_reader):
    if isinstance(node, dict):
        if set(node.keys()) == {BLOB_REF_KEY}:
            path = node[BLOB_REF_KEY]
            if not is_safe_blob_path(path):
                raise ValueError(f"Unsafe blob path in manifest: {path!r}")
            return blob_reader(path)
        return {k: _resolve(v, blob_reader) for k, v in node.items()}
    if isinstance(node, list):
        return [_resolve(v, blob_reader) for v in node]
    return node
