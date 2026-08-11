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
import os

import pytest

from mirage.observe.disk_store import DiskObserverStore
from mirage.observe.observer import Observer
from mirage.observe.store import ObserverStore


def test_append_creates_and_extends(tmp_path):
    store = DiskObserverStore(str(tmp_path / "obs"))
    asyncio.run(store.append("/d/s.jsonl", b"a\n"))
    asyncio.run(store.append("/d/s.jsonl", b"b\n"))
    files = asyncio.run(store.read_all())
    assert files == {"/d/s.jsonl": b"a\nb\n"}


def test_write_overwrites(tmp_path):
    store = DiskObserverStore(str(tmp_path / "obs"))
    asyncio.run(store.append("/d/s.jsonl", b"old\n"))
    asyncio.run(store.write("/d/s.jsonl", b"new\n"))
    files = asyncio.run(store.read_all())
    assert files == {"/d/s.jsonl": b"new\n"}


def test_read_all_empty_root(tmp_path):
    store = DiskObserverStore(str(tmp_path / "missing"))
    assert asyncio.run(store.read_all()) == {}


def test_observer_over_disk_round_trip(tmp_path):
    obs = Observer(store=DiskObserverStore(str(tmp_path / "obs")))
    asyncio.run(obs.log_clear(session="s1", agent="a"))
    events = asyncio.run(obs.events())
    assert events[-1]["type"] == "clear"
    assert events[-1]["session"] == "s1"


def test_disk_store_satisfies_protocol(tmp_path):
    assert isinstance(DiskObserverStore(str(tmp_path)), ObserverStore)


def test_read_matching_filters_by_suffix(tmp_path):
    store = DiskObserverStore(str(tmp_path / "obs"))
    asyncio.run(store.append("/d1/s1.jsonl", b"a\n"))
    asyncio.run(store.append("/d1/s2.jsonl", b"b\n"))
    asyncio.run(store.append("/d2/s1.jsonl", b"c\n"))
    files = asyncio.run(store.read_matching("/s1.jsonl"))
    assert files == {"/d1/s1.jsonl": b"a\n", "/d2/s1.jsonl": b"c\n"}


def test_clear_empties_store(tmp_path):
    store = DiskObserverStore(str(tmp_path / "obs"))
    asyncio.run(store.append("/d/s.jsonl", b"a\n"))
    asyncio.run(store.clear())
    assert asyncio.run(store.read_all()) == {}


def test_missing_root_reads_as_no_history(tmp_path):
    store = DiskObserverStore(str(tmp_path / "never-written"))
    assert asyncio.run(store.read_all()) == {}


@pytest.mark.skipif(os.geteuid() == 0,
                    reason="root ignores the permission bits under test")
def test_an_unreadable_root_raises_instead_of_reading_empty(tmp_path):
    # A partial recording that reports success is worse than a failure:
    # /.bash_history and the history builtin would show a truncated
    # history with nothing to say it was truncated.
    root = tmp_path / "obs"
    asyncio.run(DiskObserverStore(str(root)).append("/d/s.jsonl", b"a\n"))
    root.chmod(0o000)
    try:
        with pytest.raises(PermissionError):
            asyncio.run(DiskObserverStore(str(root)).read_all())
    finally:
        root.chmod(0o755)
