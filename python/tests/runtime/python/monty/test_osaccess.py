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
import errno

from mirage.runtime.python import MontyRuntime
from mirage.runtime.resolver import PrefixResolver
from mirage.runtime.types import RunArgs
from mirage.utils.errors import OperationNotSupportedError


class FakeDispatch:
    """Async dispatch stub backed by a dict of virtual files."""

    def __init__(self,
                 files: dict[str, bytes],
                 supports_append: bool = True) -> None:
        self.files = files
        self.supports_append = supports_append
        self.writes: list[tuple[str, bytes]] = []
        self.appends: list[tuple[str, bytes]] = []
        self.unlinked: list[str] = []
        self.dirs: list[str] = []
        self.renamed: list[tuple[str, str]] = []
        self.mkdir_kwargs: list[dict] = []

    async def __call__(self, op, path, **kwargs):
        virtual = path.virtual
        if op == "read":
            if virtual not in self.files:
                raise FileNotFoundError(virtual)
            return self.files[virtual], None
        if op == "readdir":
            prefix = virtual.rstrip("/") + "/"
            names = set()
            for p in self.files:
                if p.startswith(prefix):
                    names.add(p[len(prefix):].split("/")[0])
            if not names and virtual.rstrip("/") not in ("", "/"):
                raise FileNotFoundError(virtual)
            return sorted(names), None
        if op == "write":
            data = kwargs["data"]
            self.files[virtual] = data
            self.writes.append((virtual, data))
            return None, None
        if op == "append":
            if not self.supports_append:
                # What a backend without the op really raises (S3
                # registers write but not append).
                raise OperationNotSupportedError(errno.ENOTSUP,
                                                 "no op 'append'", virtual)
            data = kwargs["data"]
            self.files[virtual] = self.files.get(virtual, b"") + data
            self.appends.append((virtual, data))
            return None, None
        if op == "unlink":
            self.files.pop(virtual, None)
            self.unlinked.append(virtual)
            return None, None
        if op == "mkdir":
            self.dirs.append(virtual)
            self.mkdir_kwargs.append(dict(kwargs))
            return None, None
        if op == "rmdir":
            self.dirs = [d for d in self.dirs if d != virtual]
            return None, None
        if op == "rename":
            dst = kwargs["dst"].virtual
            if virtual in self.files:
                self.files[dst] = self.files.pop(virtual)
            self.renamed.append((virtual, dst))
            return None, None
        raise ValueError(f"unexpected op {op}")


def test_monty_host_filesystem_invisible():
    runtime = MontyRuntime()
    result = asyncio.run(
        runtime.run(RunArgs(code="print(open('/etc/passwd').read())")))
    assert result.exit_code == 1
    assert b"FileNotFoundError" in result.stderr


