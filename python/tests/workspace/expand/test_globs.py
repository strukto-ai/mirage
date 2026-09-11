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

from mirage.cache.index import RAMIndexCacheStore
from mirage.core.ram.readdir import readdir as ram_readdir
from mirage.resource.ram import RAMResource
from mirage.types import MountMode, PathSpec
from mirage.utils.glob_walk import make_resolve_glob
from mirage.utils.key_prefix import mount_key
from mirage.workspace import Workspace
from mirage.workspace.cli.registry import CLIRegistry
from mirage.workspace.expand.globs import resolve_globs
from mirage.workspace.mount.mount import MountEntry


def _mock_registry(resolve_result=None):

    async def _resolve_glob(scopes, prefix=""):
        if callable(resolve_result):
            return resolve_result(scopes)
        if resolve_result is not None:
            return resolve_result
        # A backend holding nothing the patterns match. Echoing the specs
        # back would stand in for no backend: a real one never answers a
        # dir-shaped ask with the directory itself.
        return [s for s in scopes if not s.pattern]

    resource = RAMResource()
    resource.resolve_glob = _resolve_glob
    mount = MountEntry("/data/", resource, MountMode.READ)

    reg = MagicMock()
    reg.file_cache = None
    reg.clis = CLIRegistry()
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
    ps = PathSpec(resource_path="data/file.txt",
                  virtual="/data/file.txt",
                  directory="/data/",
                  resolved=True)
    classified = ["cat", ps]
    result = _run(resolve_globs(classified, reg))
    assert len(result) == 2
    assert result[0] == "cat"
    assert isinstance(result[1], PathSpec)
    assert result[1] is ps


