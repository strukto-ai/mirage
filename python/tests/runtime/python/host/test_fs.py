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

import errno
import inspect
import os
import shutil
import stat as stat_mod
import sys
from pathlib import Path

import pytest

from mirage import MountMode, Workspace
from mirage.context import set_current_session
from mirage.errors.posix import posix_errno
from mirage.policy import Deny, Policy
from mirage.runtime.python.host.constants import (
    DESCRIPTOR_CALLS,
    REFUSED_CALLS,
    REFUSED_DESCRIPTOR_CALLS,
    ROUTED_CALLS,
)
from mirage.runtime.python.host.fs import HostFs, make_os_module, os_routing
from mirage.types import HiddenPaths, PathSpec, Visibility
from mirage.utils.stat_view import DIR_SIZE
from mirage.vfs.disk import DiskVFS
from mirage.vfs.ram import RAMVFS
from tests.fixtures.driver_ops import ops as driver_ops
from tests.fixtures.vfs_io import render

from .conftest import make_ops_with_dir, run


async def _shell(ws, line):
    result = await ws.shell(line)
    return result.exit_code, await result.stdout_str()


INSTALLED_CALLS = (
    *ROUTED_CALLS,
    *REFUSED_CALLS,
    *DESCRIPTOR_CALLS,
    *REFUSED_DESCRIPTOR_CALLS,
)

# The parameter names os gives a descriptor argument.
FD_PARAMS = frozenset({"fd", "fd2", "fd_low", "in_fd", "out_fd", "src", "dst"})

# The descriptor calls a mounted descriptor leaves to the host: the pipe
# it holds answers them truly (no terminal, its own flags), and none of
# them reads or writes a file.
HOST_FD_CALLS = frozenset(
    {
        "closerange",
        "device_encoding",
        "eventfd_read",
        "eventfd_write",
        "get_blocking",
        "get_inheritable",
        "grantpt",
        "isatty",
        "login_tty",
        "ptsname",
        "set_blocking",
        "set_inheritable",
        "setns",
        "tcgetpgrp",
        "tcsetpgrp",
        "timerfd_gettime",
        "timerfd_gettime_ns",
        "timerfd_settime",
        "timerfd_settime_ns",
        "ttyname",
        "unlockpt",
    }
)


class _NoStats(Policy):
    async def pre_vfs(self, ctx):
        return Deny("no stat") if ctx.call.name == "stat" else None


async def _read_tally(accessor, path: PathSpec, **kwargs) -> bytes:
    return b"RENDERED"


async def _refuse_tally(accessor, path: PathSpec, **kwargs) -> bytes:
    raise PermissionError(errno.EACCES, "no rendering")


class _NoReads(Policy):
    async def pre_vfs(self, ctx):
        return Deny("no read") if ctx.call.name == "read" else None


def seeded():
    """An ops facade over /data with one file and one subdirectory."""
    ops, _ = make_ops_with_dir()
    run(ops.write("/data/dir/a.txt", b"hello"))
    run(ops.mkdir("/data/dir/sub"))
    run(ops.write("/data/dir/sub/c.txt", b"c"))
    return ops, make_os_module(ops)


class TestTableInstall:
    def test_every_routed_verb_the_host_has_is_installed(self):
        ops, patched = seeded()
        for verb in (*ROUTED_CALLS, *DESCRIPTOR_CALLS):
            if not hasattr(os, verb):
                continue
            assert getattr(patched, verb) is not getattr(os, verb), verb

    def test_every_refused_verb_the_host_has_is_installed(self):
        ops, patched = seeded()
        for verb in REFUSED_CALLS:
            if not hasattr(os, verb):
                continue
            assert getattr(patched, verb) is not getattr(os, verb), verb

    def test_every_other_name_keeps_the_host_function(self):
        ops, patched = seeded()
        installed = {*INSTALLED_CALLS, "path"}
        for name, value in vars(os).items():
            if name not in installed:
                assert getattr(patched, name) is value, name

    def test_a_name_this_platform_lacks_is_not_invented(self):
        # hasattr(os, ...) has to keep answering what it did, or code
        # that probes for a platform feature gets an OSError instead.
        ops, patched = seeded()
        for verb in INSTALLED_CALLS:
            assert hasattr(patched, verb) is hasattr(os, verb), verb

    def test_routing_covers_the_tables(self):
        ops, _ = seeded()
        routed = os_routing(HostFs(ops, None))
        expected = {verb for verb in INSTALLED_CALLS if hasattr(os, verb)}
        assert set(routed) == expected

    def test_every_descriptor_call_is_classified(self):
        # A call that takes a descriptor and sits in no table reaches the
        # pipe a mounted one holds, so a Python release that adds one
        # fails here first; node's call tables have the same test.
        tables = (
            DESCRIPTOR_CALLS,
            set(REFUSED_DESCRIPTOR_CALLS),
            HOST_FD_CALLS,
        )
        for name, value in vars(os).items():
            if name in ROUTED_CALLS or name in REFUSED_CALLS:
                continue
            if not callable(value) or isinstance(value, type):
                continue
            try:
                params = inspect.signature(value).parameters
            except (TypeError, ValueError):
                continue
            if FD_PARAMS.isdisjoint(params):
                continue
            assert sum(name in table for table in tables) == 1, name

    def test_refused_descriptor_params_are_the_os_names(self):
        # A descriptor passed by name is found by these names, so one
        # that drifted from os's own would let that spelling reach the
        # pipe a mounted descriptor holds.
        for verb, params in REFUSED_DESCRIPTOR_CALLS.items():
            if not hasattr(os, verb):
                continue
            names = list(inspect.signature(getattr(os, verb)).parameters)
            assert names[: len(params)] == list(params), verb


