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

from mirage.resource import registry
from mirage.resource.hf_buckets import HfBucketsResource
from mirage.resource.registry import (REGISTRY, build_resource,
                                      known_resources, register_resource)

EXPECTED_RESOURCES = {
    "ram",
    "disk",
    "redis",
    "s3",
    "gridfs",
    "r2",
    "oci",
    "supabase",
    "gcs",
    "minio",
    "ceph",
    "seaweedfs",
    "wasabi",
    "backblaze",
    "digitalocean",
    "tencent",
    "aliyun",
    "scaleway",
    "qingstor",
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
    "mongodb",
    "postgres",
    "lancedb",
    "qdrant",
    "notion",
    "langfuse",
    "ssh",
    "email",
    "databricks_volume",
    "hf_buckets",
    "hf_datasets",
    "hf_models",
    "hf_spaces",
    "nextcloud",
    "dify",
    "chroma",
    "onedrive",
    "dropbox",
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


def test_build_hf_buckets_resource():
    r = build_resource("hf_buckets", {"bucket": "o/b"})
    assert isinstance(r, HfBucketsResource)


class FakeCustomConfig:

    def __init__(self, url: str = "") -> None:
        self.url = url


class FakeCustomResource:

    def __init__(self, config: FakeCustomConfig) -> None:
        self.config = config


class FakeKwargsResource:

    def __init__(self, root: str = "/") -> None:
        self.root = root


class FakeConfigClsResource:

    CONFIG_CLS = FakeCustomConfig

    def __init__(self, config: FakeCustomConfig) -> None:
        self.config = config


@pytest.fixture
def clean_registry(monkeypatch):
    monkeypatch.setattr(registry, "_CUSTOM", {})
    monkeypatch.setattr(registry, "_entry_points_loaded", False)


def test_register_resource_class_and_config(clean_registry):
    register_resource("fake_custom", FakeCustomResource, FakeCustomConfig)
    built = build_resource("fake_custom", {"url": "http://x"})
    assert isinstance(built, FakeCustomResource)
    assert built.config.url == "http://x"


def test_register_resource_kwargs_config(clean_registry):
    register_resource("fake_kwargs", FakeKwargsResource)
    built = build_resource("fake_kwargs", {"root": "/data"})
    assert isinstance(built, FakeKwargsResource)
    assert built.root == "/data"


def test_register_resource_config_cls_attribute(clean_registry):
    register_resource("fake_attr", FakeConfigClsResource)
    built = build_resource("fake_attr", {"url": "http://y"})
    assert built.config.url == "http://y"


def test_register_resource_rejects_builtin_shadow(clean_registry):
    with pytest.raises(ValueError):
        register_resource("s3", FakeCustomResource)


def test_register_resource_spec_string(clean_registry):
    register_resource("fake_spec",
                      "tests.resource.test_registry:FakeKwargsResource")
    built = build_resource("fake_spec", {"root": "/spec"})
    assert built.root == "/spec"


def test_known_resources_includes_custom(clean_registry):
    register_resource("fake_custom", FakeCustomResource, FakeCustomConfig)
    names = known_resources()
    assert "fake_custom" in names
    assert "s3" in names


def test_entry_point_discovery(clean_registry, monkeypatch):
    import importlib.metadata

    ep = importlib.metadata.EntryPoint(
        name="fake_ep",
        value="tests.resource.test_registry:FakeKwargsResource",
        group="mirage.resources",
    )

    def fake_entry_points(*, group):
        assert group == "mirage.resources"
        return [ep]

    monkeypatch.setattr(importlib.metadata, "entry_points", fake_entry_points)
    built = build_resource("fake_ep", {"root": "/ep"})
    assert built.root == "/ep"
    assert "fake_ep" in known_resources()


def test_entry_point_does_not_shadow_registered(clean_registry, monkeypatch):
    import importlib.metadata

    ep = importlib.metadata.EntryPoint(
        name="fake_custom",
        value="tests.resource.test_registry:FakeKwargsResource",
        group="mirage.resources",
    )
    monkeypatch.setattr(importlib.metadata, "entry_points",
                        lambda *, group: [ep])
    register_resource("fake_custom", FakeCustomResource, FakeCustomConfig)
    built = build_resource("fake_custom", {"url": "http://z"})
    assert isinstance(built, FakeCustomResource)


def test_unknown_resource_lists_known(clean_registry):
    with pytest.raises(KeyError, match="unknown resource"):
        build_resource("nope_not_real")
