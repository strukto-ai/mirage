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

import pytest

from mirage.runtime.python.monty.vfs import MontyVFS
from mirage.runtime.resolver import PrefixResolver
from mirage.runtime.vfs import RuntimeVFS
from mirage.types import ContentType, FileStat, FileType


class CountingCore(RuntimeVFS):
    """Core with a counted dispatch, so a cache hit is observable.

    Args:
        files (dict[str, bytes]): the paths the mount holds.
    """

    def __init__(self,
                 files: dict[str, bytes],
                 links: dict[str, str] | None = None,
                 dirs: set[str] | None = None) -> None:
        super().__init__(dispatch=None,
                         loop=None,
                         resolver=PrefixResolver(lambda: []))
        self.files = files
        self.links = dict(links or {})
        # A directory stats but does not read, which is the shape a
        # real mount reports and the reason the two questions cache
        # separately.
        self.dirs = set(dirs or ())
        self.calls: list[tuple[str, str]] = []

    def _raw(self, op, path, **kwargs):
        self.calls.append((op, path))
        if op == "read":
            if path not in self.files:
                raise FileNotFoundError(path)
            return self.files[path]
        if op == "stat":
            if path in self.dirs:
                return FileStat(name=path,
                                size=0,
                                type=FileType.DIRECTORY,
                                content=None)
            if path not in self.files:
                raise FileNotFoundError(path)
            return FileStat(name=path,
                            size=len(self.files[path]),
                            type=FileType.FILE,
                            content=ContentType.TEXT)
        if op == "readdir":
            # Full virtual paths, the door's own shape.
            prefix = path.rstrip("/") + "/"
            names = {
                prefix + p[len(prefix):].split("/")[0]
                for p in self.files if p.startswith(prefix)
            }
            if not names:
                raise FileNotFoundError(path)
            return sorted(names)
        if op == "readlink":
            found = self.links.get(path)
            if found is None:
                raise OSError(errno.EINVAL, "not a symbolic link", path)
            return found
        return None

    def ops(self, name: str) -> list[str]:
        return [p for op, p in self.calls if op == name]


def test_a_miss_is_remembered_so_a_repeated_probe_costs_no_dispatch():
    # Monty asks whether a path exists on nearly every guest
    # expression, so the second miss must not reach the mount. It is
    # the existence question that is cached, which is the one monty
    # actually asks that often.
    core = CountingCore({})
    vfs = MontyVFS(core)
    assert vfs.stat("/s3/nope.txt") is None
    assert vfs.stat("/s3/nope.txt") is None
    assert core.ops("stat") == ["/s3/nope.txt"]


def test_a_refused_read_does_not_poison_the_row():
    # A mount reports a read of a directory as FileNotFoundError, so a
    # read that recorded its miss made every later stat, is_dir and
    # exists of that directory answer from monty's own tree defaults
    # instead of the mount's row.
    core = CountingCore({}, dirs={"/s3/sub"})
    vfs = MontyVFS(core)
    assert vfs.read("/s3/sub") is None
    row = vfs.stat("/s3/sub")
    assert row is not None
    assert row.is_dir


def test_a_missing_row_still_short_circuits_a_later_read():
    # The cache is about the path, not about one op: once the mount has
    # said the path is not there, a read need not ask again.
    core = CountingCore({})
    vfs = MontyVFS(core)
    assert vfs.stat("/s3/nope.txt") is None
    assert vfs.read("/s3/nope.txt") is None
    assert core.ops("read") == []


def test_a_write_forgets_the_miss_so_the_guest_sees_its_own_file():
    core = CountingCore({})
    vfs = MontyVFS(core)
    assert vfs.read("/s3/new.txt") is None
    core.files["/s3/new.txt"] = b"fresh"
    vfs.write("/s3/new.txt", b"fresh")
    assert vfs.read("/s3/new.txt") == b"fresh"


def test_an_append_forgets_the_miss_too():
    core = CountingCore({})
    vfs = MontyVFS(core)
    assert vfs.read("/s3/log.txt") is None
    core.files["/s3/log.txt"] = b"line"
    vfs.append("/s3/log.txt", b"line", b"line")
    assert vfs.read("/s3/log.txt") == b"line"


def test_a_removed_path_is_remembered_without_a_second_dispatch():
    core = CountingCore({"/s3/a.txt": b"1"})
    vfs = MontyVFS(core)
    vfs.unlink("/s3/a.txt")
    assert vfs.read("/s3/a.txt") is None
    assert core.ops("read") == []


def test_a_rename_forgets_the_destination_and_remembers_the_source():
    core = CountingCore({"/s3/a.txt": b"one"})
    vfs = MontyVFS(core)
    assert vfs.read("/s3/b.txt") is None
    core.files["/s3/b.txt"] = core.files.pop("/s3/a.txt")
    vfs.rename("/s3/a.txt", "/s3/b.txt")
    assert vfs.read("/s3/b.txt") == b"one"
    assert vfs.read("/s3/a.txt") is None


