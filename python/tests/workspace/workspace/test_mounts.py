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

from mirage.resource.ram import RAMResource
from mirage.runtime.policy.safeguard import CommandSafeguard
from mirage.types import MountBackend, MountMode
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
    assert specs[0].safeguards == {}


def test_pair_tuple_carries_its_own_mode():
    specs = normalize_resources({"/a": (RAMResource(), MountMode.READ)},
                                MountMode.WRITE)
    assert specs[0].mode == MountMode.READ


def test_triple_tuple_carries_safeguards():
    guard = CommandSafeguard(timeout_seconds=1)
    specs = normalize_resources(
        {"/a": (RAMResource(), MountMode.READ, {
            "curl": guard
        })}, MountMode.WRITE)
    assert specs[0].safeguards == {"curl": guard}


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
    assert kernel_targets(specs) == [("/fuse", MountBackend.FUSE, "/tmp/mp")]


def test_safeguards_are_copied_not_aliased():
    guard = CommandSafeguard(timeout_seconds=1)
    source = {"curl": guard}
    specs = normalize_resources(
        {"/a": (RAMResource(), MountMode.READ, source)}, MountMode.WRITE)
    source["wget"] = guard
    assert set(specs[0].safeguards) == {"curl"}