class TestStatShape:
    def test_stat_is_a_real_stat_result(self):
        _, patched = seeded()
        st = patched.stat("/data/dir/a.txt")
        assert isinstance(st, os.stat_result)
        assert stat_mod.S_ISREG(st.st_mode)
        assert st.st_size == 5
        assert st.st_nlink == 1

    def test_a_directory_stats_as_one(self):
        _, patched = seeded()
        st = patched.stat("/data/dir")
        assert stat_mod.S_ISDIR(st.st_mode)
        assert st.st_size == DIR_SIZE

    def test_optional_fields_are_filled_not_none(self):
        # shutil.copystat reads st_flags when the platform has it, and
        # a None there is handed straight to the host's chflags.
        _, patched = seeded()
        st = patched.stat("/data/dir/a.txt")
        assert st.st_mtime_ns == int(st.st_mtime * 1_000_000_000)
        assert st.st_blksize == 4096
        assert st.st_blocks == 1
        for field in ("st_flags", "st_gen", "st_birthtime"):
            if hasattr(os.stat("/tmp"), field):
                assert getattr(st, field) is not None, field

    def test_an_unlinked_descriptor_keeps_every_field(self):
        _, patched = seeded()
        fd = patched.open("/data/dir/a.txt", os.O_RDONLY)
        patched.unlink("/data/dir/a.txt")
        st = patched.fstat(fd)
        patched.close(fd)
        assert (st.st_nlink, st.st_size, st.st_blksize) == (0, 5, 4096)
        assert st.st_mtime_ns == int(st.st_mtime * 1_000_000_000)

    def test_two_paths_are_not_the_same_file(self):
        _, patched = seeded()
        assert patched.path.samefile("/data/dir/a.txt", "/data/dir/a.txt")
        assert not patched.path.samefile("/data/dir/a.txt", "/data/dir/sub")

    def test_a_mount_root_is_a_mount_point(self):
        _, patched = seeded()
        assert patched.path.ismount("/data") is True
        assert patched.path.ismount("/data/dir") is False

    def test_the_same_path_stats_the_same_twice(self):
        # A synthesized mtime that moved per call fires every "did it
        # change?" heuristic there is.
        _, patched = seeded()
        first = patched.stat("/data/dir/a.txt")
        assert patched.stat("/data/dir/a.txt").st_mtime == first.st_mtime


class TestReads:
    def test_listdir(self):
        _, patched = seeded()
        assert sorted(patched.listdir("/data/dir")) == ["a.txt", "sub"]

    def test_scandir_entries_classify_by_stat(self):
        _, patched = seeded()
        with patched.scandir("/data/dir") as it:
            kinds = {
                e.name: (e.is_dir(), e.is_file(), e.is_symlink()) for e in it
            }
        assert kinds == {
            "a.txt": (False, True, False),
            "sub": (True, False, False),
        }

    def test_scandir_entry_carries_path_and_stat(self):
        _, patched = seeded()
        entry = next(
            e for e in patched.scandir("/data/dir") if e.name == "a.txt"
        )
        assert entry.path == "/data/dir/a.txt"
        assert os.fspath(entry) == "/data/dir/a.txt"
        assert entry.stat().st_size == 5
        assert entry.inode() == patched.stat("/data/dir/a.txt").st_ino

    def test_walk_is_post_order_when_asked(self):
        _, patched = seeded()
        seen = [
            (top, sorted(dirs), sorted(files))
            for top, dirs, files in patched.walk("/data/dir", topdown=False)
        ]
        assert seen == [
            ("/data/dir/sub", [], ["c.txt"]),
            ("/data/dir", ["sub"], ["a.txt"]),
        ]

    def test_walk_lets_a_topdown_caller_prune(self):
        _, patched = seeded()
        tops = []
        for top, dirs, _ in patched.walk("/data/dir"):
            tops.append(top)
            dirs[:] = []
        assert tops == ["/data/dir"]

    def test_walk_reports_a_listing_error_and_prunes(self):
        _, patched = seeded()
        errors = []
        seen = list(patched.walk("/data/dir/nope", onerror=errors.append))
        assert seen == []
        assert [type(exc) for exc in errors] == [FileNotFoundError]

    def test_path_predicates_route(self):
        _, patched = seeded()
        assert patched.path.exists("/data/dir/a.txt") is True
        assert patched.path.exists("/data/dir/nope") is False
        assert patched.path.isfile("/data/dir/a.txt") is True
        assert patched.path.isdir("/data/dir") is True
        assert patched.path.getsize("/data/dir/a.txt") == 5
        assert patched.path.getmtime("/data/dir/a.txt") > 0

    def test_access_reads_existence_mount_mode_and_bits(self):
        ops, patched = seeded()
        assert patched.access("/data/dir/a.txt", os.F_OK) is True
        assert patched.access("/data/dir/nope", os.F_OK) is False
        assert patched.access("/data/dir/a.txt", os.R_OK) is True
        assert patched.access("/data/dir/a.txt", os.W_OK) is True
        assert patched.access("/data/dir/a.txt", os.X_OK) is False
        assert patched.access("/data/dir", os.X_OK) is True

    def test_access_refuses_write_on_a_read_only_mount(self):
        vfs = RAMVFS()
        run(driver_ops(vfs).write(PathSpec.from_str_path("/fixed.txt"), b"ro"))
        ws = Workspace({"/ro/": (vfs, MountMode.READ)}, mode=MountMode.WRITE)
        patched = make_os_module(ws.vfs)
        assert patched.access("/ro/fixed.txt", os.R_OK) is True
        assert patched.access("/ro/fixed.txt", os.W_OK) is False

    def test_access_answers_write_from_the_sessions_mode(self):
        # W_OK answers what the write itself meets, for the session the
        # files run as (here the default one, bound by no one): a cap to
        # read is refused, a writable show entry below it is not, and a
        # link answers for where it leads unless it is not followed.
        ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
        run(ws.vfs.write("/data/f.txt", b"f"))
        run(ws.vfs.mkdir("/data/out"))
        run(ws.vfs.write("/data/out/g.txt", b"g"))
        run(ws.vfs.symlink("/data/link", "/data/out/g.txt"))
        patched = make_os_module(ws.vfs)
        assert patched.access("/data/f.txt", os.W_OK) is True
        run(
            ws.set_session_profile(
                ws.default_session_id,
                {
                    "mounts": {"/data": "read"},
                    "paths": {"show": {"/data/out": "rw"}},
                },
            )
        )
        assert patched.access("/data/f.txt", os.W_OK) is False
        assert patched.access("/data/f.txt", os.R_OK) is True
        assert patched.access("/data/out/g.txt", os.W_OK) is True
        assert patched.access("/data/link", os.W_OK) is True
        assert (
            patched.access("/data/link", os.W_OK, follow_symlinks=False)
            is False
        )


