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

from mirage.cache.index import (
    IndexConfig,
    IndexEntry,
    ListResult,
    LookupResult,
    LookupStatus,
    RedisIndexConfig,
    ResourceType,
)
from mirage.cache.index.config import IndexType

# The one wire format: what pydantic writes for IndexEntry, snake_case and
# every field. `config.test.ts` pins the same literal.
WIRE = (
    '{"id":"/a.txt","name":"a.txt","resource_type":"file",'
    '"remote_time":"2026-01-01T00:00:00Z",'
    '"index_time":"2026-01-01T00:00:00Z","vfs_name":"","size":6,'
    '"extra":{}}'
)


def test_index_entry_defaults():
    entry = IndexEntry(id="1", name="f", resource_type="file")
    assert entry.remote_time == ""
    assert entry.index_time == ""
    assert entry.vfs_name == ""
    assert entry.size is None


def test_index_entry_with_size():
    entry = IndexEntry(id="1", name="f", resource_type="file", size=1024)
    assert entry.size == 1024


def test_index_entry_json_is_the_shared_wire_format():
    entry = IndexEntry(
        id="/a.txt",
        name="a.txt",
        resource_type="file",
        remote_time="2026-01-01T00:00:00Z",
        index_time="2026-01-01T00:00:00Z",
        size=6,
    )
    assert entry.model_dump_json() == WIRE
    assert IndexEntry.model_validate_json(WIRE) == entry


def test_index_entry_json_refuses_a_camel_case_row():
    with pytest.raises(ValidationError):
        IndexEntry.model_validate_json(
            '{"id":"/c","name":"c","resourceType":"file"}'
        )


def test_lookup_result_not_found():
    result = LookupResult(status=LookupStatus.NOT_FOUND)
    assert result.entry is None
    assert result.status == LookupStatus.NOT_FOUND


def test_lookup_result_with_entry():
    entry = IndexEntry(id="1", name="f", resource_type="file")
    result = LookupResult(entry=entry)
    assert result.entry is not None
    assert result.status is None


def test_list_result_with_entries():
    result = ListResult(entries=["/a", "/b"])
    assert result.entries == ["/a", "/b"]
    assert result.status is None


def test_list_result_expired():
    result = ListResult(status=LookupStatus.EXPIRED)
    assert result.entries is None


def test_resource_type_enum():
    assert ResourceType.FILE == "file"
    assert ResourceType.FOLDER == "folder"


def test_index_config_defaults():
    config = IndexConfig()
    assert config.ttl == 600
    assert config.type == IndexType.RAM


def test_redis_index_config():
    config = RedisIndexConfig(ttl=300, key_prefix="s3:")
    assert config.type == IndexType.REDIS
    assert config.ttl == 300
    assert config.key_prefix == "s3:"
    assert config.url == "redis://localhost:6379/0"


def test_redis_index_config_is_index_config():
    config = RedisIndexConfig()
    assert isinstance(config, IndexConfig)


@pytest.mark.parametrize(
    ("model", "fields", "named"),
    [
        (IndexConfig, {"ttll": 5}, "ttll"),
        (IndexConfig, {"key_prefix": "s3:"}, "key_prefix"),
        (IndexConfig, {"type": "ram", "key_prefix": "s3:"}, "key_prefix"),
        (RedisIndexConfig, {"urll": "redis://localhost:6379/0"}, "urll"),
        (
            RedisIndexConfig,
            {"key_prefix": "a:", "keyPrefix": "b:"},
            "keyPrefix",
        ),
    ],
)
def test_index_config_refuses_a_field_it_does_not_take(model, fields, named):
    with pytest.raises(ValidationError, match=named):
        model(**fields)
