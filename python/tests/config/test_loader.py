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

import json
from pathlib import Path

import pytest

from mirage import MountBackend, MountMode, Workspace
from mirage.cache.file.config import CacheConfig, RedisCacheConfig
from mirage.config import (DiskStoreBlock, RamCacheBlock, RedisCacheBlock,
                           RedisStoreBlock, S3StoreBlock, WorkspaceConfig,
                           _build_runtime_entries, load_config)
from mirage.policy import DEFAULT_DENY_REASON, CommandRule
from mirage.resource.ram import RAMResource
from mirage.resource.s3 import S3Resource
from mirage.runtime.types import ScriptSource
from mirage.secrets.config import EnvVar, SecretRef
from mirage.shell.console import JobConsole
from mirage.shell.console.redis import RedisConsoleStore
from mirage.types import ConsistencyPolicy
from mirage.workspace.mount.namespace import RAMNamespaceStore
from mirage.workspace.mount.namespace.disk import DiskNamespaceStore
from mirage.workspace.mount.namespace.redis import RedisNamespaceStore
from mirage.workspace.session.disk import DiskSessionStore
from mirage.workspace.store import (DiskWorkspaceStateStore,
                                    RAMWorkspaceStateStore,
                                    RedisWorkspaceStateStore)

from mirage.policy.profile import (  # isort: skip
    CommandsBlock, PathsBlock, ProfileMount, SessionProfile, VarsBlock)

FIXTURES = Path(__file__).parent / "fixtures"


def test_load_minimal_yaml():
    cfg = load_config(FIXTURES / "minimal.yaml")
    assert isinstance(cfg, WorkspaceConfig)
    assert set(cfg.mounts) == {"/"}
    assert cfg.mounts["/"].resource == "ram"
    assert cfg.mounts["/"].mode == MountMode.WRITE
    assert cfg.cache is None


@pytest.mark.asyncio
async def test_load_full_yaml_with_env_interpolation():
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
    assert cfg.mounts["/"].backend is MountBackend.FUSE
    assert cfg.mounts["/"].mountpoint == "/tmp/mirage-fuse-full"
    assert cfg.kernel_mounts() == {
        "/": (MountBackend.FUSE, "/tmp/mirage-fuse-full")
    }
    assert "kernel_mounts" not in cfg.to_workspace_kwargs()


def test_missing_env_var_raises_with_full_list():
    with pytest.raises(ValueError, match="missing environment variables"):
        load_config(FIXTURES / "full.yaml", env={})


def test_redis_cache_discriminated_union():
    cfg = load_config(FIXTURES / "redis_cache.yaml")
    assert isinstance(cfg.cache, RedisCacheBlock)
    assert cfg.cache.url == "redis://localhost:6379/3"
    assert cfg.cache.key_prefix == "test_cache:"


@pytest.mark.asyncio
async def test_to_workspace_kwargs_yields_constructible_workspace():
    cfg = load_config(FIXTURES / "minimal.yaml")
    kwargs = cfg.to_workspace_kwargs()
    assert "/" in kwargs["resources"]
    mount = kwargs["resources"]["/"]
    assert isinstance(mount.resource, RAMResource)
    assert mount.mode == MountMode.WRITE
    ws = Workspace(**kwargs)
    assert ws is not None


@pytest.mark.asyncio
async def test_to_workspace_kwargs_emits_redis_cache_config():
    cfg = load_config(FIXTURES / "redis_cache.yaml")
    kwargs = cfg.to_workspace_kwargs()
    assert isinstance(kwargs["cache"], RedisCacheConfig)
    assert kwargs["cache"].url == "redis://localhost:6379/3"


@pytest.mark.asyncio
async def test_to_workspace_kwargs_emits_ram_cache_config():
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


@pytest.mark.asyncio
async def test_store_redis_block_builds_redis_provider():
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


@pytest.mark.asyncio
async def test_store_ram_block_builds_ram_provider():
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
    assert kwargs["owns_store"] is True
    assert isinstance(kwargs["store"].namespace("ws1"), RAMNamespaceStore)


