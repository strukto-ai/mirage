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

import importlib
import importlib.metadata
import tempfile

from mirage.shell.job_table import Job, JobStatus
from mirage.types import (CacheKey, ConsistencyPolicy, JobKey, MountKey,
                          MountMode, NodeKey, RecordKey, ResourceName,
                          ResourceStateKey, SessionKey, StateKey)
from mirage.workspace.snapshot.config import MountArgs
from mirage.workspace.snapshot.drift import (capture_fingerprints,
                                             live_only_mount_prefixes)
from mirage.workspace.snapshot.utils import FORMAT_VERSION, norm_mount_prefix
from mirage.workspace.types import ExecutionNode, ExecutionRecord


def _mirage_version() -> str:
    try:
        return importlib.metadata.version("mirage")
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


def to_state_dict(ws) -> dict:
    auto_prefixes = {"/dev/"}
    if ws.observer is not None:
        auto_prefixes.add(norm_mount_prefix(ws.observer.prefix))

    mounts_state = []
    for idx, m in enumerate(mt for mt in ws._registry.mounts()
                            if mt.prefix not in auto_prefixes):
        mounts_state.append({
            MountKey.INDEX: idx,
            MountKey.PREFIX: m.prefix,
            MountKey.MODE: m.mode.value,
            MountKey.CONSISTENCY: m.consistency.value,
            MountKey.RESOURCE_CLASS:
            f"{type(m.resource).__module__}.{type(m.resource).__name__}",
            MountKey.RESOURCE_STATE: m.resource.get_state(),
        })

    cache = ws._cache
    cache_entries = [{
        CacheKey.KEY: k,
        CacheKey.DATA: cache._store.files.get(k, b""),
        CacheKey.FINGERPRINT: e.fingerprint,
        CacheKey.TTL: e.ttl,
        CacheKey.CACHED_AT: e.cached_at,
        CacheKey.SIZE: e.size,
    } for k, e in cache._entries.items()]

    history_records = ([_record_to_dict(r) for r in ws.history.entries()]
                       if ws.history is not None else None)

    finished_jobs = [
        _job_to_dict(j) for j in ws.job_table.list_jobs()
        if j.status != JobStatus.RUNNING
    ]

    fingerprints = capture_fingerprints(ws)
    live_only_mounts = live_only_mount_prefixes(ws)

    return {
        StateKey.VERSION: FORMAT_VERSION,
        StateKey.MIRAGE_VERSION: _mirage_version(),
        StateKey.MOUNTS: mounts_state,
        StateKey.SESSIONS: [s.to_dict() for s in ws._session_mgr.list()],
        StateKey.DEFAULT_SESSION_ID: ws._session_mgr.default_id,
        StateKey.DEFAULT_AGENT_ID: ws._default_agent_id,
        StateKey.CURRENT_AGENT_ID: ws._current_agent_id,
        StateKey.CACHE: {
            CacheKey.LIMIT: cache.cache_limit,
            CacheKey.MAX_DRAIN_BYTES: cache.max_drain_bytes,
            CacheKey.ENTRIES: cache_entries,
        },
        StateKey.HISTORY: history_records,
        StateKey.JOBS: finished_jobs,
        StateKey.FINGERPRINTS: fingerprints,
        StateKey.LIVE_ONLY_MOUNTS: live_only_mounts,
    }


def build_mount_args(state: dict, resources: dict | None = None) -> MountArgs:
    """Translate a state dict into Workspace constructor inputs.

    Validates that every needs_override mount has a resource override.
    Does NOT construct a Workspace — that's the caller's job.

    Raises:
        ValueError: if any needs_override mount lacks an override, or
            if the snapshot is from an unsupported format version.
    """
    saved_version = state.get(StateKey.VERSION)
    if saved_version is not None and saved_version < FORMAT_VERSION:
        raise ValueError(f"snapshot format v{saved_version} not supported "
                         f"(loader expects v{FORMAT_VERSION}); "
                         "regenerate via `mirage workspace snapshot`")

    overrides = {norm_mount_prefix(k): v for k, v in (resources or {}).items()}

    missing = [
        m[MountKey.PREFIX] for m in state[StateKey.MOUNTS]
        if m[MountKey.RESOURCE_STATE].get(ResourceStateKey.NEEDS_OVERRIDE)
        and norm_mount_prefix(m[MountKey.PREFIX]) not in overrides
    ]
    if missing:
        raise ValueError(
            "Workspace.load: resources= must include overrides for: "
            f"{missing}. These mounts were saved with redacted creds "
            "or transient connection state and need fresh resources.")

    mount_args: dict[str, tuple] = {}
    for m in state[StateKey.MOUNTS]:
        prefix = norm_mount_prefix(m[MountKey.PREFIX])
        prov = (overrides[prefix]
                if prefix in overrides else _construct_resource(m))
        mount_args[m[MountKey.PREFIX]] = (prov, MountMode(m[MountKey.MODE]))

    return MountArgs(
        mount_args=mount_args,
        consistency=ConsistencyPolicy.LAZY,
        default_session_id=state.get(StateKey.DEFAULT_SESSION_ID, "default"),
        default_agent_id=state.get(StateKey.DEFAULT_AGENT_ID, "default"),
    )