class TestWrites:
    def test_mkdir_and_rmdir(self):
        ops, patched = seeded()
        patched.mkdir("/data/dir/fresh")
        assert patched.path.isdir("/data/dir/fresh") is True
        patched.rmdir("/data/dir/fresh")
        assert patched.path.isdir("/data/dir/fresh") is False

    def test_makedirs_creates_every_missing_ancestor(self):
        _, patched = seeded()
        patched.makedirs("/data/deep/x/y")
        assert patched.path.isdir("/data/deep") is True
        assert patched.path.isdir("/data/deep/x") is True
        assert patched.path.isdir("/data/deep/x/y") is True

    def test_makedirs_honors_exist_ok(self):
        _, patched = seeded()
        patched.makedirs("/data/deep/x")
        with pytest.raises(FileExistsError) as caught:
            patched.makedirs("/data/deep/x")
        assert caught.value.errno == errno.EEXIST
        patched.makedirs("/data/deep/x", exist_ok=True)

    def test_makedirs_still_refuses_a_file_in_the_way(self):
        _, patched = seeded()
        with pytest.raises(FileExistsError):
            patched.makedirs("/data/dir/a.txt", exist_ok=True)

    def test_makedirs_raises_what_a_stat_refused(self):
        # A refused stat is not a missing directory: makedirs used to walk
        # past it and answer EEXIST from a mkdir it should never have tried.
        ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
        run(ws.vfs.mkdir("/data/dir"))
        ws.policies.add(_NoStats())
        patched = make_os_module(ws.vfs)
        with pytest.raises(PermissionError):
            patched.makedirs("/data/dir/x/y")

    def test_removedirs_prunes_the_parents_that_empty(self):
        _, patched = seeded()
        patched.makedirs("/data/deep/x/y")
        patched.removedirs("/data/deep/x/y")
        assert patched.path.isdir("/data/deep") is False

    def test_rmdir_refuses_a_mount_root_as_busy(self):
        ws = Workspace(
            {"/data/": RAMVFS(), "/data/m/": RAMVFS()}, mode=MountMode.WRITE
        )
        patched = make_os_module(ws.vfs)
        for root in ("/data/m", "/data"):
            with pytest.raises(OSError) as caught:
                patched.rmdir(root)
            assert caught.value.errno == errno.EBUSY
        assert patched.path.isdir("/data/m") is True

    def test_remove_and_unlink_are_one_op(self):
        ops, patched = seeded()
        patched.remove("/data/dir/a.txt")
        assert patched.path.exists("/data/dir/a.txt") is False
        run(ops.write("/data/dir/a.txt", b"again"))
        patched.unlink("/data/dir/a.txt")
        assert patched.path.exists("/data/dir/a.txt") is False

    def test_rename_within_the_mount(self):
        _, patched = seeded()
        patched.rename("/data/dir/a.txt", "/data/dir/b.txt")
        assert sorted(patched.listdir("/data/dir")) == ["b.txt", "sub"]

    def test_replace_reaches_the_same_op(self):
        _, patched = seeded()
        patched.replace("/data/dir/a.txt", "/data/dir/b.txt")
        assert patched.path.exists("/data/dir/b.txt") is True

    def test_renames_creates_the_destination_parents(self):
        _, patched = seeded()
        patched.renames("/data/dir/sub/c.txt", "/data/other/deep/c.txt")
        assert patched.path.exists("/data/other/deep/c.txt") is True
        assert patched.path.isdir("/data/dir/sub") is False

    def test_renames_keeps_a_source_parent_that_still_holds_entries(self):
        # CPython's renames leaves a parent that will not prune.
        _, patched = seeded()
        patched.renames("/data/dir/a.txt", "/data/b.txt")
        assert patched.path.exists("/data/b.txt") is True
        assert sorted(patched.listdir("/data/dir")) == ["sub"]

    def test_a_rename_off_the_mount_is_exdev(self, tmp_path):
        _, patched = seeded()
        with pytest.raises(OSError) as caught:
            patched.rename("/data/dir/a.txt", str(tmp_path / "a.txt"))
        assert caught.value.errno == errno.EXDEV
        assert patched.path.exists("/data/dir/a.txt") is True

    def test_a_rename_onto_the_mount_is_exdev(self, tmp_path):
        _, patched = seeded()
        source = tmp_path / "host.txt"
        source.write_text("host")
        with pytest.raises(OSError) as caught:
            patched.rename(str(source), "/data/dir/host.txt")
        assert caught.value.errno == errno.EXDEV
        assert source.exists() is True

    def test_truncate(self):
        _, patched = seeded()
        patched.truncate("/data/dir/a.txt", 2)
        assert patched.path.getsize("/data/dir/a.txt") == 2

    def test_chmod_is_visible_to_stat(self):
        _, patched = seeded()
        patched.chmod("/data/dir/a.txt", 0o600)
        assert (
            stat_mod.S_IMODE(patched.stat("/data/dir/a.txt").st_mode) == 0o600
        )

    def test_chown_leaves_minus_one_alone(self):
        _, patched = seeded()
        patched.chown("/data/dir/a.txt", 4242, -1)
        assert patched.stat("/data/dir/a.txt").st_uid == 4242

    def test_utime_takes_seconds_and_nanoseconds(self):
        _, patched = seeded()
        patched.utime("/data/dir/a.txt", (1_700_000_000, 1_700_000_123))
        assert patched.stat("/data/dir/a.txt").st_mtime == 1_700_000_123
        patched.utime("/data/dir/a.txt", ns=(0, 1_700_000_456_000_000_000))
        assert patched.stat("/data/dir/a.txt").st_mtime == 1_700_000_456

    def test_utime_refuses_both_spellings_at_once(self):
        _, patched = seeded()
        with pytest.raises(ValueError):
            patched.utime("/data/dir/a.txt", (1, 2), ns=(3, 4))


