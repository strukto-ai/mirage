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
from mirage.commands.builtin.generic.grep import grep_generic
from mirage.commands.builtin.generic_bind.search import (
    candidate_reads,
    narrow_scope,
    run_search,
)
from mirage.commands.builtin.grep_pushdown import grep_needs_every_file
from mirage.commands.builtin.utils.wrap import stream_from_bytes
from mirage.commands.config import CommandIO, CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.core.hierarchy.scope import ScopeMatch
from mirage.core.hierarchy.search import make_search_op
from mirage.errors.fs import efbig, enoent
from mirage.io.types import ByteSource
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.vfs.types import ContentSearchOps, SearchOps, SearchQuery
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


DIRECTORY = FileStat(name="data", type=FileType.DIRECTORY)


def _scope() -> PathSpec:
    return PathSpec(vfs_path="", virtual="/data", directory="/data")


def _hit(virtual: str) -> PathSpec:
    return PathSpec(
        vfs_path=virtual.removeprefix("/data/"),
        virtual=virtual,
        directory="",
        resolved=True,
    )


HITS = [_hit("/data/a.txt")]


def _narrowing(stat=None, answer=HITS, enabled=True):
    stat_op = stat or AsyncMock(return_value=DIRECTORY)
    narrow = AsyncMock(return_value=answer)
    io = replace(
        IO,
        stat=stat_op,
        content_search=ContentSearchOps(
            narrow_paths=narrow, enabled=lambda a: enabled
        ),
    )
    return io, narrow


def _narrow(io, **gates):
    flags = {
        "fixed_string": False,
        "recursive": True,
        "whole_word": True,
        "exact_file_set": False,
        **gates,
    }
    return asyncio.run(
        narrow_scope(
            io, FakeAccessor(), NULL_INDEX, [_scope()], "needle", **flags
        )
    )


def test_a_recursive_whole_word_literal_narrows_to_candidates():
    io, narrow = _narrowing()
    resolved, used = _narrow(io)
    assert used
    assert [p.virtual for p in resolved] == ["/data/a.txt"]
    narrow.assert_awaited_once()


@pytest.mark.parametrize(
    "gates",
    [
        {"recursive": False},
        {"exact_file_set": True},
        {"whole_word": False},
        {
            "exact_file_set": grep_needs_every_file(
                FlagView({"w": True, "line_regexp": True}, spec=SPECS["grep"])
            )
        },
    ],
)
def test_a_failed_gate_scans_every_file(gates):
    io, narrow = _narrowing()
    assert _narrow(io, **gates) == ([_scope()], False)
    narrow.assert_not_awaited()


def test_a_mount_that_did_not_opt_in_scans_every_file():
    io, narrow = _narrowing(enabled=False)
    assert _narrow(io) == ([_scope()], False)
    narrow.assert_not_awaited()


@pytest.mark.parametrize(
    "stat",
    [
        AsyncMock(return_value=FileStat(name="x.txt", type=FileType.FILE)),
        AsyncMock(side_effect=FileNotFoundError("/data")),
    ],
)
def test_a_file_or_missing_operand_scans_every_file(stat):
    io, narrow = _narrowing(stat=stat)
    assert _narrow(io) == ([_scope()], False)
    narrow.assert_not_awaited()


@pytest.mark.parametrize("answer", [None, []])
def test_an_unusable_or_empty_answer_scans_every_file(answer):
    io, _ = _narrowing(answer=answer)
    assert _narrow(io) == ([_scope()], False)


def test_binary_candidates_are_dropped_and_may_leave_none():
    io, _ = _narrowing(answer=[_hit("/data/a.parquet"), _hit("/data/a.txt")])
    resolved, used = _narrow(io)
    assert (used, [p.virtual for p in resolved]) == (True, ["/data/a.txt"])
    io, _ = _narrowing(answer=[_hit("/data/a.parquet")])
    assert _narrow(io) == ([], True)


_TREE = {
    "/d": None,
    "/d/a.txt": b"ada here\n",
    "/d/b.txt": b"ada too\n",
    "/d/c.txt": b"nothing\n",
}


async def _tree_readdir(path: PathSpec) -> list[str]:
    base = path.virtual.rstrip("/") + "/"
    return sorted(
        key
        for key in _TREE
        if key.startswith(base) and "/" not in key[len(base) :]
    )


async def _tree_stat(path: PathSpec) -> FileStat:
    data = _TREE[path.virtual]
    if data is None:
        return FileStat(name=path.virtual, type=FileType.DIRECTORY)
    return FileStat(name=path.virtual, type=FileType.FILE, size=len(data))


def _tree_reads(read_log: list[str]):
    async def read(path: PathSpec) -> bytes:
        read_log.append(path.virtual)
        data = _TREE[path.virtual]
        assert data is not None
        return data

    return read


def _spec(virtual: str) -> PathSpec:
    return PathSpec(virtual=virtual, directory=virtual, vfs_path=virtual)


@pytest.mark.asyncio
async def test_candidate_reads_empty_only_what_the_search_ruled_out():
    log: list[str] = []
    read, stream = candidate_reads(
        _tree_reads(log),
        partial(stream_from_bytes, _tree_reads(log)),
        {"/d/a.txt"},
        {"/d/c.txt"},
    )
    assert await read(_spec("/d/a.txt")) == b"ada here\n"
    assert await read(_spec("/d/b.txt")) == b""
    assert await read(_spec("/d/c.txt")) == b"nothing\n"
    assert stream is not None
    assert b"".join([c async for c in stream(_spec("/d/b.txt"))]) == b""
    assert log == ["/d/a.txt", "/d/c.txt"]


@pytest.mark.asyncio
async def test_candidate_reads_keep_a_whole_read_backend_whole():
    read, stream = candidate_reads(_tree_reads([]), None, set(), set())
    assert stream is None
    assert await read(_spec("/d/a.txt")) == b""


@pytest.mark.asyncio
async def test_candidate_reads_narrow_a_walk_without_changing_it():
    # The walk still lists and labels every file; only the candidate is
    # read, and the file the search ruled out still counts 0 under -c.
    log: list[str] = []
    read, _ = candidate_reads(_tree_reads(log), None, {"/d/a.txt"}, {"/d"})
    output, io = await grep_generic(
        [_spec("/d")],
        ["ada"],
        CommandOpts(flags={"r": True, "c": True}),
        readdir=_tree_readdir,
        stat=_tree_stat,
        read_bytes=read,
        read_stream=None,
    )
    assert await _drain(output) == b"/d/a.txt:1\n/d/b.txt:0\n/d/c.txt:0\n"
    assert io.exit_code == 0
    assert log == ["/d/a.txt"]
