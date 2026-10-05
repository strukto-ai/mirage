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

from mirage.cache.file.config import CacheConfig, RedisCacheConfig


@pytest.mark.parametrize(
    ("model", "fields", "named"),
    [
        (CacheConfig, {"limti": "1MB"}, "limti"),
        (CacheConfig, {"url": "redis://localhost:6379/0"}, "url"),
        (
            CacheConfig,
            {"type": "ram", "url": "redis://localhost:6379/0"},
            "url",
        ),
        (RedisCacheConfig, {"key_prefx": "w1:"}, "key_prefx"),
        (
            RedisCacheConfig,
            {"key_prefix": "a:", "keyPrefix": "b:"},
            "keyPrefix",
        ),
    ],
)
def test_cache_config_refuses_a_field_it_does_not_take(model, fields, named):
    with pytest.raises(ValidationError, match=named):
        model(**fields)
