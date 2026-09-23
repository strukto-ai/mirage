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
from mirage.types import PathSpec
from mirage.utils.errors import (NoMountError, OperationNotSupportedError,
                                 eacces, eloop, enoent, enotdir, enotempty,
                                 enotsup, error_path, exdev, format_fs_error,
                                 fs_strerror, listing_error, no_mount,
                                 readdir_error)


def test_fs_strerror_known_types():
    assert fs_strerror(FileNotFoundError()) == "No such file or directory"
    assert fs_strerror(NotADirectoryError()) == "Not a directory"
    assert fs_strerror(IsADirectoryError()) == "Is a directory"
    assert fs_strerror(FileExistsError()) == "File exists"
    assert fs_strerror(PermissionError()) == "Permission denied"
    assert (fs_strerror(
        OperationNotSupportedError()) == "Operation not supported")


def test_fs_strerror_unknown_returns_none():
    assert fs_strerror(ValueError("nope")) is None


def test_enoent_uses_virtual_path():
    spec = PathSpec.from_str_path("/a/missing.txt")
    exc = enoent(spec)
    assert isinstance(exc, FileNotFoundError)
    assert str(exc) == "/a/missing.txt"


def test_enotdir_accepts_plain_string():
    exc = enotdir("/a/file.txt/x")
    assert isinstance(exc, NotADirectoryError)
    assert str(exc) == "/a/file.txt/x"


def test_format_fs_error_appends_strerror():
    err = format_fs_error("cat", enoent("/b/missing.txt"))
    assert err == b"cat: /b/missing.txt: No such file or directory\n"


def test_format_fs_error_rewrites_to_raw_path():
    spec = PathSpec(virtual="/a/missing.txt",
                    directory="/a/",
                    vfs_path="missing.txt",
                    raw_path="missing.txt")
    err = format_fs_error("diff", enoent("/a/missing.txt"), [spec])
    assert err == b"diff: missing.txt: No such file or directory\n"


def test_format_fs_error_prefers_exc_filename():
    exc = FileNotFoundError(2, "No such file or directory", "/a/gone.txt")
    err = format_fs_error("head", exc)
    assert err == b"head: /a/gone.txt: No such file or directory\n"


def test_format_fs_error_generic_prefixes_command():
    err = format_fs_error(
        "slack-add-reaction",
        RuntimeError("Slack API error (reactions.add): message_not_found"))
    assert err == (b"slack-add-reaction: Slack API error "
                   b"(reactions.add): message_not_found\n")


def test_format_fs_error_generic_value_error():
    err = format_fs_error("slack-add-reaction",
                          ValueError("--channel_id is required"))
    assert err == b"slack-add-reaction: --channel_id is required\n"


def test_format_fs_error_generic_does_not_double_prefix():
    # Many generic commands raise a fully GNU-formatted message already
    # carrying the "<cmd>: " prefix; it must not be doubled (uniq: uniq: ...).
    err = format_fs_error("uniq", ValueError("uniq: invalid count: '2junk'"))
    assert err == b"uniq: invalid count: '2junk'\n"


def test_enotsup_carries_op_and_operand():
    spec = PathSpec.from_str_path("/mail/inbox/a.txt")
    exc = enotsup("email", "unlink", spec)
    assert isinstance(exc, OperationNotSupportedError)
    assert exc.errno == errno.ENOTSUP
    assert exc.filename == "/mail/inbox/a.txt"
    assert "no op 'unlink'" in str(exc)


def test_format_fs_error_enotsup_reports_operand():
    err = format_fs_error("mv", enotsup("email", "unlink", "/mail/a.txt"))
    assert err == b"mv: /mail/a.txt: Operation not supported\n"


async def _is_file(key: str) -> bool:
    return key == "/data/a.txt"


async def _is_dir(key: str) -> bool:
    return key in ("/data", "/data/sub")


async def _orphan_is_file(key: str) -> bool:
    return key == "/data/missing/a.txt"


async def _orphan_is_dir(key: str) -> bool:
    return key == "/data"


@pytest.mark.asyncio
async def test_readdir_error_missing_path_is_enoent():
    exc = await readdir_error("/data/nope", "/data/nope", _is_file, _is_dir)
    assert isinstance(exc, FileNotFoundError)
    assert fs_strerror(exc) == "No such file or directory"


@pytest.mark.asyncio
async def test_readdir_error_missing_stays_enoent_at_any_depth():
    # GNU `ls /data/nope/deeper` reports the missing component, not ENOTDIR.
    exc = await readdir_error("/data/nope/deeper", "/data/nope/deeper",
                              _is_file, _is_dir)
    assert isinstance(exc, FileNotFoundError)


@pytest.mark.asyncio
async def test_readdir_error_file_component_is_enotdir():
    for key in ("/data/a.txt", "/data/a.txt/x", "/data/a.txt/x/y"):
        exc = await readdir_error(key, key, _is_file, _is_dir)
        assert isinstance(exc, NotADirectoryError), key
        assert fs_strerror(exc) == "Not a directory"


