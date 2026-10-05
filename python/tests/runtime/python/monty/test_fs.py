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

import pytest

from mirage.runtime.binding import WorkspaceBinding
from mirage.runtime.python import MontyRuntime
from mirage.runtime.resolver import PrefixResolver
from mirage.runtime.types import RunArgs
from mirage.types import ContentType, FileStat, FileType
from mirage.utils.errors import OperationNotSupportedError


class FakeDispatch:
    """Async dispatch stub backed by a dict of virtual files."""

    def __init__(
        self,
        files: dict[str, bytes],
        supports_append: bool = True,
        links: dict[str, str] | None = None,
        stat_mode: int | None = None,
        stat_modified: str | None = None,
        devices: set[str] | None = None,
        refuse_readdir: bool = False,
        refuse_readlink: bool = False,
    ) -> None:
        self.files = files
        self.supports_append = supports_append
        self.links = dict(links or {})
        self.stat_mode = stat_mode
        self.stat_modified = stat_modified
        self.devices = set(devices or ())
        # A backend that serves stat but will not list, which is what a
        # deny rule on readdir alone leaves behind.
        self.refuse_readdir = refuse_readdir
        self.refuse_readlink = refuse_readlink
        self.writes: list[tuple[str, bytes]] = []
        self.appends: list[tuple[str, bytes]] = []
        self.dirs: list[str] = []

    async def __call__(self, op, path, **kwargs):
        virtual = path.virtual
        if op == "read":
            if virtual in self.devices:
                raise ValueError(
                    "cannot read an endless device without a size"
                )
            if virtual not in self.files:
                raise FileNotFoundError(virtual)
            return self.files[virtual], None
        if op == "stat":
            if virtual in self.devices:
                return FileStat(name=virtual, type=FileType.CHAR_DEVICE), None
            if virtual in self.files:
                return FileStat(
                    name=virtual,
                    size=len(self.files[virtual]),
                    type=FileType.FILE,
                    content=ContentType.TEXT,
                    mode=self.stat_mode,
                    modified=self.stat_modified,
                ), None
            if virtual in self.dirs:
                return FileStat(name=virtual, type=FileType.DIRECTORY), None
            raise FileNotFoundError(virtual)
        if op == "readdir":
            if self.refuse_readdir:
                raise PermissionError(errno.EACCES, "denied", virtual)
            # Full virtual paths, the door's own shape.
            prefix = virtual.rstrip("/") + "/"
            names = set()
            for p in [*self.files, *self.devices]:
                if p.startswith(prefix):
                    names.add(prefix + p[len(prefix) :].split("/")[0])
            known = ("", "/", *self.dirs)
            if not names and virtual.rstrip("/") not in known:
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
                raise OperationNotSupportedError(
                    errno.ENOTSUP, "no op 'append'", virtual
                )
            data = kwargs["data"]
            self.files[virtual] = self.files.get(virtual, b"") + data
            self.appends.append((virtual, data))
            return None, None
        if op == "create":
            self.files[virtual] = b""
            return None, None
        if op == "truncate":
            self.files[virtual] = b""
            return None, None
        if op == "unlink":
            self.files.pop(virtual, None)
            return None, None
        if op == "mkdir":
            self.dirs.append(virtual)
            return None, None
        if op == "rmdir":
            self.dirs = [d for d in self.dirs if d != virtual]
            return None, None
        if op == "rename":
            dst = kwargs["dst"].virtual
            if virtual in self.files:
                self.files[dst] = self.files.pop(virtual)
            return None, None
        if op == "readlink":
            if self.refuse_readlink:
                raise PermissionError(errno.EACCES, "denied", virtual)
            found = self.links.get(virtual)
            if found is None:
                raise OSError(errno.EINVAL, "not a symbolic link", virtual)
            return found, None
        raise ValueError(f"unexpected op {op}")


def test_monty_host_filesystem_invisible():
    runtime = MontyRuntime()
    result = asyncio.run(
        runtime.run(RunArgs(code="print(open('/etc/passwd').read())"))
    )
    assert result.exit_code == 1
    assert b"FileNotFoundError" in result.stderr


