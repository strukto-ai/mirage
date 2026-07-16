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

from pathlib import Path

import pytest

from mirage import MountMode, Workspace
from mirage.cache.file.config import CacheConfig, RedisCacheConfig
from mirage.config import (RamCacheBlock, RedisCacheBlock, RedisStoreBlock,
                           WorkspaceConfig, load_config)
from mirage.resource.ram import RAMResource
from mirage.resource.s3 import S3Resource
from mirage.types import ConsistencyPolicy
from mirage.workspace.mount.namespace import RAMNamespaceStore
from mirage.workspace.mount.namespace.redis import RedisNamespaceStore
from mirage.workspace.store import (RAMWorkspaceStateStore,
                                    RedisWorkspaceStateStore)

FIXTURES = Path(__file__).parent / "fixtures"


def test_load_minimal_yaml():
    cfg = load_config(FIXTURES / "minimal.yaml")
    assert isinstance(cfg, WorkspaceConfig)
    assert set(cfg.mounts) == {"/"}
    assert cfg.mounts["/"].resource == "ram"
    assert cfg.mounts["/"].mode == MountMode.WRITE
    assert cfg.cache is None


def test_load_full_yaml_with_env_interpolation():
    env = {
        "TEST_BUCKET": "my-test-bucket",
        "TEST_AWS_KEY": "AKIAEXAMPLE",
        "TEST_AWS_SECRET": "secret",
    }
    cfg = load_config(FIXTURES / "full.yaml", env=env)
    assert cfg.mode == MountMode.WRITE
    assert cfg.consistency == ConsistencyPolicy.LAZY
    assert isinstance(cfg.cache, RamCacheBlock)
    assert cfg.cache.limit == "256MB"
    assert cfg.mounts["/s3"].config["bucket"] == "my-test-bucket"
    assert cfg.mounts["/s3"].config["aws_access_key_id"] == "AKIAEXAMPLE"
    assert cfg.mounts["/"].fuse == "/tmp/mirage-fuse-full"
    assert cfg.fuse_mounts() == {"/": "/tmp/mirage-fuse-full"}
    assert "fuse_mounts" not in cfg.to_workspace_kwargs()


def test_missing_env_var_raises_with_full_list():
    with pytest.raises(ValueError, match="missing environment variables"):
        load_config(FIXTURES / "full.yaml", env={})


def test_redis_cache_discriminated_union():
    cfg = load_config(FIXTURES / "redis_cache.yaml")
    assert isinstance(cfg.cache, RedisCacheBlock)
    assert cfg.cache.url == "redis://localhost:6379/3"
    assert cfg.cache.key_prefix == "test_cache:"


def test_to_workspace_kwargs_yields_constructible_workspace():
    cfg = load_config(FIXTURES / "minimal.yaml")
    kwargs = cfg.to_workspace_kwargs()
    assert "/" in kwargs["resources"]
    prov, mode = kwargs["resources"]["/"]
    assert isinstance(prov, RAMResource)
    assert mode == MountMode.WRITE
    ws = Workspace(**kwargs)
    assert ws is not None


def test_to_workspace_kwargs_emits_redis_cache_config():
    cfg = load_config(FIXTURES / "redis_cache.yaml")
    kwargs = cfg.to_workspace_kwargs()
    assert isinstance(kwargs["cache"], RedisCacheConfig)
    assert kwargs["cache"].url == "redis://localhost:6379/3"


def test_to_workspace_kwargs_emits_ram_cache_config():
    cfg = load_config({
        "cache": {
            "type": "ram",
            "limit": "128MB"
        },
        "mounts": {
            "/": {
                "resource": "ram"
            }
        },
    })
    kwargs = cfg.to_workspace_kwargs()
    assert isinstance(kwargs["cache"], CacheConfig)
    assert not isinstance(kwargs["cache"], RedisCacheConfig)
    assert kwargs["cache"].limit == "128MB"


