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
from collections.abc import AsyncIterator
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
from mirage.utils.key_prefix import mounted_path
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
    "/d/z.txt": b"\0noise\n",
}


async def _no_answer(path, query, index=NULL_INDEX):
    return None


class SearchRAM(RAMVFS):
    """A RAM mount whose search answers by substring, counting reads.

    Like a real index it never covers a binary-extension file. ``lines``
    answers as "bytes", "stream" or "decline" (None for every file), or
    is None for no line search; ``upper`` spells hits in another case,
    ``resource`` adds a search grep has no metadata for, and ``refuse``
    is what ``before_full_scan`` raises.
    """

    def __init__(
        self,
        files: bool = True,
        lines: str | None = "bytes",
        upper: bool = False,
        resource: bool = False,
        refuse: type[Exception] | None = None,
    ) -> None:
        super().__init__()
        self.lines, self.upper, self.refuse = lines, upper, refuse
        self.reads: list[str] = []
        self.asked: list[tuple[str, bool]] = []
        self.scans: list[ScanReason] = []
        self.pulled: list[bytes] = []
        self.open = 0
        self.streams: list[AsyncIterator[bytes]] = []
        if not files:
            self.files_containing = None  # type: ignore[assignment]
        if lines is None:
            self.lines_containing = None  # type: ignore[assignment]
        if resource:
            self.search = _no_answer  # type: ignore[method-assign]

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
        return [
            mounted_path(under[0], key.upper() if self.upper else key)
            for key, data in self._store.files.items()
            if _holds(data, text, ignore_case) and not key.endswith(".bin")
        ]

    async def lines_containing(
        self, path, text, *, ignore_case, index=NULL_INDEX
    ):
        if self.lines == "decline":
            return None
        data = self._store.files["/" + path.vfs_path]
        found = [
            line
            for line in data.splitlines(keepends=True)
            if _holds(line, text, ignore_case)
        ]
        if self.lines == "bytes":
            return b"".join(found)
        self.streams.append(self._pull(found))
        return self.streams[-1]

    async def _pull(self, found: list[bytes]) -> AsyncIterator[bytes]:
        self.open += 1
        try:
            for line in found:
                self.pulled.append(line)
                yield line
        finally:
            self.open -= 1

    async def before_full_scan(self, command, under, reason, index=NULL_INDEX):
        self.scans.append(reason)
        if self.refuse is not None:
            raise self.refuse(f"{reason}; narrow the path")


def _holds(data: bytes, text: str, ignore_case: bool) -> bool:
    if ignore_case:
        return text.lower().encode() in data.lower()
    return text.encode() in data


def _run(
    vfs: RAMVFS, line: str, hide: tuple[str, ...] = ()
) -> tuple[bytes, bytes, int]:
    async def run() -> tuple[bytes, bytes, int]:
        vfs._store.dirs.update({"/d", "/d/sub"})
        vfs._store.files.update(TREE)
        ws = Workspace({"/": vfs})
        try:
            session = None
            if hide:
                session = "agent"
                ws.create_session(session, profile={"paths": {"hide": hide}})
            result = await ws.shell(line, session_id=session)
            return result.stdout, result.stderr or b"", result.exit_code
        finally:
            await ws.close()

    return asyncio.run(run())


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
    "rg -q --files-without-match ada /d",
    "rg -c --include-zero ada /d",
    "rg -g '*.txt' -i ADA /d",
    "rg -n ada /d",
    "rg -w -e ada -e nothing /d",
    "rg --files /d",
]

MOUNTS = {
    "files": {"lines": None},
    "lines": {"files": False},
    "both": {},
    "stream": {"files": False, "lines": "stream"},
    "decline": {"files": False, "lines": "decline"},
    "upper": {"lines": None, "upper": True},
    "resource": {"lines": None, "resource": True},
    "decline-resource": {"files": False, "lines": "decline", "resource": True},
}


@pytest.mark.parametrize("mount", MOUNTS)
@pytest.mark.parametrize("line", LINES)
def test_a_search_never_changes_what_grep_and_rg_print(line, mount):
    assert _run(SearchRAM(**MOUNTS[mount]), line) == _run(RAMVFS(), line)


EVERY = "a.txt b.txt c.txt sub/d.txt z.txt"


