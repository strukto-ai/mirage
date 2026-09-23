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
from mirage.core.linear.config import LinearConfig
from mirage.types import VFSName
from mirage.vfs.linear.linear import LinearVFS


@pytest.fixture
def config():
    return LinearConfig(api_key="lin_api_test")


def test_vfs_init(config):
    vfs = LinearVFS(config)
    assert vfs.caches_reads is True


def test_vfs_name(config):
    vfs = LinearVFS(config)
    assert vfs.name == VFSName.LINEAR


def test_vfs_accessor(config):
    vfs = LinearVFS(config)
    assert vfs.accessor is not None
    assert vfs.accessor.config is config


def test_vfs_has_index(config):
    vfs = LinearVFS(config)
    assert isinstance(vfs._index, RAMIndexCacheStore)


def test_vfs_commands_registered(config):
    vfs = LinearVFS(config)
    assert len(vfs._commands) >= 10