@pytest.mark.asyncio
async def test_store_disk_block_builds_disk_provider(tmp_path):
    cfg = load_config({
        "store": {
            "type": "disk",
            "root": str(tmp_path),
        },
        "mounts": {
            "/": {
                "resource": "ram"
            }
        },
    })
    assert cfg.store is not None
    assert cfg.store.root == str(tmp_path)
    kwargs = cfg.to_workspace_kwargs()
    assert isinstance(kwargs["store"], DiskWorkspaceStateStore)
    assert kwargs["owns_store"] is True
    assert isinstance(kwargs["store"].namespace("ws1"), DiskNamespaceStore)


@pytest.mark.asyncio
async def test_store_disk_group_override(tmp_path):
    cfg = load_config({
        "store": {
            "type": "ram",
            "workspace": {
                "type": "disk",
                "root": str(tmp_path),
            },
        },
        "mounts": {
            "/": {
                "resource": "ram"
            }
        },
    })
    assert isinstance(cfg.store.workspace, DiskStoreBlock)
    store = cfg.to_workspace_kwargs()["store"]
    assert isinstance(store, RAMWorkspaceStateStore)
    assert isinstance(store.sessions("ws1"), DiskSessionStore)


@pytest.mark.asyncio
async def test_store_group_override_redirects_one_plane():
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


@pytest.mark.asyncio
async def test_store_s3_workspace_group_builds_s3_provider():
    cfg = load_config({
        "store": {
            "type": "ram",
            "workspace": {
                "type": "s3",
                "bucket": "state-bucket",
                "region": "us-east-1",
                "key_prefix": "mirage/",
            },
        },
        "mounts": {
            "/": {
                "resource": "ram"
            }
        },
    })
    assert isinstance(cfg.store.workspace, S3StoreBlock)
    store = cfg.to_workspace_kwargs()["store"]
    assert isinstance(store, RAMWorkspaceStateStore)
    assert isinstance(store.namespace("ws1"), RAMNamespaceStore)
    assert type(store.sessions("ws1")).__name__ == "S3SessionStore"


@pytest.mark.asyncio
async def test_workspace_id_passes_through():
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


@pytest.mark.asyncio
async def test_workspace_built_from_config_executes_command():
    cfg = load_config(FIXTURES / "minimal.yaml")
    kwargs = cfg.to_workspace_kwargs()
    ws = Workspace(**kwargs)
    result = await ws.execute("echo hello")
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


@pytest.mark.asyncio
async def test_resource_built_via_registry_has_correct_type():
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
    mount = kwargs["resources"]["/s3"]
    assert isinstance(mount.resource, S3Resource)
    assert mount.mode == MountMode.READ


@pytest.mark.asyncio
async def test_script_paths_resolve_against_config_dir(tmp_path):
    (tmp_path / "policy.py").write_text("'local'")
    (tmp_path / "entry.py").write_text("ctx['command'] == 'python3'")
    cfg_file = tmp_path / "ws.yaml"
    cfg_file.write_text("""\
mounts:
  /data:
    resource: ram
route_policy: policy.py
runtimes:
  - name: local
    script: entry.py
  - vfs
""")
    cfg = load_config(cfg_file)
    kwargs = cfg.to_workspace_kwargs()
    assert kwargs["route_policy"] == ScriptSource("'local'")
    entry = kwargs["runtimes"][0]
    assert entry.script == ScriptSource("ctx['command'] == 'python3'")


@pytest.mark.asyncio
async def test_js_script_path_stamps_the_language(tmp_path):
    (tmp_path / "policy.js").write_text("null")
    cfg_file = tmp_path / "ws.yaml"
    cfg_file.write_text("""\
mounts:
  /data:
    resource: ram
route_policy: policy.js
""")
    cfg = load_config(cfg_file)
    kwargs = cfg.to_workspace_kwargs()
    assert kwargs["route_policy"] == ScriptSource("null", language="js")
    assert kwargs["route_policy"].language == "js"


