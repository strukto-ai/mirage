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
from dataclasses import replace
from functools import partial
from unittest.mock import AsyncMock

import pytest

from mirage.cache.index import NULL_INDEX
from mirage.commands.builtin.generic_bind.search import run_search
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.commands.config import CommandIO, CommandOpts
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.search import make_search_op
from mirage.errors.fs import efbig, enoent
from mirage.io.types import ByteSource
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.vfs.ram import RAMVFS
from mirage.vfs.types import ScanReason, SearchOps, SearchQuery
from mirage.workspace import Workspace
from tests.core.hierarchy.conftest import FakeAccessor, detect_scope, spec

CONTENT = b"x ada\ny\n"


async def _read_op(
    accessor: FakeAccessor, path: PathSpec, index=NULL_INDEX
) -> bytes:
    return CONTENT


async def _stat_op(
    accessor: FakeAccessor, path: PathSpec, index=NULL_INDEX
) -> FileStat:
    return FileStat(
        name="a.json",
        type=FileType.FILE,
        content=ContentType.JSON,
        size=len(CONTENT),
    )


async def _readdir_op(
    accessor: FakeAccessor, path: PathSpec, index=NULL_INDEX
) -> list[str]:
    return []


async def _absent_stat(
    accessor: FakeAccessor, path: PathSpec, index=NULL_INDEX
) -> FileStat:
    raise enoent(path.virtual)


IO = CommandIO(
    readdir=_readdir_op,
    read_bytes=_read_op,
    read_stream=partial(stream_from_bytes, _read_op),
    stat=_stat_op,
    is_mounted=lambda a: True,
    local=False,
)


async def _room_searcher(
    accessor: FakeAccessor, match: ScopeMatch, query: SearchQuery
) -> list[str]:
    return [f"rooms/{match.slots['room']}:{query.query}"]


async def _empty_searcher(
    accessor: FakeAccessor, match: ScopeMatch, query: SearchQuery
) -> list[str]:
    return []


async def _drain(source: ByteSource | None) -> bytes:
    if source is None:
        return b""
    if isinstance(source, bytes):
        return source
    chunks = [chunk async for chunk in source]
    return b"".join(chunks)


def _search_command(searchers, io, *, guard=False, stream=False):
    search = make_search_op(
        detect_scope, searchers, io.stat if guard else None
    )
    return partial(
        run_search,
        replace(
            io,
            search=SearchOps(
                search=search,
                meta={"grep": {"mode": "literal", "stream": stream}},
            ),
        ),
        "grep",
    )


def test_matched_kind_answers_from_the_searcher():
    search = _search_command({"room": _room_searcher}, IO)
    out, result = asyncio.run(
        search(FakeAccessor(), [spec("/rooms/red")], ["ada"], CommandOpts())
    )
    assert result.exit_code == 0
    assert asyncio.run(_drain(out)) == b"rooms/red:ada\n"


def test_empty_answer_is_exit_1():
    search = _search_command({"room": _empty_searcher}, IO)
    out, result = asyncio.run(
        search(FakeAccessor(), [spec("/rooms/red")], ["ada"], CommandOpts())
    )
    assert result.exit_code == 1
    assert asyncio.run(_drain(out)) == b""


def test_unmatched_kind_takes_the_generic_scan():
    search = _search_command({"room": _room_searcher}, IO)
    out, result = asyncio.run(
        search(
            FakeAccessor(), [spec("/rooms/red/a.json")], ["ada"], CommandOpts()
        )
    )
    assert b"x ada" in asyncio.run(_drain(out))
    assert result.exit_code == 0


@pytest.mark.parametrize(
    "flags,pattern,expected,code",
    [
        ({"v": True}, "ada", b"y\n", 0),
        ({"line_regexp": True}, "ada", b"", 1),
        ({"line_regexp": True}, "y", b"y\n", 0),
    ],
)
def test_shaping_flag_defers_to_the_generic_scan(
    flags, pattern, expected, code
):
    provider = AsyncMock(return_value=["provider substring hit"])
    search = _search_command({"note": provider}, IO)
    out, result = asyncio.run(
        search(
            FakeAccessor(),
            [spec("/rooms/red/a.json")],
            [pattern],
            CommandOpts(flags=flags),
        )
    )
    assert (asyncio.run(_drain(out)), result.exit_code) == (expected, code)
    provider.assert_not_awaited()