def test_monty_stat_answers_from_the_mounts_own_row():
    # Monty stats out of its in-memory tree, where a materialized file
    # is a MemoryFile with 0o644 and the moment it was fetched. So a
    # chmod the shell made was invisible and every mounted file read as
    # modified just now; the door's row holds both facts.
    dispatch = FakeDispatch(
        {"/s3/a.txt": b"hello"},
        stat_mode=0o600,
        stat_modified="2026-07-15T00:00:00Z",
    )
    runtime = MontyRuntime()
    runtime.bind(WorkspaceBinding(dispatch, PrefixResolver(lambda: [])))
    result = asyncio.run(
        runtime.run(
            RunArgs(
                code="from pathlib import Path\n"
                "st = Path('/s3/a.txt').stat()\n"
                "print(oct(st.st_mode), int(st.st_mtime), st.st_size)"
            )
        )
    )
    assert result.exit_code == 0
    assert result.stdout == b"0o100600 1784073600 5\n"


def test_monty_stat_reports_an_unknown_stamp_as_epoch_zero():
    # A backend with no timestamp answers 0, not the host clock: monty
    # substitutes time.time() for a mtime of None, which is how every
    # mounted file came to look freshly modified.
    dispatch = FakeDispatch({"/s3/a.txt": b"hi"})
    runtime = MontyRuntime()
    runtime.bind(WorkspaceBinding(dispatch, PrefixResolver(lambda: [])))
    result = asyncio.run(
        runtime.run(
            RunArgs(
                code="from pathlib import Path\n"
                "print(int(Path('/s3/a.txt').stat().st_mtime))"
            )
        )
    )
    assert result.exit_code == 0
    assert result.stdout == b"0\n"


def test_monty_reports_a_character_device_without_reading_it():
    dispatch = FakeDispatch({}, devices={"/dev/zero"})
    runtime = MontyRuntime()
    runtime.bind(WorkspaceBinding(dispatch, PrefixResolver(lambda: [])))
    result = asyncio.run(
        runtime.run(
            RunArgs(
                code="from pathlib import Path\n"
                "p = Path('/dev/zero')\n"
                "print(p.exists(), p.is_file(), oct(p.stat().st_mode))"
            )
        )
    )
    assert result.exit_code == 0, result.stderr
    assert result.stdout == b"True False 0o20666\n"


def test_monty_predicates_answer_from_the_row_not_a_listing():
    # A backend may serve a stat for a path it refuses to list, and the
    # row is the better answer anyway: it says what the path IS, where
    # a listing only says whether it opens. The door asks stat first
    # and keeps the listing for the one path with no row of its own, a
    # directory a nested mount only implies. Pinned here because the
    # TypeScript twin asked the listing first and reported a served
    # stat as a refusal.
    dispatch = FakeDispatch({"/s3/d/f.txt": b"hi"}, refuse_readdir=True)
    runtime = MontyRuntime()
    runtime.bind(WorkspaceBinding(dispatch, PrefixResolver(lambda: [])))
    result = asyncio.run(
        runtime.run(
            RunArgs(
                code="from pathlib import Path\n"
                "p = Path('/s3/d/f.txt')\n"
                "print(p.exists(), p.is_file(), p.is_dir())"
            )
        )
    )
    assert result.exit_code == 0, result.stderr
    assert result.stdout == b"True True False\n"


def test_monty_append_sends_only_the_new_bytes():
    """An append must carry the delta, never the whole file.

    Monty hands the append hook the new text alone, so re-sending the
    accumulated content would make a write loop quadratic against the
    backend: N appends shipping O(N^2) bytes over N round trips.
    """
    dispatch = FakeDispatch({"/s3/log.txt": b"a"})
    runtime = MontyRuntime()
    runtime.bind(WorkspaceBinding(dispatch, PrefixResolver(lambda: [])))
    result = asyncio.run(
        runtime.run(
            RunArgs(
                code="for part in ['b', 'c', 'd']:\n"
                "    with open('/s3/log.txt', 'a') as f:\n"
                "        f.write(part)"
            )
        )
    )
    assert result.exit_code == 0, result.stderr
    assert dispatch.files["/s3/log.txt"] == b"abcd"
    assert dispatch.appends == [
        ("/s3/log.txt", b"b"),
        ("/s3/log.txt", b"c"),
        ("/s3/log.txt", b"d"),
    ]
    assert dispatch.writes == []