def test_permissions_document_maps_to_workspace_kwargs(tmp_path):
    # `mounts:` is infrastructure and `profiles:` is every permission
    # the deployment states, including the per-mount ones; there is no
    # workspace `permissions:` block and no `permissions:` on a mount.
    cfg_file = tmp_path / "ws.yaml"
    cfg_file.write_text("""\
mounts:
  /repo:
    resource: ram
  /scratch:
    resource: ram
    mode: rwx
profile: reviewer
profiles:
  default:
    cwd: /scratch
    env: {PAGER: cat}
    mounts:
      /repo: r
      /scratch: rwx
    commands:
      deny:
        - reason: production data is protected
          commands:
            rm: ["/repo/prod/*"]
            mv: ["/repo/prod/*"]
        - python3
    paths:
      hide: ["/scratch/finance"]
  reviewer:
    mounts:
      /repo:
        mode: r
        paths:
          hide: ["/repo/*.pem", "/repo/.env"]
    paths:
      hide: ["/repo/docs/internal"]
    vars:
      hide: ["AWS_*", SLACK_TOKEN]
""")
    cfg = load_config(cfg_file)
    kwargs = cfg.to_workspace_kwargs()
    assert "permissions" not in kwargs
    assert kwargs["profile"] == "reviewer"
    assert kwargs["profiles"]["default"] == SessionProfile(
        cwd="/scratch",
        env={"PAGER": "cat"},
        mounts={
            "/repo": ProfileMount(mode=MountMode.READ),
            "/scratch": ProfileMount(mode=MountMode.EXEC),
        },
        commands=CommandsBlock(deny=(
            CommandRule(reason="production data is protected",
                        commands=("rm", ),
                        paths=("/repo/prod/*", )),
            CommandRule(reason="production data is protected",
                        commands=("mv", ),
                        paths=("/repo/prod/*", )),
            CommandRule(reason=DEFAULT_DENY_REASON, commands=("python3", )),
        )),
        paths=PathsBlock(hide=("/scratch/finance", )),
    )
    assert kwargs["profiles"]["reviewer"] == SessionProfile(
        mounts={
            "/repo":
            ProfileMount(mode=MountMode.READ,
                         paths=PathsBlock(hide=("/repo/*.pem", "/repo/.env")))
        },
        paths=PathsBlock(hide=("/repo/docs/internal", )),
        vars=VarsBlock(hide=("AWS_*", "SLACK_TOKEN")),
    )


def test_permissions_document_end_to_end_from_yaml(tmp_path):
    import asyncio
    cfg_file = tmp_path / "ws.yaml"
    cfg_file.write_text("""\
mounts:
  /repo:
    resource: ram
    mode: rwx
profiles:
  default:
    mounts:
      /repo:
        paths:
          hide: ["/repo/.env"]
    commands:
      deny:
        - reason: no deletes in the repo
          commands:
            rm: ["/repo"]
  reviewer:
    cwd: /repo
    mounts: {/repo: r}
""")
    ws = Workspace(**load_config(cfg_file).to_workspace_kwargs())

    async def run():
        await ws.execute("printf S=1 > /repo/.env; printf x > /repo/f")
        hidden = await ws.execute("cat /repo/.env")
        refused = await ws.execute("rm /repo/f")
        ws.create_session("r", profile="reviewer")
        where = await ws.execute("pwd", session_id="r")
        readonly = await ws.execute("printf y > /repo/g", session_id="r")
        return hidden, refused, await where.stdout_str(), readonly

    hidden, refused, where, readonly = asyncio.run(run())
    assert hidden.exit_code != 0
    assert refused.exit_code == 1
    assert refused.stderr == b"rm: /repo/f: no deletes in the repo\n"
    assert where == "/repo\n"
    assert readonly.exit_code != 0


def test_unknown_profile_fields_fail_loud(tmp_path):
    with pytest.raises(ValueError):
        load_config({
            "mounts": {
                "/data": {
                    "resource": "ram"
                }
            },
            "profiles": {
                "a": {
                    "hidden_paths": {
                        "paths": ["/x"]
                    }
                }
            },
        })
    # A mount states infrastructure only, and there is no workspace
    # permissions block: both used to be a second place to write a rule.
    for bad in ({
            "permissions": {
                "commands": {
                    "allow": ["ls"]
                }
            }
    }, {
            "profiles": {
                "a": {
                    "extends": "default"
                }
            }
    }):
        with pytest.raises(ValueError):
            load_config({"mounts": {"/data": {"resource": "ram"}}, **bad})
    with pytest.raises(ValueError):
        load_config({
            "mounts": {
                "/data": {
                    "resource": "ram",
                    "permissions": {
                        "paths": {
                            "hide": ["/data/x"]
                        }
                    }
                }
            },
        })


