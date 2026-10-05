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
from mirage.utils.errors import (
    FS_ERRORS,
    BadDescriptorError,
    DotWalkError,
    DotWalkLoop,
    DotWalkMissing,
    FileTooLargeError,
    NoMountError,
    OperationNotSupportedError,
    eacces,
    efbig,
    eisdir,
    eloop,
    enoent,
    enotdir,
    enotempty,
    enotsup,
    error_path,
    exdev,
    format_fs_error,
    fs_error_line,
    fs_strerror,
    listing_error,
    no_mount,
    readdir_error,
    revoice_fs_error_line,
    walk_refusal,
)


def test_fs_strerror_known_types():
    assert fs_strerror(FileNotFoundError()) == "No such file or directory"
    assert fs_strerror(NotADirectoryError()) == "Not a directory"
    assert fs_strerror(IsADirectoryError()) == "Is a directory"
    assert fs_strerror(FileExistsError()) == "File exists"
    assert fs_strerror(PermissionError()) == "Permission denied"
    assert (
        fs_strerror(OperationNotSupportedError()) == "Operation not supported"
    )


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
    spec = PathSpec(
        virtual="/a/missing.txt",
        directory="/a/",
        vfs_path="missing.txt",
        raw_path="missing.txt",
    )
    err = format_fs_error("diff", enoent("/a/missing.txt"), [spec])
    assert err == b"diff: missing.txt: No such file or directory\n"


def test_format_fs_error_prefers_exc_filename():
    exc = FileNotFoundError(2, "No such file or directory", "/a/gone.txt")
    err = format_fs_error("cat", exc)
    assert err == b"cat: /a/gone.txt: No such file or directory\n"


_ENOENT = "No such file or directory"


@pytest.mark.parametrize(
    "cmd,line",
    [
        (
            "head",
            f"head: cannot open '/data/nope.txt' for reading: {_ENOENT}\n",
        ),
        (
            "tail",
            f"tail: cannot open '/data/nope.txt' for reading: {_ENOENT}\n",
        ),
        ("fmt", f"fmt: cannot open '/data/nope.txt' for reading: {_ENOENT}\n"),
        (
            "split",
            f"split: cannot open '/data/nope.txt' for reading: {_ENOENT}\n",
        ),
        (
            "csplit",
            f"csplit: cannot open '/data/nope.txt' for reading: {_ENOENT}\n",
        ),
        (
            "tac",
            f"tac: failed to open '/data/nope.txt' for reading: {_ENOENT}\n",
        ),
        (
            "truncate",
            f"truncate: cannot open '/data/nope.txt' for writing: {_ENOENT}\n",
        ),
        ("stat", f"stat: cannot statx '/data/nope.txt': {_ENOENT}\n"),
        ("sed", f"sed: can't read /data/nope.txt: {_ENOENT}\n"),
        ("uniq", f"uniq: /data/nope.txt: {_ENOENT}\n"),
    ],
)
def test_open_failure_line_names_the_failed_open(cmd, line):
    assert (
        fs_error_line(cmd, "/data/nope.txt", enoent("/data/nope.txt")) == line
    )


@pytest.mark.parametrize(
    "cmd,line",
    [
        ("head", "head: error reading '/data/sub': Is a directory\n"),
        ("tail", "tail: error reading '/data/sub': Is a directory\n"),
        ("uniq", "uniq: error reading '/data/sub': Is a directory\n"),
        ("tac", "tac: /data/sub: read error: Is a directory\n"),
        ("tsort", "tsort: /data/sub: read error: Is a directory\n"),
        ("sed", "sed: read error on /data/sub: Is a directory\n"),
        (
            "truncate",
            "truncate: cannot open '/data/sub' for writing: Is a directory\n",
        ),
        ("fmt", "fmt: /data/sub: Is a directory\n"),
        ("base64", "base64: /data/sub: Is a directory\n"),
    ],
)
def test_open_failure_line_names_a_directory_read(cmd, line):
    # GNU's own fmt and base64 lines (`fmt: read error`, `base64: read
    # error: Is a directory`) name no operand, so those keep the plain one.
    assert fs_error_line(cmd, "/data/sub", eisdir("/data/sub")) == line


@pytest.mark.parametrize(
    "cmd,line",
    [
        ("head", f'head: cannot open "it\'s.txt" for reading: {_ENOENT}\n'),
        ("stat", f'stat: cannot statx "it\'s.txt": {_ENOENT}\n'),
        ("sed", f"sed: can't read it's.txt: {_ENOENT}\n"),
    ],
)
def test_open_failure_line_quotes_the_operand_as_typed(cmd, line):
    spec = PathSpec(
        virtual="/data/it's.txt",
        directory="/data/",
        vfs_path="it's.txt",
        raw_path="it's.txt",
    )
    assert fs_error_line(cmd, spec, enoent(spec)) == line