def test_glob_pathspec_resolved_to_pathspec():
    resolved_ps = PathSpec(
        resource_path=mount_key("/data/a.txt", "/data"),
        virtual="/data/a.txt",
        directory="/data/",
        resolved=True,
    )
    reg = _mock_registry(resolve_result=[resolved_ps])
    glob_ps = PathSpec(
        resource_path="data/*.txt",
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
    assert result[1] is resolved_ps


def test_glob_multiple_matches_expand():
    matches = [
        PathSpec(resource_path="data/a.txt",
                 virtual="/data/a.txt",
                 directory="/data/",
                 resolved=True),
        PathSpec(resource_path="data/b.txt",
                 virtual="/data/b.txt",
                 directory="/data/",
                 resolved=True),
    ]
    reg = _mock_registry(resolve_result=matches)
    glob_ps = PathSpec(
        resource_path="data/*.txt",
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


def test_glob_string_result_wrapped_in_pathspec():
    reg = _mock_registry(resolve_result=["/a.txt"])
    glob_ps = PathSpec(
        resource_path="data/*.txt",
        virtual="/data/*.txt",
        directory="/data/",
        pattern="*.txt",
        resolved=False,
    )
    classified = ["cat", glob_ps]
    result = _run(resolve_globs(classified, reg))
    assert len(result) == 2
    assert isinstance(result[1], PathSpec)
    assert result[1].virtual == "/data/a.txt"


def test_glob_no_match_keeps_literal_word():
    reg = _mock_registry(resolve_result=[])
    glob_ps = PathSpec(
        resource_path="data/*.xyz",
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
    matches = [
        PathSpec(resource_path="*a.txt",
                 virtual="/data/*a.txt",
                 directory="/data/",
                 resolved=True),
        PathSpec(resource_path="xa.txt",
                 virtual="/data/xa.txt",
                 directory="/data/",
                 resolved=True),
    ]
    reg = _mock_registry(resolve_result=matches)
    glob_ps = PathSpec(
        resource_path="*a.txt",
        virtual="/data/*a.txt",
        directory="/data/",
        pattern="*a.txt",
        resolved=False,
    )
    result = _run(resolve_globs(["echo", glob_ps], reg))
    assert [r.virtual for r in result[1:]] == ["/data/*a.txt", "/data/xa.txt"]
    assert all(not r.pattern for r in result[1:])


def test_resource_reinstating_the_literal_itself_yields_no_match():
    """``resolve_glob`` is a public hook, so the shape is not a contract.

    A resource that implements nullglob-off on its own answers a
    no-match ask with the spec it was handed, which is now the directory.
    That is not a child of the directory, so it is no match, and the word
    stays literal rather than expanding to ``/data/``.
    """
    reg = _mock_registry(resolve_result=list)
    glob_ps = PathSpec(
        resource_path="*.nope",
        virtual="/data/*.nope",
        directory="/data/",
        pattern="*.nope",
        resolved=False,
    )
    result = _run(resolve_globs(["cat", glob_ps], reg))
    assert len(result) == 2
    assert result[1].virtual == "/data/*.nope"
    assert result[1].pattern


def test_mixed_text_and_pathspec():
    reg = _mock_registry()
    ps = PathSpec(resource_path="data/file.txt",
                  virtual="/data/file.txt",
                  directory="/data/",
                  resolved=True)
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
        resource_path="unknown/*.txt",
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
        resource_path=mount_key("/data/*.txt", "/data"),
        virtual="/data/*.txt",
        directory="/data/",
        pattern="*.txt",
        resolved=False,
    )
    d = ps.dir
    assert d.virtual == "/data/"
    assert d.pattern == "*.txt"
    assert d.resource_path == ""


def test_pathspec_dir_no_pattern():
    ps = PathSpec(
        resource_path="data/file.txt",
        virtual="/data/file.txt",
        directory="/data/",
        resolved=True,
    )
    d = ps.dir
    assert d.virtual == "/data/"
    assert d.pattern is None


def test_scope_error_truncates_instead_of_crash():
    ram_resolve_glob = make_resolve_glob(ram_readdir, 5)

    resource = RAMResource()
    for i in range(20):
        resource._store.files[f"/f{i:02d}.txt"] = b""
    resource._store.dirs.add("/")
    index = RAMIndexCacheStore()
    glob_ps = PathSpec(
        resource_path="*.txt",
        virtual="/*.txt",
        directory="/",
        pattern="*.txt",
        resolved=False,
    )

    async def _run():
        return await ram_resolve_glob(resource.accessor, [glob_ps], index)

    result = asyncio.run(_run())
    assert len(result) == 5


def test_relative_glob_matches_spelled_as_typed():
    matches = [
        PathSpec(resource_path="data/sub/a.txt",
                 virtual="/data/sub/a.txt",
                 directory="/data/sub/",
                 resolved=True),
    ]
    reg = _mock_registry(resolve_result=matches)
    glob_ps = PathSpec(
        resource_path="data/sub/*.txt",
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
    matches = [
        PathSpec(resource_path="data/a.txt",
                 virtual="/data/a.txt",
                 directory="/data/",
                 resolved=True),
    ]
    reg = _mock_registry(resolve_result=matches)
    glob_ps = PathSpec(
        resource_path="data/*.txt",
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
    matches = [
        PathSpec(resource_path="data/a.txt",
                 virtual="/data/a.txt",
                 directory="/data/",
                 resolved=True),
    ]
    reg = _mock_registry(resolve_result=matches)
    glob_ps = PathSpec(
        resource_path="data/*.txt",
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
    ws = Workspace({
        "/": RAMResource(),
        "/base/inner": RAMResource()
    },
                   mode=MountMode.WRITE)
    ws.create_session("s")
    return ws


async def _seed(ws):
    await ws.execute("mkdir -p /base/sub", session_id="s")
    await ws.execute("printf 111 > /base/f1", session_id="s")
    await ws.execute("printf 2222222 > /base/sub/f2", session_id="s")
    await ws.execute("printf 3333333 > /base/inner/g1", session_id="s")
    await ws.execute("ln -s /base/sub/f2 /base/link", session_id="s")


def _out(ws, line):
    r = _run(ws.execute(line, session_id="s"))
    return r.stdout.decode()


def test_glob_enumerates_nested_mount_root_and_symlink():
    """A glob lists what its directory holds, mounts and links included.

    GNU coreutils 9.7 (debian:stable-slim, tmpfs at base/inner):
    ``echo base/*`` -> ``base/f1 base/inner base/link base/sub``.
    """
    ws = _ws()
    _run(_seed(ws))
    assert _out(ws, "echo /base/*").split() == [
        "/base/f1", "/base/inner", "/base/link", "/base/sub"
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
        "/base/f1", "/base/inner", "/base/link", "/base/sub"
    ]
    assert _out(ws, "find /base/* -maxdepth 0").split() == [
        "/base/f1", "/base/inner", "/base/link", "/base/sub"
    ]
    # stat renders a mount root's name as "/" (a separate, pre-existing
    # divergence reproducible with the operand typed by hand), so this
    # pins the row count rather than the naming.
    assert len(_out(ws, "stat /base/*").splitlines()) == 4
    # wc follows the link and reports the target's bytes under the link's
    # name, and names each directory operand on stderr, like GNU.
    assert _out(ws, "wc -c /base/*").split() == [
        "3", "/base/f1", "7", "/base/link", "10", "total"
    ]


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
    _run(ws.execute("touch '/base/*a.txt'", session_id="s"))
    _run(ws.execute("touch /base/xa.txt", session_id="s"))
    assert _out(
        ws, "echo /base/*a.txt").split() == ["/base/*a.txt", "/base/xa.txt"]


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
    _run(ws.execute("mkdir '/base/*d'", session_id="s"))
    _run(ws.execute("touch '/base/*d/one.txt'", session_id="s"))
    _run(ws.execute("touch '/base/*d/two.txt'", session_id="s"))
    assert _out(ws, "echo '/base/*d'/*.txt").split() == [
        "/base/*d/one.txt", "/base/*d/two.txt"
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
    typed = _run(ws.execute("tar -cf /out.tar /base/inner", session_id="s"))
    globbed = _run(ws.execute("tar -cf /out2.tar /base/i*", session_id="s"))
    assert globbed.stderr == typed.stderr
    assert globbed.exit_code == typed.exit_code
    assert b"Device or resource busy" in globbed.stderr


def _seed_links(ws):
    _run(_seed(ws))
    _run(ws.execute("ln -s /base/sub /base/dlink", session_id="s"))
    _run(ws.execute("ln -s /base/inner /base/mlink", session_id="s"))


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
    assert _out(
        ws, "echo /base/*/f2").split() == ["/base/dlink/f2", "/base/sub/f2"]


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