def test_a_named_default_profile_must_exist(tmp_path):
    with pytest.raises(ValueError, match="unknown profile 'gone'"):
        load_config({
            "mounts": {
                "/data": {
                    "resource": "ram"
                }
            },
            "profile": "gone",
            "profiles": {
                "a": {
                    "cwd": "/data"
                }
            },
        })


@pytest.mark.asyncio
async def test_clis_section_parses_and_maps_to_kwargs():
    cfg = load_config({
        "mounts": {
            "/data": {
                "resource": "ram"
            }
        },
        "clis": {
            "sl": {
                "cli": "slack",
                "config": {
                    "token": "x"
                }
            },
            "bare": {
                "cli": "gws"
            },
        },
    })
    kwargs = cfg.to_workspace_kwargs()
    assert kwargs["clis"] == {
        "sl": ("slack", {
            "token": "x"
        }),
        "bare": ("gws", {}),
    }


def test_clis_script_entry_refuses_a_secrets_pointer():
    """A script's config is opaque: nothing declares which key is a
    credential, so the snapshot captures it verbatim, and a pointer
    resolved into it would be written out as the value it fetched. A
    script reads a credential from a managed env var instead."""
    with pytest.raises(ValueError, match="opaque"):
        load_config({
            "mounts": {},
            "clis": {
                "pager": {
                    "script": "pager.py",
                    "config": {
                        "token": {
                            "from": "env",
                            "key": "PAGER_TOKEN"
                        }
                    },
                }
            },
        })
    # A literal in a script's config is the script's own business.
    cfg = load_config({
        "mounts": {},
        "clis": {
            "pager": {
                "script": "pager.py",
                "config": {
                    "verbose": True
                }
            }
        },
    })
    assert cfg.clis is not None and cfg.clis["pager"].config == {
        "verbose": True
    }


@pytest.mark.asyncio
async def test_clis_script_entry_synthesizes_a_spec(tmp_path):
    (tmp_path / "pager.py").write_text("print('page')")
    cfg_file = tmp_path / "ws.yaml"
    cfg_file.write_text("""\
mounts:
  /data:
    resource: ram
clis:
  pager:
    script: pager.py
    runtime: monty
    config:
      page_size: 20
""")
    cfg = load_config(cfg_file)
    kwargs = cfg.to_workspace_kwargs()
    spec, config = kwargs["clis"]["pager"]
    assert spec.name == "pager"
    assert spec.script == ScriptSource("print('page')")
    assert spec.runtime == "monty"
    assert config == {"page_size": 20}


@pytest.mark.asyncio
async def test_clis_js_script_stamps_the_language(tmp_path):
    (tmp_path / "pager.mjs").write_text("console.log('page')")
    cfg_file = tmp_path / "ws.yaml"
    cfg_file.write_text("""\
mounts:
  /data:
    resource: ram
clis:
  pager:
    script: pager.mjs
""")
    cfg = load_config(cfg_file)
    kwargs = cfg.to_workspace_kwargs()
    spec, _ = kwargs["clis"]["pager"]
    # .mjs also stamps module: the path is gone once the source is
    # embedded, so the engine could not otherwise know to run it as an
    # ES module and `import` would fail.
    assert spec.script == ScriptSource("console.log('page')",
                                       language="js",
                                       module=True)


@pytest.mark.asyncio
async def test_clis_plain_js_script_is_not_a_module(tmp_path):
    (tmp_path / "pager.js").write_text("console.log('page')")
    cfg_file = tmp_path / "ws.yaml"
    cfg_file.write_text("""\
mounts:
  /data:
    resource: ram
clis:
  pager:
    script: pager.js
""")
    spec, _ = load_config(cfg_file).to_workspace_kwargs()["clis"]["pager"]
    assert spec.script.language == "js"
    assert spec.script.module is False


