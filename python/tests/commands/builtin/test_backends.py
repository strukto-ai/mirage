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
from mirage.commands.builtin.dev import COMMANDS as DEV_COMMANDS
from mirage.commands.config import command, registered_commands
from mirage.commands.spec import SPECS
from mirage.io.types import IOResult
from mirage.vfs.base import BaseVFS
from mirage.vfs.dev import DevVFS
from mirage.vfs.ram import RAMVFS


async def _custom_cat(accessor, paths, texts, opts):
    return b"custom", IOResult()


def _served(vfs: BaseVFS) -> set:
    return {(rc.name, rc.fn) for rc in commands_for(vfs)}


def test_a_builtin_serves_its_own_command_module():
    assert _served(DevVFS()) == {
        (rc.name, rc.fn) for rc in registered_commands(DEV_COMMANDS)
    }


def test_a_subclass_serves_its_bases_commands():
    class Versioned(DevVFS):
        pass

    assert _served(Versioned()) == _served(DevVFS())


def test_a_vfs_without_a_command_module_serves_only_what_it_was_handed():
    assert commands_for(RAMVFS()) == []
    assert commands_for(BaseVFS(name="custom")) == []


def test_a_class_named_like_a_builtin_serves_no_builtin_commands():
    class DevVFS(BaseVFS):
        name = "mydev"

    assert commands_for(DevVFS()) == []


def test_handed_commands_come_after_the_module_they_replace():
    cat = command("cat", vfs="ram", spec=SPECS["cat"])(_custom_cat)

    class Handed(DevVFS):
        def commands(self):
            return [cat]

    cats = [rc.fn for rc in commands_for(Handed()) if rc.name == "cat"]
    assert cats[-1] is registered_commands([cat])[0].fn
