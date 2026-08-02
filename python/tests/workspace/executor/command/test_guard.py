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
from mirage.types import MountMode, PathSpec
from mirage.workspace.executor.command.guard import check_mount_root_guard
from mirage.workspace.mount import MountRegistry


def _registry() -> MountRegistry:
    registry = MountRegistry()
    registry.mount("/data", RAMResource(), MountMode.WRITE)
    return registry


def _path(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path="",
                    resolved=True)


@pytest.mark.parametrize("cmd,needle,code", [
    ("rm", "Device or resource busy", 1),
    ("rmdir", "Device or resource busy", 1),
    ("mv", "Device or resource busy", 1),
    ("mkdir", "File exists", 1),
    ("touch", "Is a directory", 1),
    ("ln", "File exists", 1),
])
def test_mount_root_is_refused(cmd, needle, code):
    result = check_mount_root_guard(cmd, [_path("/data")], _registry(), [])
    assert result is not None
    msg, exit_code = result
    assert needle in msg
    assert exit_code == code


def test_mkdir_dash_p_is_a_no_op_on_a_mount_root():
    registry = _registry()
    for argv in (["-p"], ["--parents"], ["-pv"]):
        assert check_mount_root_guard("mkdir", [_path("/data")], registry,
                                      argv) is None
    # A long flag containing p is not the shorthand cluster.
    assert check_mount_root_guard("mkdir", [_path("/data")], registry,
                                  ["--print"]) is not None


def test_non_root_paths_pass():
    registry = _registry()
    for cmd in ("rm", "rmdir", "mv", "mkdir", "touch", "ln"):
        assert check_mount_root_guard(cmd, [_path("/data/file.txt")], registry,
                                      []) is None


def test_no_paths_passes():
    assert check_mount_root_guard("rm", [], _registry(), ["-r"]) is None
