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

from mirage.commands.builtin.generic.crossmount.constants import (
    CROSS_MOUNT_COMMANDS, RELAY_COMMANDS, STREAM_COMMANDS)
from mirage.commands.builtin.generic.crossmount.types import Cmd, Strategy
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.types import PathSpec


def strategy_for(cmd_name: str, flag_kwargs: dict) -> Strategy:
    """Pick the combine strategy for one cross-mount command invocation.

    Flags can flip the strategy: ``sed -i`` edits each operand in place
    (per-operand independent), so it fans out instead of streaming.

    Args:
        cmd_name (str): Command name, must be in CROSS_MOUNT_COMMANDS.
        flag_kwargs (dict): Flags parsed against the shared command spec.
    """
    if cmd_name in RELAY_COMMANDS:
        return Strategy.RELAY
    if cmd_name == Cmd.SED and FlagView(flag_kwargs,
                                        spec=SPECS[Cmd.SED]).bool("i"):
        return Strategy.FANOUT
    if cmd_name in STREAM_COMMANDS:
        return Strategy.STREAM
    return Strategy.FANOUT


def is_cross_mount(cmd_name: str, scopes: list[PathSpec], registry) -> bool:
    if cmd_name not in CROSS_MOUNT_COMMANDS or len(scopes) < 2:
        return False
    mounts = set()
    for s in scopes:
        try:
            mounts.add(registry.mount_for(s.virtual).prefix)
        except ValueError:
            # a scope outside any mount cannot make the command cross-mount
            pass
    return len(mounts) > 1
