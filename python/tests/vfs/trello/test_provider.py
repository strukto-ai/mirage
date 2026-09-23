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

from mirage.cache.index.ram import RAMIndexCacheStore
from mirage.types import VFSName
from mirage.vfs.trello.config import TrelloConfig
from mirage.vfs.trello.trello import TrelloVFS


@pytest.fixture
def config():
    return TrelloConfig(api_key="test_key", api_token="test_token")


def test_vfs_init(config):
    vfs = TrelloVFS(config)
    assert vfs.caches_reads is True


def test_vfs_name(config):
    vfs = TrelloVFS(config)
    assert vfs.name == VFSName.TRELLO


def test_vfs_accessor(config):
    vfs = TrelloVFS(config)
    assert vfs.accessor is not None
    assert vfs.accessor.config is config


def test_vfs_index(config):
    vfs = TrelloVFS(config)
    assert isinstance(vfs._index, RAMIndexCacheStore)


def test_vfs_commands_registered(config):
    vfs = TrelloVFS(config)
    assert len(vfs._commands) >= 10
