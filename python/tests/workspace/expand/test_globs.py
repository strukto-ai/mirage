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
from unittest.mock import MagicMock

import pytest

from mirage.core.ram.readdir import readdir as ram_readdir
from mirage.core.ram.stat import stat as ram_stat
from mirage.io.types import IOResult
from mirage.types import MountMode, PathSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.base import BaseVFS
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace
from mirage.workspace.cli.registry import CLIRegistry
from mirage.workspace.expand.globs import resolve_globs
from mirage.workspace.mount.mount import MountEntry
from tests.fixtures.vfs_io import override


def _mock_registry(listing=None):
    """A registry whose dispatcher lists ``listing`` for every directory.

    Args:
        listing (list[str] | None): the virtual paths a listing answers.
    """
    mount = MountEntry("/data/", RAMVFS(), MountMode.READ)

    async def dispatch(name, path, /, **kwargs):
        if name == "readdir":
            return list(listing or []), IOResult()
        raise FileNotFoundError(path.virtual)

    reg = MagicMock()
    reg.file_cache = None
    reg.clis = CLIRegistry()
    reg.dispatch = dispatch
    reg.try_mount_for = MagicMock(return_value=mount)
    reg.mounts = MagicMock(return_value=[mount])
    return reg


def _run(coro):
    return asyncio.run(coro)


def test_text_passes_through():
    reg = _mock_registry()
    classified = ["grep", "pattern"]
    result = _run(resolve_globs(classified, reg))
    assert result == ["grep", "pattern"]


def test_pathspec_without_pattern_preserved():
    reg = _mock_registry()
    ps = PathSpec(
        vfs_path="data/file.txt",
        virtual="/data/file.txt",
        directory="/data/",
        resolved=True,
    )
    classified = ["cat", ps]
    result = _run(resolve_globs(classified, reg))
    assert len(result) == 2
    assert result[0] == "cat"
    assert isinstance(result[1], PathSpec)
    assert result[1] is ps


def test_glob_pathspec_resolved_to_pathspec():
    reg = _mock_registry(["/data/a.txt"])
    glob_ps = PathSpec(
        vfs_path="data/*.txt",
        virtual="/data/*.txt",
        directory="/data/",
        pattern="*.txt",
        resolved=False,
    )
    classified = ["cat", glob_ps]
    result = _run(resolve_globs(classified, reg))
    assert len(result) == 2
    assert result[0] == "cat"
    assert isinstance(result[1], PathSpec)
    assert result[1].virtual == "/data/a.txt"
    assert result[1].vfs_path == mount_key("/data/a.txt", "/data")


def test_glob_multiple_matches_expand():
    reg = _mock_registry(["/data/a.txt", "/data/b.txt"])
    glob_ps = PathSpec(
        vfs_path="data/*.txt",
        virtual="/data/*.txt",
        directory="/data/",
        pattern="*.txt",
        resolved=False,
    )
    classified = ["ls", glob_ps]
    result = _run(resolve_globs(classified, reg))
    assert len(result) == 3
    assert result[0] == "ls"
    assert all(isinstance(r, PathSpec) for r in result[1:])
    assert result[1].virtual == "/data/a.txt"
    assert result[2].virtual == "/data/b.txt"


def test_glob_no_match_keeps_literal_word():
    reg = _mock_registry([])
    glob_ps = PathSpec(
        vfs_path="data/*.xyz",
        virtual="/data/*.xyz",
        directory="/data/",
        pattern="*.xyz",
        resolved=False,
    )
    classified = ["cat", glob_ps]
    result = _run(resolve_globs(classified, reg))
    assert len(result) == 2
    assert result[0] == "cat"
    assert isinstance(result[1], PathSpec)
    assert result[1].virtual == "/data/*.xyz"
    assert result[1].pattern


def test_match_named_like_the_glob_word_survives():
    """A file may be named exactly like the word that globbed for it.

    The merge layer used to read "the backend handed me back the word I
    gave it" as "nothing matched", which is what a zero-match backend
    answers with nullglob off. The two are byte-identical, so the real
    match was thrown away.
    """
    reg = _mock_registry(["/data/*a.txt", "/data/xa.txt"])
    glob_ps = PathSpec(
        vfs_path="*a.txt",
        virtual="/data/*a.txt",
        directory="/data/",
        pattern="*a.txt",
        resolved=False,
    )
    result = _run(resolve_globs(["echo", glob_ps], reg))
    assert [r.virtual for r in result[1:]] == ["/data/*a.txt", "/data/xa.txt"]
    assert all(not r.pattern for r in result[1:])


