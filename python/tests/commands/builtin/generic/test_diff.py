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
from collections.abc import AsyncIterator
from types import SimpleNamespace

import pytest

from mirage.commands.builtin.generic.diff import (
    DiffFlags,
    diff,
    parse_flags,
    quote_header_name,
    switch_words,
)
from mirage.commands.spec import SPECS
from mirage.core.api.errors import ApiError
from mirage.io.memory import MemoryBudget, run_with_memory
from mirage.io.stream import OutputStream
from mirage.io.types import IOResult, materialize
from mirage.rs.diff_pool import DiffPool
from mirage.rs.diff_types import DiffOptions, PairResult
from mirage.types import FileStat, FileType, MountMode, PathSpec
from mirage.utils.timezone import resolve_tz
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.executor.command.flags import (
    parse_flags as parse_line_flags,
)


def _operand(raw: str, virtual: str) -> PathSpec:
    return PathSpec(
        virtual=virtual,
        directory=virtual,
        vfs_path=virtual.removeprefix("/d/"),
        raw_path=raw,
    )


DASH = _operand("-", "/d/-")
DEV_STDIN = PathSpec.from_str_path("/dev/stdin", "")
DIRS = {"/d/sub": ["x"], "/d/sub2": ["x", "y"]}


@pytest.mark.asyncio
async def test_brief_comparison_reads_inputs_larger_than_the_default_budget():
    read_bytes = 0

    async def read(path):
        nonlocal read_bytes
        chunk = b"x" * 16384
        for _ in range(2176):
            read_bytes += len(chunk)
            yield chunk

    async def run():
        out, io = await diff(
            [_operand("a", "/d/a"), _operand("b", "/d/b")],
            stream=read,
            readdir_fn=_readdir,
            stat_fn=_stat,
            flags=DiffFlags(DiffOptions(brief=True)),
        )
        assert await materialize(out) == b""
        assert io.exit_code == 0

    await run_with_memory(MemoryBudget(32 << 20, lambda: 0), run())
    assert read_bytes == 68 << 20


@pytest.mark.asyncio
async def test_brief_answers_from_sizes_and_stops_at_the_first_difference():
    read_bytes = 0
    files = {"/d/a": b"x" * 5000, "/d/b": b"x" * 5001, "/d/c": b"y" * 5000}

    async def read(path: PathSpec) -> AsyncIterator[bytes]:
        nonlocal read_bytes
        data = files[path.virtual]
        for at in range(0, len(data), 1000):
            read_bytes += 1000
            yield data[at : at + 1000]

    async def size_of(path: PathSpec) -> int | None:
        return len(files[path.virtual])

    for other, read_total, sizes in (("b", 0, size_of), ("c", 2000, None)):
        read_bytes = 0
        out, io = await diff(
            [_operand("a", "/d/a"), _operand(other, f"/d/{other}")],
            stream=read,
            readdir_fn=_readdir,
            stat_fn=_stat,
            flags=DiffFlags(DiffOptions(brief=True)),
            size_of=sizes,
        )
        assert (
            await materialize(out) == f"Files a and {other} differ\n".encode()
        )
        assert (io.exit_code, read_bytes) == (1, read_total)


async def _readdir(path: PathSpec) -> list[str]:
    return DIRS[path.virtual]


async def _stat(path: PathSpec) -> FileStat:
    kind = FileType.DIRECTORY if path.virtual in DIRS else FileType.FILE
    return FileStat(name=path.virtual.rsplit("/", 1)[-1], type=kind)


@pytest.mark.asyncio
async def test_two_stdin_operands_are_one_file():
    async def unread(path: PathSpec) -> bytes:
        raise AssertionError(f"read {path.virtual}")

    out, io = await diff(
        [DASH, DEV_STDIN],
        stream=unread,
        readdir_fn=_readdir,
        stat_fn=_stat,
        flags=DiffFlags(),
        stdin=b"abc",
    )
    assert (out, io.exit_code) == (None, 0)


