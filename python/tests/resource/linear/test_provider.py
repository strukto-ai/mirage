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
from mirage.resource.linear.linear import LinearResource
from mirage.types import ResourceName


@pytest.fixture
def config():
    return LinearConfig(api_key="lin_api_test")


def test_resource_init(config):
    resource = LinearResource(config)
    assert resource.caches_reads is True


def test_resource_name(config):
    resource = LinearResource(config)
    assert resource.name == ResourceName.LINEAR


def test_resource_accessor(config):
    resource = LinearResource(config)
    assert resource.accessor is not None
    assert resource.accessor.config is config


def test_resource_has_index(config):
    resource = LinearResource(config)
    assert isinstance(resource._index, RAMIndexCacheStore)


def test_resource_commands_registered(config):
    resource = LinearResource(config)
    assert len(resource._commands) >= 10