@pytest.mark.asyncio
async def test_clis_path_form_reference_rebases_on_the_config_dir(
        tmp_path, monkeypatch):
    # `cli: ./tool.py:TREE` means "next to the config file", the same
    # build-context rule script: follows; without rebasing it resolves
    # against the process cwd and only works by luck.
    (tmp_path / "tool.py").write_text(
        "from mirage import CLISpec\n"
        "TREE = CLISpec(name='tool', subcommands=(CLISpec(name='run',\n"
        "               fn=lambda inv: None), ))\n")
    cfg_file = tmp_path / "ws.yaml"
    cfg_file.write_text("""\
mounts:
  /data:
    resource: ram
clis:
  tool:
    cli: ./tool.py:TREE
""")
    monkeypatch.chdir(tmp_path.parent)
    cfg = load_config(cfg_file)
    ref, _ = cfg.to_workspace_kwargs()["clis"]["tool"]
    assert ref == f"{tmp_path / 'tool.py'}:TREE"


@pytest.mark.asyncio
async def test_mounts_path_form_resource_rebases_on_the_config_dir(
        tmp_path, monkeypatch):
    # `resource: ./wiki.py:WikiResource` reads the same way `cli:` does,
    # so it follows the same build-context rule.
    (tmp_path / "wiki.py").write_text("""\
from mirage.resource.ram.ram import RAMResource


class WikiResource(RAMResource):
    pass
""")
    cfg_file = tmp_path / "ws.yaml"
    cfg_file.write_text("""\
mounts:
  /wiki:
    resource: ./wiki.py:WikiResource
""")
    monkeypatch.chdir(tmp_path.parent)
    cfg = load_config(cfg_file)
    assert cfg.mounts[
        "/wiki"].resource == f"{tmp_path / 'wiki.py'}:WikiResource"
    mount = cfg.to_workspace_kwargs()["resources"]["/wiki"]
    assert type(mount.resource).__name__ == "WikiResource"


@pytest.mark.asyncio
async def test_mounts_module_dotpath_resource_is_left_alone(tmp_path):
    cfg_file = tmp_path / "ws.yaml"
    cfg_file.write_text("""\
mounts:
  /wiki:
    resource: mypkg.backends:WikiResource
""")
    cfg = load_config(cfg_file)
    assert cfg.mounts["/wiki"].resource == "mypkg.backends:WikiResource"


BOX_RUNTIME = """\
from mirage import LineExecutorMixin, RunResult, Runtime


class EchoBox(Runtime, LineExecutorMixin):
    name = "echobox"
    captures = ("nvidia-smi", )

    async def run_line(self, line, stdin, env, cwd):
        return RunResult(stdout=f"box:{line}\\n".encode(), stderr=None,
                         exit_code=0)


NOT_A_RUNTIME = {"name": "nope"}
"""


def test_runtimes_path_form_reference_rebases_and_builds(
        tmp_path, monkeypatch):
    # A runtime entry's `name: ./box.py:EchoBox` reads the way `resource:`
    # and `cli:` do: rebased onto the config dir, then constructed with
    # the entry's uniform options, so a deployment ships a runtime as a
    # file with no host program calling register_runtime.
    (tmp_path / "box.py").write_text(BOX_RUNTIME)
    cfg_file = tmp_path / "ws.yaml"
    cfg_file.write_text("""\
mounts:
  /data:
    resource: ram
runtimes:
  - name: ./box.py:EchoBox
    captures: [nvidia-smi, rocm-smi]
  - ./box.py:EchoBox
  - vfs
""")
    monkeypatch.chdir(tmp_path.parent)
    cfg = load_config(cfg_file)
    assert cfg.runtimes is not None
    # Both spellings rebase: the keyed entry and the bare string beside
    # a bare builtin name.
    assert cfg.runtimes[0]["name"] == f"{tmp_path / 'box.py'}:EchoBox"
    assert cfg.runtimes[1] == f"{tmp_path / 'box.py'}:EchoBox"
    box, bare, vfs = cfg.to_workspace_kwargs()["runtimes"]
    assert type(box).__name__ == "EchoBox"
    assert box.name == "echobox"
    assert box.captures == ("nvidia-smi", "rocm-smi")
    assert type(bare).__name__ == "EchoBox"
    assert bare.captures == ("nvidia-smi", )
    assert vfs == "vfs"