@pytest.mark.asyncio
async def test_a_missing_operand_is_named_before_either_is_read():
    async def unread(path: PathSpec) -> bytes:
        raise AssertionError(f"read {path.virtual}")

    async def stat(path: PathSpec) -> FileStat:
        if path.virtual == "/d/gone":
            raise FileNotFoundError(
                2, "No such file or directory", path.virtual
            )
        return FileStat(name=path.virtual, type=FileType.FILE)

    out, io = await diff(
        [_operand("slow", "/d/slow"), _operand("gone", "/d/gone")],
        stream=unread,
        readdir_fn=_readdir,
        stat_fn=stat,
        flags=DiffFlags(),
    )
    assert (out, io.exit_code, io.stderr) == (
        None,
        2,
        b"diff: gone: No such file or directory\n",
    )


@pytest.mark.asyncio
async def test_each_operand_that_fails_its_stat_is_named():
    async def unread(path: PathSpec) -> bytes:
        raise AssertionError(f"read {path.virtual}")

    async def stat(path: PathSpec) -> FileStat:
        if path.virtual == "/d/gone":
            raise FileNotFoundError(
                2, "No such file or directory", path.virtual
            )
        raise NotADirectoryError(20, "Not a directory", path.virtual)

    out, io = await diff(
        [_operand("gone", "/d/gone"), _operand("f/child", "/d/f/child")],
        stream=unread,
        readdir_fn=_readdir,
        stat_fn=stat,
        flags=DiffFlags(new_file=True, new_first=True),
    )
    assert (out, io.exit_code, io.stderr) == (
        None,
        2,
        b"diff: gone: No such file or directory\n"
        b"diff: f/child: Not a directory\n",
    )


@pytest.mark.asyncio
async def test_a_read_failing_mid_stream_is_trouble_and_closes_its_input():
    closed: list[str] = []

    async def read(path: PathSpec) -> AsyncIterator[bytes]:
        try:
            yield b"x\n"
            if path.virtual == "/d/a":
                raise PermissionError(13, "Permission denied", path.virtual)
            yield b"y\n"
        finally:
            closed.append(path.virtual)

    pool = DiffPool()
    try:
        failed = [_operand("a", "/d/a"), _operand("b", "/d/b")]
        out, io = await diff(
            failed,
            stream=read,
            readdir_fn=_readdir,
            stat_fn=_stat,
            flags=DiffFlags(),
            computer=pool,
        )
        assert (out, io.exit_code) == (None, 2)
        assert await materialize(io.stderr) == b"diff: a: Permission denied\n"
        assert closed == ["/d/a"]
        same = [_operand("b", "/d/b"), _operand("c", "/d/c")]
        out, io = await diff(
            same,
            stream=read,
            readdir_fn=_readdir,
            stat_fn=_stat,
            flags=DiffFlags(),
            computer=pool,
        )
        assert io.exit_code == 0
        assert closed == ["/d/a", "/d/b", "/d/c"]
    finally:
        await pool.close()


def test_switch_words_keep_the_option_words_as_typed():
    assert switch_words(["-ru", "--exclude", ".git", "a", "b", "-x*.log"]) == [
        "-ru",
        "--exclude",
        ".git",
        "-x*.log",
    ]
    assert switch_words(["--exclude=.git", "-r", "a", "--", "-b"]) == [
        "--exclude=.git",
        "-r",
        "--",
    ]
    assert switch_words(["-rx", "pat", "-U", "1", "a", "b"]) == [
        "-rx",
        "pat",
        "-U",
        "1",
    ]


def test_quote_header_name_quotes_a_name_the_way_gnu_diff_does():
    assert quote_header_name("plain/é\x7f") == "plain/é\x7f"
    assert quote_header_name("sp ace") == '"sp ace"'
    assert quote_header_name('t\tq"b\\') == '"t\\tq\\"b\\\\"'
    assert quote_header_name("c\x01") == '"c\\001"'


