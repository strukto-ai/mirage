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

from mirage.errors.fs import (
    efbig,
    eisdir,
    enoent,
    enotdir,
    enotsup,
)
from mirage.errors.render import (
    format_fs_error,
    fs_error_line,
    revoice_fs_error_line,
)
from mirage.errors.types import (
    BadDescriptorError,
)
from mirage.types import PathSpec


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


def test_format_fs_error_enotsup_reports_operand():
    err = format_fs_error("mv", enotsup("email", "unlink", "/mail/a.txt"))
    assert err == b"mv: /mail/a.txt: Operation not supported\n"


@pytest.mark.parametrize("cmd", ["head", "tail"])
def test_read_cap_failure_names_the_read_at_the_chokepoint(cmd):
    spec = PathSpec.from_str_path("/records.jsonl")
    assert format_fs_error(cmd, efbig(spec), [spec]) == (
        f"{cmd}: error reading '/records.jsonl': File too large\n".encode()
    )


@pytest.mark.parametrize("cmd", ["wc", "du"])
def test_wc_and_du_vet_the_empty_name(cmd):
    assert fs_error_line(cmd, "", enoent("")) == (
        f"{cmd}: invalid zero-length file name\n"
    )


def test_other_commands_name_the_empty_operand_quoted():
    assert fs_error_line("tail", "", enoent("")) == (
        "tail: cannot open '' for reading: No such file or directory\n"
    )
