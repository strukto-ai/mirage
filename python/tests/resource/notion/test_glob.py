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
import pytest_asyncio

from mirage.accessor.notion import NotionAccessor
from mirage.cache.index import IndexEntry, RAMIndexCacheStore
from mirage.core.notion.readdir import readdir
from mirage.types import PathSpec
from mirage.utils.glob_walk import make_resolve_glob

resolve_glob = make_resolve_glob(readdir)


def page_entry(name: str) -> IndexEntry:
    return IndexEntry(id=name,
                      name=name,
                      resource_type="notion/page",
                      vfs_name=name)


def file_entry(name: str) -> IndexEntry:
    return IndexEntry(id=name, name=name, resource_type="file", vfs_name=name)


def glob_spec(virtual: str) -> PathSpec:
    last_slash = virtual.rfind("/")
    return PathSpec(
        virtual=virtual,
        directory=virtual[:last_slash + 1],
        resource_path=virtual[len("/notion"):].strip("/"),
        pattern=virtual[last_slash + 1:],
        resolved=False,
    )


@pytest_asyncio.fixture
async def index():
    store = RAMIndexCacheStore()
    await store.set_dir("/pages", [
        ("Demo_page__uuid1", page_entry("Demo_page__uuid1")),
        ("Roadmap__uuid2", page_entry("Roadmap__uuid2")),
    ])
    await store.set_dir("/pages/Demo_page__uuid1", [
        ("page.json", file_entry("page.json")),
        ("page.md", file_entry("page.md")),
    ])
    return store


@pytest.mark.asyncio
async def test_mid_path_glob_expands_from_index(index):
    spec = glob_spec("/notion/pages/Demo_page__*/page.md")
    result = await resolve_glob(NotionAccessor(config=None), [spec], index)
    assert [p.virtual
            for p in result] == ["/notion/pages/Demo_page__uuid1/page.md"]


@pytest.mark.asyncio
async def test_last_component_glob(index):
    spec = glob_spec("/notion/pages/Demo*")
    result = await resolve_glob(NotionAccessor(config=None), [spec], index)
    assert [p.virtual for p in result] == ["/notion/pages/Demo_page__uuid1"]
