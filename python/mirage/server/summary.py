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

import logging
from collections.abc import Mapping
from typing import TypeVar

from mirage import Workspace
from mirage.server.registry import WorkspaceEntry
from mirage.server.schemas import (
    MountSummary,
    SessionSummary,
    WorkspaceBrief,
    WorkspaceDetail,
    WorkspaceInternals,
)
from mirage.shell.constants import BIN_PREFIX
from mirage.types import JsonValue, MountBackend, parse_mount_mode
from mirage.utils.dates import ms_to_rfc3339
from mirage.utils.path import norm_dir
from mirage.vfs.base import BaseVFS
from mirage.vfs.history import HISTORY_PREFIX
from mirage.workspace.mount.mount import MountEntry

logger = logging.getLogger(__name__)

_AUTO_PREFIXES = {
    "/dev/",
    norm_dir(HISTORY_PREFIX),
    norm_dir(BIN_PREFIX),
}
_DESCRIPTION_MAX = 120


def _is_auto_prefix(prefix: str) -> bool:
    return prefix in _AUTO_PREFIXES


def _describe_vfs(vfs: BaseVFS) -> str:
    raw = vfs.vfs_md
    if len(raw) <= _DESCRIPTION_MAX:
        return raw
    return raw[: _DESCRIPTION_MAX - 1].rstrip() + "\u2026"


def _user_mounts(ws: Workspace) -> list[MountEntry]:
    return [m for m in ws._registry.mounts() if not _is_auto_prefix(m.prefix)]


async def _build_internals(ws: Workspace) -> WorkspaceInternals:
    cache = ws.cache
    history_len = len(await ws.observer.command_events())
    return WorkspaceInternals(
        cache_bytes=cache.cache_size,
        cache_entries=cache.cache_entries,
        history_length=history_len,
        in_flight_jobs=len(ws.job_table.all_running_jobs()),
    )


def make_brief(entry: WorkspaceEntry) -> WorkspaceBrief:
    return WorkspaceBrief(
        id=entry.id,
        status="running",
        created_at=ms_to_rfc3339(entry.created_at * 1000),
    )


async def make_detail(
    entry: WorkspaceEntry, verbose: bool = False
) -> WorkspaceDetail:
    """The workspace's detail, read on its own loop.

    Its mounts, sessions and job table belong to the workspace's thread,
    and its history is read through its own dispatcher, so the whole read
    runs there rather than on the caller's loop.

    Args:
        entry (WorkspaceEntry): the workspace.
        verbose (bool): include cache, history and job counts.
    """
    ws = entry.runner.ws

    async def detail() -> WorkspaceDetail:
        user_mounts = _user_mounts(ws)
        points = _by_dir(ws.fuse_mountpoints)
        backends = _by_dir(ws.kernel_backends)
        mounts = [
            MountSummary(
                prefix=m.prefix,
                vfs=m.vfs.name,
                mode=m.mode.value,
                description=_describe_vfs(m.vfs),
                backend=backends.get(m.prefix, MountBackend.WORKSPACE),
                mountpoint=points.get(m.prefix),
            )
            for m in user_mounts
        ]
        sessions = [
            SessionSummary(session_id=s.session_id, cwd=s.cwd)
            for s in ws.list_sessions()
        ]
        return WorkspaceDetail(
            id=entry.id,
            status="running",
            created_at=ms_to_rfc3339(entry.created_at * 1000),
            system_time=ws.system_time,
            mounts=mounts,
            sessions=sessions,
            internals=await _build_internals(ws) if verbose else None,
        )

    return await entry.runner.call(detail())


T = TypeVar("T")


def _by_dir(mapping: Mapping[str, T]) -> dict[str, T]:
    """A kernel-mount map keyed by directory prefix, as mounts list theirs.

    Args:
        mapping (Mapping[str, T]): values keyed by the prefix as exposed.
    """
    return {norm_dir(k): v for k, v in mapping.items()}


def _config_mounts(config: dict[str, JsonValue] | None) -> list[MountSummary]:
    """The mounts a stopped workspace's config names, as a running one's
    would list them, longest prefix first: a mount with no mode of its own
    takes the config's, write by default.

    Args:
        config (dict[str, JsonValue] | None): the config it starts from.
    """
    mounts = (config or {}).get("mounts")
    if not isinstance(mounts, dict):
        return []
    fallback = _mode_of((config or {}).get("mode"), "write")
    out: list[MountSummary] = []
    for prefix, mount in mounts.items():
        spec = mount if isinstance(mount, dict) else {}
        vfs = spec.get("vfs")
        summary = MountSummary(
            prefix=norm_dir(prefix),
            vfs=vfs if isinstance(vfs, str) else "",
            mode=_mode_of(spec.get("mode"), fallback),
            description="",
            backend=_backend_of(spec.get("backend")),
        )
        if not _is_auto_prefix(summary.prefix):
            out.append(summary)
    out.sort(key=lambda m: len(m.prefix), reverse=True)
    return out


def _backend_of(value: JsonValue) -> MountBackend:
    """The backend a saved config's mount names, ``workspace`` when it
    names none.

    Args:
        value (JsonValue): the backend the config wrote, if any.
    """
    if not isinstance(value, str) or not value:
        return MountBackend.WORKSPACE
    try:
        return MountBackend(value.lower())
    except ValueError as exc:
        logger.debug("mirage: a saved config's backend did not parse: %s", exc)
        return MountBackend.WORKSPACE


def _mode_of(value: JsonValue, fallback: str) -> str:
    """A mode as a running workspace names it, an alias such as ``rw``
    read as ``write``; ``fallback`` when the config gives none.

    Args:
        value (JsonValue): the mode the config wrote, if any.
        fallback (str): the mode when it wrote none.
    """
    if not isinstance(value, str):
        return fallback
    try:
        return parse_mount_mode(value.lower()).value
    except ValueError as exc:
        logger.debug(
            "mirage: a saved config's mount mode did not parse: %s", exc
        )
        return value.lower()


def make_stopped_brief(workspace_id: str, created_at: float) -> WorkspaceBrief:
    """A stopped workspace's brief.

    Args:
        workspace_id (str): the workspace.
        created_at (float): when it was first created, in epoch seconds.
    """
    return WorkspaceBrief(
        id=workspace_id,
        status="stopped",
        created_at=ms_to_rfc3339(created_at * 1000),
    )


def make_stopped_detail(
    workspace_id: str,
    config: dict[str, JsonValue] | None,
    created_at: float,
) -> WorkspaceDetail:
    """A stopped workspace's detail, as ``make_stopped_brief``.

    Args:
        workspace_id (str): the workspace.
        config (dict[str, JsonValue] | None): the config it starts from,
            None when it kept none.
        created_at (float): when it was first created, in epoch seconds.
    """
    return WorkspaceDetail(
        id=workspace_id,
        status="stopped",
        created_at=ms_to_rfc3339(created_at * 1000),
        mounts=_config_mounts(config),
    )
