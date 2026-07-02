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

from mirage.core.chroma.path import resolve_path, virtual_key_for
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


@pytest.mark.asyncio
async def test_resolve_file(chroma_accessor, chroma_index, quickstart_path):
    resolved = await resolve_path(chroma_accessor, quickstart_path,
                                  chroma_index)
    assert not resolved.is_dir
    assert resolved.entry is not None
    assert resolved.entry.extra["slug"] == "guides/quickstart"


@pytest.mark.asyncio
async def test_resolve_directory(chroma_accessor, chroma_index):
    path = PathSpec.from_str_path("/knowledge/guides",
                                  mount_key("/knowledge/guides", "/knowledge"))
    resolved = await resolve_path(chroma_accessor, path, chroma_index)
    assert resolved.is_dir


@pytest.mark.asyncio
async def test_resolve_mount_root(chroma_accessor, chroma_index,
                                  knowledge_root):
    resolved = await resolve_path(chroma_accessor, knowledge_root,
                                  chroma_index)
    assert resolved.is_dir


@pytest.mark.asyncio
async def test_resolve_missing_raises(chroma_accessor, chroma_index):
    path = PathSpec.from_str_path(
        "/knowledge/missing", mount_key("/knowledge/missing", "/knowledge"))
    with pytest.raises(FileNotFoundError):
        await resolve_path(chroma_accessor, path, chroma_index)


@pytest.mark.asyncio
async def test_resolve_str_path_coerced(chroma_accessor, chroma_index):
    resolved = await resolve_path(chroma_accessor, "/guides/quickstart",
                                  chroma_index)
    assert not resolved.is_dir


def test_virtual_key_for_prefixed():
    path = PathSpec.from_str_path(
        "/knowledge/guides/quickstart",
        mount_key("/knowledge/guides/quickstart", "/knowledge"))
    assert virtual_key_for(path) == "/knowledge/guides/quickstart"


def test_virtual_key_for_root():
    path = PathSpec(resource_path=mount_key("/knowledge", "/knowledge"),
                    virtual="/knowledge",
                    directory="/knowledge")
    assert virtual_key_for(path) == "/knowledge"


def test_virtual_key_for_unprefixed():
    path = PathSpec(resource_path="guides/quickstart",
                    virtual="/guides/quickstart",
                    directory="/guides")
    assert virtual_key_for(path) == "/guides/quickstart"
