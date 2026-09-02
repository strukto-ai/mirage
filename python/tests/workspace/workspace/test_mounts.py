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

from mirage.nfs.config import NFSConfig
from mirage.resource.ram import RAMResource
from mirage.types import Limit, MountBackend, MountMode
from mirage.workspace.mount.spec import Mount
from mirage.workspace.workspace.mounts import (kernel_targets,
                                               normalize_resources)


def test_bare_resource_takes_the_default_mode():
    resource = RAMResource()
    specs = normalize_resources({"/a": resource}, MountMode.WRITE)
    assert len(specs) == 1
    assert specs[0].resource is resource
    assert specs[0].mode == MountMode.WRITE
    assert specs[0].backend == MountBackend.VFS
    assert specs[0].command_limits == {}


def test_pair_tuple_carries_its_own_mode():
    specs = normalize_resources({"/a": (RAMResource(), MountMode.READ)},
                                MountMode.WRITE)
    assert specs[0].mode == MountMode.READ


def test_triple_tuple_carries_limits():
    guard = Limit(timeout_seconds=1)
    specs = normalize_resources(
        {"/a": (RAMResource(), MountMode.READ, {
            "curl": guard
        })}, MountMode.WRITE)
    assert specs[0].command_limits == {"curl": guard}


def test_mount_without_a_mode_falls_back_to_the_default():
    specs = normalize_resources({"/a": Mount(resource=RAMResource())},
                                MountMode.EXEC)
    assert specs[0].mode == MountMode.EXEC


def test_mount_carries_backend_and_mountpoint():
    mount = Mount(resource=RAMResource(),
                  mode=MountMode.WRITE,
                  backend=MountBackend.FUSE,
                  mountpoint="/tmp/mp")
    specs = normalize_resources({"/a": mount}, MountMode.READ)
    assert specs[0].backend == MountBackend.FUSE
    assert specs[0].mountpoint == "/tmp/mp"


def test_a_mount_carries_no_permissions():
    # Permissions live in one document, the profile, so a mount states
    # infrastructure only: what it is, where it is, how it is served.
    with pytest.raises(TypeError):
        Mount(resource=RAMResource(), permissions={"paths": {"hide": ["x"]}})


def test_wrong_length_tuple_is_rejected():
    with pytest.raises(TypeError):
        normalize_resources({"/a": (RAMResource(), )}, MountMode.READ)


def test_kernel_targets_selects_only_real_mountpoints():
    specs = normalize_resources(
        {
            "/vfs":
            RAMResource(),
            "/fuse":
            Mount(resource=RAMResource(),
                  backend=MountBackend.FUSE,
                  mountpoint="/tmp/mp"),
        }, MountMode.WRITE)
    assert kernel_targets(specs) == [("/fuse", MountBackend.FUSE, "/tmp/mp",
                                      None)]


def test_kernel_targets_carry_a_declared_nfs_config():
    # A declared mount is the only place a user can express these, so
    # without this `backend=nfs` in a spec could not choose a port, an
    # idle window or a soft mount -- only add_nfs_mount could be tuned.
    config = NFSConfig(port=12345)
    specs = normalize_resources(
        {
            "/nfs":
            Mount(resource=RAMResource(),
                  backend=MountBackend.NFS,
                  mountpoint="/tmp/mp",
                  nfs_config=config),
        }, MountMode.WRITE)

    assert kernel_targets(specs) == [("/nfs", MountBackend.NFS, "/tmp/mp",
                                      config)]


def test_limits_are_copied_not_aliased():
    guard = Limit(timeout_seconds=1)
    source = {"curl": guard}
    specs = normalize_resources(
        {"/a": (RAMResource(), MountMode.READ, source)}, MountMode.WRITE)
    source["wget"] = guard
    assert set(specs[0].command_limits) == {"curl"}


def test_a_coroutine_is_refused_naming_the_await():
    # 0.0.5 made build_resource async, so every caller written against
    # 0.0.3/0.0.4 handed the mount table an un-awaited coroutine and got
    # `'coroutine' object has no attribute 'set_index'` from
    # install_mounts. The mount and the fix have to be in the message.
    coro = asyncio.sleep(0)
    try:
        with pytest.raises(TypeError) as excinfo:
            normalize_resources({"/gh": (coro, MountMode.READ)},
                                MountMode.WRITE)
    finally:
        coro.close()
    message = str(excinfo.value)
    assert "'/gh'" in message
    assert "await" in message


@pytest.mark.parametrize("value", ["not-a-resource", 42, None])
def test_a_non_resource_is_refused_naming_the_mount(value):
    with pytest.raises(TypeError, match=r"'/x'.*expected a BaseResource"):
        normalize_resources({"/x": value}, MountMode.WRITE)


def test_the_guard_runs_before_any_mount_is_installed():
    # A bad second entry must not leave the first one half-installed.
    with pytest.raises(TypeError):
        normalize_resources({
            "/good": RAMResource(),
            "/bad": "nope",
        }, MountMode.WRITE)
