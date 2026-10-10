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

from mirage.commands.builtin.backends import commands_for
from mirage.commands.builtin.generic_bind.factory import GENERIC_COMMANDS
from mirage.commands.config import Command
from mirage.vfs.base import BaseVFS


def mount_commands(vfs: BaseVFS) -> list[Command]:
    """The command a mount of ``vfs`` runs for each name, filetype aside:
    the VFS's own where it has one, else the generic every mount shares.

    Args:
        vfs (BaseVFS): the VFS.
    """
    served = {rc.name: rc for rc in GENERIC_COMMANDS}
    for rc in commands_for(vfs):
        if rc.filetype is None:
            served[rc.name] = rc
    return list(served.values())
