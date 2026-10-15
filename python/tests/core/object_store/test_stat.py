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

import asyncio

import pytest

from mirage.core.object_store.stat import make_stat
from mirage.types import FileType
from tests.core.object_store.conftest import (
    MODIFIED,
    FakeStore,
    make_driver,
    spec,
)


def test_stat_maps_the_driver_meta_onto_filestat(accessor):
    store = FakeStore({"a.txt": b"hi"})
    stat = make_stat(make_driver(store))
    st = asyncio.run(stat(accessor, spec("/a.txt")))
    assert st.size == 2
    assert st.modified == MODIFIED
    assert st.fingerprint == "fp-a.txt"
    assert st.revision == "rev-a.txt"
    assert st.extra == {"etag": "fp-a.txt"}


def test_stat_root_is_a_directory_without_connecting(accessor):
    store = FakeStore()
    stat = make_stat(make_driver(store))
    st = asyncio.run(stat(accessor, spec("/")))
    assert st.type == FileType.DIRECTORY
    assert store.connects == 0


def test_stat_prefix_is_a_directory(accessor):
    store = FakeStore({"dir/f.txt": b"x"})
    stat = make_stat(make_driver(store))
    assert asyncio.run(stat(accessor, spec("/dir"))).type == FileType.DIRECTORY


def test_stat_missing_is_enoent(accessor):
    stat = make_stat(make_driver(FakeStore({"a.txt": b"hi"})))
    with pytest.raises(FileNotFoundError):
        asyncio.run(stat(accessor, spec("/never")))


def test_stat_trailing_slash_prefers_the_coexisting_prefix(accessor):
    store = FakeStore({"csv": b"file", "csv/inner.txt": b"x"})
    stat = make_stat(make_driver(store))
    assert asyncio.run(stat(accessor, spec("/csv"))).type != (
        FileType.DIRECTORY
    )
    assert (
        asyncio.run(stat(accessor, spec("/csv/"))).type == FileType.DIRECTORY
    )