@pytest.mark.parametrize(
    "line,said",
    [
        (
            "cat: /b/nope: No such file or directory",
            "sed: can't read /b/nope: No such file or directory",
        ),
        (
            "cat: '/b/a b': Is a directory",
            "sed: read error on /b/a b: Is a directory",
        ),
        (
            "cat: /b/other: No such file or directory",
            "sed: /b/other: No such file or directory",
        ),
        ("unrelated", "unrelated"),
    ],
)
def test_revoice_says_a_fetch_line_in_the_real_command_voice(line, said):
    # A line that is cat's own for the operand is said again from its
    # strerror; one about another path only has its prefix swapped.
    operand = "/b/a b" if "a b" in line else "/b/nope"
    assert revoice_fs_error_line(line, "cat", "sed", operand) == said


def test_open_failure_line_leaves_standard_input_bare():
    exc = BadDescriptorError(errno.EBADF, "Bad file descriptor", "-")
    assert fs_error_line("tail", "-", exc) == "tail: -: Bad file descriptor\n"


def test_format_fs_error_words_a_head_open_failure():
    exc = FileNotFoundError(2, "No such file or directory", "/a/gone.txt")
    assert format_fs_error("head", exc) == (
        b"head: cannot open '/a/gone.txt' for reading: "
        b"No such file or directory\n"
    )


@pytest.mark.parametrize(
    ("cmd", "step"),
    [
        ("tac", "failed to open '/data/a.txt/x' for reading"),
        ("stat", "cannot statx '/data/a.txt/x'"),
        ("truncate", "cannot open '/data/a.txt/x' for writing"),
    ],
)
def test_each_command_names_its_own_failed_step(cmd, step):
    # The errno is the backend's either way; only the step and the
    # quoting are the command's (coreutils 9.7).
    for exc, strerror in (
        (enoent("/data/a.txt/x"), "No such file or directory"),
        (enotdir("/data/a.txt/x"), "Not a directory"),
    ):
        line = fs_error_line(cmd, "/data/a.txt/x", exc)
        assert line == f"{cmd}: {step}: {strerror}\n"


def test_tac_names_a_directory_read_first_and_quotes_it_when_needed():
    # tac's read failure leads with the name, which GNU quotes the way
    # quotef does: only a name that needs it, ':' included.
    assert fs_error_line("tac", "/data/sub", eisdir("/data/sub")) == (
        "tac: /data/sub: read error: Is a directory\n"
    )
    assert fs_error_line("tac", "/data/a b", eisdir("/data/a b")) == (
        "tac: '/data/a b': read error: Is a directory\n"
    )
    assert fs_error_line("tac", "/data/c:d", eisdir("/data/c:d")) == (
        "tac: '/data/c:d': read error: Is a directory\n"
    )


def test_stat_and_truncate_say_one_step_for_a_directory():
    assert fs_error_line("truncate", "/data/sub", eisdir("/data/sub")) == (
        "truncate: cannot open '/data/sub' for writing: Is a directory\n"
    )
    assert fs_error_line("stat", "/data/sub", eisdir("/data/sub")) == (
        "stat: cannot statx '/data/sub': Is a directory\n"
    )


def test_a_step_line_escapes_a_control_character_in_the_name():
    line = fs_error_line("stat", "/data/a\tb", enoent("/data/a\tb"))
    assert line == (
        "stat: cannot statx '/data/a'$'\\t''b': No such file or directory\n"
    )


def test_tac_leaves_standard_input_bare():
    exc = BadDescriptorError(errno.EBADF, "Bad file descriptor", "-")
    assert fs_error_line("tac", "-", exc) == "tac: -: Bad file descriptor\n"


def test_an_empty_operand_is_named_as_typed():
    # An empty raw_path is the operand as typed, not a missing one, so it
    # is not replaced by the virtual path it resolved to; the TypeScript
    # formatter reads it the same way.
    spec = PathSpec(
        virtual="/data", directory="/", vfs_path="data", raw_path=""
    )
    assert fs_error_line("tac", spec, enoent(spec)) == (
        "tac: failed to open '' for reading: No such file or directory\n"
    )
    assert fs_error_line("cat", spec, enoent(spec)) == (
        "cat: '': No such file or directory\n"
    )


def test_format_fs_error_words_a_stat_failure():
    exc = FileNotFoundError(2, "No such file or directory", "/a/gone.txt")
    assert format_fs_error("stat", exc) == (
        b"stat: cannot statx '/a/gone.txt': No such file or directory\n"
    )


