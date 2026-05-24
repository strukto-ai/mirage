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

from mirage.resource.registry import REGISTRY, build_resource

EXPECTED_RESOURCES = {
    "ram",
    "disk",
    "redis",
    "s3",
    "r2",
    "oci",
    "supabase",
    "gcs",
    "github",
    "github_ci",
    "linear",
    "gdocs",
    "gsheets",
    "gslides",
    "gdrive",
    "slack",
    "discord",
    "gmail",
    "trello",
    "telegram",
    "mongodb",
    "postgres",
    "notion",
    "langfuse",
    "ssh",
    "email",
    "paperclip",
    "databricks_volume",
}


def test_registry_covers_all_known_resources():
    assert set(REGISTRY) == EXPECTED_RESOURCES


def test_build_ram_returns_ram_resource():
    from mirage.resource.ram import RAMResource
    p = build_resource("ram")
    assert isinstance(p, RAMResource)


def test_build_disk_takes_raw_kwargs(tmp_path):
    from mirage.resource.disk import DiskResource
    p = build_resource("disk", {"root": str(tmp_path)})
    assert isinstance(p, DiskResource)


def test_build_s3_uses_config_class():
    from mirage.resource.s3 import S3Resource
    p = build_resource(
        "s3", {
            "bucket": "b",
            "region": "us-east-1",
            "aws_access_key_id": "k",
            "aws_secret_access_key": "s",
        })
    assert isinstance(p, S3Resource)
    assert p.config.bucket == "b"
    assert p.config.region == "us-east-1"


def test_build_r2_uses_r2_config():
    from mirage.resource.r2 import R2Resource
    p = build_resource(
        "r2", {
            "bucket": "b",
            "account_id": "acct",
            "access_key_id": "k",
            "secret_access_key": "s",
        })
    assert isinstance(p, R2Resource)


def test_build_redis_takes_raw_kwargs():
    from mirage.resource.redis import RedisResource
    p = build_resource("redis", {
        "url": "redis://localhost:6379/15",
        "key_prefix": "test:",
    })
    assert isinstance(p, RedisResource)


def test_unknown_resource_raises_keyerror():
    with pytest.raises(KeyError, match="unknown resource 'nonsense'"):
        build_resource("nonsense")


def test_registry_module_import_is_free_of_resource_deps():
    import importlib
    import sys
    if "mirage.resource.registry" in sys.modules:
        del sys.modules["mirage.resource.registry"]
    importlib.import_module("mirage.resource.registry")
