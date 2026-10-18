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
from mirage.commands.builtin.generic.crossmount.types import (
    Cmd,
    OperandMount,
    Strategy,
)
from mirage.commands.config import AggregateFn
from mirage.types import PathSpec


def strategy_for(cmd_name: str) -> Strategy:
    """Pick the combine strategy for one cross-mount command invocation.

    Args:
        cmd_name (str): Command name, must be in CROSS_MOUNT_COMMANDS.
    """
    if cmd_name in STREAM_COMMANDS:
        return Strategy.STREAM
    if cmd_name in FANOUT_COMMANDS:
        return Strategy.FANOUT
    if cmd_name in RELAY_COMMANDS:
        return Strategy.RELAY
    raise ValueError(f"Unsupported cross-mount command: {cmd_name}")


def is_cross_mount(
    cmd_name: str,
    operands: Sequence[OperandMount],
    flag_scopes: Sequence[PathSpec] = (),
) -> bool:
    """Whether one invocation spans mounts and runs as a cross-mount one.

    Args:
        cmd_name (str): Command name.
        operands (Sequence[OperandMount]): Path operands in command-line
            order, each with the mount the workspace resolved for it.
        flag_scopes (Sequence[PathSpec]): Path-valued flags (``-t``'s
            directory), which name where a copy lands.
    """
    if len(operands) < 2 or (
        cmd_name not in CROSS_MOUNT_COMMANDS
        and aggregate_for(cmd_name, operands) is None
    ):
        return False
    # a scope outside any mount cannot make the command cross-mount
    mounts = {o.mount for o in operands if o.mount is not None}
    # A copy of a tree that holds a mount reads both filesystems, the way
    # GNU cp -r copies across one, even from a single mount's operands.
    # Only a source counts: the destination (-t's directory, else the last
    # operand) lands beside a mount and crosses nothing.
    landing = {s.virtual for s in flag_scopes} or {operands[-1].path.virtual}
    return len(mounts) > 1 or (
        cmd_name == Cmd.CP
        and any(o.nests for o in operands if o.path.virtual not in landing)
    )


def aggregate_for(
    cmd_name: str, operands: Sequence[OperandMount]
) -> AggregateFn | None:
    """Use an existing, shared registration reducer for a custom command.

    Different reducers cannot safely compose one invocation. Known command
    families retain their flag-aware reduction instead.

    Args:
        cmd_name (str): Command name.
        operands (Sequence[OperandMount]): Path operands in command-line
            order, each with the reducer its mount resolves.
    """
    if cmd_name in CROSS_MOUNT_COMMANDS:
        return None
    aggregate = None
    for operand in operands:
        if operand.aggregate is None:
            return None
        if aggregate is not None and operand.aggregate is not aggregate:
            return None
        aggregate = operand.aggregate
    return aggregate
