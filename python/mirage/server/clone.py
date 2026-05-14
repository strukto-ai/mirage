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

from mirage import Workspace
from mirage.resource.registry import build_resource
from mirage.workspace.snapshot import to_state_dict
from mirage.workspace.snapshot.utils import norm_mount_prefix


def _build_override_resources(override: dict[str, Any] | None) -> dict:
    if not override:
        return {}
    if "mounts" not in override:
        return {}
    out: dict = {}
    for prefix, block in override["mounts"].items():
        if not isinstance(block, dict):
            continue
        resource_name = block.get("resource")
        config = block.get("config") or {}
        if resource_name is None:
            continue
        out[norm_mount_prefix(prefix)] = build_resource(resource_name, config)
    return out


def _existing_needs_override_resources(ws: Workspace, skip: set[str]) -> dict:
    auto_prefixes = {"/dev/"}
    if ws.observer is not None:
        auto_prefixes.add(norm_mount_prefix(ws.observer.prefix))
    out: dict = {}
    for m in ws._registry.mounts():
        if m.prefix in auto_prefixes:
            continue
        if m.prefix in skip:
            continue
        state = m.resource.get_state()
        if state.get("needs_override"):
            out[m.prefix] = m.resource
    return out


async def clone_workspace_with_override(src_ws: Workspace,
                                        override: dict[str, Any]
                                        | None) -> Workspace:
    """Snapshot ``src_ws`` and rebuild a fresh workspace from state.

    Behavior:
        * Local resources (RAM, Disk) are reconstructed fresh, so the
          clone's writes never touch the original's data.
        * Remote resources (S3, Redis, GDrive, ...) that declare
          ``needs_override=True`` are reused from the original by
          default -- they share connection pools and bucket data.
        * If ``override`` supplies a fresh resource for a prefix, that
          resource replaces the reused one -- e.g. point the clone at
          a different S3 bucket.

    Args:
        src_ws (Workspace): the source workspace.
        override (dict[str, Any] | None): partial workspace config
            with ``mounts: {<prefix>: {resource, config}}`` entries to
            swap.

    Returns:
        Workspace: a new, independent workspace.
    """
    state = to_state_dict(src_ws)
    override_resources = _build_override_resources(override)
    existing = _existing_needs_override_resources(src_ws,
                                                  skip=set(override_resources))
    merged = {**existing, **override_resources}
    return Workspace._from_state(state, resources=merged)
