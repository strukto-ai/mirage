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

from mirage.core.object_store.identity import make_identity
from tests.core.object_store.conftest import FakeStore, make_driver, spec


def test_identity_found_file_returns_markers(accessor):
    store = FakeStore({"a.txt": b"hi"})
    identity = make_identity(make_driver(store))
    result = asyncio.run(identity(accessor, spec("/a.txt")))
    assert result.exists is True
    assert result.fingerprint == "fp-a.txt"
    assert result.revision == "rev-a.txt"


def test_identity_head_miss_probe_hit_is_a_directory(accessor):
    store = FakeStore({"dir/f.txt": b"x"})
    identity = make_identity(make_driver(store))
    with pytest.raises(IsADirectoryError):
        asyncio.run(identity(accessor, spec("/dir")))


def test_identity_head_miss_probe_miss_is_absent(accessor):
    store = FakeStore({"a.txt": b"hi"})
    identity = make_identity(make_driver(store))
    result = asyncio.run(identity(accessor, spec("/never.txt")))
    assert result.exists is False
    assert result.revision is None
    assert result.fingerprint is None


def test_identity_mount_root_is_a_directory_without_connecting(accessor):
    store = FakeStore()
    identity = make_identity(make_driver(store))
    with pytest.raises(IsADirectoryError):
        asyncio.run(identity(accessor, spec("/")))
    assert store.connects == 0


def test_identity_trailing_slash_on_a_marker_directory_is_eisdir(accessor):
    # A zero-byte marker object keyed "dir/" is what an empty directory
    # is on these stores, so the point lookup would find it and report
    # its metadata as a file identity. The trailing slash says the
    # caller means the directory, exactly as it does for stat.
    store = FakeStore({"dir/": b""})
    identity = make_identity(make_driver(store))
    with pytest.raises(IsADirectoryError):
        asyncio.run(identity(accessor, spec("/dir/")))


def test_identity_trailing_slash_on_nothing_is_absent(accessor):
    # The hint is not a licence to answer EISDIR unasked: nothing is
    # stored under the prefix, so the honest answer is "absent".
    store = FakeStore({"a.txt": b"hi"})
    identity = make_identity(make_driver(store))
    result = asyncio.run(identity(accessor, spec("/nope/")))
    assert result.exists is False
    assert result.revision is None
    assert result.fingerprint is None


def test_identity_trailing_slash_never_reads_the_marker_as_a_file(accessor):
    # The same key with and without the slash: only the file spelling
    # may answer with markers.
    store = FakeStore({"csv": b"rows", "csv/": b""})
    identity = make_identity(make_driver(store))
    with pytest.raises(IsADirectoryError):
        asyncio.run(identity(accessor, spec("/csv/")))
    result = asyncio.run(identity(accessor, spec("/csv")))
    assert result.exists is True
    assert result.fingerprint == "fp-csv"
    assert result.revision == "rev-csv"
