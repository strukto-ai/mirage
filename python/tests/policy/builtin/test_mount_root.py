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
from mirage.policy.builtin.mount_root import has_parents_flag
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
         registry: MountRegistry | None = None,
         operands: list[PathSpec] | None = None) -> CommandContext:
    return CommandContext(
        command=command,
        paths=tuple(paths),
        operands=tuple(paths if operands is None else operands),
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


@pytest.mark.asyncio
async def test_ln_wording_follows_the_link_kind():
    # GNU words the refusal by link kind: ln -s says "symbolic link",
    # plain ln says "link" (pinned by integ guard_root_ln_is_eexist).
    policy = MountRootPolicy()
    deny = await policy.pre_command(
        _ctx("ln", [_path("/data/k.txt"), _path("/data")], ["-s"]))
    assert deny is not None
    assert deny.message == ("ln: failed to create symbolic link "
                            "'/data': File exists\n")
    deny = await policy.pre_command(
        _ctx("ln", [_path("/data/k.txt"), _path("/data")]))
    assert deny is not None
    assert deny.message == "ln: failed to create link '/data': File exists\n"


def test_has_parents_flag_spots_the_shorthand_cluster():
    assert has_parents_flag(("-p", ))
    assert has_parents_flag(("--parents", ))
    assert has_parents_flag(("-pv", ))
    assert not has_parents_flag(("--print", ))
    assert not has_parents_flag(("x", "-r"))


@pytest.mark.parametrize("cmd,needle", [
    ("tar", "tar: /data: Cannot open: Device or resource busy"),
    ("zip", "zip: cannot read '/data': Device or resource busy"),
    ("cp", "cp: cannot copy '/data': Device or resource busy"),
])
@pytest.mark.asyncio
async def test_whole_mount_archivers_refused(cmd, needle):
    # zip's first operand is the archive it writes, cp's last is the
    # destination, so each line puts the mount root in a source slot.
    operands = {
        "tar": [_path("/data")],
        "zip": [_path("/out.zip"), _path("/data")],
        "cp": [_path("/data"), _path("/dst")],
    }[cmd]
    argv = ["-cf", "/out.tar"] if cmd == "tar" else []
    deny = await MountRootPolicy().pre_command(_ctx(cmd, operands, argv=argv))
    assert deny is not None
    assert needle in deny.message


@pytest.mark.asyncio
async def test_tar_refusal_names_the_operand_as_typed_and_exits_two():
    deny = await MountRootPolicy().pre_command(
        _ctx("tar", [_path("/data", raw=".")], argv=["-cf", "/out.tar"]))
    assert deny is not None
    assert "tar: .: Cannot open" in deny.message
    assert "Error is not recoverable" in deny.message
    assert deny.exit_code == 2


@pytest.mark.asyncio
async def test_extracting_into_a_mount_root_is_allowed():
    # `-C /data` is a path-valued flag, so it reaches paths but never
    # operands; refusing it would block the safe direction.
    deny = await MountRootPolicy().pre_command(
        _ctx("tar",
             [_path("/archive.tar"), _path("/data")],
             operands=[_path("/archive.tar")]))
    assert deny is None


@pytest.mark.asyncio
async def test_copying_into_a_mount_root_is_allowed():
    deny = await MountRootPolicy().pre_command(
        _ctx("cp", [_path("/src/a.txt"), _path("/data")]))
    assert deny is None


@pytest.mark.asyncio
async def test_zip_archive_slot_is_not_a_source():
    deny = await MountRootPolicy().pre_command(
        _ctx("zip", [_path("/data"), _path("/src/a.txt")]))
    assert deny is None


@pytest.mark.parametrize("argv,denied", [
    (["-cf", "/a.tar"], True),
    (["--create", "-f", "/a.tar"], True),
    (["cf", "/a.tar"], True),
    (["-tf", "/a.tar"], False),
    (["-xf", "/a.tar"], False),
    (["xzf", "/a.tar"], False),
    (["-xf", "/a.tar", "-C", "/cache"], False),
])
@pytest.mark.asyncio
async def test_only_tar_create_reads_its_operands_from_the_filesystem(
        argv, denied):
    """Under -t and -x an operand names a member, not a path.

    A selector that happens to spell a mount root is not a mount, so
    refusing it would deny an ordinary listing or extraction.
    """
    deny = await MountRootPolicy().pre_command(
        _ctx("tar", [_path("/data")], argv=argv))
    assert (deny is not None) is denied
