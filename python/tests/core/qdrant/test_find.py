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

from mirage.commands.builtin.qdrant import COMMANDS
from mirage.types import PathSpec


def _find_command():
    for fn in COMMANDS:
        for rc in getattr(fn, "_registered_commands", []):
            if rc.name == "find" and rc.filetype is None:
                return fn
    raise AssertionError("factory find not registered for qdrant")


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path=virtual.strip("/"))


async def _run(accessor, paths, *texts: str, **flags) -> list[str]:
    find = _find_command()
    stdout, _io = await find(accessor, paths, *texts, index=None, **flags)
    data = stdout if isinstance(stdout, bytes) else b""
    return data.decode().splitlines()


@pytest.mark.asyncio
async def test_plain_find_walks_groups_to_point_files(accessor):
    lines = await _run(accessor, [_spec("/")])
    assert "/animals/cat/big/1.json" in lines
    assert "/animals/cat/big/1.txt" in lines
    assert "/animals/cat/big/1.png" in lines
    assert "/animals/dog/small" in lines


@pytest.mark.asyncio
async def test_iname_matches_rendered_text_files(accessor):
    lines = await _run(accessor, [_spec("/")], iname="*.TXT")
    assert lines
    assert all(line.endswith(".txt") for line in lines)


@pytest.mark.asyncio
async def test_type_split_uses_field_config_hint(accessor):
    dirs = await _run(accessor, [_spec("/")], type="d")
    assert "/animals/cat/big" in dirs
    assert all(not d.endswith((".json", ".txt", ".png")) for d in dirs)
    files = await _run(accessor, [_spec("/")], type="f")
    assert files
    assert all(f.endswith((".json", ".txt", ".png")) for f in files)


@pytest.mark.asyncio
async def test_negated_name_prunes_blobs(accessor):
    lines = await _run(accessor, [_spec("/")], "!", "-name", "*.png", type="f")
    assert lines
    assert all(not line.endswith(".png") for line in lines)