def test_runtimes_reference_must_name_a_runtime_subclass(tmp_path):
    (tmp_path / "box.py").write_text(BOX_RUNTIME)
    ref = f"{tmp_path / 'box.py'}:NOT_A_RUNTIME"
    with pytest.raises(ValueError, match="is not a Runtime subclass"):
        _build_runtime_entries([{"name": ref}])
    with pytest.raises(ValueError, match="cannot load script"):
        _build_runtime_entries([f"{tmp_path / 'missing.py'}:EchoBox"])


def test_runtimes_reference_refuses_an_unknown_entry_key(tmp_path):
    # A referenced class is constructed with the entry's keys as kwargs,
    # so a typo fails the way it does for a builtin name instead of
    # leaving the runtime on its class defaults; TypeScript's loader runs
    # the same check by hand (checkRuntimeOptions).
    (tmp_path / "box.py").write_text(BOX_RUNTIME)
    ref = f"{tmp_path / 'box.py'}:EchoBox"
    with pytest.raises(TypeError,
                       match="unexpected keyword argument 'captuers'"):
        _build_runtime_entries([{"name": ref, "captuers": ["nvidia-smi"]}])


@pytest.mark.asyncio
async def test_mounts_registry_name_is_left_alone(tmp_path):
    cfg_file = tmp_path / "ws.yaml"
    cfg_file.write_text("""\
mounts:
  /data:
    resource: ram
""")
    cfg = load_config(cfg_file)
    assert cfg.mounts["/data"].resource == "ram"


@pytest.mark.asyncio
async def test_clis_module_dotpath_reference_is_left_alone(tmp_path):
    # importlib resolves a dotpath, not the filesystem, so rebasing it
    # would break the import.
    cfg_file = tmp_path / "ws.yaml"
    cfg_file.write_text("""\
mounts:
  /data:
    resource: ram
clis:
  tool:
    cli: mypkg.clis:TREE
""")
    cfg = load_config(cfg_file)
    ref, _ = cfg.to_workspace_kwargs()["clis"]["tool"]
    assert ref == "mypkg.clis:TREE"


@pytest.mark.asyncio
async def test_clis_registered_name_reference_is_left_alone(tmp_path):
    cfg_file = tmp_path / "ws.yaml"
    cfg_file.write_text("""\
mounts:
  /data:
    resource: ram
clis:
  sl:
    cli: slack
""")
    cfg = load_config(cfg_file)
    ref, _ = cfg.to_workspace_kwargs()["clis"]["sl"]
    assert ref == "slack"


@pytest.mark.asyncio
async def test_clis_script_file_must_exist(tmp_path):
    cfg_file = tmp_path / "ws.yaml"
    cfg_file.write_text("""\
mounts:
  /data:
    resource: ram
clis:
  pager:
    script: pager.py
""")
    cfg = load_config(cfg_file)
    with pytest.raises(FileNotFoundError):
        cfg.to_workspace_kwargs()


def test_clis_entry_takes_exactly_one_of_cli_or_script():
    mounts = {"/data": {"resource": "ram"}}
    with pytest.raises(ValueError, match="exactly one of cli or script"):
        load_config({
            "mounts": mounts,
            "clis": {
                "sl": {
                    "cli": "slack",
                    "script": "pager.py"
                }
            },
        })
    with pytest.raises(ValueError, match="exactly one of cli or script"):
        load_config({
            "mounts": mounts,
            "clis": {
                "sl": {
                    "config": {
                        "token": "x"
                    }
                }
            },
        })


def test_clis_runtime_takes_script():
    with pytest.raises(ValueError, match="it takes script"):
        load_config({
            "mounts": {
                "/data": {
                    "resource": "ram"
                }
            },
            "clis": {
                "sl": {
                    "cli": "slack",
                    "runtime": "monty"
                }
            },
        })