def apply_state_dict(ws, state: dict) -> None:
    """Restore post-construction state into an already-built Workspace.

    Restores: resource load_state (content, fresh disk root, etc.),
    sessions, cache entries, history, finished jobs.

    Workspace must already have its mounts constructed via the args
    from build_mount_args. This function is purely additive — it does
    not construct anything.
    """
    # load_state runs for ALL mounts (overridden too), so disk content
    # is written into the new root, redis content into the new URL, etc.
    # Cred-only resources (S3 et al.) define load_state as no-op.
    for m in state[StateKey.MOUNTS]:
        try:
            mount = ws._registry.mount_for_prefix(m[MountKey.PREFIX])
        except ValueError:
            continue
        mount.resource.load_state(m[MountKey.RESOURCE_STATE])

    _restore_sessions(ws, state)
    ws._current_agent_id = state.get(StateKey.CURRENT_AGENT_ID,
                                     ws._default_agent_id)

    _restore_cache(ws, state)
    _restore_history(ws, state)
    _restore_jobs(ws, state)


def _restore_sessions(ws, state: dict) -> None:
    default_sid = state.get(StateKey.DEFAULT_SESSION_ID)
    for s_data in state.get(StateKey.SESSIONS, []):
        sid = s_data[SessionKey.SESSION_ID]
        if sid == default_sid:
            session = ws._session_mgr.get(sid)
        else:
            try:
                session = ws._session_mgr.create(sid)
            except ValueError:
                continue
        session.cwd = s_data.get(SessionKey.CWD, "/")
        session.env = s_data.get(SessionKey.ENV, {})


def _restore_cache(ws, state: dict) -> None:
    cache_state = state.get(StateKey.CACHE) or {}
    if hasattr(ws._cache, "max_drain_bytes"):
        ws._cache.max_drain_bytes = cache_state.get(CacheKey.MAX_DRAIN_BYTES)
    cache = ws._cache
    if not hasattr(cache, "_entries") or not hasattr(cache, "_store"):
        # Non-RAM cache backend (e.g. Redis) — skip; its content lives
        # outside the workspace and isn't part of the snapshot anyway.
        return
    from mirage.cache.file.entry import CacheEntry
    for entry in cache_state.get(CacheKey.ENTRIES, []):
        key = entry[CacheKey.KEY]
        data = entry[CacheKey.DATA]
        cache._store.files[key] = data
        cache._entries[key] = CacheEntry(
            size=entry.get(CacheKey.SIZE, len(data)),
            cached_at=entry.get(CacheKey.CACHED_AT, 0),
            fingerprint=entry.get(CacheKey.FINGERPRINT),
            ttl=entry.get(CacheKey.TTL),
        )
        cache._cache_size += entry.get(CacheKey.SIZE, len(data))


def _restore_history(ws, state: dict) -> None:
    if not state.get(StateKey.HISTORY) or ws.history is None:
        return
    ws.history._entries = []
    for rec_d in state[StateKey.HISTORY]:
        ws.history.append(_record_from_dict(rec_d))


def _restore_jobs(ws, state: dict) -> None:
    max_id = 0
    for job_d in state.get(StateKey.JOBS, []):
        max_id = max(max_id, job_d.get(JobKey.ID, 0))
        ws.job_table._jobs[job_d[JobKey.ID]] = _job_from_dict(job_d)
    ws.job_table._next_id = max_id + 1


