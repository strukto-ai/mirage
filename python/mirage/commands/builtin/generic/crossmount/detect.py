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

from mirage.types import PathSpec

TRANSFER_COMMANDS = frozenset({"cp", "mv"})
COMPARE_COMMANDS = frozenset({"diff", "cmp"})
READ_COMMANDS = frozenset({"cat", "head", "tail", "wc", "grep", "rg"})


def is_cross_mount(cmd_name: str, scopes: list[PathSpec], registry) -> bool:
    allowed = TRANSFER_COMMANDS | COMPARE_COMMANDS | READ_COMMANDS
    if cmd_name not in allowed or len(scopes) < 2:
        return False
    mounts = set()
    for s in scopes:
        try:
            mounts.add(registry.mount_for(s.original).prefix)
        except ValueError:
            pass
    return len(mounts) > 1