@pytest.mark.asyncio
async def test_readdir_error_stops_at_the_first_missing_component():
    """A flat store can hold a key under a parent that is not a directory
    (RAM/Redis rename does not create the destination's ancestors). The walk
    must stop where the kernel would, at `/data/missing`, instead of finding
    the orphan below it and reporting ENOTDIR.
    """
    for key in ("/data/missing/a.txt/x", "/data/missing/a.txt/x/y"):
        exc = await readdir_error(key, key, _orphan_is_file, _orphan_is_dir)
        assert isinstance(exc, FileNotFoundError), key


async def _both_is_file(key: str) -> bool:
    return key in ("/data/a", "/data/a/x")


async def _both_is_dir(key: str) -> bool:
    return key in ("/data", "/data/a")


@pytest.mark.asyncio
async def test_readdir_error_prefers_a_coexisting_directory():
    """A keyed store can hold an object ``a`` and a prefix ``a/`` at once,
    and a child path only ever reaches ``a`` through the directory. So the
    directory wins: ``/data/a/never`` is ENOENT because ``never`` is absent,
    not ENOTDIR because ``a`` is also an object.
    """
    for key in ("/data/a/never", "/data/a/never/deeper"):
        exc = await readdir_error(key, key, _both_is_file, _both_is_dir)
        assert isinstance(exc, FileNotFoundError), key


@pytest.mark.asyncio
async def test_readdir_error_object_only_component_is_still_enotdir():
    # The mirror of the case above: with no coexisting prefix, traversal
    # really does hit a non-directory.
    exc = await readdir_error("/data/a.txt/never", "/data/a.txt/never",
                              _is_file, _is_dir)
    assert isinstance(exc, NotADirectoryError)


@pytest.mark.asyncio
async def test_readdir_error_orphan_exact_file_is_enoent():
    """The generic walk must not shortcut on the listed path itself.

    A flat store can hold `/data/missing/a.txt` with `/data/missing`
    absent, and resolution stops at the gap: `readdir` of the orphan
    itself is ENOENT, not ENOTDIR, exactly as it already is one level
    below. `listing_error` is where the shortcut lives, for the stores
    that cannot hold the gap.
    """
    exc = await readdir_error("/data/missing/a.txt", "/data/missing/a.txt",
                              _orphan_is_file, _orphan_is_dir)
    assert isinstance(exc, FileNotFoundError)


@pytest.mark.asyncio
async def test_listing_error_settles_a_file_operand_without_walking():
    """A store that cannot hold an orphan proves ENOTDIR in one probe.

    That is what keeps a `readdir` on a plain file to one round trip on
    an API-backed mount, where each probe is a request.
    """
    probed: list[str] = []

    async def counting_is_file(key: str) -> bool:
        probed.append(key)
        return key == "/data/deep/a.txt"

    async def unreachable_is_dir(key: str) -> bool:
        raise AssertionError(f"the walk should not have started: {key}")

    exc = await listing_error("/data/deep/a.txt", "/data/deep/a.txt",
                              counting_is_file, unreachable_is_dir)
    assert isinstance(exc, NotADirectoryError)
    assert probed == ["/data/deep/a.txt"]


@pytest.mark.asyncio
async def test_listing_error_falls_back_to_the_walk():
    for key, expected in (("/data/a.txt/never", NotADirectoryError),
                          ("/data/nope/deeper", FileNotFoundError)):
        exc = await listing_error(key, key, _is_file, _is_dir)
        assert isinstance(exc, expected), key


@pytest.mark.asyncio
async def test_listing_error_asks_the_mount_root_nothing():

    async def unreachable(key: str) -> bool:
        raise AssertionError(f"the root needs no probe: {key}")

    exc = await listing_error("/", "/", unreachable, unreachable)
    assert isinstance(exc, FileNotFoundError)


@pytest.mark.asyncio
async def test_readdir_error_reports_the_virtual_path():
    spec = PathSpec.from_str_path("/data/nope")
    exc = await readdir_error(spec, "/data/nope", _is_file, _is_dir)
    assert format_fs_error(
        "ls", exc) == (b"ls: /data/nope: No such file or directory\n")


def test_new_constructors_name_their_condition():
    # The four constructors python was missing (R5a): each construction
    # classifies to its own condition, so no boundary needs a message
    # needle to recognize it.
    spec = PathSpec.from_str_path("/data/x")
    assert classify(eacces(spec)) is FsCondition.EACCES
    assert classify(enotempty(spec)) is FsCondition.ENOTEMPTY
    assert classify(exdev(spec)) is FsCondition.EXDEV
    assert classify(eloop(spec)) is FsCondition.ELOOP


def test_new_constructors_carry_the_virtual_path():
    spec = PathSpec.from_str_path("/data/x")
    for exc in (eacces(spec), enotempty(spec), exdev(spec), eloop(spec)):
        assert error_path(exc) == "/data/x"


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