class TestLinks:
    def test_symlink_stores_the_target_verbatim(self):
        _, patched = seeded()
        patched.symlink("a.txt", "/data/dir/link")
        assert patched.readlink("/data/dir/link") == "a.txt"

    def test_lstat_reports_the_link_itself(self):
        _, patched = seeded()
        patched.symlink("a.txt", "/data/dir/link")
        st = patched.lstat("/data/dir/link")
        assert stat_mod.S_ISLNK(st.st_mode)
        assert st.st_size == len("a.txt")
        assert patched.path.islink("/data/dir/link") is True
        assert patched.path.islink("/data/dir/a.txt") is False

    def test_lstat_reports_what_chown_h_wrote_on_the_link(self):
        _, patched = seeded()
        patched.symlink("a.txt", "/data/dir/link")
        patched.lchown("/data/dir/link", 4242, 4343)
        st = patched.lstat("/data/dir/link")
        # The link's own row, not the process defaults: chown -h writes
        # ownership onto the node and ls -l shows it, so lstat must too.
        assert (st.st_uid, st.st_gid) == (4242, 4343)
        assert stat_mod.S_ISLNK(st.st_mode)
        assert st.st_size == len("a.txt")

    def test_utime_on_a_link_leaves_its_target(self):
        _, patched = seeded()
        before = patched.stat("/data/dir/a.txt").st_mtime
        patched.symlink("a.txt", "/data/dir/link")
        patched.utime("/data/dir/link", (100, 200), follow_symlinks=False)
        assert patched.lstat("/data/dir/link").st_mtime == 200
        assert patched.stat("/data/dir/a.txt").st_mtime == before

    def test_a_descriptor_changes_the_mode_and_owner_of_its_file(self):
        _, patched = seeded()
        fd = patched.open("/data/dir/a.txt", os.O_RDWR)
        try:
            patched.fchmod(fd, 0o600)
            patched.fchown(fd, 4242, 4343)
        finally:
            patched.close(fd)
        st = patched.stat("/data/dir/a.txt")
        assert (stat_mod.S_IMODE(st.st_mode), st.st_uid, st.st_gid) == (
            0o600,
            4242,
            4343,
        )

    def test_a_link_stays_lrwxrwxrwx_after_chmod_h(self):
        _, patched = seeded()
        patched.symlink("a.txt", "/data/dir/link")
        patched.chmod("/data/dir/link", 0o600, follow_symlinks=False)
        st = patched.lstat("/data/dir/link")
        # No POSIX system consults the bits on a symlink, so the overlay
        # mode is stored but never reported for one.
        assert stat_mod.S_IMODE(st.st_mode) == 0o777
        assert stat_mod.S_ISLNK(st.st_mode)

    def test_stat_follows_the_link(self):
        _, patched = seeded()
        patched.symlink("a.txt", "/data/dir/link")
        assert patched.stat("/data/dir/link").st_size == 5
        assert patched.path.realpath("/data/dir/link") == "/data/dir/a.txt"

    def test_a_broken_link_lstats_and_does_not_exist(self):
        _, patched = seeded()
        patched.symlink("gone.txt", "/data/dir/broken")
        assert stat_mod.S_ISLNK(patched.lstat("/data/dir/broken").st_mode)
        assert patched.path.exists("/data/dir/broken") is False
        assert patched.path.lexists("/data/dir/broken") is True

    def test_readlink_of_a_plain_file_is_einval(self):
        _, patched = seeded()
        with pytest.raises(OSError) as caught:
            patched.readlink("/data/dir/a.txt")
        assert caught.value.errno == errno.EINVAL

    def test_readlink_of_a_missing_path_is_enoent(self):
        # The other half of readlink(2)'s split, and the half a caller's
        # `except FileNotFoundError` is written against: EINVAL for both
        # meant that clause never fired.
        _, patched = seeded()
        with pytest.raises(FileNotFoundError) as caught:
            patched.readlink("/data/dir/gone.txt")
        assert caught.value.errno == errno.ENOENT

    def test_lstat_of_a_missing_path_stays_enoent(self):
        # lstat probes readlink first, so the ENOENT above has to reach
        # the caller rather than being read as "not a link".
        _, patched = seeded()
        with pytest.raises(FileNotFoundError):
            patched.lstat("/data/dir/gone.txt")
        assert patched.path.islink("/data/dir/gone.txt") is False
        assert patched.path.lexists("/data/dir/gone.txt") is False

    def test_readlink_off_the_mount_answers_as_the_caller_spelled_it(
        self, tmp_path
    ):
        _, patched = seeded()
        target = tmp_path / "target.txt"
        target.write_text("t")
        link = tmp_path / "link"
        link.symlink_to(target)
        # A bytes path is a host spelling no mount serves, and
        # os.readlink answers one with bytes; coercing it with str()
        # handed back "b'/tmp/...'".
        assert patched.readlink(str(link)) == str(target)
        assert patched.readlink(os.fsencode(link)) == os.fsencode(target)

    def test_walk_survives_a_broken_link(self):
        # Classifying it means following it, which raises; os.walk reads
        # that as "not a directory" rather than ending the walk.
        _, patched = seeded()
        patched.symlink("gone.txt", "/data/dir/broken")
        seen = [
            (top, sorted(files)) for top, _, files in patched.walk("/data/dir")
        ]
        assert seen == [
            ("/data/dir", ["a.txt", "broken"]),
            ("/data/dir/sub", ["c.txt"]),
        ]

    def test_walk_lists_a_link_to_a_directory_without_entering_it(self):
        _, patched = seeded()
        patched.symlink("/data/dir/sub", "/data/dir/subs")
        tops = [top for top, _, _ in patched.walk("/data/dir")]
        assert tops == ["/data/dir", "/data/dir/sub"]
        tops = [
            top for top, _, _ in patched.walk("/data/dir", followlinks=True)
        ]
        assert sorted(tops) == ["/data/dir", "/data/dir/sub", "/data/dir/subs"]


