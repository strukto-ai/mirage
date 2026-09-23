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

from mirage.commands import COMMANDS
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def test_builtins_registered_by_default():
    ws = Workspace({"/tmp/": RAMVFS()}, mode=MountMode.READ)
    mount = ws._registry.mount_for("/tmp/a")
    names = {name for (name, _) in mount._cmds}
    assert "cat" in names
    assert "head" in names
    assert "ls" in names
    assert "grep" in names
    assert "rm" in names


def test_builtin_count_matches_commands_dict():
    ws = Workspace({"/tmp/": RAMVFS()}, mode=MountMode.READ)
    mount = ws._registry.mount_for("/tmp/a")
    names = {name for (name, _) in mount._cmds}
    for name in COMMANDS:
        assert name in names, f"{name} not registered"
