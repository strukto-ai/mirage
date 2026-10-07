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

from mirage.commands.builtin.backends import mount_commands
from mirage.commands.builtin.ram import COMMANDS as RAM_COMMANDS
from mirage.commands.config import command, registered_commands
from mirage.commands.spec import SPECS
from mirage.io.types import IOResult
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram import RAMVFS


async def _custom_cat(accessor, paths, texts, opts):
    return b"custom", IOResult()


def _named(commands) -> dict[str, set[str]]:
    found: dict[str, set[str]] = {}
    for rc in commands:
        found.setdefault(rc.name, set()).add(rc.vfs)
    return found


def test_a_builtin_serves_its_own_command_module():
    served = {(rc.name, rc.fn) for rc in mount_commands(RAMVFS())}
    assert served == {
        (rc.name, rc.fn) for rc in registered_commands(RAM_COMMANDS)
    }


def test_a_subclass_serves_its_bases_commands():
    class Versioned(RAMVFS):
        pass

    served = {(rc.name, rc.fn) for rc in mount_commands(Versioned())}
    assert served == {(rc.name, rc.fn) for rc in mount_commands(RAMVFS())}


def test_any_other_vfs_serves_the_generic_set_under_its_name():
    named = _named(mount_commands(BaseVFS(name="custom")))
    assert {"cat", "ls", "grep", "find"} <= set(named)
    assert set().union(*named.values()) == {"custom"}


def test_handed_commands_come_after_the_generic_set_they_override():
    cat = command("cat", vfs="custom", spec=SPECS["cat"])(_custom_cat)
    vfs = BaseVFS(name="custom", overrides={"cat"}, commands=[cat])
    cats = [rc for rc in mount_commands(vfs) if rc.name == "cat"]
    assert [rc.fn for rc in cats] == [
        rc.fn for rc in registered_commands([cat])
    ]


def test_a_builtin_loses_the_commands_it_overrides():
    class Searchless(RAMVFS):
        overrides = frozenset({"grep", "rg"})

    names = {rc.name for rc in mount_commands(Searchless())}
    assert "cat" in names
    assert not {"grep", "rg"} & names