@pytest.mark.skipif(
    not hasattr(os, "setxattr"), reason="the xattr family is linux only"
)
class TestXattrs:
    def test_the_family_routes_through_the_node_table(self):
        _, patched = seeded()
        patched.setxattr("/data/dir/a.txt", "user.b", b"two")
        patched.setxattr("/data/dir/a.txt", b"user.a", b"one")
        assert patched.listxattr("/data/dir/a.txt") == ["user.a", "user.b"]
        assert patched.getxattr("/data/dir/a.txt", "user.a") == b"one"
        patched.removexattr("/data/dir/a.txt", "user.b")
        assert patched.listxattr("/data/dir/a.txt") == ["user.a"]

    def test_flags_and_a_missing_name_answer_linux_errnos(self):
        _, patched = seeded()
        patched.setxattr("/data/dir/a.txt", "user.a", b"one")
        with pytest.raises(FileExistsError):
            patched.setxattr(
                "/data/dir/a.txt", "user.a", b"x", os.XATTR_CREATE
            )
        with pytest.raises(OSError) as caught:
            patched.setxattr(
                "/data/dir/a.txt", "user.q", b"x", os.XATTR_REPLACE
            )
        assert caught.value.errno == errno.ENODATA
        with pytest.raises(OSError) as missing:
            patched.getxattr("/data/dir/a.txt", "user.q")
        assert missing.value.errno == errno.ENODATA


class TestRefusals:
    @pytest.mark.parametrize("verb", sorted(REFUSED_CALLS))
    def test_a_refused_verb_answers_its_condition(self, verb):
        if not hasattr(os, verb):
            pytest.skip(f"{verb} is not a name this platform has")
        _, patched = seeded()
        with pytest.raises(OSError) as caught:
            getattr(patched, verb)("/data/dir/a.txt", *_extra_args(verb))
        assert caught.value.errno == posix_errno(REFUSED_CALLS[verb])

    def test_a_refused_verb_still_serves_a_host_path(self, tmp_path):
        _, patched = seeded()
        target = tmp_path / "a.txt"
        target.write_text("host")
        assert patched.statvfs(str(tmp_path)).f_bsize > 0

    def test_link_refuses_when_either_end_is_mounted(self, tmp_path):
        _, patched = seeded()
        host = tmp_path / "host.txt"
        host.write_text("host")
        with pytest.raises(OSError) as caught:
            patched.link(str(host), "/data/dir/hard")
        assert caught.value.errno == errno.EPERM


def _extra_args(verb):
    """The non-path arguments a refused verb needs to be callable."""
    return {
        "chflags": (0,),
        "lchflags": (0,),
        "link": ("/data/dir/hard",),
        "mkfifo": (),
        "mknod": (),
    }.get(verb, ())


