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

import pytest

from mirage.commands.builtin.utils.backup import (backup_control,
                                                  backup_target, parent_path,
                                                  sibling_path)
from mirage.commands.errors import UsageError
from mirage.types import PathSpec


def _spec(path: str) -> PathSpec:
    return PathSpec(virtual=path,
                    directory=path,
                    resource_path=path.strip("/"))


def _listing(children: list[str]):

    async def readdir(p) -> list[str]:
        return children

    return readdir


def test_backup_control_aliases_and_default():
    assert backup_control("cp", True, None) == "existing"
    assert backup_control("cp", None, None) is None
    assert backup_control("cp", False, None) is None
    assert backup_control("cp", "t", None) == "numbered"
    assert backup_control("cp", "numbered", None) == "numbered"
    assert backup_control("cp", "nil", None) == "existing"
    assert backup_control("cp", "never", None) == "simple"
    assert backup_control("cp", "off", None) == "none"
    # -S SUFFIX alone enables backups (GNU 9.7).
    assert backup_control("cp", None, ".bak") == "existing"


def test_backup_control_invalid_argument():
    with pytest.raises(UsageError) as exc:
        backup_control("mv", "bogus", None)
    message = str(exc.value)
    assert "mv: invalid argument 'bogus' for 'backup type'" in message
    assert "  - 'none', 'off'" in message
    assert "Try 'mv --help' for more information." in message


def test_sibling_and_parent_paths():
    target = _spec("/data/sub/b.txt")
    backup = sibling_path(target, "~")
    assert backup.virtual == "/data/sub/b.txt~"
    assert backup.resource_path == "data/sub/b.txt~"
    parent = parent_path(target)
    assert parent.virtual == "/data/sub"
    assert parent.resource_path == "data/sub"
    assert parent_path(_spec("/b.txt")).virtual == "/"


@pytest.mark.asyncio
async def test_backup_target_simple():
    target = _spec("/d/b.txt")
    picked = await backup_target(None, target, "simple", "~")
    assert picked is not None
    assert picked.virtual == "/d/b.txt~"


@pytest.mark.asyncio
async def test_backup_target_none():
    assert await backup_target(None, _spec("/d/b.txt"), "none", "~") is None


@pytest.mark.asyncio
async def test_backup_target_numbered_scans_versions():
    listing = _listing(["/d/b.txt", "/d/b.txt.~1~", "/d/b.txt.~7~"])
    picked = await backup_target(listing, _spec("/d/b.txt"), "numbered", "~")
    assert picked is not None
    assert picked.virtual == "/d/b.txt.~8~"


@pytest.mark.asyncio
async def test_backup_target_existing_falls_back_to_simple():
    picked = await backup_target(_listing(["/d/b.txt"]), _spec("/d/b.txt"),
                                 "existing", ".bak")
    assert picked is not None
    assert picked.virtual == "/d/b.txt.bak"


@pytest.mark.asyncio
async def test_backup_target_existing_stays_numbered():
    listing = _listing(["/d/b.txt", "/d/b.txt.~2~"])
    picked = await backup_target(listing, _spec("/d/b.txt"), "existing", "~")
    assert picked is not None
    assert picked.virtual == "/d/b.txt.~3~"


@pytest.mark.asyncio
async def test_backup_target_ignores_other_names():
    listing = _listing(["/d/bb.txt.~4~", "/d/b.txt.bak", "/d/b.txt~"])
    picked = await backup_target(listing, _spec("/d/b.txt"), "existing", "~")
    assert picked is not None
    assert picked.virtual == "/d/b.txt~"
