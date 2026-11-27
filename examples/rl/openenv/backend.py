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

import os
import shlex
import uuid
from pathlib import Path

from constants import (
    DEFAULT_PROFILE,
    VERIFIER_PROFILE,
    VERIFIER_SESSION_ID,
)
from schemas import MirageTask
from server import ServerPool

from mirage import Workspace
from mirage.config import load_config


async def _seed_tree(
    ws: Workspace, src_root: Path, dest_prefix: str = "/"
) -> None:
    if not src_root.is_dir():
        return
    for file_path in sorted(src_root.rglob("*")):
        if not file_path.is_file():
            continue
        rel = str(file_path.relative_to(src_root))
        target = (
            f"/{rel}"
            if dest_prefix == "/"
            else f"{dest_prefix.rstrip('/')}/{rel}"
        )
        parent = str(Path(target).parent)
        if parent and parent != "/":
            await ws.shell(
                f"mkdir -p {shlex.quote(parent)}",
                session_id=VERIFIER_SESSION_ID,
            )
        await ws.vfs.write(
            target,
            file_path.read_bytes(),
            session_id=VERIFIER_SESSION_ID,
        )
        if file_path.suffix == ".sh":
            await ws.shell(
                f"chmod +x {shlex.quote(target)}",
                session_id=VERIFIER_SESSION_ID,
            )


async def create_episode_workspace(
    task: MirageTask, servers: ServerPool
) -> Workspace:
    """Allocate per-run backend endpoints and build one episode Workspace.

    Each backend declared in ``task.backends`` receives its own isolated
    ``/_run/<run_id>`` endpoint interpolated directly into ``workspace.yaml``.
    The default session keeps ``profiles.default`` while an internal
    ``_verifier`` session seeds files and executes ``/tests/test.sh``.

    Args:
        task (MirageTask): Task definition pointing at ``environment/`` and
            ``tests/``.
        servers (ServerPool): Shared pool of ``integ/server`` backends.

    Returns:
        Workspace: Seeded Mirage workspace ready for ``MirageOpenEnv``.
    """
    run_id = uuid.uuid4().hex[:8]
    endpoints = await servers.allocate_endpoints(run_id, task.backends)

    env_dir = task.task_dir / "environment"
    interp_env = {**os.environ, **endpoints}
    ws_cfg = load_config(env_dir / "workspace.yaml", env=interp_env)
    ws_kwargs = ws_cfg.to_workspace_kwargs()
    merged_env = {**dict(ws_kwargs.pop("env", None) or {}), **endpoints}

    ws = Workspace(**ws_kwargs, env=merged_env)
    ws.set_profile(VERIFIER_PROFILE, {"cwd": "/workspace"})
    ws.create_session(VERIFIER_SESSION_ID, profile=VERIFIER_PROFILE)
    await _seed_tree(ws, env_dir / "files", dest_prefix="/")
    await _seed_tree(ws, task.task_dir / "tests", dest_prefix="/tests")
    await ws.set_session_profile(ws.default_session_id, DEFAULT_PROFILE)
    return ws