class TestDescriptors:
    def test_a_policy_that_refuses_reads_still_lets_an_open_file_go(self):
        ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
        run(ws.vfs.write("/data/f.txt", b"body"))
        ws.policies.add(_NoReads())
        patched = make_os_module(ws.vfs)
        fd = patched.open("/data/f.txt", os.O_WRONLY)
        patched.unlink("/data/f.txt")
        patched.close(fd)
        assert not patched.path.exists("/data/f.txt")

    def test_a_read_refused_as_its_name_goes_fails_the_reads_after(self):
        # The removal goes ahead, but the bytes it could not keep are not
        # an empty file: the reads after it report the refusal.
        ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
        run(ws.vfs.write("/data/f.txt", b"body"))
        patched = make_os_module(ws.vfs)
        fd = patched.open("/data/f.txt", os.O_RDONLY)
        ws.policies.add(_NoReads())
        patched.unlink("/data/f.txt")
        with pytest.raises(PermissionError):
            patched.read(fd, 4)
        patched.close(fd)
        assert not patched.path.exists("/data/f.txt")

    def test_a_reader_keeps_the_rendering_of_a_removed_file(self):
        # A writable open beside it reads the stored bytes, and the reader
        # still sees what the mount renders, as it did before the removal.
        ws = Workspace(
            {"/data/": render(RAMVFS(), ".tally", _read_tally)},
            mode=MountMode.WRITE,
        )
        run(ws.vfs.write("/data/b.tally", b"STORED"))
        patched = make_os_module(ws.vfs)
        reader = patched.open("/data/b.tally", os.O_RDONLY)
        writer = patched.open("/data/b.tally", os.O_RDWR)
        patched.unlink("/data/b.tally")
        assert patched.read(reader, 8) == b"RENDERED"
        assert patched.read(writer, 6) == b"STORED"
        patched.close(reader)
        patched.close(writer)

    def test_a_failed_rendering_leaves_a_writer_its_stored_bytes(self):
        # Only the reader of the rendering reports it could not be read.
        ws = Workspace(
            {"/data/": render(RAMVFS(), ".tally", _refuse_tally)},
            mode=MountMode.WRITE,
        )
        run(ws.vfs.write("/data/b.tally", b"STORED"))
        patched = make_os_module(ws.vfs)
        reader = patched.open("/data/b.tally", os.O_RDONLY)
        writer = patched.open("/data/b.tally", os.O_RDWR)
        patched.unlink("/data/b.tally")
        assert patched.read(writer, 6) == b"STORED"
        with pytest.raises(PermissionError):
            patched.read(reader, 6)
        patched.close(reader)
        patched.close(writer)

    def test_a_write_only_handle_leaves_a_reader_its_rendering(self):
        # The writer lands on the stored bytes, not on the rendering the
        # reader keeps.
        ws = Workspace(
            {"/data/": render(RAMVFS(), ".tally", _read_tally)},
            mode=MountMode.WRITE,
        )
        run(ws.vfs.write("/data/b.tally", b"STORED"))
        patched = make_os_module(ws.vfs)
        reader = patched.open("/data/b.tally", os.O_RDONLY)
        writer = patched.open("/data/b.tally", os.O_WRONLY)
        patched.unlink("/data/b.tally")
        patched.write(writer, b"X")
        patched.fsync(writer)
        assert patched.read(reader, 8) == b"RENDERED"
        patched.close(reader)
        patched.close(writer)

    def test_a_rename_onto_its_own_name_keeps_the_descriptor(self):
        ops, patched = seeded()
        fd = patched.open("/data/dir/a.txt", os.O_RDWR)
        patched.write(fd, b"J")
        patched.rename("/data/dir/a.txt", "/data/dir/a.txt")
        patched.close(fd)
        assert run(ops.read("/data/dir/a.txt")) == b"Jello"

    def test_fdopen_opens_a_descriptor_as_io_open_does(self):
        ops, patched = seeded()
        fd = patched.open("/data/dir/a.txt", os.O_RDWR | os.O_APPEND)
        with patched.fdopen(fd, "a+b", 0) as f:
            assert (f.tell(), f.truncate()) == (5, 5)
        fd = patched.open("/data/dir/a.txt", os.O_RDONLY)
        with patched.fdopen(fd, "r+b", 0) as f:
            assert f.read() == b"hello"
        assert run(ops.read("/data/dir/a.txt")) == b"hello"

    def test_an_appending_write_leaves_the_position_past_it(self):
        ops, patched = seeded()
        fd = patched.open("/data/dir/a.txt", os.O_RDWR | os.O_APPEND)
        patched.lseek(fd, 0, os.SEEK_SET)
        patched.write(fd, b"!")
        assert patched.lseek(fd, 0, os.SEEK_CUR) == 6
        assert patched.read(fd, 10) == b""
        patched.close(fd)
        assert run(ops.read("/data/dir/a.txt")) == b"hello!"

    def test_an_append_that_cannot_find_its_end_writes_nothing(self):
        ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
        run(ws.vfs.write("/data/log", b"abc"))
        patched = make_os_module(ws.vfs)
        fd = patched.open("/data/log", os.O_WRONLY | os.O_APPEND)
        ws.policies.add(_NoStats())
        with pytest.raises(PermissionError):
            patched.write(fd, b"X")
        patched.close(fd)
        assert run(ws.vfs.read("/data/log")) == b"abc"

    def test_a_host_path_keeps_a_host_descriptor(self, tmp_path):
        _, patched = seeded()
        target = tmp_path / "a.txt"
        fd = patched.open(str(target), os.O_WRONLY | os.O_CREAT)
        patched.write(fd, b"host")
        patched.close(fd)
        assert target.read_bytes() == b"host"