def test_mixed_text_and_pathspec():
    reg = _mock_registry()
    ps = PathSpec(
        vfs_path="data/file.txt",
        virtual="/data/file.txt",
        directory="/data/",
        resolved=True,
    )
    classified = ["grep", "-i", "pattern", ps]
    result = _run(resolve_globs(classified, reg))
    assert result[0] == "grep"
    assert result[1] == "-i"
    assert result[2] == "pattern"
    assert isinstance(result[3], PathSpec)
    assert result[3] is ps


def test_resolve_error_returns_original_pathspec():
    reg = _mock_registry()
    reg.try_mount_for = MagicMock(return_value=None)
    glob_ps = PathSpec(
        vfs_path="unknown/*.txt",
        virtual="/unknown/*.txt",
        directory="/unknown/",
        pattern="*.txt",
        resolved=False,
    )
    classified = ["cat", glob_ps]
    result = _run(resolve_globs(classified, reg))
    assert len(result) == 2
    assert isinstance(result[1], PathSpec)


def test_pathspec_dir_carries_pattern():
    ps = PathSpec(
        vfs_path=mount_key("/data/*.txt", "/data"),
        virtual="/data/*.txt",
        directory="/data/",
        pattern="*.txt",
        resolved=False,
    )
    d = ps.dir
    assert d.virtual == "/data/"
    assert d.pattern == "*.txt"
    assert d.vfs_path == ""


def test_pathspec_dir_no_pattern():
    ps = PathSpec(
        vfs_path="data/file.txt",
        virtual="/data/file.txt",
        directory="/data/",
        resolved=True,
    )
    d = ps.dir
    assert d.virtual == "/data/"
    assert d.pattern is None


def test_relative_glob_matches_spelled_as_typed():
    reg = _mock_registry(["/data/sub/a.txt"])
    glob_ps = PathSpec(
        vfs_path="data/sub/*.txt",
        virtual="/data/sub/*.txt",
        directory="/data/sub/",
        pattern="*.txt",
        resolved=False,
        raw_path="sub/*.txt",
    )
    result = _run(resolve_globs(["ls", glob_ps], reg))
    assert isinstance(result[1], PathSpec)
    assert result[1].raw_path == "sub/a.txt"
    assert result[1].virtual == "/data/sub/a.txt"


def test_absolute_glob_matches_keep_virtual():
    reg = _mock_registry(["/data/a.txt"])
    glob_ps = PathSpec(
        vfs_path="data/*.txt",
        virtual="/data/*.txt",
        directory="/data/",
        pattern="*.txt",
        resolved=False,
    )
    result = _run(resolve_globs(["ls", glob_ps], reg))
    assert isinstance(result[1], PathSpec)
    assert result[1].raw_path == result[1].virtual
    assert result[1].raw_path == "/data/a.txt"


def test_bare_relative_glob_raw_has_no_dir_prefix():
    reg = _mock_registry(["/data/a.txt"])
    glob_ps = PathSpec(
        vfs_path="data/*.txt",
        virtual="/data/*.txt",
        directory="/data/",
        pattern="*.txt",
        resolved=False,
        raw_path="*.txt",
    )
    result = _run(resolve_globs(["ls", glob_ps], reg))
    assert isinstance(result[1], PathSpec)
    assert result[1].raw_path == "a.txt"


def _ws():
    """Workspace with a nested mount and a symlink under /base."""
    ws = Workspace(
        {"/": RAMVFS(), "/base/inner": RAMVFS()}, mode=MountMode.WRITE
    )
    ws.create_session("s")
    return ws


async def _seed(ws):
    await ws.shell("mkdir -p /base/sub", session_id="s")
    await ws.shell("printf 111 > /base/f1", session_id="s")
    await ws.shell("printf 2222222 > /base/sub/f2", session_id="s")
    await ws.shell("printf 3333333 > /base/inner/g1", session_id="s")
    await ws.shell("ln -s /base/sub/f2 /base/link", session_id="s")


