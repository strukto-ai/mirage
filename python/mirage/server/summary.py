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
from mirage.types import JsonValue
from mirage.utils.path import norm_dir
from mirage.vfs.base import BaseVFS
from mirage.vfs.history import HISTORY_PREFIX
from mirage.workspace.mount.mount import MountEntry

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
    ws = entry.runner.ws
    user_mounts = _user_mounts(ws)
    workspace_mode = user_mounts[0].mode.value if user_mounts else "read"
    return WorkspaceBrief(
        id=entry.id,
        status="running",
        mode=workspace_mode,
        mount_count=len(user_mounts),
        session_count=len(ws.list_sessions()),
        created_at=entry.created_at,
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
        workspace_mode = user_mounts[0].mode.value if user_mounts else "read"
        mounts = [
            MountSummary(
                prefix=m.prefix,
                vfs=m.vfs.name,
                mode=m.mode.value,
                description=_describe_vfs(m.vfs),
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
            mode=workspace_mode,
            created_at=entry.created_at,
            fuse_mountpoints=ws.fuse_mountpoints,
            system_time=ws.system_time,
            mounts=mounts,
            sessions=sessions,
            internals=await _build_internals(ws) if verbose else None,
        )

    return await entry.runner.call(detail())


def _config_mounts(config: dict[str, JsonValue] | None) -> list[MountSummary]:
    """The mounts a stopped workspace's config names, as a running one's
    would list them: a mount with no mode of its own takes the config's,
    write by default, and a mode reads in lower case, as a config may
    write it in any.

    Args:
        config (dict[str, JsonValue] | None): the config it starts from.
    """
    mounts = (config or {}).get("mounts")
    if not isinstance(mounts, dict):
        return []
    mode = (config or {}).get("mode")
    fallback = mode.lower() if isinstance(mode, str) else "write"
    out: list[MountSummary] = []
    for prefix, mount in mounts.items():
        spec = mount if isinstance(mount, dict) else {}
        vfs, own = spec.get("vfs"), spec.get("mode")
        summary = MountSummary(
            prefix=norm_dir(prefix),
            vfs=vfs if isinstance(vfs, str) else "",
            mode=own.lower() if isinstance(own, str) else fallback,
            description="",
        )
        if not _is_auto_prefix(summary.prefix):
            out.append(summary)
    return out


def make_stopped_brief(
    workspace_id: str,
    config: dict[str, JsonValue] | None,
    created_at: float,
) -> WorkspaceBrief:
    """A stopped workspace's brief.

    Args:
        workspace_id (str): the workspace.
        config (dict[str, JsonValue] | None): the config it starts from,
            None when it kept none.
        created_at (float): when it was first created.
    """
    mounts = _config_mounts(config)
    return WorkspaceBrief(
        id=workspace_id,
        status="stopped",
        mode=mounts[0].mode if mounts else "read",
        mount_count=len(mounts),
        session_count=0,
        created_at=created_at,
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
        created_at (float): when it was first created.
    """
    mounts = _config_mounts(config)
    return WorkspaceDetail(
        id=workspace_id,
        status="stopped",
        mode=mounts[0].mode if mounts else "read",
        created_at=created_at,
        mounts=mounts,
    )