class TestProcessPatch:
    def test_a_module_level_import_routes_inside_the_block(self):
        ws = Workspace({"/mem/": RAMVFS()}, mode=MountMode.WRITE)
        run(ws.vfs.mkdir("/mem/dir"))
        run(ws.vfs.write("/mem/dir/a.txt", b"a"))
        host_listdir = os.listdir
        with ws:
            # `os` here is the module this test file imported before the
            # block opened, which is the whole point: a sys.modules swap
            # would never have reached it.
            assert os.listdir is not host_listdir
            assert os.listdir("/mem/dir") == ["a.txt"]
            assert os.path.exists("/mem/dir/a.txt") is True
        assert os.listdir is host_listdir
        assert sys.modules["os"] is os

    def test_pathlib_predicates_answer_false_for_a_missing_path(self):
        # pathlib reads the errno to tell missing from broken, so a
        # backend's bare FileNotFoundError used to escape `exists()`.
        ws = Workspace({"/mem/": RAMVFS()}, mode=MountMode.WRITE)
        with ws:
            missing = Path("/mem/nope.txt")
            assert missing.exists() is False
            assert missing.is_file() is False
            assert missing.is_dir() is False
            with pytest.raises(FileNotFoundError) as caught:
                os.stat("/mem/nope.txt")
        assert caught.value.errno == errno.ENOENT
        assert caught.value.filename == "/mem/nope.txt"

    def test_a_runtime_command_inside_the_block_shares_its_files(self):
        # A command runs with the patch transparent (its mount op holds
        # host_io), so the guest reaches the workspace through its own
        # file adapter while the block's code reaches it through the patch.
        ws = Workspace({"/mem/": RAMVFS()}, mode=MountMode.EXEC)
        with ws:
            Path("/mem/host.txt").write_text("from host")
            result = run(
                _shell(
                    ws,
                    "python3 -c \"print(open('/mem/host.txt').read()); "
                    "open('/mem/guest.txt', 'w').write('from guest')\"",
                )
            )
            assert result == (0, "from host\n")
            assert Path("/mem/guest.txt").read_text() == "from guest"

    def test_pathlib_routes_for_content_and_metadata(self):
        ws = Workspace({"/mem/": RAMVFS()}, mode=MountMode.WRITE)
        run(ws.vfs.mkdir("/mem/dir"))
        run(ws.vfs.write("/mem/dir/a.txt", b"hello"))
        with ws:
            path = Path("/mem/dir/a.txt")
            assert path.exists() is True
            assert path.read_text() == "hello"
            assert path.stat().st_size == 5
            assert sorted(p.name for p in Path("/mem/dir").iterdir()) == [
                "a.txt"
            ]
            Path("/mem/dir/written.txt").write_text("written")
            assert Path("/mem/dir/written.txt").read_text() == "written"

    def test_the_call_pathlib_actually_makes_routes(self):
        # pathlib does not call the builtin: it calls io.open, and it
        # passes the "locale" sentinel for the encoding on any
        # interpreter that is not in UTF-8 mode, which is the normal
        # case. This is that call, spelled out.
        ws = Workspace({"/mem/": RAMVFS()}, mode=MountMode.WRITE)
        run(ws.vfs.write("/mem/a.txt", b"hello"))
        with ws:
            with open("/mem/a.txt", "r", -1, "locale", None, None) as f:
                assert f.read() == "hello"

    def test_shutil_copies_across_the_boundary(self, tmp_path):
        ws = Workspace({"/mem/": RAMVFS()}, mode=MountMode.WRITE)
        run(ws.vfs.mkdir("/mem/dir"))
        run(ws.vfs.write("/mem/dir/a.txt", b"hello"))
        with ws:
            out = tmp_path / "copied.txt"
            shutil.copy("/mem/dir/a.txt", str(out))
            assert out.read_text() == "hello"
            shutil.copy(str(out), "/mem/dir/back.txt")
            assert os.path.getsize("/mem/dir/back.txt") == 5

    def test_a_hidden_path_reads_as_absent_through_os(self):
        ws = Workspace({"/mem/": RAMVFS()}, mode=MountMode.WRITE)
        run(ws.vfs.write("/mem/open.txt", b"public"))
        run(ws.vfs.mkdir("/mem/secrets"))
        run(ws.vfs.write("/mem/secrets/token.txt", b"s3cret"))
        session = ws.create_session("agent")
        session.visibility = Visibility(
            paths=HiddenPaths(paths=("/mem/secrets",), patterns=("*.key",))
        )
        run(ws.vfs.write("/mem/note.key", b"key"))
        with ws:
            set_current_session(session)
            try:
                assert os.listdir("/mem") == ["open.txt"]
                assert os.path.exists("/mem/secrets") is False
                assert os.path.exists("/mem/note.key") is False
                with pytest.raises(FileNotFoundError):
                    os.stat("/mem/secrets/token.txt")
            finally:
                set_current_session(None)

    def test_a_hidden_link_is_absent_through_lstat(self):
        # lstat reads the link's row off the node table, so the gate has
        # to be the readlink probe in front of it: the table itself has
        # no session.
        ws = Workspace({"/mem/": RAMVFS()}, mode=MountMode.WRITE)
        run(ws.vfs.write("/mem/a.txt", b"hello"))
        session = ws.create_session("agent")
        session.visibility = Visibility(
            paths=HiddenPaths(paths=(), patterns=("*.key",))
        )
        with ws:
            os.symlink("a.txt", "/mem/secret.key")
            os.lchown("/mem/secret.key", 4242, 4343)
            set_current_session(session)
            try:
                assert os.listdir("/mem") == ["a.txt"]
                assert os.path.islink("/mem/secret.key") is False
                with pytest.raises(FileNotFoundError):
                    os.lstat("/mem/secret.key")
            finally:
                set_current_session(None)

    def test_a_disk_mount_still_reaches_its_own_host_files(self, tmp_path):
        # The patch is process-wide, so the disk backend's own os calls
        # go through it too; they name host paths under the VFS
        # root, which no mount owns, and fall through.
        root = tmp_path / "root"
        root.mkdir()
        (root / "f.txt").write_text("on disk")
        ws = Workspace(
            {"/work/": DiskVFS(root=str(root))}, mode=MountMode.WRITE
        )
        with ws:
            assert os.listdir("/work") == ["f.txt"]
            assert os.stat("/work/f.txt").st_size == 7
            os.mkdir("/work/sub")
            assert (root / "sub").is_dir() is True

    def test_the_host_filesystem_still_answers(self, tmp_path):
        ws = Workspace({"/mem/": RAMVFS()}, mode=MountMode.WRITE)
        (tmp_path / "host.txt").write_text("host")
        with ws:
            assert os.listdir(str(tmp_path)) == ["host.txt"]
            assert isinstance(os.stat(str(tmp_path)), os.stat_result)
            assert os.path.exists(str(tmp_path / "host.txt")) is True