def _out(ws, line):
    r = _run(ws.shell(line, session_id="s"))
    return r.stdout.decode()


def test_glob_enumerates_nested_mount_root_and_symlink():
    """A glob lists what its directory holds, mounts and links included.

    GNU coreutils 9.7 (debian:stable-slim, tmpfs at base/inner):
    ``echo base/*`` -> ``base/f1 base/inner base/link base/sub``.
    """
    ws = _ws()
    _run(_seed(ws))
    assert _out(ws, "echo /base/*").split() == [
        "/base/f1",
        "/base/inner",
        "/base/link",
        "/base/sub",
    ]


def test_du_glob_rows_match_gnu():
    """Pinned against ``du -b base/*`` on GNU coreutils 9.7."""
    ws = _ws()
    _run(_seed(ws))
    assert _out(ws, "du /base/*").splitlines() == [
        "3\t/base/f1",
        "7\t/base/inner",
        "12\t/base/link",
        "7\t/base/sub",
    ]


def test_glob_operand_commands_see_mount_and_link():
    """The omission was the expander's, so every glob consumer had it."""
    ws = _ws()
    _run(_seed(ws))
    assert _out(ws, "ls -d /base/*").split() == [
        "/base/f1",
        "/base/inner",
        "/base/link",
        "/base/sub",
    ]
    assert _out(ws, "find /base/* -maxdepth 0").split() == [
        "/base/f1",
        "/base/inner",
        "/base/link",
        "/base/sub",
    ]
    assert _out(ws, "stat /base/* | grep '^  File:'").splitlines() == [
        "  File: /base/f1",
        "  File: /base/inner",
        "  File: /base/link -> /base/sub/f2",
        "  File: /base/sub",
    ]
    # wc follows the link and reports the target's bytes under the link's
    # name, and gives each directory operand a row of zeros beside its
    # stderr line, like GNU.
    assert _out(ws, "wc -c /base/*").split() == [
        "3",
        "/base/f1",
        "0",
        "/base/inner",
        "7",
        "/base/link",
        "0",
        "/base/sub",
        "10",
        "total",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,expected",
    [
        ("echo /base/*", "/base/f1 /base/sub\n"),
        ("shopt -s dotglob; echo /base/*", "/base/f1 /base/sub\n"),
        ("echo /base/*/*", "/base/*/*\n"),
        ("echo /base/*/", "/base/sub/\n"),
        ("shopt -s globstar; echo /base/**", "/base/ /base/f1 /base/sub\n"),
        ("for f in /base/*; do echo $f; done", "/base/f1\n/base/sub\n"),
        ("touch /base/*.key; echo /base/*", "/base/f1 /base/sub\n"),
    ],
)
async def test_a_glob_never_matches_what_the_session_hides(line, expected):
    """The listing a glob walks is the dispatcher's, so a hidden file, a
    hidden nested mount and a link leading where the session cannot see
    match nothing, at any depth."""
    ws = _ws()
    await _seed(ws)
    await ws.shell("printf k > /base/sub/f.key", session_id="s")
    await ws.shell("printf k > /base/top.key", session_id="s")
    await ws.shell("ln -s /base/sub/f.key /base/.alias", session_id="s")
    ws.create_session(
        "n",
        profile={"paths": {"hide": ["*.key", "/base/inner", "/base/sub/f2"]}},
    )
    try:
        result = await ws.shell(line, session_id="n")
        assert await result.stdout_str() == expected
    finally:
        await ws.close()


def test_glob_matches_only_the_pattern():
    """Merged namespace names are filtered by the pattern like any entry."""
    ws = _ws()
    _run(_seed(ws))
    assert _out(ws, "echo /base/i*").split() == ["/base/inner"]
    assert _out(ws, "echo /base/l*").split() == ["/base/link"]
    assert _out(ws, "echo /base/f*").split() == ["/base/f1"]


