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

from mirage.errors import FsCondition, classify
from mirage.errors.constants import FS_ERRORS, OPERAND_CONDITIONS
from mirage.errors.fs import (
    dot_walk_error,
    eacces,
    ebadf,
    ebusy,
    eexist,
    efbig,
    eisdir,
    eloop,
    enoent,
    enotdir,
    enotempty,
    enotsup,
    erofs,
    error_path,
    exdev,
    fs_error,
    fs_strerror,
    listing_error,
    no_mount,
    readdir_error,
    walk_refusal,
)
from mirage.errors.posix import posix_errno, posix_phrase
from mirage.errors.render import fs_error_line
from mirage.errors.types import (
    BadDescriptorError,
    DotWalkLoop,
    DotWalkMissing,
    DotWalkNotDir,
    FileTooLargeError,
    NoMountError,
    OperationNotSupportedError,
    ReadOnlyError,
)
from mirage.types import PathSpec


@pytest.mark.parametrize(
    ("make", "condition", "kind"),
    [
        (enoent, FsCondition.ENOENT, FileNotFoundError),
        (enotdir, FsCondition.ENOTDIR, NotADirectoryError),
        (eisdir, FsCondition.EISDIR, IsADirectoryError),
        (eexist, FsCondition.EEXIST, FileExistsError),
        (eacces, FsCondition.EACCES, PermissionError),
        (erofs, FsCondition.EROFS, ReadOnlyError),
        (ebadf, FsCondition.EBADF, BadDescriptorError),
        (efbig, FsCondition.EFBIG, FileTooLargeError),
        (eloop, FsCondition.ELOOP, DotWalkLoop),
        (enotempty, FsCondition.ENOTEMPTY, OSError),
        (exdev, FsCondition.EXDEV, OSError),
        (ebusy, FsCondition.EBUSY, OSError),
    ],
)
def test_every_constructor_stamps_the_kernel_shape(make, condition, kind):
    # errno, phrase and the operand as filename, the way the kernel and
    # the disk backend raise it, and the same error ``fs_error`` builds.
    for exc in (
        make(PathSpec.from_str_path("/data/x")),
        fs_error("/data/x", condition),
    ):
        assert type(exc) is kind
        assert (exc.errno, exc.strerror, exc.filename) == (
            posix_errno(condition),
            posix_phrase(condition),
            "/data/x",
        )
        assert classify(exc) is condition
        assert isinstance(exc, FS_ERRORS) is (kind is not OSError)
        assert fs_strerror(exc) == (
            posix_phrase(condition)
            if condition in OPERAND_CONDITIONS
            else None
        )


def test_fs_strerror_reads_a_bare_class_and_nothing_else():
    assert fs_strerror(FileNotFoundError()) == "No such file or directory"
    assert fs_strerror(PermissionError()) == "Permission denied"
    assert (
        fs_strerror(OperationNotSupportedError()) == "Operation not supported"
    )
    assert fs_strerror(ValueError("nope")) is None
    assert fs_strerror(OSError(errno.EIO, "Input/output error", "/d")) is None


def test_enotsup_carries_op_and_operand():
    exc = enotsup("email", "unlink", PathSpec.from_str_path("/mail/a.txt"))
    assert isinstance(exc, OperationNotSupportedError)
    assert exc.errno == errno.ENOTSUP
    assert exc.filename == "/mail/a.txt"
    assert "no op 'unlink'" in str(exc)
    assert (
        type(fs_error("/x", FsCondition.ENOTSUP)) is OperationNotSupportedError
    )


def _probes(files: set[str], dirs: set[str]):
    async def is_file(key: str) -> bool:
        return key in files

    async def is_dir(key: str) -> bool:
        return key in dirs

    return is_file, is_dir


FLAT = _probes({"/data/a.txt"}, {"/data", "/data/sub"})
ORPHAN = _probes({"/data/missing/a.txt"}, {"/data"})
BOTH = _probes({"/data/a", "/data/a/x"}, {"/data", "/data/a"})


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("key", "probes", "kind"),
    [
        ("/data/nope", FLAT, FileNotFoundError),
        ("/data/nope/deeper", FLAT, FileNotFoundError),
        ("/data/a.txt", FLAT, NotADirectoryError),
        ("/data/a.txt/x/y", FLAT, NotADirectoryError),
        ("/data/a.txt/never", FLAT, NotADirectoryError),
        ("/data/missing/a.txt", ORPHAN, FileNotFoundError),
        ("/data/missing/a.txt/x/y", ORPHAN, FileNotFoundError),
        ("/data/a/never", BOTH, FileNotFoundError),
        ("/data/a/never/deeper", BOTH, FileNotFoundError),
    ],
)
async def test_readdir_error_stops_where_the_kernel_walk_stops(
    key, probes, kind
):
    """A missing component is ENOENT however deep, a file component is
    ENOTDIR, a flat store's orphan (``/data/missing`` absent) stops the
    walk at the gap, the orphan itself included, and a directory beside
    an object of the same name wins, since traversal only reaches the
    name through it."""
    assert type(await readdir_error(key, key, *probes)) is kind