def test_monty_reads_virtual_file_via_dispatch():
    dispatch = FakeDispatch({"/s3/a.txt": b"virtual"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, PrefixResolver(lambda: []))
    result = asyncio.run(
        runtime.run(RunArgs(code="print(open('/s3/a.txt').read().upper())")))
    assert result.exit_code == 0
    assert result.stdout == b"VIRTUAL\n"


def test_monty_missing_virtual_file():
    dispatch = FakeDispatch({})
    runtime = MontyRuntime()
    runtime.attach(dispatch, PrefixResolver(lambda: []))
    result = asyncio.run(runtime.run(RunArgs(code="open('/s3/missing.txt')")))
    assert result.exit_code == 1
    assert b"FileNotFoundError" in result.stderr


def test_monty_write_flushes_through_dispatch():
    dispatch = FakeDispatch({"/s3/seed.txt": b"x"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, PrefixResolver(lambda: []))
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/s3/out.txt').write_text('data')")))
    assert result.exit_code == 0
    assert ("/s3/out.txt", b"data") in dispatch.writes
    assert dispatch.files["/s3/out.txt"] == b"data"


def test_monty_append_sends_only_the_new_bytes():
    """An append must carry the delta, never the whole file.

    Monty hands the append hook the new text alone, so re-sending the
    accumulated content would make a write loop quadratic against the
    backend: N appends shipping O(N^2) bytes over N round trips.
    """
    dispatch = FakeDispatch({"/s3/log.txt": b"a"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, PrefixResolver(lambda: []))
    result = asyncio.run(
        runtime.run(
            RunArgs(code="for part in ['b', 'c', 'd']:\n"
                    "    with open('/s3/log.txt', 'a') as f:\n"
                    "        f.write(part)")))
    assert result.exit_code == 0, result.stderr
    assert dispatch.files["/s3/log.txt"] == b"abcd"
    assert dispatch.appends == [("/s3/log.txt", b"b"), ("/s3/log.txt", b"c"),
                                ("/s3/log.txt", b"d")]
    assert dispatch.writes == []


def test_monty_iterdir_lists_virtual_dir():
    dispatch = FakeDispatch({"/s3/a.txt": b"1", "/s3/b.txt": b"2"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, PrefixResolver(lambda: []))
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "print(sorted(str(p) "
                    "for p in Path('/s3').iterdir()))")))
    assert result.exit_code == 0
    assert result.stdout == b"['/s3/a.txt', '/s3/b.txt']\n"


def test_monty_unlink_routes_to_dispatch():
    dispatch = FakeDispatch({"/s3/a.txt": b"1"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, PrefixResolver(lambda: []))
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/s3/a.txt').unlink()")))
    assert result.exit_code == 0
    assert dispatch.unlinked == ["/s3/a.txt"]


def test_monty_mkdir_routes_to_dispatch():
    dispatch = FakeDispatch({})
    runtime = MontyRuntime()
    runtime.attach(dispatch, PrefixResolver(lambda: []))
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/s3/sub').mkdir()\n"
                    "Path('/s3/sub/n.txt').write_text('deep')")))
    assert result.exit_code == 0, result.stderr
    assert "/s3/sub" in dispatch.dirs
    assert dispatch.files["/s3/sub/n.txt"] == b"deep"


def test_monty_rename_routes_to_dispatch():
    dispatch = FakeDispatch({"/s3/a.txt": b"one"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, PrefixResolver(lambda: []))
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/s3/a.txt').rename('/s3/b.txt')")))
    assert result.exit_code == 0, result.stderr
    assert dispatch.renamed == [("/s3/a.txt", "/s3/b.txt")]
    assert dispatch.files["/s3/b.txt"] == b"one"


def test_monty_unlink_after_rename_reaches_the_mount():
    # monty 0.0.19 renames a file without restamping its own path, so
    # the following unlink used to die with KeyError('a.txt') after the
    # rename had already landed on the backend.
    dispatch = FakeDispatch({"/s3/a.txt": b"one"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, PrefixResolver(lambda: []))
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/s3/a.txt').rename('/s3/b.txt')\n"
                    "Path('/s3/b.txt').unlink()")))
    assert result.exit_code == 0, result.stderr
    assert dispatch.unlinked == ["/s3/b.txt"]
    assert "/s3/b.txt" not in dispatch.files


