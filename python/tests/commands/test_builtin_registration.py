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

from mirage.commands.builtin.generic_bind import generic
from mirage.commands.builtin.generic_bind.factory import GENERIC_COMMANDS
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def test_builtins_registered_by_default():
    ws = Workspace({"/tmp/": RAMVFS()}, mode=MountMode.READ)
    mount = ws._registry.mount_for("/tmp/a")
    for name in ("cat", "head", "ls", "grep", "rm"):
        assert mount.resolve_command(name) is generic(name)


def test_every_mount_shares_the_generic_set():
    ws = Workspace(
        {"/tmp/": RAMVFS(), "/other/": RAMVFS()}, mode=MountMode.READ
    )
    for prefix in ("/tmp/a", "/other/a"):
        mount = ws._registry.mount_for(prefix)
        for registered in GENERIC_COMMANDS:
            assert mount.resolve_command(registered.name) is registered