def test_glob_keeps_a_match_spelled_like_the_word():
    """GNU bash 5.2 (debian:stable-slim), ``*a.txt`` beside ``xa.txt``:
    ``echo /data/*a.txt`` -> ``/data/*a.txt /data/xa.txt``. The live ``*``
    matches the literal ``*`` in the first name.
    """
    ws = _ws()
    _run(_seed(ws))
    _run(ws.shell("touch '/base/*a.txt'", session_id="s"))
    _run(ws.shell("touch /base/xa.txt", session_id="s"))
    assert _out(ws, "echo /base/*a.txt").split() == [
        "/base/*a.txt",
        "/base/xa.txt",
    ]


def test_glob_lists_a_directory_whose_name_holds_a_quoted_glob_char():
    """A quoted glob character in the parent is part of a real name.

    The backend is asked with the directory-shaped spec, and a match is a
    real path it listed, so the two are compared in unmarked space. The
    marked spelling names no directory, so it would answer every word
    under ``'/base/*d'/`` with the literal. GNU bash 5.2
    (debian:stable-slim): ``echo '/data/*d'/*.txt`` ->
    ``/data/*d/one.txt /data/*d/two.txt``.
    """
    ws = _ws()
    _run(_seed(ws))
    _run(ws.shell("mkdir '/base/*d'", session_id="s"))
    _run(ws.shell("touch '/base/*d/one.txt'", session_id="s"))
    _run(ws.shell("touch '/base/*d/two.txt'", session_id="s"))
    assert _out(ws, "echo '/base/*d'/*.txt").split() == [
        "/base/*d/one.txt",
        "/base/*d/two.txt",
    ]
    assert _out(ws, "echo '/base/*d'/o*.txt").split() == ["/base/*d/one.txt"]
    # Nothing under it still falls back to the literal word.
    assert _out(ws, "echo '/base/*d'/*.none").split() == ["/base/*d/*.none"]


def test_unmatched_glob_still_stays_literal():
    """bash with nullglob off: a zero-match word keeps its spelling."""
    ws = _ws()
    _run(_seed(ws))
    assert _out(ws, "echo /base/zzz*").split() == ["/base/zzz*"]


def test_midpath_glob_descends_into_nested_mount():
    """A mount root is a directory a mid-path segment can match."""
    ws = _ws()
    _run(_seed(ws))
    assert _out(ws, "echo /base/*/g1").split() == ["/base/inner/g1"]


def test_single_match_boundary_glob_is_installed():
    """One match is still an expansion.

    Comparing operand counts read it as unchanged, so the pattern stayed
    routed to the parent mount, which cannot serve the child mount's
    keys.
    """
    ws = _ws()
    _run(_seed(ws))
    assert _out(ws, "du /base/i*").splitlines() == ["7\t/base/inner"]
    assert _out(ws, "ls -d /base/i*").split() == ["/base/inner"]


def test_glob_produced_mount_root_is_refused():
    """The mount-root refusal reads operands, so it must see expanded ones.

    Expanding after the admission policies handed ``tar`` a mount root
    nobody had checked, letting a glob archive a whole backend the same
    operand typed by hand is refused for.
    """
    ws = _ws()
    _run(_seed(ws))
    typed = _run(ws.shell("tar -cf /out.tar /base/inner", session_id="s"))
    globbed = _run(ws.shell("tar -cf /out2.tar /base/i*", session_id="s"))
    assert globbed.stderr == typed.stderr
    assert globbed.exit_code == typed.exit_code
    assert b"Device or resource busy" in globbed.stderr


def _seed_links(ws):
    _run(_seed(ws))
    _run(ws.shell("ln -s /base/sub /base/dlink", session_id="s"))
    _run(ws.shell("ln -s /base/inner /base/mlink", session_id="s"))


def test_glob_descends_a_symlinked_directory():
    """bash follows a link while expanding and keeps the typed spelling.

    GNU bash 5.2 (debian:stable-slim, ``base/dlink -> base/sub``):
    ``echo base/d*/f2`` -> ``base/dlink/f2``.
    """
    ws = _ws()
    _seed_links(ws)
    assert _out(ws, "echo /base/d*/f2").split() == ["/base/dlink/f2"]
    assert _out(ws, "echo /base/dlink/*").split() == ["/base/dlink/f2"]