def test_monty_rmdir_routes_to_dispatch():
    dispatch = FakeDispatch({"/s3/dir/keep.txt": b"x"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, PrefixResolver(lambda: []))
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/s3/dir').rmdir()")))
    assert result.exit_code == 0, result.stderr
    assert "/s3/dir" not in dispatch.dirs


def test_monty_append_falls_back_when_the_mount_has_no_append_op():
    """A mount without `append` keeps working, via the full flush.

    S3 registers `write` but not `append`, so dispatching the delta
    unconditionally would turn a working `open(path, "a")` into a hard
    failure on those mounts.
    """
    dispatch = FakeDispatch({"/s3/log.txt": b"a"}, supports_append=False)
    runtime = MontyRuntime()
    runtime.attach(dispatch, PrefixResolver(lambda: ["/s3/"]))
    result = asyncio.run(
        runtime.run(
            RunArgs(code="for part in ['b', 'c']:\n"
                    "    with open('/s3/log.txt', 'a') as f:\n"
                    "        f.write(part)")))
    assert result.exit_code == 0, result.stderr
    assert dispatch.appends == []
    assert dispatch.files["/s3/log.txt"] == b"abc"
    # One probe per mount, not one per append.
    assert [p for p, _ in dispatch.writes] == ["/s3/log.txt", "/s3/log.txt"]


def test_monty_mkdir_forwards_parents_and_honors_exist_ok():
    dispatch = FakeDispatch({"/s3/a.txt": b"1"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, PrefixResolver(lambda: ["/s3/"]))
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/s3/x/y').mkdir(parents=True)\n"
                    "Path('/s3/x/y').mkdir(exist_ok=True)\n"
                    "print('ok')")))
    assert result.exit_code == 0, result.stderr
    assert result.stdout == b"ok\n"
    assert dispatch.dirs == ["/s3/x/y"]
    assert dispatch.mkdir_kwargs == [{"parents": True}]


def test_monty_mkdir_without_exist_ok_raises_on_an_existing_dir():
    dispatch = FakeDispatch({"/s3/sub/a.txt": b"1"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, PrefixResolver(lambda: ["/s3/"]))
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/s3/sub').mkdir()")))
    assert result.exit_code == 1
    assert b"FileExistsError" in result.stderr
    assert dispatch.dirs == []


def test_monty_mkdir_on_a_file_raises_even_under_exist_ok():
    """`exist_ok` forgives a directory, never a file.

    Pinned against CPython: `Path('a.txt').mkdir(exist_ok=True)` over a
    regular file raises FileExistsError, and only an existing directory
    is quiet.
    """
    dispatch = FakeDispatch({"/s3/a.txt": b"hi"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, PrefixResolver(lambda: ["/s3/"]))
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/s3/a.txt').read_text()\n"
                    "Path('/s3/a.txt').mkdir(exist_ok=True)")))
    assert result.exit_code == 1
    assert b"FileExistsError" in result.stderr
    assert dispatch.dirs == []


def test_monty_mkdir_on_an_unread_mount_file_still_raises():
    """The file need not be in the tree yet for mkdir to refuse it."""
    dispatch = FakeDispatch({"/s3/a.txt": b"hi"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, PrefixResolver(lambda: ["/s3/"]))
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/s3/a.txt').mkdir(exist_ok=True)")))
    assert result.exit_code == 1
    assert b"FileExistsError" in result.stderr
    assert dispatch.dirs == []


def test_monty_rename_across_mounts_raises_exdev():
    """The dispatcher resolves the mount from the source alone.

    Handing it a destination on another mount would delete the source
    and write the target into the wrong backend, so refuse the way
    POSIX does.
    """
    dispatch = FakeDispatch({"/a/f.txt": b"data"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, PrefixResolver(lambda: ["/a/", "/b/"]))
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/a/f.txt').rename('/b/f.txt')")))
    assert result.exit_code == 1
    assert dispatch.renamed == []
    assert dispatch.files["/a/f.txt"] == b"data"


def test_monty_rename_within_one_mount_still_dispatches():
    dispatch = FakeDispatch({"/a/f.txt": b"data"})
    runtime = MontyRuntime()
    runtime.attach(dispatch, PrefixResolver(lambda: ["/a/", "/b/"]))
    result = asyncio.run(
        runtime.run(
            RunArgs(code="from pathlib import Path\n"
                    "Path('/a/f.txt').rename('/a/g.txt')")))
    assert result.exit_code == 0, result.stderr
    assert dispatch.renamed == [("/a/f.txt", "/a/g.txt")]
