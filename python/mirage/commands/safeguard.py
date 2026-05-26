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

from mirage.types import CommandSafeguard

_DEFAULT_MAX_LINES = 2000

DEFAULT_COMMAND_SAFEGUARDS: dict[str, CommandSafeguard] = {
    name: CommandSafeguard(max_lines=_DEFAULT_MAX_LINES)
    for name in ("cat", "grep", "rg", "head", "tail")
}


def resolve_safeguard(
    name: str,
    command_default: CommandSafeguard | None = None,
    mount_override: CommandSafeguard | None = None,
) -> CommandSafeguard | None:
    if mount_override is not None:
        return mount_override
    if command_default is not None:
        return command_default
    return DEFAULT_COMMAND_SAFEGUARDS.get(name)