def test_glob_reports_a_link_and_its_target():
    """``echo base/*/f2`` -> ``base/dlink/f2 base/sub/f2`` on GNU bash."""
    ws = _ws()
    _seed_links(ws)
    assert _out(ws, "echo /base/*/f2").split() == [
        "/base/dlink/f2",
        "/base/sub/f2",
    ]


def test_glob_follows_a_link_into_a_nested_mount():
    """The followed directory is re-owned, so it can be another mount."""
    ws = _ws()
    _seed_links(ws)
    assert _out(ws, "echo /base/mlink/*").split() == ["/base/mlink/g1"]
    assert _out(ws, "echo /base/m*/g1").split() == ["/base/mlink/g1"]


def test_midpath_glob_does_not_descend_into_a_file():
    """A descent step yields children, so a file parent matches nothing.

    A backend asked to list a path that is really a file answers with
    that file, which walked back out as a doubled segment
    (``/base/f*/f1`` -> ``/base/base/f1``). GNU bash keeps the literal.
    """
    ws = _ws()
    _run(_seed(ws))
    assert _out(ws, "echo /base/f*/f1").split() == ["/base/f*/f1"]
    assert _out(ws, "echo /base/f1/*").split() == ["/base/f1/*"]


def _dirs_ws():
    """Workspace whose /data/records holds directories, a file and links."""
    ws = Workspace(
        {"/": RAMVFS(), "/data/records/inner": RAMVFS()}, mode=MountMode.WRITE
    )
    ws.create_session("s")
    return ws


async def _seed_dirs(ws):
    await ws.shell(
        "mkdir -p /data/records/2026-09-10 /data/records/2026-09-11",
        session_id="s",
    )
    await ws.shell(
        "echo sample > /data/records/2026-09-10/sample.txt", session_id="s"
    )
    await ws.shell("echo plain > /data/records/plain.txt", session_id="s")
    await ws.shell(
        "ln -s /data/records/2026-09-10 /data/records/lnk", session_id="s"
    )
    await ws.shell(
        "ln -s /data/records/nowhere /data/records/broken", session_id="s"
    )


# Trailing-slash pathname expansion, pinned against bash 5.2.37
# (debian:stable-slim) and bash 3.2.57: a word ending in a slash matches
# directories only (a symlink to a directory counts, a broken link and a
# regular file do not), and every match keeps exactly one trailing slash
# (#1065).


def test_trailing_slash_glob_keeps_the_slash_and_only_directories():
    ws = _dirs_ws()
    _run(_seed_dirs(ws))
    assert _out(ws, "cd /data/records && printf '<%s>\\n' */") == (
        "<2026-09-10/>\n<2026-09-11/>\n<inner/>\n<lnk/>\n"
    )


def test_trailing_slash_glob_spells_an_absolute_word():
    ws = _dirs_ws()
    _run(_seed_dirs(ws))
    assert _out(ws, "printf '<%s>\\n' /data/records/2026*/") == (
        "</data/records/2026-09-10/>\n</data/records/2026-09-11/>\n"
    )


def test_trailing_slash_glob_spells_a_relative_head():
    ws = _dirs_ws()
    _run(_seed_dirs(ws))
    assert _out(ws, "cd /data && printf '<%s>\\n' records/2026*/") == (
        "<records/2026-09-10/>\n<records/2026-09-11/>\n"
    )


def test_trailing_slash_glob_walks_a_mid_path_pattern():
    ws = _dirs_ws()
    _run(_seed_dirs(ws))
    assert _out(ws, "cd /data && printf '<%s>\\n' */2026*/") == (
        "<records/2026-09-10/>\n<records/2026-09-11/>\n"
    )


def test_trailing_slash_glob_zero_match_stays_literal():
    ws = _dirs_ws()
    _run(_seed_dirs(ws))
    assert _out(ws, "cd /data/records && printf '<%s>\\n' nomatch*/") == (
        "<nomatch*/>\n"
    )


def test_doubled_trailing_slash_keeps_one():
    ws = _dirs_ws()
    _run(_seed_dirs(ws))
    assert _out(ws, "cd /data/records && printf '<%s>\\n' 2026*//") == (
        "<2026-09-10/>\n<2026-09-11/>\n"
    )