def test_clis_block_refuses_unknown_keys():
    with pytest.raises(ValueError, match="mode"):
        load_config({
            "mounts": {
                "/data": {
                    "resource": "ram"
                }
            },
            "clis": {
                "sl": {
                    "cli": "slack",
                    "mode": "write"
                }
            },
        })


# The accepted half of the shared contract, one file per subject:
# every config block that is not a permission verb, then a verb each.
ACCEPTED_FIXTURES = ("blocks", "allow", "ask", "deny")


def _shared_fixture_cases(name: str) -> list[dict]:
    # integ/fixtures/config/*.json are the contract: the TypeScript suite
    # (packages/node/src/config.test.ts) reads the same files, so a
    # config that loads in one language and not the other fails a test
    # until both loaders agree.
    fixture = (Path(__file__).parents[3] / "integ" / "fixtures" / "config" /
               f"{name}.json")
    cases = json.loads(fixture.read_text())["cases"]
    assert cases, f"the {name} fixture must not be empty"
    return cases


@pytest.mark.asyncio
async def test_console_redis_block_builds_factory():
    cfg = load_config({
        "console": {
            "type": "redis",
            "url": "redis://localhost:6379/5",
            "key_prefix": "test_console:",
        },
        "mounts": {
            "/": {
                "resource": "ram"
            }
        },
    })
    kwargs = cfg.to_workspace_kwargs()
    factory = kwargs["console_factory"]
    first = factory(1)
    second = factory(1)
    assert isinstance(first, JobConsole)
    assert isinstance(first.store, RedisConsoleStore)
    assert isinstance(second.store, RedisConsoleStore)
    # Fresh keys per console: job ids restart at 1 when the table
    # empties, so two consoles built for "job 1" must not share a
    # stream (a shared one would replay the first job's chunks). The
    # minted prefix is public: it is the address an embedder hands to
    # a reader in another process.
    assert first.store.key_prefix != second.store.key_prefix
    assert first.store.key_prefix.startswith("test_console:")


@pytest.mark.asyncio
async def test_console_ram_block_emits_no_factory():
    cfg = load_config({
        "console": {
            "type": "ram"
        },
        "mounts": {
            "/": {
                "resource": "ram"
            }
        },
    })
    assert "console_factory" not in cfg.to_workspace_kwargs()


def test_shared_rejection_fixture_is_refused():
    for case in _shared_fixture_cases("rejected"):
        with pytest.raises(ValueError):
            load_config(case["config"])


@pytest.mark.parametrize("fixture", ACCEPTED_FIXTURES)
def test_shared_acceptance_fixture_is_accepted(fixture: str):
    # Every key of every block, so a field added to a model here and
    # never mirrored into the TypeScript key tables fails there.
    for case in _shared_fixture_cases(fixture):
        load_config(case["config"])


def test_profile_policy_path_rebases_on_the_config_dir(tmp_path, monkeypatch):
    # `policy: roles/x.py` means "next to the config file", the same
    # build-context rule the cli path form follows; without rebasing it
    # resolves against the process cwd and only works by luck.
    (tmp_path / "roles").mkdir()
    (tmp_path / "roles" /
     "x.py").write_text("def pre_command(ctx):\n    return None\n")
    cfg_file = tmp_path / "ws.yaml"
    cfg_file.write_text("""\
mounts:
  /data:
    resource: ram
profiles:
  release: {policy: {script: roles/x.py, runtime: monty}}
""")
    monkeypatch.chdir(tmp_path.parent)
    cfg = load_config(cfg_file)
    release = cfg.to_workspace_kwargs()["profiles"]["release"]
    assert release.policy is not None
    assert isinstance(release.policy.script, ScriptSource)
    assert release.policy.script.source == \
        "def pre_command(ctx):\n    return None\n"
    assert release.policy.runtime == "monty"


def test_profile_policy_states_its_runtime(tmp_path):
    # There is no default engine: a policy the config does not pin to an
    # engine is refused at load, not guessed at the gate.
    (tmp_path / "roles").mkdir()
    (tmp_path / "roles" / "x.py").write_text("None\n")
    cfg_file = tmp_path / "ws.yaml"
    cfg_file.write_text("""\
mounts:
  /data:
    resource: ram
profiles:
  release: {policy: {script: roles/x.py}}
""")
    with pytest.raises(ValueError, match="runtime"):
        load_config(cfg_file)


