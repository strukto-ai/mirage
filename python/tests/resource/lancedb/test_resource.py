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

from mirage.resource.lancedb import LanceDBConfig, LanceDBResource
from mirage.resource.registry import REGISTRY, build_resource


def _resource(**kw) -> LanceDBResource:
    base = dict(uri="/tmp/db", group_by=["label"], id_column="id")
    base.update(kw)
    return LanceDBResource(LanceDBConfig(**base))


def test_resource_name_local_is_not_remote():
    res = _resource()
    assert res.name == "lancedb"
    assert res.caches_reads is False


def test_resource_remote_uri_caches_reads():
    res = _resource(uri="s3://bucket/db")
    assert res.caches_reads is True


def test_resource_registers_ops():
    res = _resource()
    assert {"read", "readdir", "stat"} <= {o.name for o in res.ops_list()}


def test_resource_registers_commands():
    res = _resource()
    expected = {
        "cat", "find", "grep", "head", "ls", "rg", "stat", "tail", "tree", "wc"
    }
    assert expected <= {c.name for c in res.commands()}


@pytest.mark.asyncio
async def test_resource_in_registry():
    assert "lancedb" in REGISTRY
    res = await build_resource("lancedb", {"uri": "/tmp/db"})
    assert res.name == "lancedb"


def test_resource_get_state_redacts_api_key():
    res = _resource(api_key="secret-value")
    state = res.get_state()
    assert "secret-value" not in str(state)


def test_cloud_config_fields_and_remote():
    res = _resource(uri="db://my-db",
                    api_key="sk-xxx",
                    region="us-west-2",
                    host_override="https://my-db.region.api.lancedb.com")
    assert res.caches_reads is True
    assert res.config.region == "us-west-2"
    assert res.config.host_override == "https://my-db.region.api.lancedb.com"
