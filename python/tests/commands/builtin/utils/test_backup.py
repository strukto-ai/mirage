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


def test_an_empty_backup_control_is_the_default_not_a_refusal():
    """GNU ACCEPTS `cp --backup=`, exit 0, and backs up as `existing`.

    gnulib's `xget_version` only calls argmatch when
    `version && *version`, so an empty control is the bare `--backup`.
    Measured on coreutils 9.4: `cp --backup= src bk` exits 0 and writes
    `bk~`. mirage used to answer `invalid argument ''` and exit 1.
    """
    assert backup_control("cp", "", None) == "existing"


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
async def test_backup_target_numbered_ignores_unicode_digits():
    # python's \d also matches Unicode digits, which JS /\d/ rejects; a
    # sibling named b.txt.~٩~ is not a numbered backup in either language.
    listing = _listing(["/d/b.txt", "/d/b.txt.~2~", "/d/b.txt.~٩~"])
    picked = await backup_target(listing, _spec("/d/b.txt"), "numbered", "~")
    assert picked is not None
    assert picked.virtual == "/d/b.txt.~3~"


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


# The backup-type clause names the refused control through gnulib's
# quote(), so a byte outside 0x20-0x7e comes back escaped rather than
# interpolated raw. Rows measured against GNU coreutils 9.4 under
# `LC_ALL=C` with a raw `bytes` argv (`cp --backup=<w>`). Mirrored in
# backup.test.ts.
@pytest.mark.parametrize("value,escaped", [
    ("xé", r"x\303\251"),
    ("x\r", r"x\r"),
    ("x\x01", r"x\001"),
    ("x\x7f", r"x\177"),
    ("x'", r"x\'"),
    ("x\\", r"x\\"),
])
def test_backup_type_clause_quotes_the_word(value, escaped):
    with pytest.raises(UsageError) as exc:
        backup_control("cp", value, None)
    assert str(
        exc.value) == (f"cp: invalid argument '{escaped}' for 'backup type'\n"
                       "Valid arguments are:\n"
                       "  - 'none', 'off'\n"
                       "  - 'simple', 'never'\n"
                       "  - 'existing', 'nil'\n"
                       "  - 'numbered', 't'\n"
                       "Try 'cp --help' for more information.")
    assert exc.value.exit_code == 1