def test_monty_append_falls_back_when_the_mount_has_no_append_op():
    """A mount without `append` keeps working, via the full flush.

    S3 registers `write` but not `append`, so dispatching the delta
    unconditionally would turn a working `open(path, "a")` into a hard
    failure on those mounts.
    """
    dispatch = FakeDispatch({"/s3/log.txt": b"a"}, supports_append=False)
    runtime = MontyRuntime()
    runtime.bind(WorkspaceBinding(dispatch, PrefixResolver(lambda: ["/s3/"])))
    result = asyncio.run(
        runtime.run(
            RunArgs(
                code="for part in ['b', 'c']:\n"
                "    with open('/s3/log.txt', 'a') as f:\n"
                "        f.write(part)"
            )
        )
    )
    assert result.exit_code == 0, result.stderr
    assert dispatch.appends == []
    assert dispatch.files["/s3/log.txt"] == b"abc"
    # One probe per mount, not one per append.
    assert [p for p, _ in dispatch.writes] == ["/s3/log.txt", "/s3/log.txt"]


@pytest.mark.parametrize(
    "read_first", [True, False], ids=["read-first", "never-read"]
)
def test_monty_mkdir_on_a_file_raises_even_under_exist_ok(read_first):
    """`exist_ok` forgives a directory, never a file.

    Pinned against CPython: `Path('a.txt').mkdir(exist_ok=True)` over a
    regular file raises FileExistsError, and only an existing directory
    is quiet. The file need not be in the tree yet for mkdir to refuse
    it.

    Args:
        read_first (bool): whether the guest reads the file before the
            mkdir.
    """
    dispatch = FakeDispatch({"/s3/a.txt": b"hi"})
    runtime = MontyRuntime()
    runtime.bind(WorkspaceBinding(dispatch, PrefixResolver(lambda: ["/s3/"])))
    read = "Path('/s3/a.txt').read_text()\n" if read_first else ""
    code = (
        "from pathlib import Path\n"
        + read
        + "Path('/s3/a.txt').mkdir(exist_ok=True)"
    )
    result = asyncio.run(runtime.run(RunArgs(code=code)))
    assert result.exit_code == 1
    assert b"FileExistsError" in result.stderr
    assert dispatch.dirs == []


def test_monty_a_dangling_link_is_a_link_though_it_does_not_exist():
    # The stat follows the link and misses, so `exists()` is False, but
    # the name plane still holds the link: the miss was the target's.
    dispatch = FakeDispatch({}, links={"/s3/dangling": "/s3/gone"})
    runtime = MontyRuntime()
    runtime.bind(WorkspaceBinding(dispatch, PrefixResolver(lambda: [])))
    code = (
        "from pathlib import Path\n"
        "p = Path('/s3/dangling')\n"
        "print(p.exists(), p.is_symlink())"
    )
    result = asyncio.run(runtime.run(RunArgs(code=code)))
    assert result.exit_code == 0, result.stderr
    assert result.stdout == b"False True\n"


def test_monty_a_refused_readlink_is_not_read_as_not_a_link():
    # CPython's `Path.is_symlink` swallows only its `_ignore_error` list
    # and re-raises PermissionError; False would be an answer the guest
    # cannot tell from the truth.
    dispatch = FakeDispatch({"/s3/x": b"1"}, refuse_readlink=True)
    runtime = MontyRuntime()
    runtime.bind(WorkspaceBinding(dispatch, PrefixResolver(lambda: [])))
    code = "from pathlib import Path\nPath('/s3/x').is_symlink()"
    result = asyncio.run(runtime.run(RunArgs(code=code)))
    assert result.exit_code == 1
    assert b"PermissionError: [Errno 13] Permission denied: '/s3/x'" in (
        result.stderr
    )
