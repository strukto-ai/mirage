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

from collections.abc import Iterable
from typing import Any

from mirage.types import CommandSafeguard

_DEFAULT_MAX_LINES = 2000
_DEFAULT_TIMEOUT_SECONDS = 600.0

DEFAULT_COMMAND_SAFEGUARDS: dict[str, CommandSafeguard] = {
    name:
    CommandSafeguard(max_lines=_DEFAULT_MAX_LINES,
                     timeout_seconds=_DEFAULT_TIMEOUT_SECONDS)
    for name in ("cat", "grep", "rg", "head", "tail")
}

FALLBACK_SAFEGUARD = CommandSafeguard(timeout_seconds=_DEFAULT_TIMEOUT_SECONDS)


def resolve_safeguard(
    name: str,
    command_default: CommandSafeguard | None = None,
    mount_override: CommandSafeguard | None = None,
) -> CommandSafeguard | None:
    if mount_override is not None:
        return mount_override
    if command_default is not None:
        return command_default
    return DEFAULT_COMMAND_SAFEGUARDS.get(name, FALLBACK_SAFEGUARD)


def resolve_across_mounts(
    name: str,
    mounts: Iterable[Any],
) -> CommandSafeguard | None:
    """Resolve and aggregate the safeguard across the mounts a command spans.

    A command that touches several mounts but yields one stream
    (cross-mount cat, fan-out find/grep -r/du/tree/ls -R) must respect
    every spanned mount's guard, so each mount's per-command override is
    resolved and combined with CommandSafeguard.aggr (tightest per field).

    Args:
        name (str): command name being resolved.
        mounts (Iterable): the mounts the command spans.
    """
    resolved = [
        resolve_safeguard(name, None, m.command_safeguards.get(name))
        for m in mounts
    ]
    return CommandSafeguard.aggr(resolved)