def test_an_rmdir_is_remembered_and_a_mkdir_forgets():
    core = CountingCore({})
    vfs = MontyVFS(core)
    vfs.rmdir("/s3/gone")
    assert vfs.read("/s3/gone") is None
    assert core.ops("read") == []
    vfs.mkdir("/s3/gone", parents=False)
    assert vfs.read("/s3/gone") is None
    assert core.ops("read") == ["/s3/gone"]


class RefusingCore(CountingCore):
    """Core that answers nothing: every op is refused, not missed."""

    def __init__(self) -> None:
        super().__init__({})

    def _raw(self, op, path, **kwargs):
        self.calls.append((op, path))
        raise PermissionError(errno.EACCES, "denied", path)


def test_a_refused_readlink_is_not_read_as_not_a_link():
    # A backend that will not answer has said nothing about whether the
    # path is a link, and False is the one answer a guest cannot tell
    # from the truth. CPython draws the same line: `Path.is_symlink`
    # swallows only its `_ignore_error` list and re-raises
    # PermissionError. A bare `except OSError` here swallowed both.
    vfs = MontyVFS(RefusingCore())
    with pytest.raises(PermissionError):
        vfs.is_link("/s3/x")


def test_a_dangling_link_is_still_a_link_after_a_stat_miss():
    # `exists()` stats, the stat follows the link and misses, and the
    # door remembers the path as absent. `is_link` has to keep seeing
    # it: the name plane is where the fact lives, and the miss was the
    # target's, not the link's. Pinned here because the TypeScript twin
    # read the mark off the parent's listing, which goes through that
    # cache, and answered False for a link plainly there.
    core = CountingCore({}, links={"/s3/dangling": "/s3/gone"})
    vfs = MontyVFS(core)
    assert vfs.stat("/s3/dangling") is None
    assert vfs.is_link("/s3/dangling") is True


def test_a_created_ancestor_is_forgotten_along_with_the_leaf():
    # `mkdir(parents=True)` brings the ancestors into being too, so a
    # miss the guest already cached for one of them is stale the moment
    # the call returns. Forgetting only the leaf left the ancestor
    # cached as missing, and a later stat of it skipped the mount's row
    # to answer from monty's own tree, with a synthetic mode and stamp
    # in place of the backend's. A write has the same shape on a prefix
    # store, where the key materializes every directory above it.
    core = CountingCore({})
    vfs = MontyVFS(core)
    assert vfs.stat("/s3/a") is None
    core.dirs.update({"/s3/a", "/s3/a/b"})
    vfs.mkdir("/s3/a/b", parents=True)
    assert vfs.stat("/s3/a") is not None


def test_a_rename_forgets_the_absences_under_its_destination():
    # A rename is the one op that makes a whole subtree exist at once.
    # A cached absence never self-heals, because the cache answers
    # before the dispatch runs, so a child the guest asked about before
    # the move went on reading as missing for the rest of the run.
    core = CountingCore({"/s3/src/child.txt": b"x"})
    vfs = MontyVFS(core)
    assert vfs.stat("/s3/dst/child.txt") is None
    core.files["/s3/dst/child.txt"] = core.files.pop("/s3/src/child.txt")
    vfs.rename("/s3/src", "/s3/dst")
    assert vfs.stat("/s3/dst/child.txt") is not None


def test_a_refused_listing_is_not_read_as_an_absence():
    # A backend that will not answer has said nothing about whether the
    # path is there, so the refusal has to come out as itself. Folding
    # it into "no entries" reports an authorization or a transport
    # failure as a missing directory, which is the one answer a guest
    # cannot tell from the truth.
    vfs = MontyVFS(RefusingCore())
    with pytest.raises(PermissionError):
        vfs.readdir("/s3/d")
    with pytest.raises(PermissionError):
        vfs.stat("/s3/d")
    with pytest.raises(PermissionError):
        vfs.read("/s3/d")


def test_a_listing_miss_is_not_cached_because_a_directory_may_gain_entries():
    core = CountingCore({})
    vfs = MontyVFS(core)
    assert vfs.readdir("/s3/d") is None
    core.files["/s3/d/a.txt"] = b"1"
    assert [e.path for e in vfs.readdir("/s3/d")] == ["/s3/d/a.txt"]


def test_an_unwired_view_answers_none_and_swallows_no_mutation():
    # The runtime is built without a workspace: every question answers
    # "not here" and every mutation is a no-op rather than a crash.
    vfs = MontyVFS(None)
    assert vfs.wired is False
    assert vfs.read("/s3/a.txt") is None
    assert vfs.readdir("/s3") is None
    vfs.write("/s3/a.txt", b"x")
    vfs.unlink("/s3/a.txt")


def test_is_link_reads_the_name_plane():
    # Monty's own tree holds no links, so the readlink op is the only
    # place the fact lives; a python readdir row carries no mark.
    core = CountingCore({"/ram/t.txt": b"x"}, links={"/ram/l": "t.txt"})
    vfs = MontyVFS(core)
    assert vfs.is_link("/ram/l") is True
    assert vfs.is_link("/ram/t.txt") is False


def test_is_link_is_false_without_a_workspace():
    assert MontyVFS(None).is_link("/ram/l") is False
