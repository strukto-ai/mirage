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
from pydantic import ValidationError

from mirage.cache.file.config import CacheConfig, CacheType, RedisCacheConfig


def test_cache_config_takes_its_fields():
    config = CacheConfig(limit="1MB", max_drain_bytes=64)
    assert config.type == CacheType.RAM
    assert config.limit == "1MB"
    assert config.max_drain_bytes == 64


def test_cache_config_refuses_an_unknown_field():
    with pytest.raises(ValidationError, match="limti"):
        CacheConfig(limti="1MB")


def test_cache_config_refuses_a_redis_field_on_a_default_ram_type():
    with pytest.raises(ValidationError, match="url"):
        CacheConfig(url="redis://localhost:6379/0")


def test_redis_cache_config_takes_its_fields():
    config = RedisCacheConfig(limit="8GB", key_prefix="w1:")
    assert config.type == CacheType.REDIS
    assert config.limit == "8GB"
    assert config.key_prefix == "w1:"


def test_redis_cache_config_refuses_the_camel_case_spelling():
    with pytest.raises(ValidationError, match="keyPrefix"):
        RedisCacheConfig(key_prefix="a:", keyPrefix="b:")


def test_redis_cache_config_refuses_an_unknown_field():
    with pytest.raises(ValidationError, match="key_prefx"):
        RedisCacheConfig(key_prefx="w1:")


def test_cache_config_refuses_an_unknown_type():
    with pytest.raises(
        ValidationError, match="Input should be 'ram' or 'redis'"
    ):
        CacheConfig(type="redsi")


def test_cache_config_refuses_a_null_type():
    with pytest.raises(
        ValidationError, match="Input should be 'ram' or 'redis'"
    ):
        CacheConfig(type=None)


def test_cache_config_refuses_a_redis_field_on_an_explicit_ram_type():
    with pytest.raises(ValidationError, match="url"):
        CacheConfig(type="ram", url="redis://localhost:6379/0")