def test_guard_probes_existence_before_searching():
    io = CommandIO(
        readdir=_readdir_op,
        read_bytes=_read_op,
        read_stream=partial(stream_from_bytes, _read_op),
        stat=_absent_stat,
        is_mounted=lambda a: True,
        local=False,
    )
    search = _search_command({"room": _room_searcher}, io, guard=True)
    with pytest.raises(FileNotFoundError):
        asyncio.run(
            search(
                FakeAccessor(), [spec("/rooms/red")], ["ada"], CommandOpts()
            )
        )


def test_stream_first_pull_failure_falls_back_to_bytes():
    # A native stream that refuses a kind before yielding (mongodb's
    # documents-only stream on schema.json) must not fail the scan.
    async def _refusing_stream(
        accessor: FakeAccessor, path: PathSpec, index=NULL_INDEX
    ):
        raise enoent(path.virtual)
        yield b""

    io = CommandIO(
        readdir=_readdir_op,
        read_bytes=_read_op,
        read_stream=_refusing_stream,
        stat=_stat_op,
        is_mounted=lambda a: True,
        local=False,
    )
    search = _search_command({"room": _room_searcher}, io, stream=True)
    out, result = asyncio.run(
        search(
            FakeAccessor(), [spec("/rooms/red/a.json")], ["ada"], CommandOpts()
        )
    )
    assert b"x ada" in asyncio.run(_drain(out))
    assert result.exit_code == 0


def test_stream_failure_after_data_is_reported():
    async def _breaking_stream(
        accessor: FakeAccessor, path: PathSpec, index=NULL_INDEX
    ):
        yield CONTENT
        raise enoent(path.virtual)

    io = CommandIO(
        readdir=_readdir_op,
        read_bytes=_read_op,
        read_stream=_breaking_stream,
        stat=_stat_op,
        is_mounted=lambda a: True,
        local=False,
    )
    search = _search_command({"room": _room_searcher}, io, stream=True)
    out, result = asyncio.run(
        search(
            FakeAccessor(), [spec("/rooms/red/a.json")], ["ada"], CommandOpts()
        )
    )
    asyncio.run(_drain(out))
    assert result.exit_code == 2
    assert result.stderr == (
        b"grep: /h/rooms/red/a.json: No such file or directory\n"
    )


def test_refused_pushdown_falls_back_to_the_scan():
    # A push-down past the mount's read cap cannot print its answer; the
    # scan reads the operand, which refuses the same way, and reports it
    # against the operand as typed, then moves on as grep does.
    async def _refusing_searcher(
        accessor: FakeAccessor, match: ScopeMatch, query: SearchQuery
    ) -> list[str]:
        raise efbig(f"rooms/{match.slots['room']}/{match.slots['note']}")

    async def _refused_read(
        accessor: FakeAccessor, path: PathSpec, index=NULL_INDEX
    ) -> bytes:
        raise efbig(path)

    io = replace(
        IO,
        read_bytes=_refused_read,
        read_stream=partial(stream_from_bytes, _refused_read),
    )
    search = _search_command({"note": _refusing_searcher}, io)
    out, result = asyncio.run(
        search(
            FakeAccessor(), [spec("/rooms/red/a.json")], ["ada"], CommandOpts()
        )
    )
    assert asyncio.run(_drain(out)) == b""
    assert result.exit_code == 2
    assert asyncio.run(result.stderr_str()) == (
        "grep: /h/rooms/red/a.json: File too large\n"
    )


