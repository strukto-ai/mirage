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

from mirage.accessor.langfuse import LangfuseAccessor
from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.commands.builtin.generic_bind import generic
from mirage.commands.config import CommandOpts
from mirage.io.types import materialize
from mirage.types import PathSpec
from mirage.vfs.langfuse import LangfuseVFS
from mirage.vfs.langfuse.config import LangfuseConfig
from tests.fixtures.vfs_io import io_for


def _find_command():
    return generic("find").fn


def _spec(virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual, directory=virtual, vfs_path=virtual.strip("/")
    )


async def _run(paths, *texts: str, **flags) -> list[str]:
    accessor = LangfuseAccessor(
        LangfuseConfig(public_key="pk", secret_key="sk")
    )
    find = _find_command()
    stdout, _io = await find(
        accessor,
        paths,
        list(texts),
        CommandOpts(
            io=io_for(LangfuseVFS, accessor),
            index=RAMIndexCacheStore(),
            flags={**flags},
        ),
    )
    data = await materialize(stdout)
    return data.decode().splitlines()


@pytest.mark.asyncio
async def test_size_counts_a_directory_as_dir_size():
    dirs = await _run([_spec("/")], maxdepth="1")
    assert await _run([_spec("/")], maxdepth="1", size="+0c") == dirs
    assert await _run([_spec("/")], maxdepth="1", size="-1k") == []