def test_trailing_slash_glob_drives_the_issue_loop():
    # The traversal from #1065: `"$d"*.txt` concatenates the spelled
    # directory, so a missing slash made every file invisible.
    ws = _dirs_ws()
    _run(_seed_dirs(ws))
    line = (
        'cd /data/records && for d in */; do for f in "$d"*.txt; do '
        '[ -f "$f" ] || continue; cat "$f"; done; done'
    )
    assert _out(ws, line) == "sample\nsample\n"


def _recording_keys(vfs: RAMVFS) -> list[tuple[str, str]]:
    """Record the keys ``vfs``'s listing is handed, then list as before.

    Args:
        vfs (RAMVFS): the backend to watch.
    """
    seen: list[tuple[str, str]] = []

    async def readdir(accessor, path: PathSpec, **kwargs):
        seen.append((path.virtual, path.vfs_path))
        return await ram_readdir(accessor, path)

    override(vfs, "readdir", readdir)
    return seen


def test_glob_listing_is_handed_keys_below_a_non_root_prefix():
    # A glob's listing never sees the mount prefix: the backend is handed
    # each directory keyed ``mount_key(virtual, prefix)``, on every entry
    # point that expands a word (the workspace expander, its mid-path and
    # globstar walks, and the builtins' operands), a quoted prefix read
    # by its literal spelling.
    # Pinned the same way in typescript's globs.test.ts.
    vfs = RAMVFS()
    ws = Workspace({"/mnt/x+/": vfs}, mode=MountMode.WRITE)
    seen = _recording_keys(vfs)
    ws.create_session("s")
    for line in (
        "mkdir -p /mnt/x+/team/sub",
        "printf 1 > /mnt/x+/team/f1",
        "printf 2 > /mnt/x+/tea.txt",
        "printf 3 > /mnt/x+/other",
    ):
        _run(ws.shell(line, session_id="s"))
    cases = [
        ("echo /mnt/x+/*", "/mnt/x+/other /mnt/x+/tea.txt /mnt/x+/team"),
        ("echo /mnt/x+/*/f*", "/mnt/x+/team/f1"),
        ("cd /mnt/x+ && echo tea*", "tea.txt team"),
        ("shopt -s globstar; echo /mnt/x+/**/f1", "/mnt/x+/team/f1"),
        ("touch /mnt/x+/tea* && echo touched", "touched"),
        ("echo '/mnt/x+'/t*", "/mnt/x+/tea.txt /mnt/x+/team"),
    ]
    for line, want in cases:
        assert _out(ws, line).strip() == want, line
    assert seen
    assert [
        (v, key) for v, key in seen if key != mount_key(v, "/mnt/x+")
    ] == []


class NoStatRAM(RAMVFS):
    """A RAM mount that answers listings but defines no ``stat``."""

    stat = BaseVFS.stat


async def _answers_nothing(_accessor, _path, *args, **kwargs):
    return None


def _unstatable(virtual: str, stat):
    async def answer(accessor, path):
        if path.virtual == virtual:
            return None
        return await stat(accessor, path)

    return answer


def _flat_ws(vfs: RAMVFS) -> Workspace:
    vfs.load_state({"dirs": ["/", "/a", "/b"], "files": {"/f": b"x"}})
    ws = Workspace({"/m": vfs}, mode=MountMode.WRITE)
    ws.create_session("s")
    return ws


# A match the mount cannot stat is not a directory, on both hosts.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "stat,expected",
    [
        ("missing", b"/m/*/\n"),
        ("none", b"/m/*/\n"),
        ("one", b"/m/a/ /m/b/\n"),
    ],
    ids=["missing", "none", "one"],
)
async def test_trailing_slash_glob_keeps_nothing_a_mount_cannot_stat(
    stat, expected
):
    vfs = NoStatRAM() if stat == "missing" else RAMVFS()
    ws = _flat_ws(vfs)
    if stat != "missing":
        override(
            vfs,
            "stat",
            _answers_nothing
            if stat == "none"
            else _unstatable("/m/f", ram_stat),
        )
    try:
        listed = await ws.shell("echo /m/*", session_id="s")
        assert listed.stdout == b"/m/a /m/b /m/f\n"
        result = await ws.shell("echo /m/*/", session_id="s")
        assert (result.exit_code, result.stdout) == (0, expected)
    finally:
        await ws.close()
