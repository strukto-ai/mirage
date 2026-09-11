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
import os
import shutil
import stat as stat_mod
import sys
from pathlib import Path

import pytest

from mirage import MountMode, Workspace
from mirage.context import set_current_session
from mirage.errors.posix import posix_errno
from mirage.ops.os_patch import make_os_module, os_routing
from mirage.resource.disk import DiskResource
from mirage.resource.ram import RAMResource
from mirage.runtime.verbs import PASSTHROUGH_VERBS, REFUSED_VERBS, ROUTED_VERBS
from mirage.types import HiddenPaths, PathSpec

from .conftest import make_ops_with_dir, run


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
        for verb in ROUTED_VERBS:
            if not hasattr(os, verb):
                continue
            assert getattr(patched, verb) is not getattr(os, verb), verb

    def test_every_refused_verb_the_host_has_is_installed(self):
        ops, patched = seeded()
        for verb in REFUSED_VERBS:
            if not hasattr(os, verb):
                continue
            assert getattr(patched, verb) is not getattr(os, verb), verb

    def test_passthrough_verbs_keep_the_host_function(self):
        ops, patched = seeded()
        for verb in PASSTHROUGH_VERBS:
            if not hasattr(os, verb):
                continue
            assert getattr(patched, verb) is getattr(os, verb), verb

    def test_a_name_this_platform_lacks_is_not_invented(self):
        # hasattr(os, ...) has to keep answering what it did, or code
        # that probes for a platform feature gets an OSError instead.
        ops, patched = seeded()
        for verb in (*ROUTED_VERBS, *REFUSED_VERBS):
            assert hasattr(patched, verb) is hasattr(os, verb), verb

    def test_routing_covers_the_tables(self):
        ops, _ = seeded()
        routed = os_routing(ops)
        expected = {
            verb
            for verb in (*ROUTED_VERBS, *REFUSED_VERBS) if hasattr(os, verb)
        }
        assert set(routed) == expected


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
        assert st.st_size == 0

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
                e.name: (e.is_dir(), e.is_file(), e.is_symlink())
                for e in it
            }
        assert kinds == {
            "a.txt": (False, True, False),
            "sub": (True, False, False),
        }

    def test_scandir_entry_carries_path_and_stat(self):
        _, patched = seeded()
        entry = next(e for e in patched.scandir("/data/dir")
                     if e.name == "a.txt")
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
        assert seen == [("/data/dir/sub", [], ["c.txt"]),
                        ("/data/dir", ["sub"], ["a.txt"])]

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
        resource = RAMResource()
        run(resource.write(PathSpec.from_str_path("/fixed.txt"), b"ro"))
        ws = Workspace({"/ro/": (resource, MountMode.READ)},
                       mode=MountMode.WRITE)
        patched = make_os_module(ws.fs)
        assert patched.access("/ro/fixed.txt", os.R_OK) is True
        assert patched.access("/ro/fixed.txt", os.W_OK) is False


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

    def test_removedirs_prunes_the_parents_that_empty(self):
        _, patched = seeded()
        patched.makedirs("/data/deep/x/y")
        patched.removedirs("/data/deep/x/y")
        assert patched.path.isdir("/data/deep") is False

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
        assert stat_mod.S_IMODE(
            patched.stat("/data/dir/a.txt").st_mode) == 0o600

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
            self, tmp_path):
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
        seen = [(top, sorted(files))
                for top, _, files in patched.walk("/data/dir")]
        assert seen == [("/data/dir", ["a.txt", "broken"]),
                        ("/data/dir/sub", ["c.txt"])]

    def test_walk_lists_a_link_to_a_directory_without_entering_it(self):
        _, patched = seeded()
        patched.symlink("/data/dir/sub", "/data/dir/subs")
        tops = [top for top, _, _ in patched.walk("/data/dir")]
        assert tops == ["/data/dir", "/data/dir/sub"]
        tops = [
            top for top, _, _ in patched.walk("/data/dir", followlinks=True)
        ]
        assert sorted(tops) == ["/data/dir", "/data/dir/sub", "/data/dir/subs"]