@pytest.mark.asyncio
async def test_unified_headers_carry_each_side_mtime():
    files = {"/d/a b": b"x\ny\n", "/d/c": b"x\nz\n"}

    async def read(path: PathSpec) -> bytes:
        return files[path.virtual]

    async def stat(path: PathSpec) -> FileStat:
        if path.virtual not in files:
            raise FileNotFoundError(path.virtual)
        return FileStat(
            name=path.virtual,
            type=FileType.FILE,
            modified="2026-01-02T03:04:05Z",
        )

    pair = [_operand("a b", "/d/a b"), _operand("c", "/d/c")]
    out, io = await diff(
        pair,
        stream=read,
        readdir_fn=_readdir,
        stat_fn=stat,
        flags=DiffFlags(DiffOptions(mode="unified")),
    )
    assert io.exit_code == 1
    out = await materialize(out)
    assert out.splitlines()[:2] == [
        b'--- "a b"\t2026-01-02 03:04:05.000000000 +0000',
        b"+++ c\t2026-01-02 03:04:05.000000000 +0000",
    ]
    out, _ = await diff(
        [pair[1], _operand("gone", "/d/gone")],
        stream=read,
        readdir_fn=_readdir,
        stat_fn=stat,
        flags=DiffFlags(
            DiffOptions(mode="unified"), new_file=True, new_first=True
        ),
    )
    out = await materialize(out)
    assert out.splitlines()[1] == (
        b"+++ gone\t1970-01-01 00:00:00.000000000 +0000"
    )


@pytest.mark.asyncio
async def test_unified_headers_read_the_time_the_namespace_keeps():
    async def read(path: PathSpec) -> bytes:
        return b"x\n" if path.virtual == "/d/a" else b"y\n"

    async def stat(path: PathSpec) -> FileStat:
        return FileStat(
            name=path.virtual,
            type=FileType.FILE,
            modified="2026-10-05T00:00:00Z",
        )

    async def stat_path(path: str | PathSpec) -> FileStat | None:
        virtual = path.virtual if isinstance(path, PathSpec) else path
        return FileStat(
            name=virtual, type=FileType.FILE, modified="2021-06-15T12:00:00Z"
        )

    out, _ = await diff(
        [_operand("a", "/d/a"), _operand("b", "/d/b")],
        stream=read,
        readdir_fn=_readdir,
        stat_fn=stat,
        flags=DiffFlags(DiffOptions(mode="unified")),
        stat_path=stat_path,
    )
    out = await materialize(out)
    assert out.splitlines()[0] == b"--- a\t2021-06-15 12:00:00.000000000 +0000"


@pytest.mark.asyncio
async def test_unified_headers_read_in_the_tz_zone_with_every_digit():
    async def read(path: PathSpec) -> bytes:
        return b"x\n"

    async def stat_path(path: str | PathSpec) -> FileStat | None:
        virtual = path.virtual if isinstance(path, PathSpec) else path
        return FileStat(
            name=virtual,
            type=FileType.FILE,
            modified="2026-03-04T05:06:07.123456789Z",
        )

    async def missing(path: PathSpec) -> FileStat:
        if path.virtual == "/d/gone":
            raise FileNotFoundError(path.virtual)
        return FileStat(name=path.virtual, type=FileType.FILE)

    out, _ = await diff(
        [_operand("a", "/d/a"), _operand("gone", "/d/gone")],
        stream=read,
        readdir_fn=_readdir,
        stat_fn=missing,
        flags=DiffFlags(
            DiffOptions(mode="unified"), new_file=True, new_first=True
        ),
        stat_path=stat_path,
        zone=resolve_tz("Asia/Hong_Kong"),
    )
    out = await materialize(out)
    assert out.splitlines()[:2] == [
        b"--- a\t2026-03-04 13:06:07.123456789 +0800",
        b"+++ gone\t1970-01-01 08:00:00.000000000 +0800",
    ]


async def _unreachable(path: PathSpec) -> FileStat:
    raise ApiError("HTTP 503 Service Unavailable", 503)


@pytest.mark.asyncio
async def test_a_service_failure_is_trouble_not_a_difference():
    out, io = await diff(
        [_operand("a", "/d/a"), _operand("b", "/d/b")],
        stream=_readdir,
        readdir_fn=_readdir,
        stat_fn=_unreachable,
        flags=DiffFlags(recursive=True),
    )
    assert (out, io.exit_code) == (None, 2)
    assert (
        await materialize(io.stderr) == b"diff: HTTP 503 Service Unavailable\n"
    )


_HINT = b"diff: Try 'diff --help' for more information.\n"


def _line_flags(argv: list[str]) -> DiffFlags | IOResult:
    parsed = parse_line_flags(argv, SPECS["diff"], "diff", "/")
    return parse_flags(parsed.flag_kwargs)