def test_a_profile_written_with_script_is_told_where_the_keys_went(tmp_path):
    cfg_file = tmp_path / "ws.yaml"
    cfg_file.write_text("""\
mounts:
  /data:
    resource: ram
profiles:
  release: {script: roles/x.py, runtime: monty}
""")
    with pytest.raises(ValueError, match="now one policy block"):
        load_config(cfg_file)


def test_env_block_literal_and_managed_entries(tmp_path):
    cfg_file = tmp_path / "ws.yaml"
    cfg_file.write_text("""\
mounts:
  /data:
    resource: ram
env:
  GREETING: hello ${WHO}
  EDITOR:
    value: vim
    readonly: true
    export: false
  TOKEN:
    from: aws-sm
    ref: prod/tokens
    key: api
    fetch: eager
  HOME_DIR:
    from: env
""")
    cfg = load_config(cfg_file, env={"WHO": "world"})
    assert cfg.env is not None
    assert cfg.env["GREETING"] == "hello world"
    editor = cfg.env["EDITOR"]
    assert isinstance(editor, EnvVar)
    assert editor.value == "vim"
    assert editor.readonly is True
    assert editor.export is False
    token = cfg.env["TOKEN"]
    assert isinstance(token, EnvVar)
    assert token.provider == "aws-sm"
    assert token.ref == "prod/tokens"
    assert token.key == "api"
    assert token.fetch == "eager"
    home = cfg.env["HOME_DIR"]
    assert isinstance(home, EnvVar)
    assert home.provider == "env"
    assert home.ref == ""
    assert home.key is None
    assert home.fetch == "lazy"
    assert cfg.to_workspace_kwargs()["env"] is cfg.env


def test_env_block_absent_by_default():
    cfg = load_config({"mounts": {"/": {"resource": "ram"}}})
    assert cfg.env is None
    assert "env" not in cfg.to_workspace_kwargs()


def test_env_entry_refusals_surface_as_config_errors():
    base = {"mounts": {"/": {"resource": "ram"}}}
    with pytest.raises(ValueError, match="not both"):
        load_config({**base, "env": {"X": {"value": "v", "from": "env"}}})
    with pytest.raises(ValueError, match="always exported"):
        load_config({**base, "env": {"X": {"from": "env", "export": False}}})
    with pytest.raises(ValueError, match="managed entries"):
        load_config({**base, "env": {"X": {"value": "v", "key": "k"}}})


def test_secrets_block_declares_instances():
    cfg = load_config({
        "mounts": {
            "/": {
                "resource": "ram"
            }
        },
        "secrets": {
            "sm": {
                "source": "aws-sm",
                "config": {
                    "region": "us-east-2",
                    "aws_access_key_id": {
                        "from": "env",
                        "key": "KEY_ID"
                    },
                },
            }
        },
    })
    block = cfg.secrets["sm"]
    assert block.source == "aws-sm"
    assert block.config["region"] == "us-east-2"
    assert isinstance(block.config["aws_access_key_id"], SecretRef)
    assert block.config["aws_access_key_id"].key == "KEY_ID"
    assert cfg.to_workspace_kwargs()["secrets"] is cfg.secrets


def test_secrets_block_absent_by_default():
    cfg = load_config({"mounts": {"/": {"resource": "ram"}}})
    assert cfg.secrets is None
    assert "secrets" not in cfg.to_workspace_kwargs()


def test_secrets_block_refusals_surface_as_config_errors():
    base = {"mounts": {"/": {"resource": "ram"}}}
    with pytest.raises(ValueError, match="needs no config of its own"):
        load_config({
            **base, "secrets": {
                "sm": {
                    "source": "aws-sm",
                    "config": {
                        "region": {
                            "from": "aws-sm",
                            "key": "r"
                        }
                    },
                }
            }
        })
    with pytest.raises(ValueError):
        load_config({**base, "secrets": {"sm": {"kind": "aws-sm"}}})
