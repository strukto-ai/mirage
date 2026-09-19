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

import asyncio

import pytest

from mirage.cache.index import IndexConfig, RedisIndexConfig
from mirage.cache.index.redis import RedisIndexCacheStore
from mirage.types import Limit, MountBackend, MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace.mount.registry import MountRegistry
from mirage.workspace.mount.spec import Mount
from mirage.workspace.workspace.mounts import (install_mounts, kernel_targets,
                                               normalize_mounts)


def test_bare_vfs_takes_the_default_mode():
    vfs = RAMVFS()
    specs = normalize_mounts({"/a": vfs}, MountMode.WRITE)
    assert len(specs) == 1
    assert specs[0].vfs is vfs
    assert specs[0].mode == MountMode.WRITE
    assert specs[0].backend == MountBackend.WORKSPACE
    assert specs[0].command_limits == {}


def test_pair_tuple_carries_its_own_mode():
    specs = normalize_mounts({"/a": (RAMVFS(), MountMode.READ)},
                             MountMode.WRITE)
    assert specs[0].mode == MountMode.READ


def test_triple_tuple_carries_limits():
    guard = Limit(timeout_seconds=1)
    specs = normalize_mounts(
        {"/a": (RAMVFS(), MountMode.READ, {
            "curl": guard
        })}, MountMode.WRITE)
    assert specs[0].command_limits == {"curl": guard}


def test_mount_without_a_mode_falls_back_to_the_default():
    specs = normalize_mounts({"/a": Mount(vfs=RAMVFS())}, MountMode.EXEC)
    assert specs[0].mode == MountMode.EXEC


def test_mount_carries_backend_and_mountpoint():
    mount = Mount(vfs=RAMVFS(),
                  mode=MountMode.WRITE,
                  backend=MountBackend.FUSE,
                  mountpoint="/tmp/mp")
    specs = normalize_mounts({"/a": mount}, MountMode.READ)
    assert specs[0].backend == MountBackend.FUSE
    assert specs[0].mountpoint == "/tmp/mp"


def test_a_mount_carries_no_permissions():
    # Permissions live in one document, the profile, so a mount states
    # infrastructure only: what it is, where it is, how it is served.
    with pytest.raises(TypeError):
        Mount(vfs=RAMVFS(), permissions={"paths": {"hide": ["x"]}})


def test_wrong_length_tuple_is_rejected():
    with pytest.raises(TypeError):
        normalize_mounts({"/a": (RAMVFS(), )}, MountMode.READ)


def test_kernel_targets_selects_only_real_mountpoints():
    specs = normalize_mounts(
        {
            "/vfs":
            RAMVFS(),
            "/fuse":
            Mount(
                vfs=RAMVFS(), backend=MountBackend.FUSE, mountpoint="/tmp/mp"),
        }, MountMode.WRITE)
    assert kernel_targets(specs) == [("/fuse", MountBackend.FUSE, "/tmp/mp")]


def test_limits_are_copied_not_aliased():
    guard = Limit(timeout_seconds=1)
    source = {"curl": guard}
    specs = normalize_mounts({"/a": (RAMVFS(), MountMode.READ, source)},
                             MountMode.WRITE)
    source["wget"] = guard
    assert set(specs[0].command_limits) == {"curl"}


def test_a_coroutine_is_refused_naming_the_await():
    # 0.0.5 made build_vfs async, so every caller written against
    # 0.0.3/0.0.4 handed the mount table an un-awaited coroutine and got
    # `'coroutine' object has no attribute 'set_index'` from
    # install_mounts. The mount and the fix have to be in the message.
    coro = asyncio.sleep(0)
    try:
        with pytest.raises(TypeError) as excinfo:
            normalize_mounts({"/gh": (coro, MountMode.READ)}, MountMode.WRITE)
    finally:
        coro.close()
    message = str(excinfo.value)
    assert "'/gh'" in message
    assert "await" in message


@pytest.mark.parametrize("value", ["not-a-VFS", 42, None])
def test_a_non_vfs_is_refused_naming_the_mount(value):
    with pytest.raises(TypeError, match=r"'/x'.*expected a BaseVFS"):
        normalize_mounts({"/x": value}, MountMode.WRITE)


def test_the_guard_runs_before_any_mount_is_installed():
    # A bad second entry must not leave the first one half-installed.
    with pytest.raises(TypeError):
        normalize_mounts({
            "/good": RAMVFS(),
            "/bad": "nope",
        }, MountMode.WRITE)


# A mount keeps the index it names when the workspace passes none
# (#1012): a `RedisIndexConfig` the placement carries must not be
# replaced with a RAM default.
def test_install_mounts_keeps_a_mounts_own_index_without_a_config():
    registry = MountRegistry()
    own = RedisIndexConfig(url="redis://127.0.0.1:1/0", key_prefix="own:")
    install_mounts(
        registry,
        normalize_mounts({"/a": Mount(vfs=RAMVFS(), index=own)},
                         MountMode.WRITE), None, MountMode.WRITE)
    assert isinstance(
        registry.mount_for("/a/").index_store, RedisIndexCacheStore)


def test_install_mounts_applies_a_workspace_index_to_every_vfs():
    registry = MountRegistry()
    install_mounts(registry, normalize_mounts({"/a": RAMVFS()},
                                              MountMode.WRITE),
                   IndexConfig(ttl=5), MountMode.WRITE)
    assert registry.mount_for("/a/").index_store._ttl == 5