def test_store_redis_block_builds_redis_provider():
    cfg = load_config({
        "store": {
            "type": "redis",
            "url": "redis://localhost:6379/4",
            "key_prefix": "test_store:",
        },
        "mounts": {
            "/": {
                "resource": "ram"
            }
        },
    })
    assert cfg.store is not None
    assert cfg.store.key_prefix == "test_store:"
    kwargs = cfg.to_workspace_kwargs()
    assert isinstance(kwargs["store"], RedisWorkspaceStateStore)
    assert isinstance(kwargs["store"].namespace("ws1"), RedisNamespaceStore)


def test_store_ram_block_builds_ram_provider():
    cfg = load_config({
        "store": {
            "type": "ram"
        },
        "mounts": {
            "/": {
                "resource": "ram"
            }
        },
    })
    kwargs = cfg.to_workspace_kwargs()
    assert isinstance(kwargs["store"], RAMWorkspaceStateStore)
    assert isinstance(kwargs["store"].namespace("ws1"), RAMNamespaceStore)


def test_store_group_override_redirects_one_plane():
    cfg = load_config({
        "store": {
            "type": "ram",
            "observer": {
                "type": "redis",
                "url": "redis://localhost:6379/4",
                "key_prefix": "obs:",
            },
        },
        "mounts": {
            "/": {
                "resource": "ram"
            }
        },
    })
    assert isinstance(cfg.store.observer, RedisStoreBlock)
    store = cfg.to_workspace_kwargs()["store"]
    assert isinstance(store, RAMWorkspaceStateStore)
    assert isinstance(store.namespace("ws1"), RAMNamespaceStore)
    assert type(store.observer("ws1")).__name__ == "RedisObserverStore"


def test_workspace_id_passes_through():
    cfg = load_config({
        "workspace_id": "agent-ws-7",
        "mounts": {
            "/": {
                "resource": "ram"
            }
        },
    })
    assert cfg.to_workspace_kwargs()["workspace_id"] == "agent-ws-7"


def test_store_block_rejects_unknown_field():
    with pytest.raises(Exception):
        load_config({
            "store": {
                "type": "ram",
                "ttl": 600
            },
            "mounts": {
                "/": {
                    "resource": "ram"
                }
            },
        })


def test_dict_source_works_too():
    cfg = load_config({"mounts": {"/": {"resource": "ram"}}})
    assert "/" in cfg.mounts


def test_unknown_mount_field_rejected():
    with pytest.raises(Exception):
        load_config({
            "mounts": {
                "/": {
                    "resource": "ram",
                    "bogus_field": 1
                }
            },
        })


def test_workspace_built_from_config_executes_command():
    cfg = load_config(FIXTURES / "minimal.yaml")
    kwargs = cfg.to_workspace_kwargs()
    ws = Workspace(**kwargs)
    import asyncio
    result = asyncio.run(ws.execute("echo hello"))
    assert result.exit_code == 0
    assert (result.stdout or b"").startswith(b"hello")


def test_round_trip_dict_source_matches_yaml(tmp_path):
    yaml_text = "mounts:\n  /:\n    resource: ram\n    mode: WRITE\n"
    p = tmp_path / "x.yaml"
    p.write_text(yaml_text, encoding="utf-8")
    from_yaml = load_config(p)
    from_dict = load_config(
        {"mounts": {
            "/": {
                "resource": "ram",
                "mode": "WRITE"
            }
        }})
    assert from_yaml.model_dump() == from_dict.model_dump()


def test_resource_built_via_registry_has_correct_type():
    cfg = load_config({
        "mounts": {
            "/s3": {
                "resource": "s3",
                "mode": "READ",
                "config": {
                    "bucket": "b",
                    "region": "us-east-1",
                    "aws_access_key_id": "k",
                    "aws_secret_access_key": "s",
                },
            },
        },
    })
    kwargs = cfg.to_workspace_kwargs()
    prov, mode = kwargs["resources"]["/s3"]
    assert isinstance(prov, S3Resource)
    assert mode == MountMode.READ
