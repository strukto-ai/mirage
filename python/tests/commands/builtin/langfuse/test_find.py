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
from mirage.commands.builtin.langfuse import COMMANDS
from mirage.resource.langfuse.config import LangfuseConfig
from mirage.types import PathSpec


def _find_command():
    for fn in COMMANDS:
        for rc in getattr(fn, "_registered_commands", []):
            if rc.name == "find" and rc.filetype is None:
                return fn
    raise AssertionError("factory find not registered for langfuse")


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=virtual.strip("/"))


async def _run(paths, *texts: str, **flags) -> list[str]:
    accessor = LangfuseAccessor(
        LangfuseConfig(public_key="pk", secret_key="sk"))
    find = _find_command()
    stdout, _io = await find(accessor,
                             paths,
                             *texts,
                             index=RAMIndexCacheStore(),
                             **flags)
    data = stdout if isinstance(stdout, bytes) else b""
    return data.decode().splitlines()


@pytest.mark.asyncio
async def test_walk_lists_top_level_dirs():
    lines = await _run([_spec("/")], maxdepth="1")
    assert "/traces" in lines
    assert "/prompts" in lines


@pytest.mark.asyncio
async def test_path_pattern_is_honored():
    lines = await _run([_spec("/")], maxdepth="1", path="*prompts*")
    assert lines == ["/prompts"]


@pytest.mark.asyncio
async def test_size_is_honored_dirs_count_as_zero():
    lines = await _run([_spec("/")], maxdepth="1", size="+0c")
    assert lines == []
