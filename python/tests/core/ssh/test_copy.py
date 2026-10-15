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

import errno
from unittest.mock import AsyncMock, MagicMock

import asyncssh
import pytest

from mirage.core.ssh.copy import dir_copy
from mirage.errors.types import OperationNotSupportedError
from mirage.types import PathSpec
from tests.fixtures.ssh_run import Answer, RunAccessor


async def copy_tree(answer: Answer, landed: bool = False) -> RunAccessor:
    accessor = RunAccessor(
        "/srv", answer, MagicMock(exists=AsyncMock(return_value=landed))
    )
    await dir_copy(
        accessor, PathSpec.from_str_path("/a b"), PathSpec.from_str_path("/c")
    )
    return accessor


@pytest.mark.asyncio
async def test_one_cp_on_the_server_copies_the_tree():
    accessor = await copy_tree((0, b"copied\n", b""))
    assert accessor.sent == [
        "env LC_ALL=C cp -RL -- '/srv/a b' '/srv/c' && echo copied"
    ]


@pytest.mark.parametrize(
    "answer",
    [
        (1, b"This service allows sftp connections only.\n", b""),
        asyncssh.ChannelOpenError(1, "refused"),
    ],
)
@pytest.mark.asyncio
async def test_a_server_that_runs_nothing_leaves_the_walk(answer):
    with pytest.raises(OperationNotSupportedError):
        await copy_tree(answer)


@pytest.mark.asyncio
async def test_a_cp_that_failed_partway_says_why():
    err = b"cp: cannot open '/srv/a b/x' for reading: Permission denied\n"
    with pytest.raises(PermissionError) as raised:
        await copy_tree((1, b"", err), landed=True)
    assert raised.value.errno == errno.EACCES
