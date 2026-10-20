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

from typing import Any

import pytest

from mirage.commands.builtin.generic_bind.archive_io import is_dir_of
from mirage.commands.builtin.generic_bind.files import command_files
from mirage.commands.config import Context
from mirage.context import reset_mount_gate, set_mount_gate
from mirage.io import IOResult
from mirage.types import MountMode, PathSpec
from mirage.workspace.files import Files

DIR = PathSpec.from_str_path("/d")


def _probe(stat_error: type[OSError], listed: bool) -> Any:
    async def dispatch(name: str, path: PathSpec, /, **_kw: Any):
        if name == "stat":
            raise stat_error(path.virtual)
        if not listed:
            raise FileNotFoundError(path.virtual)
        return [path.virtual + "/a"], IOResult()

    token = set_mount_gate("/", MountMode.WRITE)
    try:
        return is_dir_of(
            command_files(Context(vfs=Files(dispatch, ledger=False)))
        )
    finally:
        reset_mount_gate(token)


@pytest.mark.asyncio
async def test_is_dir_of_asks_the_listing_after_a_stat_miss():
    assert await _probe(FileNotFoundError, True)(DIR) is True


@pytest.mark.asyncio
async def test_is_dir_of_answers_no_when_both_channels_miss():
    assert await _probe(FileNotFoundError, False)(DIR) is False


@pytest.mark.asyncio
async def test_is_dir_of_lets_a_refused_stat_through():
    with pytest.raises(PermissionError):
        await _probe(PermissionError, True)(DIR)