class TestRmtree:
    @staticmethod
    def _busy_world():
        ws = Workspace(
            {"/data/": RAMVFS(), "/data/d/m/": RAMVFS()}, mode=MountMode.WRITE
        )
        run(ws.vfs.mkdir("/data/d"))
        run(ws.vfs.write("/data/d/keep.txt", b"k"))
        return ws

    def test_a_tree_holding_a_mount_root_reaches_the_handlers(self):
        ws = self._busy_world()
        seen = []
        with ws:
            for path in ("/data/d", "/data/."):
                shutil.rmtree(path, onexc=lambda f, p, e: seen.append(e.errno))
                shutil.rmtree(
                    path, onerror=lambda f, p, i: seen.append(i[1].errno)
                )
                shutil.rmtree(path, ignore_errors=True)
                with pytest.raises(OSError) as caught:
                    shutil.rmtree(path)
                seen.append(caught.value.errno)
            assert os.path.exists("/data/d/keep.txt")
        assert seen == [errno.EBUSY] * 6

    def test_a_mounted_tree_leaves_shutils_own_walk_alone(self):
        # The switch is the whole process's: a host rmtree on another
        # thread mid-walk must still get the descriptor walk.
        seen = []

        class Watching(RAMVFS):
            async def readdir(self, path):
                seen.append(shutil._use_fd_functions)
                return await super().readdir(path)

        ws = Workspace({"/data/": Watching()}, mode=MountMode.WRITE)
        run(ws.vfs.mkdir("/data/t"))
        run(ws.vfs.write("/data/t/a.txt", b"a"))
        with ws:
            shutil.rmtree("/data/t")
            assert not os.path.exists("/data/t")
        assert seen and all(seen)

    def test_a_directory_swapped_for_a_link_is_left(self, monkeypatch):
        # Another writer swaps the child for a link to /data/outside right
        # after the walk classified it: the walk must not follow it there.
        ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
        for folder in ("/data/t", "/data/t/child", "/data/outside"):
            run(ws.vfs.mkdir(folder))
        run(ws.vfs.write("/data/t/child/f.txt", b"t"))
        run(ws.vfs.write("/data/outside/f.txt", b"o"))
        classify = HostFs.lstat

        def swapping(self, path, *args, **kwargs):
            answer = classify(self, path, *args, **kwargs)
            if path == "/data/t/child" and not os.path.exists("/data/moved"):
                os.rename("/data/t/child", "/data/moved")
                os.symlink("/data/outside", "/data/t/child")
            return answer

        monkeypatch.setattr(HostFs, "lstat", swapping)
        with ws:
            assert shutil.rmtree.avoids_symlink_attacks is False
            with pytest.raises(OSError, match="symbolic link"):
                shutil.rmtree("/data/t")
        assert run(ws.vfs.read("/data/outside/f.txt")) == b"o"
        assert run(ws.vfs.read("/data/moved/f.txt")) == b"t"

    @pytest.mark.parametrize("spelling", ["/data/t", "/data/t/", "/data/up/t"])
    def test_a_tree_goes_however_it_is_reached(self, spelling):
        # A link above the tree is the caller's path, not a swap inside it.
        ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
        run(ws.vfs.mkdir("/data/t"))
        run(ws.vfs.mkdir("/data/t/sub"))
        run(ws.vfs.write("/data/t/sub/f.txt", b"f"))
        run(ws.vfs.write("/data/t/g.txt", b"g"))
        run(ws.vfs.symlink("/data/up", "/data"))
        with ws:
            shutil.rmtree(spelling)
            assert os.listdir("/data") == ["up"]
