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

import pytest

from mirage.cache.index import NULL_INDEX
from mirage.types import MountMode
from mirage.utils.key_prefix import mounted_path
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

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
    ``resource`` adds the ``search`` command's search, which grep and rg
    never ask, and ``refuse`` is what ``before_full_scan`` raises.
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
        self.scans: list[str] = []
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
        self, path, text, *, whole_word, ignore_case, index=NULL_INDEX
    ):
        self.asked.append((text, whole_word))
        return [
            mounted_path(path, key.upper() if self.upper else key)
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

    async def before_full_scan(self, path, *, files=None, index=NULL_INDEX):
        self.scans.append(path.virtual)
        if self.refuse is not None:
            raise self.refuse(f"{files} files in scope, narrow the path")


def _holds(data: bytes, text: str, ignore_case: bool) -> bool:
    if ignore_case:
        return text.lower().encode() in data.lower()
    return text.encode() in data


def _run(
    vfs: RAMVFS,
    line: str,
    hide: tuple[str, ...] = (),
    pins: dict[str, str] | None = None,
    deny: tuple[str, ...] = (),
) -> tuple[bytes, bytes, int]:
    async def run() -> tuple[bytes, bytes, int]:
        vfs._store.dirs.update({"/d", "/d/sub"})
        vfs._store.files.update(TREE)
        ws = Workspace({"/": (vfs, MountMode.WRITE)}, mode=MountMode.WRITE)
        ws.mount("/").revisions = pins or {}
        try:
            session = None
            if hide or deny:
                session = "agent"
                rules = [{"reason": "sealed", "paths": list(deny)}]
                ws.create_session(
                    session,
                    profile={
                        "paths": {"hide": list(hide)},
                        "commands": {"deny": rules if deny else []},
                    },
                )
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
    "echo 'x ada' | grep ada - /d/c.txt",
    "echo 'x ada' | rg ada - /d",
    "ln -s a.txt /d/la.txt && ln -s sub /d/ls && grep -R ada /d",
    "ln -s a.txt /d/la.txt && ln -s sub /d/ls && rg -L ada /d",
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


# rg drops a byte-order mark only where a file starts, which a line answer
# cannot say it does, so an answer that starts with one is not used, and the
# file is read as one no search answered.
MARKED = {
    "/m/mid.txt": b"skip\n\xef\xbb\xbfada\n",
    "/m/top.txt": b"\xef\xbb\xbfada\n",
}


def _marked(vfs: RAMVFS) -> RAMVFS:
    vfs._store.dirs.add("/m")
    vfs._store.files.update(MARKED)
    return vfs


@pytest.mark.parametrize("lines", ["bytes", "stream"])
def test_rg_reads_a_file_whose_line_answer_starts_with_a_mark(lines):
    line = "rg -x ada /m"
    vfs = SearchRAM(files=False, lines=lines)
    searched = _run(_marked(vfs), line)
    assert searched == _run(_marked(RAMVFS()), line)
    assert searched[0] == b"/m/top.txt:ada\n"
    assert vfs.scans == ["/m"]


# Under -E none rg keeps the mark, so the answer stands and nothing is read.
@pytest.mark.parametrize("lines", ["bytes", "stream"])
def test_rg_keeps_a_marked_line_answer_under_no_encoding(lines):
    line = "rg -E none ada /m"
    vfs = SearchRAM(files=False, lines=lines)
    searched = _run(_marked(vfs), line)
    assert searched == _run(_marked(RAMVFS()), line)
    assert (vfs.reads, vfs.scans) == ([], [])


EVERY = "a.txt b.txt c.txt sub/d.txt z.txt"


@pytest.mark.parametrize(
    "line, mount, reads, asked, scan",
    [
        # Only the files holding the text are read; -c and -L still print
        # the rest from the walk. A regex asks the text every match holds.
        ("grep -rc ada /d", "files", "a.txt sub/d.txt", "ada", None),
        ("rg -lw ada /d", "files", "a.txt sub/d.txt", "ada -w", None),
        ("grep -rE 'conn.*refused' /d", "files", "b.txt", "refused", None),
        # -a reads the binary-extension file no search vouches for, asking
        # the mount first, and a named file is read whatever the search said
        # (twice, as GNU does).
        (
            "grep -ra ada /d",
            "files",
            "a.txt sub/d.txt w.bin",
            "ada",
            True,
        ),
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
        ("grep -r ada /d", "decline", EVERY, "", True),
        ("grep -rn ada /d", "decline", EVERY, "", True),
        ("grep -rv ada /d", "both", None, "", True),
        ("rg --passthru ada /d", "both", None, "", True),
        ("grep -r 'a.b' /d", "both", None, "", True),
        ("rg -L ada /d", "both", None, "", True),
        (
            "rg --files-without-match ada /d",
            "both",
            None,
            "",
            True,
        ),
        (
            "rg -c --include-zero ada /d",
            "both",
            None,
            "",
            True,
        ),
        ("rg -q --files-without-match ada /d", "files", None, "ada", None),
        (
            "rg --stats ada /d | head -2",
            "both",
            None,
            "",
            True,
        ),
        ("rg -z ada /d", "both", EVERY, "", True),
        (
            "rg -U 'ada here\\nnothing' /d",
            "both",
            EVERY,
            "",
            True,
        ),
        ("rg -U ada /d", "lines", "a.txt sub/d.txt", "", None),
        ("rg --files /d", "both", "", "", None),
    ],
)
def test_what_a_search_reads_asks_and_scans(line, mount, reads, asked, scan):
    vfs = SearchRAM(**MOUNTS[mount])
    assert _run(vfs, line) == _run(RAMVFS(), line)
    text, _, word = asked.partition(" ")
    assert vfs.asked == ([(text, bool(word))] if text else [])
    assert vfs.scans == (["/d"] if scan else [])
    if reads is not None:
        assert sorted(vfs.reads) == [f"d/{key}" for key in reads.split()]


@pytest.mark.parametrize(
    "searchable, reads",
    [
        (
            ("d/sub",),
            ["d/a.txt", "d/b.txt", "d/c.txt", "d/sub/d.txt", "d/z.txt"],
        ),
        (("d/*.txt",), ["d/a.txt", "d/sub/d.txt"]),
    ],
)
def test_a_file_the_search_does_not_cover_is_always_read(searchable, reads):
    # A glob naming a directory covers what is below it, and `*` stays
    # within one segment, so d/*.txt leaves d/sub/d.txt uncovered.
    vfs = SearchRAM(lines=None)
    vfs.searchable = searchable
    line = "grep -r ada /d"
    assert _run(vfs, line) == _run(RAMVFS(), line)
    assert sorted(vfs.reads) == reads


def test_a_path_pinned_to_a_revision_is_always_read():
    # A search sees the current content, so a pinned file is read
    # whatever it answers: its saved bytes may hold the text.
    vfs = SearchRAM(lines=None)
    line = "grep -r ada /d"
    assert _run(vfs, line, pins={"/d/c.txt": "r1"}) == _run(RAMVFS(), line)
    assert sorted(vfs.reads) == ["d/a.txt", "d/c.txt", "d/sub/d.txt"]


async def _grep_after_edit(vfs: RAMVFS) -> tuple[bytes, list[str]]:
    vfs.caches_reads = True
    vfs._store.dirs.update({"/d", "/d/sub"})
    vfs._store.files.update(TREE | {"/d/c.txt": b"ada cached\n"})
    ws = Workspace({"/": vfs})
    try:
        await ws.shell("cat /d/c.txt")
        vfs._store.files["/d/c.txt"] = b"nothing\n"
        reads = getattr(vfs, "reads", [])
        reads.clear()
        result = await ws.shell("grep -rl ada /d")
        return result.stdout, sorted(reads)
    finally:
        await ws.close()


def test_a_cached_file_is_always_read():
    # A search sees the current content and a read serves the cached
    # copy, so a file edited since it was cached is read, not ruled out.
    narrowed, reads = asyncio.run(_grep_after_edit(SearchRAM(lines=None)))
    scanned, _ = asyncio.run(_grep_after_edit(RAMVFS()))
    assert narrowed == scanned == b"/d/a.txt\n/d/c.txt\n/d/sub/d.txt\n"
    assert reads == ["d/a.txt", "d/sub/d.txt"]


def test_a_hidden_path_keeps_the_search_and_loses_its_hits():
    # The dispatcher drops the hidden d.txt from the answer, so the
    # search still narrows and the hidden file is never read.
    vfs, hide = SearchRAM(), ("/d/sub",)
    line = "grep -r ada /d"
    assert _run(vfs, line, hide) == _run(RAMVFS(), line, hide)
    assert (vfs.asked, vfs.scans) == ([("ada", False)], [])
    assert "d/sub/d.txt" not in vfs.reads


@pytest.mark.parametrize("line", ["grep -r ada", "rg ada"])
def test_a_hidden_operand_beside_a_visible_one_keeps_its_match(line):
    # A mount with no search asks the scan guard for every operand; the
    # hidden one reaches no directory, so the walk reports it as absent.
    out, err, _ = _run(RAMVFS(), f"{line} /d/a.txt /d/b.txt", ("/d/b.txt",))
    assert out == b"/d/a.txt:ada here\n"
    assert b"/d/b.txt" in err


@pytest.mark.parametrize(
    "line", ["grep -r ada /d", "grep -rn ada /d", "grep -rl ada /d"]
)
def test_a_path_rule_below_the_walk_keeps_greps_answer(line):
    # The dispatcher asks no search below the rule and judges each line
    # search as a read of its file, so a sealed file is reported as the
    # plain walk reports it.
    deny = ("/d/sub/*",)
    assert _run(SearchRAM(), line, deny=deny) == _run(
        RAMVFS(), line, deny=deny
    )


@pytest.mark.parametrize(
    "line, pulls_every_line",
    [
        ("grep -ri ada /d", True),
        ("grep -rin ada /d", False),
        ("grep -ril ada /d", False),
        ("grep -riq ada /d", False),
        ("rg -i ada /d", True),
        ("rg -iq ada /d", False),
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


# rg -q stops on a long first line of a streamed answer, which it closes all
# the same.
def test_rg_closes_a_streamed_answer_it_stops_inside():
    vfs = SearchRAM(files=False, lines="stream")

    async def run() -> tuple[int, int]:
        ws = Workspace({"/": vfs})
        vfs._store.dirs.add("/big")
        vfs._store.files["/big/x.txt"] = b"ada" * 50_000 + b"\nada\n" * 9
        try:
            await ws.shell("rg -q ada /big/x.txt")
            return len(vfs.pulled), vfs.open
        finally:
            await ws.close()

    assert asyncio.run(run()) == (1, 0)


REFUSED = b"grep: 6 files in scope, narrow the path\n"


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
            (REFUSED, 1),
        ),
        (
            "grep -r ada /d",
            "decline",
            ValueError,
            (REFUSED, 1),
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


@pytest.mark.parametrize("fail", [False, True])
def test_streamed_candidates_must_finish_before_they_can_prune(fail):
    closed = []

    class StreamSearchRAM(SearchRAM):
        async def files_containing(
            self, path, text, *, whole_word, ignore_case, index=NULL_INDEX
        ):
            found = await super().files_containing(
                path,
                text,
                whole_word=whole_word,
                ignore_case=ignore_case,
                index=index,
            )

            async def entries():
                try:
                    for item in found:
                        yield item
                        if fail:
                            raise OSError("truncated search")
                finally:
                    closed.append(True)

            return entries()

    mount = StreamSearchRAM(lines=None)
    result = _run(mount, "grep -r ada /d", hide=("/d/sub/d.txt",))
    if fail:
        assert result[0] == b""
        assert result[2] != 0
    else:
        assert result == _run(
            SearchRAM(lines=None), "grep -r ada /d", hide=("/d/sub/d.txt",)
        )
    assert closed == [True]