def test_query_carries_the_honored_flags():
    seen: list[SearchQuery] = []

    async def recorder(
        accessor: FakeAccessor, match: ScopeMatch, query: SearchQuery
    ) -> list[str]:
        seen.append(query)
        return ["line"]

    search = _search_command({"room": recorder}, IO)
    asyncio.run(
        search(
            FakeAccessor(),
            [spec("/rooms/red")],
            ["ada"],
            CommandOpts(flags={"i": True}),
        )
    )
    assert seen[0].options["grep"]["ignore_case"]
    assert not seen[0].options["grep"]["fixed_string"]


def test_stdin_operand_reads_the_pipe_not_the_backend():
    # A `-` operand is the line's stdin, which no backend holds. Asked
    # about it, a search that answers any operand said "no match" and
    # the pipe was never read.
    asked: list[str] = []

    async def answer_everything(
        accessor: FakeAccessor,
        operand: PathSpec,
        query: SearchQuery,
        index=NULL_INDEX,
    ) -> list[str]:
        asked.append(operand.raw_path)
        return []

    ops = SearchOps(
        search=answer_everything,
        meta={"grep": {"mode": "literal", "stream": False}},
    )
    dash = PathSpec(
        virtual="/h/-",
        directory="/h/",
        vfs_path="-",
        resolved=True,
        raw_path="-",
    )
    for name in ("grep", "rg"):
        out, result = asyncio.run(
            run_search(
                replace(IO, search=ops),
                name,
                FakeAccessor(),
                [dash],
                ["ada"],
                CommandOpts(stdin=b"x ada\n"),
            )
        )
        assert (asyncio.run(_drain(out)), result.exit_code) == (b"x ada\n", 0)
    assert asked == []


TREE = {
    "/d/a.txt": b"ada here\nnothing\n",
    "/d/b.txt": b"conn was refused\nbob\n",
    "/d/c.txt": b"nothing\n",
    "/d/sub/d.txt": b"ADA upper\nada lovelace\n",
    "/d/w.bin": b"ada in a blob\n",
}


class SearchRAM(RAMVFS):
    """A RAM mount whose search answers by substring, counting reads.

    Like a real index it never covers a binary-extension file.
    """

    def __init__(self, files: bool = True, lines: bool = True) -> None:
        super().__init__()
        self.reads: list[str] = []
        self.asked: list[tuple[str, bool]] = []
        self.scans: list[ScanReason] = []
        if not files:
            self.files_containing = None  # type: ignore[assignment]
        if not lines:
            self.lines_containing = None  # type: ignore[assignment]

    async def read(self, path, index=NULL_INDEX, offset=0, size=None):
        self.reads.append(path.vfs_path)
        return await super().read(path, index, offset, size)

    def read_stream(self, path, index=NULL_INDEX):
        self.reads.append(path.vfs_path)
        return super().read_stream(path, index)

    async def files_containing(
        self, text, under, *, whole_word, ignore_case, index=NULL_INDEX
    ):
        self.asked.append((text, whole_word))
        return {
            key.strip("/")
            for key, data in self._store.files.items()
            if _holds(data, text, ignore_case) and not key.endswith(".bin")
        }

    async def lines_containing(
        self, path, text, *, ignore_case, index=NULL_INDEX
    ):
        data = self._store.files["/" + path.vfs_path]
        return b"".join(
            line
            for line in data.splitlines(keepends=True)
            if _holds(line, text, ignore_case)
        )

    async def before_full_scan(self, command, under, reason, index=NULL_INDEX):
        self.scans.append(reason)


def _holds(data: bytes, text: str, ignore_case: bool) -> bool:
    if ignore_case:
        return text.lower().encode() in data.lower()
    return text.encode() in data


def _seed(vfs: RAMVFS) -> RAMVFS:
    vfs._store.dirs.update({"/d", "/d/sub"})
    vfs._store.files.update(TREE)
    return vfs


async def _run(vfs: RAMVFS, line: str) -> tuple[bytes, bytes, int]:
    ws = Workspace({"/": _seed(vfs)})
    try:
        result = await ws.shell(line)
        return result.stdout, result.stderr or b"", result.exit_code
    finally:
        await ws.close()


