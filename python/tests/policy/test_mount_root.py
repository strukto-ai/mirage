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

from mirage.policy import CommandContext, MountRootPolicy
from mirage.policy.mount_root import has_parents_flag
from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.workspace.mount import MountRegistry


def _registry() -> MountRegistry:
    registry = MountRegistry()
    registry.mount("/data", RAMResource(), MountMode.WRITE)
    return registry


def _path(virtual: str, raw: str | None = None) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    resource_path="",
                    raw_path=raw or virtual,
                    resolved=True)


def _ctx(command: str,
         paths: list[PathSpec],
         argv: list[str] | None = None,
         registry: MountRegistry | None = None) -> CommandContext:
    return CommandContext(command=command,
                          paths=tuple(paths),
                          argv=tuple(argv or []),
                          cwd="/",
                          registry=registry or _registry())


@pytest.mark.parametrize("cmd,needle", [
    ("rm", "Device or resource busy"),
    ("rmdir", "Device or resource busy"),
    ("mv", "Device or resource busy"),
    ("mkdir", "File exists"),
    ("touch", "Is a directory"),
    ("ln", "File exists"),
])
@pytest.mark.asyncio
async def test_mount_root_refuses(cmd, needle):
    deny = await MountRootPolicy().pre_command(_ctx(cmd, [_path("/data")]))
    assert deny is not None
    assert needle in deny.message
    assert deny.exit_code == 1


@pytest.mark.asyncio
async def test_mkdir_dash_p_is_a_no_op_on_a_mount_root():
    registry = _registry()
    policy = MountRootPolicy()
    for argv in (["-p"], ["--parents"], ["-pv"]):
        assert await policy.pre_command(
            _ctx("mkdir", [_path("/data")], argv, registry)) is None
    # A long flag containing p is not the shorthand cluster.
    assert await policy.pre_command(
        _ctx("mkdir", [_path("/data")], ["--print"], registry)) is not None


@pytest.mark.asyncio
async def test_non_root_paths_and_no_paths_pass():
    registry = _registry()
    policy = MountRootPolicy()
    for cmd in ("rm", "rmdir", "mv", "mkdir", "touch", "ln"):
        assert await policy.pre_command(
            _ctx(cmd, [_path("/data/file.txt")], registry=registry)) is None
    assert await policy.pre_command(_ctx("rm", [], ["-r"], registry)) is None


@pytest.mark.asyncio
async def test_rm_r_on_a_mount_root_is_refused_never_an_unmount():
    deny = await MountRootPolicy().pre_command(
        _ctx("rm", [_path("/data")], ["-rf"]))
    assert deny is not None
    assert "Device or resource busy" in deny.message


def test_has_parents_flag_spots_the_shorthand_cluster():
    assert has_parents_flag(("-p", ))
    assert has_parents_flag(("--parents", ))
    assert has_parents_flag(("-pv", ))
    assert not has_parents_flag(("--print", ))
    assert not has_parents_flag(("x", "-r"))