@pytest.mark.parametrize(
    "argv,stderr",
    [
        (["-c", "-u"], b"diff: conflicting output style options\n" + _HINT),
        (["-y", "-e"], b"diff: conflicting output style options\n" + _HINT),
        (
            ["--label=a", "--label=b", "--label=c"],
            b"diff: too many file label options\n",
        ),
        (["--color=bogus"], b"diff: invalid color 'bogus'\n" + _HINT),
        (["-W", "0"], b"diff: invalid width '0'\n" + _HINT),
        (["-W", "40", "-W", "20"], b"diff: conflicting width options\n"),
        (["-C", "x"], b"diff: invalid context length 'x'\n" + _HINT),
        (["-I", "\\("], b"diff: \\(: Unmatched ( or \\(\n"),
        (
            ["--from-file=x", "--to-file=y"],
            b"diff: --from-file and --to-file both specified\n",
        ),
        (
            ["--from-file=x", "--from-file=y"],
            b"diff: conflicting --from-file option value 'y'\n" + _HINT,
        ),
    ],
)
def test_parse_flags_refuses_what_diffutils_refuses(
    argv: list[str], stderr: bytes
):
    parsed = _line_flags(argv)
    assert isinstance(parsed, IOResult)
    assert (parsed.exit_code, parsed.stderr) == (2, stderr)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,stdout,stderr,code",
    [
        ("diff --from-file=x y z", "2c2\n< b\n---\n> c\n", "", 1),
        ("diff --to-file=x y z", "2c2\n< c\n---\n> b\n", "", 1),
        ("diff --from-file x y", "2c2\n< b\n---\n> c\n", "", 1),
        ("diff --from=x y", "2c2\n< b\n---\n> c\n", "", 1),
        ("diff --from-file=x", "", "", 0),
        ("diff --from-file=x x z", "", "", 0),
        ("diff -q --from-file=x y z", "Files x and y differ\n", "", 1),
        (
            "diff --from-file=x nope y",
            "2c2\n< b\n---\n> c\n",
            "diff: nope: No such file or directory\n",
            2,
        ),
        (
            "diff --from-file=x y nope",
            "2c2\n< b\n---\n> c\n",
            "diff: nope: No such file or directory\n",
            2,
        ),
        (
            "diff --from-file=nope y",
            "",
            "diff: nope: No such file or directory\n",
            2,
        ),
        ("diff --from-file=x --from-file=x y", "2c2\n< b\n---\n> c\n", "", 1),
        (
            "printf 'a\\nz\\n' | diff --from-file=- x y",
            "2c2\n< z\n---\n> b\n",
            "diff: -: Bad file descriptor\n",
            2,
        ),
        (
            "printf 'a\\nz\\n' | diff --from-file=x - -",
            "2c2\n< b\n---\n> z\n",
            "diff: -: Bad file descriptor\n",
            2,
        ),
    ],
)
async def test_from_file_and_to_file_compare_one_file_with_each_operand(
    line, stdout, stderr, code
):
    # Pinned against GNU diffutils 3.10: one comparison per operand, in
    # order, with no separator, and the worst status of them.
    ws = Workspace({"/data/": RAMVFS()}, mode=MountMode.WRITE)
    try:
        await ws.shell(
            "cd /data && printf 'a\\nb\\n' > x && printf 'a\\nc\\n' > y"
            " && printf 'a\\nb\\n' > z"
        )
        r = await ws.shell(f"cd /data && {line}")
        assert (
            await r.stdout_str(),
            await r.stderr_str(),
            r.exit_code,
        ) == (stdout, stderr, code)
    finally:
        await ws.close()


@pytest.mark.parametrize(
    "argv,mode,context",
    [
        ([], "normal", 3),
        (["-p"], "context", 3),
        (["-F", "^a"], "normal", 3),
        (["-C", "1"], "context", 1),
        (["-n"], "rcs", 3),
        (["-y", "--color=always"], "sides", 3),
        (["--color=always", "--color"], "normal", 3),
        (["-U", "5", "--unified=2"], "unified", 5),
    ],
)
def test_parse_flags_picks_one_style_and_its_context(
    argv: list[str], mode: str, context: int
):
    parsed = _line_flags(argv)
    assert isinstance(parsed, DiffFlags)
    assert (parsed.options.mode, parsed.options.context) == (mode, context)