class TestRefusals:

    @pytest.mark.parametrize("verb", sorted(REFUSED_VERBS))
    def test_a_refused_verb_answers_its_condition(self, verb):
        if not hasattr(os, verb):
            pytest.skip(f"{verb} is not a name this platform has")
        _, patched = seeded()
        with pytest.raises(OSError) as caught:
            getattr(patched, verb)("/data/dir/a.txt", *_extra_args(verb))
        assert caught.value.errno == posix_errno(REFUSED_VERBS[verb])

    def test_a_refused_verb_still_serves_a_host_path(self, tmp_path):
        _, patched = seeded()
        target = tmp_path / "a.txt"
        target.write_text("host")
        assert patched.statvfs(str(tmp_path)).f_bsize > 0
        fd = patched.open(str(target), os.O_RDONLY)
        os.close(fd)

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
        "chflags": (0, ),
        "lchflags": (0, ),
        "getxattr": ("user.x", ),
        "link": ("/data/dir/hard", ),
        "mkfifo": (),
        "mknod": (),
        "open": (os.O_RDONLY, ),
        "removexattr": ("user.x", ),
        "setxattr": ("user.x", b"v"),
    }.get(verb, ())


class TestProcessPatch:

    def test_a_module_level_import_routes_inside_the_block(self):
        ws = Workspace({"/mem/": RAMResource()}, mode=MountMode.WRITE)
        run(ws.fs.mkdir("/mem/dir"))
        run(ws.fs.write("/mem/dir/a.txt", b"a"))
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

    def test_pathlib_routes_for_content_and_metadata(self):
        ws = Workspace({"/mem/": RAMResource()}, mode=MountMode.WRITE)
        run(ws.fs.mkdir("/mem/dir"))
        run(ws.fs.write("/mem/dir/a.txt", b"hello"))
        with ws:
            path = Path("/mem/dir/a.txt")
            assert path.exists() is True
            assert path.read_text() == "hello"
            assert path.stat().st_size == 5
            assert sorted(p.name
                          for p in Path("/mem/dir").iterdir()) == ["a.txt"]
            Path("/mem/dir/written.txt").write_text("written")
            assert Path("/mem/dir/written.txt").read_text() == "written"

    def test_the_call_pathlib_actually_makes_routes(self):
        # pathlib does not call the builtin: it calls io.open, and it
        # passes the "locale" sentinel for the encoding on any
        # interpreter that is not in UTF-8 mode, which is the normal
        # case. This is that call, spelled out.
        ws = Workspace({"/mem/": RAMResource()}, mode=MountMode.WRITE)
        run(ws.fs.write("/mem/a.txt", b"hello"))
        with ws:
            with open("/mem/a.txt", "r", -1, "locale", None, None) as f:
                assert f.read() == "hello"

    def test_shutil_copies_across_the_boundary(self, tmp_path):
        ws = Workspace({"/mem/": RAMResource()}, mode=MountMode.WRITE)
        run(ws.fs.mkdir("/mem/dir"))
        run(ws.fs.write("/mem/dir/a.txt", b"hello"))
        with ws:
            out = tmp_path / "copied.txt"
            shutil.copy("/mem/dir/a.txt", str(out))
            assert out.read_text() == "hello"
            shutil.copy(str(out), "/mem/dir/back.txt")
            assert os.path.getsize("/mem/dir/back.txt") == 5

    def test_a_hidden_path_reads_as_absent_through_os(self):
        ws = Workspace({"/mem/": RAMResource()}, mode=MountMode.WRITE)
        run(ws.fs.write("/mem/open.txt", b"public"))
        run(ws.fs.mkdir("/mem/secrets"))
        run(ws.fs.write("/mem/secrets/token.txt", b"s3cret"))
        session = ws.create_session("agent")
        session.hidden_paths = HiddenPaths(paths=("/mem/secrets", ),
                                           patterns=("*.key", ))
        run(ws.fs.write("/mem/note.key", b"key"))
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
        ws = Workspace({"/mem/": RAMResource()}, mode=MountMode.WRITE)
        run(ws.fs.write("/mem/a.txt", b"hello"))
        session = ws.create_session("agent")
        session.hidden_paths = HiddenPaths(paths=(), patterns=("*.key", ))
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
        # go through it too; they name host paths under the resource
        # root, which no mount owns, and fall through.
        root = tmp_path / "root"
        root.mkdir()
        (root / "f.txt").write_text("on disk")
        ws = Workspace({"/work/": DiskResource(root=str(root))},
                       mode=MountMode.WRITE)
        with ws:
            assert os.listdir("/work") == ["f.txt"]
            assert os.stat("/work/f.txt").st_size == 7
            os.mkdir("/work/sub")
            assert (root / "sub").is_dir() is True

    def test_the_host_filesystem_still_answers(self, tmp_path):
        ws = Workspace({"/mem/": RAMResource()}, mode=MountMode.WRITE)
        (tmp_path / "host.txt").write_text("host")
        with ws:
            assert os.listdir(str(tmp_path)) == ["host.txt"]
            assert isinstance(os.stat(str(tmp_path)), os.stat_result)
            assert os.path.exists(str(tmp_path / "host.txt")) is True