LINES = [
    "grep -r ada /d",
    "grep -rc ada /d",
    "grep -rL ada /d",
    "grep -rlw ada /d",
    "grep -rn ada /d",
    "grep -ri ADA /d",
    "grep -rx 'ada lovelace' /d",
    "grep -r -e ada -e bob /d",
    "grep -rE 'conn.*refused' /d",
    "grep -r --exclude-dir=sub ada /d",
    "grep -r -C1 ada /d",
    "grep -rv ada /d",
    "grep -ra ada /d",
    "grep -rh ada /d /d/w.bin",
    "grep -rq ada /d",
    "rg ada /d",
    "rg -c ada /d",
    "rg --files-without-match ada /d",
    "rg -g '*.txt' -i ADA /d",
    "rg -n ada /d",
    "rg -w -e ada -e nothing /d",
]


@pytest.mark.parametrize("files, lines", [(1, 0), (0, 1), (1, 1)])
@pytest.mark.parametrize("line", LINES)
def test_a_search_never_changes_what_grep_and_rg_print(line, files, lines):
    plain = asyncio.run(_run(RAMVFS(), line))
    narrowed = asyncio.run(_run(SearchRAM(bool(files), bool(lines)), line))
    assert narrowed == plain


@pytest.mark.parametrize(
    "line, reads, asked",
    [
        # Only the files holding the text are read; -c and -L still
        # print the rest from the walk.
        ("grep -rc ada /d", ["a.txt", "sub/d.txt"], [("ada", False)]),
        ("rg -lw ada /d", ["a.txt", "sub/d.txt"], [("ada", True)]),
        # A regex is asked for the text every match holds.
        ("grep -rE 'conn.*refused' /d", ["b.txt"], [("refused", False)]),
        # -a reads the binary-extension file the search cannot vouch for.
        ("grep -ra ada /d", ["a.txt", "sub/d.txt", "w.bin"], [("ada", False)]),
        # A named file is read whatever the search said, here twice, as
        # GNU reads it once in the walk and once as the operand.
        (
            "grep -r ada /d /d/c.txt",
            ["a.txt", "c.txt", "c.txt", "sub/d.txt"],
            [("ada", False)],
        ),
    ],
)
def test_only_the_files_a_search_returns_are_read(line, reads, asked):
    vfs = SearchRAM(lines=False)
    asyncio.run(_run(vfs, line))
    assert (sorted(vfs.reads), vfs.asked) == (
        [f"d/{key}" for key in reads],
        asked,
    )


def test_matching_lines_stand_in_for_a_file_when_nothing_else_prints():
    lines = SearchRAM(files=False)
    assert asyncio.run(_run(lines, "grep -r ada /d"))[2] == 0
    assert lines.reads == []
    # -n needs the real line numbers, so a file with a matching line is
    # read whole.
    numbered = SearchRAM(files=False)
    asyncio.run(_run(numbered, "grep -rn ada /d"))
    assert sorted(numbered.reads) == ["d/a.txt", "d/sub/d.txt"]


@pytest.mark.parametrize(
    "line, reason",
    [
        ("grep -rv ada /d", ScanReason.EVERY_LINE),
        ("rg --passthru ada /d", ScanReason.EVERY_LINE),
        ("grep -r 'a.b' /d", ScanReason.NO_TEXT),
        ("rg -L ada /d", ScanReason.LINKS),
    ],
)
def test_a_walk_that_reads_every_file_says_why(line, reason):
    vfs = SearchRAM()
    asyncio.run(_run(vfs, line))
    assert (vfs.scans, vfs.asked) == ([reason], [])


def test_a_mount_may_refuse_a_full_scan():
    class Refusing(SearchRAM):
        async def before_full_scan(
            self, command, under, reason, index=NULL_INDEX
        ):
            raise ValueError(f"{reason}; narrow the path")

    assert asyncio.run(_run(Refusing(), "grep -rv ada /d")) == (
        b"",
        b"grep: the output needs lines that do not match; narrow the path\n",
        1,
    )
    assert asyncio.run(_run(Refusing(), "grep -r ada /d"))[2] == 0
