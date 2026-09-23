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

from mirage.policy import (CommandContext, DenyScope, MountRootPolicy,
                           render_deny)
from mirage.policy.builtin.mount_root import (has_no_target_flag,
                                              has_parents_flag,
                                              has_symlink_flag)
from mirage.types import MountMode, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.workspace.mount import MountRegistry


def _registry() -> MountRegistry:
    registry = MountRegistry()
    registry.mount("/data", RAMVFS(), MountMode.WRITE)
    return registry


def _path(virtual: str, raw: str | None = None) -> PathSpec:
    return PathSpec(virtual=virtual,
                    directory=virtual,
                    vfs_path="",
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
    # ln refuses a mount root only as the link NAME, which -T pins;
    # without it a directory operand is the directory to link into.
    argv = ["-T"] if cmd == "ln" else []
    deny = await MountRootPolicy().pre_command(
        _ctx(cmd, [_path("/data")], argv))
    assert deny is not None
    assert needle in deny.reason
    # Every mount-root refusal is about one operand and speaks in the
    # command's own voice; the door renders `<cmd>: <reason>`.
    assert deny.scope is DenyScope.OPERAND
    assert render_deny(cmd, deny) == (f"{cmd}: {deny.reason}\n".encode(), 1)


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
    assert "Device or resource busy" in deny.reason


@pytest.mark.asyncio
async def test_ln_wording_follows_the_link_kind():
    # GNU words the refusal by link kind: ln -s says "symbolic link",
    # plain ln says "link" (pinned by integ guard_root_ln_is_eexist). A
    # mount root is only refused as the link NAME, which -T pins.
    policy = MountRootPolicy()
    deny = await policy.pre_command(
        _ctx("ln", [_path("/data/k.txt"), _path("/data")], ["-sT"]))
    assert deny is not None
    assert deny.reason == ("failed to create symbolic link "
                           "'/data': File exists")
    deny = await policy.pre_command(
        _ctx("ln", [_path("/data/k.txt"), _path("/data")], ["-T"]))
    assert deny is not None
    assert deny.reason == "failed to create link '/data': File exists"


def test_ln_flag_scan_honors_option_boundaries():
    assert has_no_target_flag(("-sT", "a", "b"))
    assert has_no_target_flag(("-s", "--no-target-directory", "a", "b"))
    assert not has_no_target_flag(("-s", "--", "-T", "/mnt"))
    assert not has_no_target_flag(("-SfooT", "a", "b"))
    assert not has_no_target_flag(("-S", "T", "a", "b"))
    assert not has_no_target_flag(("--suffix", "T", "a", "b"))
    assert not has_no_target_flag(("-t", "T", "a"))
    assert has_symlink_flag(("-bs", "a", "b"))
    assert not has_symlink_flag(("-S", "s", "a", "b"))
    assert not has_symlink_flag(("--", "-s", "b"))


def test_has_parents_flag_spots_the_shorthand_cluster():
    assert has_parents_flag(("-p", ))
    assert has_parents_flag(("--parents", ))
    assert has_parents_flag(("-pv", ))
    assert not has_parents_flag(("--print", ))
    assert not has_parents_flag(("x", "-r"))


@pytest.mark.parametrize("cmd,needle", [
    ("tar", "tar: /data: Cannot open: Device or resource busy\n"
     "tar: Error is not recoverable: exiting now\n"),
    ("zip", "zip: cannot read '/data': Device or resource busy\n"),
    ("cp", "cp: cannot copy '/data': Device or resource busy\n"),
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
    assert render_deny(cmd, deny)[0] == needle.encode()


@pytest.mark.asyncio
async def test_tar_refusal_names_the_operand_as_typed_and_exits_two():
    deny = await MountRootPolicy().pre_command(
        _ctx("tar", [_path("/data", raw=".")], argv=["-cf", "/out.tar"]))
    assert deny is not None
    err, code = render_deny("tar", deny)
    assert b"tar: .: Cannot open" in err
    assert b"Error is not recoverable" in err
    # tar's fatal-error code, from the operand-exit table, not from the
    # policy: a Deny carries no number.
    assert code == 2


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
