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

from mirage.core.lancedb.readdir import is_dir_name, readdir
from mirage.resource.lancedb.config import LanceDBConfig
from mirage.types import PathSpec


def _ps(path: str) -> PathSpec:
    return PathSpec(virtual=path,
                    directory=path,
                    resource_path=path.strip("/"))


def _names(paths: list[str]) -> set[str]:
    return {p.rsplit("/", 1)[-1] for p in paths}


@pytest.mark.asyncio
async def test_root_lists_table(accessor):
    out = await readdir(accessor, _ps("/"))
    assert _names(out) == {"animals"}


@pytest.mark.asyncio
async def test_table_lists_groups(accessor):
    out = await readdir(accessor, _ps("/animals"))
    assert _names(out) == {"cat", "dog"}


@pytest.mark.asyncio
async def test_group_lists_next_level(accessor):
    out = await readdir(accessor, _ps("/animals/cat"))
    assert _names(out) == {"big", "small"}


@pytest.mark.asyncio
async def test_leaf_lists_row_files(accessor):
    out = await readdir(accessor, _ps("/animals/cat/big"))
    assert _names(out) == {"1.md", "1.png"}


def test_is_dir_name_classifies_row_files():
    cfg = LanceDBConfig(uri="mem://", blob_column="img", blob_ext="png")
    assert is_dir_name("/animals/cat", config=cfg) is True
    assert is_dir_name("/animals/cat/big/1.md", config=cfg) is False
    assert is_dir_name("/animals/cat/big/1.png", config=cfg) is False
    no_blob = LanceDBConfig(uri="mem://")
    assert is_dir_name("/animals/cat/big/1.png", config=no_blob) is True