@pytest.mark.parametrize(
    "line, mount, reads, asked, scan",
    [
        # Only the files holding the text are read; -c and -L still print
        # the rest from the walk. A regex asks the text every match holds.
        ("grep -rc ada /d", "files", "a.txt sub/d.txt", "ada", None),
        ("rg -lw ada /d", "files", "a.txt sub/d.txt", "ada -w", None),
        ("grep -rE 'conn.*refused' /d", "files", "b.txt", "refused", None),
        # -a reads the binary-extension file no search vouches for, and a
        # named file is read whatever the search said (twice, as GNU does).
        ("grep -ra ada /d", "files", "a.txt sub/d.txt w.bin", "ada", None),
        (
            "grep -r ada /d /d/c.txt",
            "files",
            "a.txt c.txt c.txt sub/d.txt",
            "ada",
            None,
        ),
        ("grep -r ada /d", "upper", "a.txt sub/d.txt", "ada", None),
        ("grep -r ada /d", "resource", "a.txt sub/d.txt", "ada", None),
        # Lines stand in for a file; -n reads a file holding one.
        ("grep -r ada /d", "lines", "", "", None),
        ("grep -rn ada /d", "lines", "a.txt sub/d.txt", "", None),
        ("grep -rn ada /d", "stream", "a.txt sub/d.txt", "", None),
        ("grep -r ada /d", "decline", EVERY, "", ScanReason.UNANSWERED),
        ("grep -rn ada /d", "decline", EVERY, "", ScanReason.UNANSWERED),
        ("grep -rv ada /d", "both", None, "", ScanReason.EVERY_LINE),
        ("rg --passthru ada /d", "both", None, "", ScanReason.EVERY_LINE),
        ("grep -r 'a.b' /d", "both", None, "", ScanReason.NO_TEXT),
        ("rg -L ada /d", "both", None, "", ScanReason.LINKS),
        (
            "rg --files-without-match ada /d",
            "both",
            None,
            "",
            ScanReason.EVERY_FILE,
        ),
        (
            "rg -c --include-zero ada /d",
            "both",
            None,
            "",
            ScanReason.EVERY_FILE,
        ),
        ("rg -q --files-without-match ada /d", "files", None, "ada", None),
        ("rg --files /d", "both", "", "", None),
    ],
)
def test_what_a_search_reads_asks_and_scans(line, mount, reads, asked, scan):
    vfs = SearchRAM(**MOUNTS[mount])
    assert _run(vfs, line) == _run(RAMVFS(), line)
    text, _, word = asked.partition(" ")
    assert vfs.asked == ([(text, bool(word))] if text else [])
    assert vfs.scans == ([scan] if scan else [])
    if reads is not None:
        assert sorted(vfs.reads) == [f"d/{key}" for key in reads.split()]


def test_a_hidden_path_is_walked_without_the_search():
    vfs, hide = SearchRAM(), ("/d/sub",)
    line = "grep -r ada /d"
    assert _run(vfs, line, hide) == _run(RAMVFS(), line, hide)
    assert (vfs.asked, vfs.scans) == ([], [ScanReason.NO_SEARCH])


@pytest.mark.parametrize(
    "line, pulls_every_line",
    [
        ("grep -ri ada /d", True),
        ("grep -rin ada /d", False),
        ("grep -ril ada /d", False),
        ("grep -riq ada /d", False),
    ],
)
def test_a_streamed_answer_is_pulled_as_far_as_needed(line, pulls_every_line):
    # Lines that stand in for the file are all pulled; -n only asks
    # whether to read it, and -l and -q stop early. Closed either way.
    vfs = SearchRAM(files=False, lines="stream")

    async def run() -> tuple[bool, int]:
        ws = Workspace({"/": vfs})
        vfs._store.dirs.update({"/d", "/d/sub"})
        vfs._store.files.update(TREE)
        try:
            await ws.shell(line)
            return b"ada lovelace\n" in vfs.pulled, vfs.open
        finally:
            await ws.close()

    assert asyncio.run(run()) == (pulls_every_line, 0)


def _refused(reason: ScanReason) -> bytes:
    return f"grep: {reason}; narrow the path\n".encode()


DENIED = b"".join(
    b"grep: /d/%s: Permission denied\n" % key.encode() for key in EVERY.split()
)


@pytest.mark.parametrize(
    "line, mount, refuse, out",
    [
        (
            "grep -rv ada /d",
            "both",
            ValueError,
            (_refused(ScanReason.EVERY_LINE), 1),
        ),
        (
            "grep -r ada /d",
            "decline",
            ValueError,
            (_refused(ScanReason.UNANSWERED), 1),
        ),
        # An OSError is a per-file read error to grep, which goes on to the
        # next file; that file is refused too, not read.
        ("grep -r ada /d", "decline", PermissionError, (DENIED, 2)),
        ("grep -r ada /d", "decline-resource", PermissionError, (DENIED, 2)),
        # A narrowed line, and one that reads no content, run.
        ("grep -r ada /d", "both", ValueError, None),
        ("rg --files /d", "both", ValueError, None),
    ],
)
def test_a_mount_may_refuse_a_full_scan(line, mount, refuse, out):
    vfs = SearchRAM(**MOUNTS[mount], refuse=refuse)
    if out is None:
        assert _run(vfs, line) == _run(RAMVFS(), line)
    else:
        assert (_run(vfs, line), vfs.reads) == ((b"", *out), [])
