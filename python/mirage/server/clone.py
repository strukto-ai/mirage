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

from collections.abc import Mapping
from typing import Any

from mirage import Workspace
from mirage.resource.history import HISTORY_PREFIX
from mirage.resource.registry import build_resource
from mirage.secrets.config import SecretSource
from mirage.secrets.sources import resolve_config_secrets, resolve_sources_for
from mirage.workspace.snapshot import requires_resource_override, to_state_dict
from mirage.workspace.snapshot.utils import norm_mount_prefix


async def build_override_resources(
    override: dict[str, Any] | None,
    declared: Mapping[str, "SecretSource | Mapping[str, Any]"] | None,
) -> dict[str, Any]:
    """Build the mounts an override supplies, against the declarations
    the new workspace will run with.

    Shared by the clone and load doors, which both take the same
    ``mounts: {<prefix>: {resource, config}}`` shape. An override mount
    reads a pointer the way a yaml one does: `build_resource` is sync,
    so the credential is fetched before it. The declared sources are
    built only when an override config names one, so an override that
    swaps a RAM mount never reads a bootstrap file.

    Args:
        override (dict[str, Any] | None): the partial workspace config,
            as it arrived.
        declared (Mapping[str, SecretSource | Mapping[str, Any]] | None):
            the `secrets:` block the new workspace will run with.

    Returns:
        dict[str, Any]: prefix -> built resource, empty when the
            override names no mount.
    """
    if not override or "mounts" not in override:
        return {}
    blocks = {
        prefix: (block["resource"], block.get("config") or {})
        for prefix, block in override["mounts"].items()
        if isinstance(block, dict) and block.get("resource") is not None
    }
    sources = await resolve_sources_for(
        declared, [config for _, config in blocks.values()])
    out: dict[str, Any] = {}
    for prefix, (resource_name, config) in blocks.items():
        out[norm_mount_prefix(prefix)] = build_resource(
            resource_name, await
            resolve_config_secrets(config, sources, f"mounts.{prefix}.config"))
    return out


def _existing_redacted_resources(ws: Workspace, state: dict[str, Any],
                                 skip: set[str]) -> dict[str, Any]:
    auto_prefixes = {"/dev/", norm_mount_prefix(HISTORY_PREFIX)}
    prefix_to_resource = {
        m.prefix: m.resource
        for m in ws._registry.mounts() if m.prefix not in auto_prefixes
    }
    out: dict[str, Any] = {}
    for m in state["mounts"]:
        prefix = m["prefix"]
        if norm_mount_prefix(prefix) in skip:
            continue
        if requires_resource_override(m) and prefix in prefix_to_resource:
            out[prefix] = prefix_to_resource[prefix]
    return out


async def clone_workspace_with_override(src_ws: Workspace,
                                        override: dict[str, Any]
                                        | None) -> Workspace:
    """Snapshot ``src_ws`` and rebuild a fresh workspace from state.

    Behavior:
        * Local resources (RAM, Disk) are reconstructed fresh, so the
          clone's writes never touch the original's data.
        * Remote resources (S3, Redis, GDrive, ...) that redact secrets
          or connection material are reused from the original by default
          -- they share connection pools and bucket data.
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
    state = await to_state_dict(src_ws)
    # Same-process, so the declarations travel with the clone the way
    # a reused remote resource does: the state carries the env
    # pointers but never the `secrets:` block behind them. An override
    # naming its own wins, the way a mount override does, so a staging
    # clone does not keep reading production accounts.
    supplied = (override or {}).get("secrets")
    secrets = supplied if supplied is not None else src_ws.declared_sources
    override_resources = await build_override_resources(override, secrets)
    existing = _existing_redacted_resources(src_ws,
                                            state,
                                            skip=set(override_resources))
    merged = {**existing, **override_resources}
    return await Workspace._from_state(state,
                                       resources=merged,
                                       secrets=secrets)
