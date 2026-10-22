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

from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


class _Unattributed(RAMVFS):
    """A RAM store with no setattr and no directory times, as an object
    store is: a mode and a made directory's time land in the overlay."""

    setattr = BaseVFS.setattr

    async def stat(self, path: PathSpec) -> FileStat:
        row = await super().stat(path)
        if row.type is FileType.DIRECTORY:
            return row.model_copy(update={"modified": None})
        return row


@pytest.mark.asyncio
async def test_a_mode_lands_where_a_chmod_would():
    ws = Workspace({"/d": _Unattributed()}, mode=MountMode.WRITE)
    try:
        result = await ws.shell(
            "mkdir -p -m 700 /d/a/kid && (umask 077; mkdir /d/m) && "
            "stat -c '%n %a' /d/a /d/a/kid /d/m"
        )
        assert (result.exit_code, result.stdout) == (
            0,
            b"/d/a 755\n/d/a/kid 700\n/d/m 700\n",
        )
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_every_directory_parents_makes_takes_its_time():
    ws = Workspace({"/d": _Unattributed()}, mode=MountMode.WRITE)
    try:
        result = await ws.shell(
            "touch -d 2000-01-01 /d/ref && mkdir -p /d/p/a/b && "
            "find /d/p -newer /d/ref | sort"
        )
        assert (result.exit_code, result.stdout) == (
            0,
            b"/d/p\n/d/p/a\n/d/p/a/b\n",
        )
    finally:
        await ws.close()
