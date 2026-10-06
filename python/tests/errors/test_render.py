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

from mirage.errors.fs import (
    dot_walk_error,
    ebadf,
    efbig,
    eisdir,
    enoent,
    enotdir,
    enotempty,
    enotsup,
    exdev,
)
from mirage.errors.render import (
    format_fs_error,
    fs_error_line,
    revoice_fs_error_line,
)
from mirage.errors.types import FsCondition
from mirage.types import PathSpec
from mirage.utils.path import CycleError

_ENOENT = "No such file or directory"
_NOPE = "/data/nope.txt"
_SUB = "/data/sub"
_FILE = "/data/a.txt/x"
_QUOTED = PathSpec(
    virtual="/data/it's.txt",
    directory="/data/",
    vfs_path="it's.txt",
    raw_path="it's.txt",
)
_EMPTY = PathSpec(virtual="/data", directory="/", vfs_path="data", raw_path="")


@pytest.mark.parametrize(
    ("cmd", "operand", "make", "step"),
    [
        ("head", _NOPE, enoent, f"cannot open '{_NOPE}' for reading"),
        ("tail", _NOPE, enoent, f"cannot open '{_NOPE}' for reading"),
        ("fmt", _NOPE, enoent, f"cannot open '{_NOPE}' for reading"),
        ("split", _NOPE, enoent, f"cannot open '{_NOPE}' for reading"),
        ("csplit", _NOPE, enoent, f"cannot open '{_NOPE}' for reading"),
        ("tac", _NOPE, enoent, f"failed to open '{_NOPE}' for reading"),
        ("truncate", _NOPE, enoent, f"cannot open '{_NOPE}' for writing"),
        ("stat", _NOPE, enoent, f"cannot statx '{_NOPE}'"),
        ("sed", _NOPE, enoent, f"can't read {_NOPE}"),
        ("uniq", _NOPE, enoent, _NOPE),
        ("head", _QUOTED, enoent, 'cannot open "it\'s.txt" for reading'),
        ("stat", _QUOTED, enoent, 'cannot statx "it\'s.txt"'),
        ("sed", _QUOTED, enoent, "can't read it's.txt"),
        ("stat", "/data/a\tb", enoent, "cannot statx '/data/a'$'\\t''b'"),
        ("tail", "", enoent, "cannot open '' for reading"),
        ("tac", _EMPTY, enoent, "failed to open '' for reading"),
        ("cat", _EMPTY, enoent, "''"),
        ("head", _SUB, eisdir, f"error reading '{_SUB}'"),
        ("tail", _SUB, eisdir, f"error reading '{_SUB}'"),
        ("uniq", _SUB, eisdir, f"error reading '{_SUB}'"),
        ("tac", _SUB, eisdir, f"{_SUB}: read error"),
        ("tac", "/data/a b", eisdir, "'/data/a b': read error"),
        ("tac", "/data/c:d", eisdir, "'/data/c:d': read error"),
        ("tsort", _SUB, eisdir, f"{_SUB}: read error"),
        ("sed", _SUB, eisdir, f"read error on {_SUB}"),
        ("truncate", _SUB, eisdir, f"cannot open '{_SUB}' for writing"),
        ("stat", _SUB, eisdir, f"cannot statx '{_SUB}'"),
        ("fmt", _SUB, eisdir, _SUB),
        ("base64", _SUB, eisdir, _SUB),
        ("tac", _FILE, enotdir, f"failed to open '{_FILE}' for reading"),
        ("stat", _FILE, enotdir, f"cannot statx '{_FILE}'"),
        ("truncate", _FILE, enotdir, f"cannot open '{_FILE}' for writing"),
        ("tail", "-", ebadf, "-"),
        ("tac", "-", ebadf, "-"),
    ],
)
def test_each_command_names_its_own_failed_step(cmd, operand, make, step):
    # The errno is the backend's; the step and the quoting are the
    # command's. The reference fmt and base64 read lines name no operand,
    # so those keep the plain one; an empty raw_path is the operand as
    # typed, not the path it resolved to.
    exc = make(operand)
    line = fs_error_line(cmd, operand, exc)
    assert line == f"{cmd}: {step}: {exc.strerror}\n"


@pytest.mark.parametrize("cmd", ["wc", "du"])
def test_wc_and_du_vet_the_empty_name(cmd):
    assert fs_error_line(cmd, "", enoent("")) == (
        f"{cmd}: invalid zero-length file name\n"
    )


@pytest.mark.parametrize(
    ("cmd", "exc", "words"),
    [
        ("cat", enoent("/b/x"), f"/b/x: {_ENOENT}"),
        ("ls", enoent("/b/x"), f"cannot access '/b/x': {_ENOENT}"),
        ("head", enoent("/b/x"), f"cannot open '/b/x' for reading: {_ENOENT}"),
        ("stat", enoent("/b/x"), f"cannot statx '/b/x': {_ENOENT}"),
        ("cat", dot_walk_error("", FsCondition.ENOENT), f"'': {_ENOENT}"),
        (
            "mv",
            enotsup("email", "unlink", "/m"),
            "/m: Operation not supported",
        ),
        ("cat", efbig("/r"), "/r: File too large"),
        (
            "rmdir",
            enotempty("/d"),
            "failed to remove '/d': Directory not empty",
        ),
        ("mv", exdev("/d"), "/d: Invalid cross-device link"),
        ("cat", CycleError("/l"), "/l: Too many levels of symbolic links"),
        ("slack", RuntimeError("API error"), "API error"),
        (
            "slack",
            ValueError("--channel_id is required"),
            "--channel_id is required",
        ),
        ("uniq", ValueError("uniq: invalid count: '2'"), "invalid count: '2'"),
    ],
)
def test_format_fs_error_says_the_line_the_command_would(cmd, exc, words):
    # A filesystem error is the operand's line; anything else is the
    # command's prefix and the error's own words, never doubled.
    assert format_fs_error(cmd, exc) == f"{cmd}: {words}\n".encode()


def test_format_fs_error_spells_the_operand_the_caller_passes():
    typed = PathSpec(
        virtual="/a/x.txt", directory="/a/", vfs_path="x.txt", raw_path="x.txt"
    )
    assert format_fs_error("diff", enoent("/a/x.txt"), [typed]) == (
        f"diff: x.txt: {_ENOENT}\n".encode()
    )
    records = PathSpec.from_str_path("/r")
    for cmd in ("head", "tail"):
        assert format_fs_error(cmd, efbig(records), [records]) == (
            f"{cmd}: error reading '/r': File too large\n".encode()
        )


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
