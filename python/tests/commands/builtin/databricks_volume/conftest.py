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

from mirage import MountMode, Workspace
from mirage.cache.index import RAMIndexCacheStore
from mirage.types import PathSpec
from mirage.utils.stream import collect_bytes
from tests.resource.databricks_volume.test_databricks_volume import (
    FakeFiles, make_resource, seed_directory, seed_file)


def seed_text_command_fixture(files: FakeFiles) -> str:
    root = "/Volumes/main/default/agent_files/root"
    seed_directory(files, root)
    seed_file(files, f"{root}/words.txt", b"beta\nalpha\nalpha\n")
    seed_file(files, f"{root}/more.txt", b"delta\n")
    seed_file(files, f"{root}/table.csv", b"name,score\nann,2\nbob,3\n")
    seed_file(files, f"{root}/table_extra.csv", b"name,score\ncam,5\n")
    seed_file(files, f"{root}/data.json", b'{"name": "mirage"}\n')
    seed_file(files, f"{root}/data2.json", b'{"name": "agent"}\n')
    seed_file(files, f"{root}/events.jsonl", b'{"name": "first"}\n')
    seed_file(files, f"{root}/events_extra.jsonl", b'{"name": "second"}\n')
    seed_file(files, f"{root}/old.txt", b"same\nold\n")
    seed_file(files, f"{root}/new.txt", b"same\nnew\n")
    return root


async def materialize(source) -> bytes:
    if source is None:
        return b""
    return await collect_bytes(source)


class IndexTrackingReader:

    def __init__(self) -> None:
        self.seen_indexes: list[RAMIndexCacheStore | None] = []

    async def read_bytes(self,
                         accessor,
                         path,
                         index=None,
                         *args,
                         **kwargs) -> bytes:
        self.seen_indexes.append(index)
        original = path.virtual if isinstance(path, PathSpec) else path
        if str(original).endswith(".json"):
            return b'{"name": "mirage"}\n'
        if str(original).endswith(".csv"):
            return b"name,score\nann,2\n"
        return b"beta\nalpha\nalpha\n"

    async def read_stream(self, accessor, path, index=None, *args, **kwargs):
        self.seen_indexes.append(index)
        yield await self.read_bytes(accessor, path, index, *args, **kwargs)


@pytest.fixture
def databricks_text_files() -> FakeFiles:
    files = FakeFiles()
    seed_text_command_fixture(files)
    return files


@pytest.fixture
def databricks_text_workspace(databricks_text_files: FakeFiles) -> Workspace:
    return Workspace({"/dbx/": make_resource(databricks_text_files)},
                     mode=MountMode.READ)


@pytest.fixture
def expected_index() -> RAMIndexCacheStore:
    return RAMIndexCacheStore(ttl=600)


@pytest.fixture
def materialize_output():
    return materialize
