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

from mirage.commands.builtin.lancedb import COMMANDS
from mirage.types import PathSpec


def _find_command():
    for fn in COMMANDS:
        for rc in getattr(fn, "_registered_commands", []):
            if rc.name == "find" and rc.filetype is None:
                return fn
    raise AssertionError("factory find not registered for lancedb")


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
async def test_plain_find_walks_groups_to_row_files(accessor):
    lines = await _run(accessor, [_spec("/")])
    assert "/animals/cat/big/1.md" in lines
    assert "/animals/cat/big/1.png" in lines
    assert "/animals/dog/small" in lines


@pytest.mark.asyncio
async def test_name_selects_blob_files(accessor):
    lines = await _run(accessor, [_spec("/")], name="*.png")
    assert lines == [
        "/animals/cat/big/1.png",
        "/animals/cat/small/2.png",
        "/animals/dog/big/3.png",
        "/animals/dog/small/4.png",
    ]


@pytest.mark.asyncio
async def test_type_d_walks_without_stat_via_config_hint(accessor):
    lines = await _run(accessor, [_spec("/")], type="d")
    assert "/animals" in lines
    assert "/animals/cat" in lines
    assert "/animals/dog/small" in lines
    assert all(not line.endswith((".md", ".png")) for line in lines)


@pytest.mark.asyncio
async def test_depth_and_start_point(accessor):
    lines = await _run(accessor, [_spec("/animals/cat")], maxdepth="1")
    assert lines == [
        "/animals/cat",
        "/animals/cat/big",
        "/animals/cat/small",
    ]


@pytest.mark.asyncio
async def test_multi_start_points_in_operand_order(accessor):
    lines = await _run(
        accessor,
        [_spec("/animals/dog"), _spec("/animals/cat")],
        type="f",
        name="*.md")
    assert lines == [
        "/animals/dog/big/3.md",
        "/animals/dog/small/4.md",
        "/animals/cat/big/1.md",
        "/animals/cat/small/2.md",
    ]