def _record_to_dict(record) -> dict:
    return {
        RecordKey.AGENT: record.agent,
        RecordKey.COMMAND: record.command,
        RecordKey.STDOUT: record.stdout,
        RecordKey.STDIN: record.stdin,
        RecordKey.EXIT_CODE: record.exit_code,
        RecordKey.TREE: _node_to_dict(record.tree),
        RecordKey.TIMESTAMP: record.timestamp,
        RecordKey.SESSION_ID: record.session_id,
    }


def _record_from_dict(d: dict):
    return ExecutionRecord(
        agent=d[RecordKey.AGENT],
        command=d[RecordKey.COMMAND],
        stdout=d.get(RecordKey.STDOUT, b"") or b"",
        stdin=d.get(RecordKey.STDIN),
        exit_code=d.get(RecordKey.EXIT_CODE, 0),
        tree=_node_from_dict(d.get(RecordKey.TREE) or {}),
        timestamp=d.get(RecordKey.TIMESTAMP, 0.0),
        session_id=d.get(RecordKey.SESSION_ID, "default"),
    )


def _node_to_dict(node) -> dict:
    return {
        NodeKey.COMMAND: node.command,
        NodeKey.OP: node.op,
        NodeKey.STDERR: node.stderr,
        NodeKey.EXIT_CODE: node.exit_code,
        NodeKey.CHILDREN: [_node_to_dict(c) for c in node.children],
    }


def _node_from_dict(d: dict):
    return ExecutionNode(
        command=d.get(NodeKey.COMMAND),
        op=d.get(NodeKey.OP),
        stderr=d.get(NodeKey.STDERR, b"") or b"",
        exit_code=d.get(NodeKey.EXIT_CODE, 0),
        children=[_node_from_dict(c) for c in d.get(NodeKey.CHILDREN, [])],
    )


def _job_to_dict(job) -> dict:
    return {
        JobKey.ID: job.id,
        JobKey.COMMAND: job.command,
        JobKey.CWD: job.cwd,
        JobKey.STATUS: job.status.value,
        JobKey.STDOUT: job.stdout,
        JobKey.STDERR: job.stderr,
        JobKey.EXIT_CODE: job.exit_code,
        JobKey.CREATED_AT: job.created_at,
        JobKey.AGENT: job.agent,
        JobKey.SESSION_ID: job.session_id,
    }


def _job_from_dict(d: dict):
    return Job(
        id=d[JobKey.ID],
        command=d[JobKey.COMMAND],
        task=None,
        cwd=d.get(JobKey.CWD, "/"),
        status=JobStatus(d.get(JobKey.STATUS, JobStatus.COMPLETED.value)),
        stdout=d.get(JobKey.STDOUT, b"") or b"",
        stderr=d.get(JobKey.STDERR, b"") or b"",
        exit_code=d.get(JobKey.EXIT_CODE, 0),
        created_at=d.get(JobKey.CREATED_AT, 0.0),
        agent=d.get(JobKey.AGENT, "unknown"),
        session_id=d.get(JobKey.SESSION_ID, "default"),
    )


def _construct_resource(mount_state: dict):
    cls_path = mount_state[MountKey.RESOURCE_CLASS]
    mod_name, cls_name = cls_path.rsplit(".", 1)
    cls = getattr(importlib.import_module(mod_name), cls_name)
    resource_state = mount_state[MountKey.RESOURCE_STATE]
    ptype = resource_state.get(ResourceStateKey.TYPE, "")

    if ptype == ResourceName.RAM:
        return cls()
    if ptype == ResourceName.DISK:
        return cls(root=tempfile.mkdtemp(prefix="mirage-disk-"))
    if ptype == ResourceName.REDIS:
        raise ValueError(
            f"Redis mount at {mount_state[MountKey.PREFIX]} requires "
            "resources= override")

    config = resource_state.get(ResourceStateKey.CONFIG)
    if config is None:
        return cls()
    config_cls = _config_class_for(cls)
    if config_cls is not None:
        return cls(config_cls(**config))
    return cls()


def _config_class_for(resource_cls):
    mod = importlib.import_module(resource_cls.__module__)
    for name in dir(mod):
        obj = getattr(mod, name)
        if (isinstance(obj, type) and name.endswith("Config")
                and obj.__module__ == resource_cls.__module__):
            return obj
    return None
