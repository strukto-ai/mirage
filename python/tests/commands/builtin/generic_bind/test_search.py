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
from mirage.utils.key_prefix import mounted_path
from mirage.vfs.ram import RAMVFS
from mirage.vfs.types import ScanReason
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
    "echo 'x ada' | grep ada - /d/c.txt",
    "echo 'x ada' | rg ada - /d",
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
        # -a reads the binary-extension file no search vouches for, asking
        # the mount first, and a named file is read whatever the search said
        # (twice, as GNU does).
        (
            "grep -ra ada /d",
            "files",
            "a.txt sub/d.txt w.bin",
            "ada",
            ScanReason.BINARY,
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