@pytest.mark.asyncio
async def test_recursive_side_by_side_heads_every_pair_it_shows():
    files = {
        "/d/x/f": b"x\n",
        "/d/y/f": b"y\n",
        "/d/x/g": b"same\n",
        "/d/y/g": b"same\n",
    }
    dirs = {"/d/x": ["f", "g"], "/d/y": ["f", "g"]}

    async def read(path: PathSpec) -> bytes:
        return files[path.virtual]

    async def readdir(path: PathSpec) -> list[str]:
        return dirs[path.virtual]

    async def stat(path: PathSpec) -> FileStat:
        kind = FileType.DIRECTORY if path.virtual in dirs else FileType.FILE
        return FileStat(name=path.virtual, type=kind)

    pair = [_operand("x", "/d/x"), _operand("y", "/d/y")]
    for flags, expected in (
        (
            DiffFlags(
                DiffOptions(mode="sides", widths=("20",)), recursive=True
            ),
            b"diff x/f y/f\nx     |\ty\ndiff x/g y/g\nsame\tsame\n",
        ),
        (
            DiffFlags(
                DiffOptions(
                    mode="sides", widths=("20",), suppress_common=True
                ),
                recursive=True,
            ),
            b"diff x/f y/f\nx     |\ty\n",
        ),
        (
            DiffFlags(
                DiffOptions(mode="unified"),
                recursive=True,
                labels=("A", "B"),
                identical=True,
            ),
            b"diff A B\n--- A\n+++ B\n@@ -1 +1 @@\n-x\n+y\n"
            b"Files A and B are identical\n",
        ),
    ):
        out, io = await diff(
            pair, stream=read, readdir_fn=readdir, stat_fn=stat, flags=flags
        )
        assert (await materialize(out), io.exit_code) == (expected, 1)


async def _one_empty_chunk():
    yield b""


@pytest.mark.asyncio
async def test_a_from_file_comparison_that_fails_closes_the_ones_before():
    closed: list[bool] = []
    calls: list[bool] = []

    async def close() -> None:
        closed.append(True)

    async def compare(options, old, new) -> PairResult:
        calls.append(True)
        if len(calls) > 1:
            raise ValueError("engine broke")
        kept = OutputStream(_one_empty_chunk(), close)
        return PairResult("different", (kept,), 1, ())

    async def stat(path: PathSpec) -> FileStat:
        return FileStat(name=path.virtual, type=FileType.FILE)

    with pytest.raises(ValueError):
        await diff(
            [_operand("y", "/d/y"), _operand("z", "/d/z")],
            stream=_readdir,
            readdir_fn=_readdir,
            stat_fn=stat,
            flags=DiffFlags(from_file=_operand("x", "/d/x")),
            computer=SimpleNamespace(compare=compare),
        )
    assert closed == [True]


@pytest.mark.asyncio
async def test_a_walk_that_fails_closes_the_output_it_kept():
    closed: list[bool] = []
    calls: list[bool] = []

    async def close() -> None:
        closed.append(True)

    async def compare(options, old, new) -> PairResult:
        calls.append(True)
        if len(calls) > 1:
            raise FileNotFoundError("gone")
        kept = OutputStream(_one_empty_chunk(), close)
        return PairResult("different", (kept,), 1, ())

    async def readdir(path: PathSpec) -> list[str]:
        return [f"{path.virtual}/1", f"{path.virtual}/2"]

    async def stat(path: PathSpec) -> FileStat:
        kind = (
            FileType.DIRECTORY
            if path.virtual in ("/d/a", "/d/b")
            else FileType.FILE
        )
        return FileStat(name=path.virtual, type=kind)

    out, io = await diff(
        [_operand("a", "/d/a"), _operand("b", "/d/b")],
        stream=_readdir,
        readdir_fn=readdir,
        stat_fn=stat,
        flags=DiffFlags(recursive=True),
        computer=SimpleNamespace(compare=compare),
    )
    assert (out, io.exit_code) == (None, 2)
    assert closed == [True]