def test_format_fs_error_generic_prefixes_command():
    err = format_fs_error(
        "slack-add-reaction",
        RuntimeError("Slack API error (reactions.add): message_not_found"),
    )
    assert err == (
        b"slack-add-reaction: Slack API error "
        b"(reactions.add): message_not_found\n"
    )


def test_format_fs_error_generic_value_error():
    err = format_fs_error(
        "slack-add-reaction", ValueError("--channel_id is required")
    )
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
    exc = await readdir_error(
        "/data/nope/deeper", "/data/nope/deeper", _is_file, _is_dir
    )
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
    exc = await readdir_error(
        "/data/a.txt/never", "/data/a.txt/never", _is_file, _is_dir
    )
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
    exc = await readdir_error(
        "/data/missing/a.txt",
        "/data/missing/a.txt",
        _orphan_is_file,
        _orphan_is_dir,
    )
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
        exc = await listing_error(key, key, _is_file, _is_dir)
        assert isinstance(exc, expected), key


@pytest.mark.asyncio
async def test_listing_error_asks_the_listed_path_about_a_file_once():
    """The walk ends at the listed path, which the first probe already
    found is not a file; on an API-backed mount a second ask is a
    second request."""
    asked: list[str] = []

    async def counting_is_file(key: str) -> bool:
        asked.append(key)
        return await _is_file(key)

    exc = await listing_error(
        "/data/sub/never", "/data/sub/never", counting_is_file, _is_dir
    )
    assert isinstance(exc, FileNotFoundError)
    assert asked == ["/data/sub/never"]


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
    assert format_fs_error("ls", exc) == (
        b"ls: /data/nope: No such file or directory\n"
    )


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


def test_efbig_is_a_per_operand_fs_error():
    exc = efbig(PathSpec.from_str_path("/at/records.jsonl"))
    assert isinstance(exc, FileTooLargeError)
    assert isinstance(exc, FS_ERRORS)
    assert exc.errno == errno.EFBIG
    assert error_path(exc) == "/at/records.jsonl"
    assert (
        format_fs_error("cat", exc)
        == b"cat: /at/records.jsonl: File too large\n"
    )


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


@pytest.mark.parametrize("cmd", ["head", "tail"])
def test_read_cap_failure_names_the_read_at_the_chokepoint(cmd):
    spec = PathSpec.from_str_path("/records.jsonl")
    assert format_fs_error(cmd, efbig(spec), [spec]) == (
        f"{cmd}: error reading '/records.jsonl': File too large\n".encode()
    )


def test_walk_refusal_names_the_empty_operand_as_typed():
    # `virtual` reads the empty name as the working directory, so the
    # refusal carries the spelling the command reports.
    spec = PathSpec(
        virtual="/data",
        directory="/",
        vfs_path="",
        raw_path="",
        walk_error="ENOENT",
    )
    exc = walk_refusal(spec)
    assert isinstance(exc, DotWalkMissing)
    assert error_path(exc) == ""
    assert fs_error_line("cat", spec, exc) == (
        "cat: '': No such file or directory\n"
    )
    assert format_fs_error("cat", exc) == (
        b"cat: '': No such file or directory\n"
    )


def test_walk_refusal_of_a_loop_is_a_final_per_operand_error():
    spec = PathSpec(
        virtual="/data/l1",
        directory="/data/",
        vfs_path="l1",
        raw_path="l1",
        walk_error="ELOOP",
    )
    exc = walk_refusal(spec)
    assert isinstance(exc, DotWalkLoop)
    assert isinstance(exc, DotWalkError)
    assert isinstance(exc, FS_ERRORS)
    assert classify(exc) is FsCondition.ELOOP
    assert fs_error_line("head", spec, exc) == (
        "head: cannot open 'l1' for reading: "
        "Too many levels of symbolic links\n"
    )


def test_eloop_is_typed_and_classified():
    exc = eloop(PathSpec.from_str_path("/data/l1"))
    assert isinstance(exc, DotWalkLoop)
    assert exc.errno == errno.ELOOP
    assert fs_strerror(exc) == "Too many levels of symbolic links"


@pytest.mark.parametrize("cmd", ["wc", "du"])
def test_wc_and_du_vet_the_empty_name(cmd):
    assert fs_error_line(cmd, "", enoent("")) == (
        f"{cmd}: invalid zero-length file name\n"
    )


def test_other_commands_name_the_empty_operand_quoted():
    assert fs_error_line("tail", "", enoent("")) == (
        "tail: cannot open '' for reading: No such file or directory\n"
    )
