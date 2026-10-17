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

from mirage.commands.builtin.generic_bind.archive_io import is_dir_of
from mirage.commands.config import CommandIO
from mirage.types import PathSpec

DIR = PathSpec.from_str_path("/d")


async def _missing_stat(_accessor, path, _index):
    raise FileNotFoundError(path.virtual)


async def _refused_stat(_accessor, path, _index):
    raise PermissionError(path.virtual)


async def _listing(_accessor, path, _index):
    return [path.virtual + "/a"]


async def _missing_listing(_accessor, path, _index):
    raise FileNotFoundError(path.virtual)


async def _unused(*_args):
    raise AssertionError("not used")


def _ops(stat, readdir) -> CommandIO:
    return CommandIO(
        readdir=readdir,
        read_bytes=_unused,
        read_stream=_unused,
        stat=stat,
        is_mounted=lambda _a: True,
    )


@pytest.mark.asyncio
async def test_is_dir_of_asks_the_listing_after_a_stat_miss():
    probe = is_dir_of(_ops(_missing_stat, _listing), None, None)
    assert await probe(DIR) is True


@pytest.mark.asyncio
async def test_is_dir_of_answers_no_when_both_channels_miss():
    probe = is_dir_of(_ops(_missing_stat, _missing_listing), None, None)
    assert await probe(DIR) is False


@pytest.mark.asyncio
async def test_is_dir_of_lets_a_refused_stat_through():
    probe = is_dir_of(_ops(_refused_stat, _listing), None, None)
    with pytest.raises(PermissionError):
        await probe(DIR)