@pytest.mark.asyncio
async def test_listing_error_settles_a_file_operand_without_walking():
    """A store that cannot hold an orphan proves ENOTDIR in one probe,
    which keeps a ``readdir`` on a plain file to one request."""
    probed: list[str] = []

    async def counting_is_file(key: str) -> bool:
        probed.append(key)
        return key == "/data/deep/a.txt"

    async def unreachable_is_dir(key: str) -> bool:
        raise AssertionError(f"the walk should not have started: {key}")

    exc = await listing_error(
        "/data/deep/a.txt",
        "/data/deep/a.txt",
        counting_is_file,
        unreachable_is_dir,
    )
    assert isinstance(exc, NotADirectoryError)
    assert probed == ["/data/deep/a.txt"]


@pytest.mark.asyncio
async def test_listing_error_falls_back_to_the_walk():
    for key, expected in (
        ("/data/a.txt/never", NotADirectoryError),
        ("/data/nope/deeper", FileNotFoundError),
    ):
        exc = await listing_error(key, key, *FLAT)
        assert isinstance(exc, expected), key


@pytest.mark.asyncio
async def test_listing_error_asks_the_listed_path_about_a_file_once():
    asked: list[str] = []
    is_file, is_dir = FLAT

    async def counting_is_file(key: str) -> bool:
        asked.append(key)
        return await is_file(key)

    exc = await listing_error(
        "/data/sub/never", "/data/sub/never", counting_is_file, is_dir
    )
    assert isinstance(exc, FileNotFoundError)
    assert asked == ["/data/sub/never"]


@pytest.mark.asyncio
async def test_listing_error_asks_the_mount_root_nothing():
    async def unreachable(key: str) -> bool:
        raise AssertionError(f"the root needs no probe: {key}")

    exc = await listing_error("/", "/", unreachable, unreachable)
    assert isinstance(exc, FileNotFoundError)


def test_no_mount_is_a_typed_miss():
    # The registry's miss stays a ValueError for every existing catch,
    # but only the subclass classifies to ENOENT: a backend's bare
    # ValueError is a refusal, not absence.
    err = no_mount("/nowhere/x")
    assert isinstance(err, NoMountError)
    assert isinstance(err, ValueError)
    assert str(err) == "no mount matches path: '/nowhere/x'"
    assert classify(err) is FsCondition.ENOENT
    assert classify(ValueError("row too large to render")) is None


@pytest.mark.parametrize(
    ("condition", "kind"),
    [
        (FsCondition.ENOENT, DotWalkMissing),
        (FsCondition.ENOTDIR, DotWalkNotDir),
        (FsCondition.ELOOP, DotWalkLoop),
    ],
)
def test_dot_walk_error_raises_the_walk_refusal(condition, kind):
    exc = dot_walk_error("a/..", condition)
    assert type(exc) is kind
    assert classify(exc) is condition
    assert error_path(exc) == "a/.."


@pytest.mark.parametrize(
    ("raw", "walk_error", "cmd", "line"),
    [
        ("", "ENOENT", "cat", "cat: '': No such file or directory\n"),
        (
            "l1",
            "ELOOP",
            "head",
            "head: cannot open 'l1' for reading: "
            "Too many levels of symbolic links\n",
        ),
    ],
)
def test_walk_refusal_names_the_operand_as_typed(raw, walk_error, cmd, line):
    # `virtual` reads the empty name as the working directory, so the
    # refusal carries the spelling the command reports.
    spec = PathSpec(
        virtual="/data/l1" if raw else "/data",
        directory="/data/" if raw else "/",
        vfs_path=raw,
        raw_path=raw,
        walk_error=walk_error,
    )
    exc = walk_refusal(spec)
    assert isinstance(exc, FS_ERRORS)
    assert error_path(exc) == raw
    assert fs_error_line(cmd, spec, exc) == line
