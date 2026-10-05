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

from collections.abc import Sequence

from mirage.commands.builtin.generic.crossmount.constants import (
    CROSS_MOUNT_COMMANDS,
    FANOUT_COMMANDS,
    RELAY_COMMANDS,
    STREAM_COMMANDS,
)
from mirage.commands.builtin.generic.crossmount.types import Cmd, Strategy
from mirage.types import PathSpec


def strategy_for(cmd_name: str) -> Strategy:
    """Pick the combine strategy for one cross-mount command invocation.

    Args:
        cmd_name (str): Command name, must be in CROSS_MOUNT_COMMANDS.
    """
    if cmd_name in RELAY_COMMANDS:
        return Strategy.RELAY
    if cmd_name in STREAM_COMMANDS:
        return Strategy.STREAM
    if cmd_name in FANOUT_COMMANDS:
        return Strategy.FANOUT
    raise ValueError(f"Unsupported cross-mount command: {cmd_name}")


def is_cross_mount(
    cmd_name: str,
    scopes: list[PathSpec],
    registry,
    flag_scopes: Sequence[PathSpec] = (),
) -> bool:
    if cmd_name not in CROSS_MOUNT_COMMANDS or len(scopes) < 2:
        return False
    mounts = set()
    for s in scopes:
        m = registry.try_mount_for(s.virtual)
        # a scope outside any mount cannot make the command cross-mount
        if m is not None:
            mounts.add(m.prefix)
    # A copy of a tree that holds a mount reads both filesystems, the way
    # GNU cp -r copies across one, even from a single mount's operands.
    # Only a source counts: the destination (-t's directory, else the last
    # operand) lands beside a mount and crosses nothing.
    landing = {s.virtual for s in flag_scopes or scopes[-1:]}
    return len(mounts) > 1 or (
        cmd_name == Cmd.CP
        and any(
            registry.descendant_mounts(s.virtual)
            for s in scopes
            if s.virtual not in landing
        )
    )
