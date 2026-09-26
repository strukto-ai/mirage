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

from mirage.accessor.github import GitHubAccessor
from mirage.commands.builtin.github.du import _du_size
from mirage.commands.builtin.github.grep import grep
from mirage.commands.builtin.github.pushdown import narrow_scope
from mirage.commands.builtin.github.rg import rg
from mirage.commands.config import CommandOpts
from mirage.core.github.search import search_code as real_search_code
from mirage.core.github.tree_entry import TreeEntry
from mirage.io.stream import materialize
from mirage.types import PathSpec
from tests.fixtures.github_mock import MOCK_BLOBS, MOCK_TREE

_NGLOBALS = narrow_scope.__globals__


@pytest.fixture
def counting_read(monkeypatch):
    reads: list[str] = []

    async def _read_bytes(config, owner, repo, sha, session=None):
        reads.append(sha)
        return MOCK_BLOBS.get(sha, b"")

    monkeypatch.setattr("mirage.core.github.read.read_bytes", _read_bytes)
    return reads


def _root() -> PathSpec:
    return PathSpec(vfs_path="", virtual="/", directory="/", resolved=False)


def _subdir() -> PathSpec:
    return PathSpec(vfs_path="src",
                    virtual="/src",
                    directory="/src",
                    resolved=False)


@pytest.mark.asyncio
async def test_du_sizes_from_the_git_tree():
    # du reads the tree, not the index: the tree is keyed repo-relative,
    # which is the space this comparison is in, and it stays right
    # however the mount keys its index.
    accessor = GitHubAccessor(None,
                              "acme",
                              "proj",
                              "main",
                              "main",
                              tree={
                                  "src/main.py":
                                  TreeEntry(path="src/main.py",
                                            type="blob",
                                            sha="main",
                                            size=7)
                              })
    assert await _du_size(accessor, _subdir()) == 7


@pytest.mark.asyncio
async def test_subdir_narrows_and_fetches_fewer(mock_github_api, github_env,
                                                counting_read, monkeypatch):
    accessor, index = github_env
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    stdout, _ = await grep(
        accessor, [_subdir()], ['import'],
        CommandOpts(index=index, flags={
            'r': True,
            'w': True
        }))
    await materialize(stdout)
    # /src holds 7 files; code search narrows to the import-matching subset.
    assert 0 < len(counting_read) < 7


@pytest.mark.asyncio
async def test_regex_scans_every_file(mock_github_api, github_env,
                                      counting_read, monkeypatch):
    # A regex narrows on an extracted literal, so the searched term is only
    # part of the match; a whole-word search for it can miss real matches.
    # Excluded even under -w.
    accessor, index = github_env
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    stdout, _ = await grep(
        accessor, [_root()], ['import.*os'],
        CommandOpts(index=index, flags={
            'r': True,
            'w': True
        }))
    await materialize(stdout)
    assert len(counting_read) == len(MOCK_BLOBS)


@pytest.mark.asyncio
async def test_rg_shortcircuit_no_match_exit_1(mock_github_api, github_env,
                                               monkeypatch):
    accessor, index = github_env
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    stdout, io = await rg(
        accessor, [_root()], ['import'],
        CommandOpts(index=index,
                    flags={
                        'files_with_matches': True,
                        'glob': ['*.nomatch'],
                        'word_regexp': True
                    }))
    body = (await materialize(stdout)).decode()
    assert io.exit_code == 1
    assert body == ""


# The mount conftest.py builds, as code search names it.
_OWN = "test-owner/test-repo"
_IMPORT_FILES = [
    "/src/main.py",
    "/src/models/item.py",
    "/src/models/user.py",
    "/src/utils.py",
    "/tests/test_main.py",
    "/tests/test_utils.py",
]


def _answer(monkeypatch, items, total=None):
    """Answer code search at the HTTP layer, under the real search_code.

    ``mock_github_api`` patches ``search_code`` itself, which would skip the
    rules under test, so the real one is put back and ``github_get`` answers.
    """
    calls: list[dict] = []

    async def _get(token, path, params=None, **kwargs):
        calls.append(params)
        return {
            "total_count": len(items) if total is None else total,
            "incomplete_results": False,
            "items": items,
        }

    monkeypatch.setattr("mirage.core.github.search.search_code",
                        real_search_code)
    monkeypatch.setattr("mirage.core.github.search.github_get", _get)
    return calls


def _hit(path, sha, full_name=_OWN):
    return {"path": path, "sha": sha, "repository": {"full_name": full_name}}


async def _grep_files(accessor, index, pattern, flags):
    stdout, io = await grep(accessor, [_root()], [pattern],
                            CommandOpts(index=index, flags=flags))
    body = (await materialize(stdout)).decode()
    files = sorted({line.split(":", 1)[0] for line in body.splitlines()})
    return files, io


@pytest.mark.asyncio
async def test_a_foreign_answer_falls_back_to_the_full_scan(
        mock_github_api, github_env, counting_read, monkeypatch):
    # A fork shares the path; trusted, it would narrow grep to one file.
    accessor, index = github_env
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    _answer(monkeypatch,
            [_hit("src/main.py", "bbb222", "test-owner/test-repo-fork")])
    files, _ = await _grep_files(accessor, index, "import", {
        "r": True,
        "w": True
    })
    assert files == _IMPORT_FILES
    assert len(counting_read) == len(MOCK_BLOBS)


@pytest.mark.asyncio
async def test_a_truncated_answer_falls_back_to_the_full_scan(
        mock_github_api, github_env, counting_read, monkeypatch):
    accessor, index = github_env
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    _answer(monkeypatch, [_hit("src/main.py", "bbb222")], total=7)
    files, _ = await _grep_files(accessor, index, "import", {
        "r": True,
        "w": True
    })
    assert files == _IMPORT_FILES
    assert len(counting_read) == len(MOCK_BLOBS)


@pytest.mark.asyncio
@pytest.mark.parametrize("pattern, flags", [
    ("import path:src", {
        "r": True,
        "w": True,
        "F": True
    }),
    ("foo NOT bar", {
        "r": True,
        "w": True
    }),
])
async def test_a_pattern_that_rescopes_the_search_is_never_searched(
        mock_github_api, github_env, monkeypatch, pattern, flags):
    # Without -F a colon pattern is not a literal and was never searched; the
    # -F spelling and the operator are what reached code search before.
    accessor, index = github_env
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    calls = _answer(monkeypatch, [_hit("src/main.py", "bbb222")])
    files, io = await _grep_files(accessor, index, pattern, flags)
    assert calls == []
    assert files == []
    assert io.exit_code == 1


@pytest.mark.asyncio
async def test_rg_falls_back_on_a_foreign_answer_too(mock_github_api,
                                                     github_env, counting_read,
                                                     monkeypatch):
    accessor, index = github_env
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    _answer(monkeypatch,
            [_hit("src/main.py", "bbb222", "test-owner/test-repo-fork")])
    stdout, _ = await rg(accessor, [_root()], ["import"],
                         CommandOpts(index=index, flags={"word_regexp": True}))
    await materialize(stdout)
    assert len(counting_read) == len(MOCK_BLOBS)


@pytest.mark.asyncio
async def test_a_complete_own_answer_still_narrows(mock_github_api, github_env,
                                                   counting_read, monkeypatch):
    # The push-down still pays when the answer vouches for itself.
    accessor, index = github_env
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    _answer(monkeypatch, [_hit("src/main.py", "bbb222")])
    files, _ = await _grep_files(accessor, index, "import", {
        "r": True,
        "w": True
    })
    assert files == ["/src/main.py"]
    assert counting_read == ["bbb222"]


@pytest.mark.asyncio
async def test_a_file_search_never_indexes_is_still_read(
        mock_github_api, github_env, counting_read, monkeypatch):
    # tests/test_utils.py holds `import` but sits over the 384 KB limit, so
    # code search can never name it.
    accessor, index = github_env
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    big = dict(MOCK_TREE)
    big["tests/test_utils.py"] = TreeEntry(path="tests/test_utils.py",
                                           type="blob",
                                           sha="ddd222",
                                           size=400_000)

    async def _fetch_tree(config, owner, repo, ref, session=None):
        return dict(big), False

    monkeypatch.setattr("mirage.core.github.tree.fetch_tree", _fetch_tree)
    _answer(monkeypatch, [_hit("src/main.py", "bbb222")])
    files, _ = await _grep_files(accessor, index, "import", {
        "r": True,
        "w": True
    })
    assert files == ["/src/main.py", "/tests/test_utils.py"]
    assert sorted(counting_read) == ["bbb222", "ddd222"]


@pytest.mark.asyncio
@pytest.mark.parametrize("command, flags, stderr", [
    (grep, {
        "r": True,
        "w": True
    }, "grep: 12 files in scope and code search could not narrow them; "
     "narrow the path\n"),
    (grep, {
        "r": True
    }, "grep: 12 files in scope, narrow the path, "
     "or use -w to enable code search\n"),
    (rg, {
        "word_regexp": True
    }, "rg: 12 files in scope and code search could not narrow them; "
     "narrow the path\n"),
])
async def test_a_scope_too_large_to_scan_names_why_it_was_not_narrowed(
        mock_github_api, github_env, monkeypatch, command, flags, stderr):
    # With -w given, telling the caller to add -w is wrong: code search ran
    # and its answer could not be trusted.
    accessor, index = github_env
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    monkeypatch.setitem(command.__wrapped__.__globals__, "SCOPE_ERROR", 5)
    _answer(monkeypatch, [_hit("src/main.py", "bbb222")], total=7)
    _, io = await command(accessor, [_root()], ["import"],
                          CommandOpts(index=index, flags=flags))
    assert io.exit_code == 1
    assert io.stderr == stderr.encode()


@pytest.mark.asyncio
async def test_a_truncated_tree_never_trusts_a_narrowing(
        mock_github_api, github_env, counting_read, monkeypatch):
    # A truncated tree cannot list every file code search skips, so no
    # answer can be shown to be the whole set.
    accessor, index = github_env
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)

    async def _fetch_tree(config, owner, repo, ref, session=None):
        return dict(MOCK_TREE), True

    async def _fetch_dir_tree(config, owner, repo, tree_sha, session=None):
        # The per-directory listing a truncated tree falls back to.
        base = next((p for p, e in MOCK_TREE.items() if e.sha == tree_sha), "")
        return [
            TreeEntry(path=p.rsplit("/", 1)[-1],
                      type=e.type,
                      sha=e.sha,
                      size=e.size) for p, e in MOCK_TREE.items()
            if (p.rsplit("/", 1)[0] if "/" in p else "") == base
        ]

    monkeypatch.setattr("mirage.core.github.tree.fetch_tree", _fetch_tree)
    monkeypatch.setattr("mirage.core.github.readdir.fetch_dir_tree",
                        _fetch_dir_tree)
    calls = _answer(monkeypatch, [_hit("src/main.py", "bbb222")])
    files, _ = await _grep_files(accessor, index, "import", {
        "r": True,
        "w": True
    })
    assert calls == []
    assert files == _IMPORT_FILES


@pytest.mark.asyncio
async def test_a_big_binary_file_is_not_read(mock_github_api, github_env,
                                             counting_read, monkeypatch):
    # A recursive walk skips binary extensions, and an unindexed file joins
    # the narrowing only as a file that walk would have read.
    accessor, index = github_env
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    big = dict(MOCK_TREE)
    big["docs/model.gguf"] = TreeEntry(path="docs/model.gguf",
                                       type="blob",
                                       sha="gguf01",
                                       size=400_000)

    async def _fetch_tree(config, owner, repo, ref, session=None):
        return dict(big), False

    monkeypatch.setattr("mirage.core.github.tree.fetch_tree", _fetch_tree)
    _answer(monkeypatch, [_hit("src/main.py", "bbb222")])
    files, _ = await _grep_files(accessor, index, "import", {
        "r": True,
        "w": True
    })
    assert files == ["/src/main.py"]
    assert counting_read == ["bbb222"]


@pytest.mark.asyncio
async def test_a_named_file_is_always_read(mock_github_api, github_env,
                                           counting_read, monkeypatch):
    # A full scan reads every file named on the line, binary extension or
    # not, so a narrowing is only offered over directory operands.
    accessor, index = github_env
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    big = dict(MOCK_TREE)
    big["docs/model.gguf"] = TreeEntry(path="docs/model.gguf",
                                       type="blob",
                                       sha="gguf02",
                                       size=10)
    monkeypatch.setitem(MOCK_BLOBS, "gguf02", b"import weights\n")

    async def _fetch_tree(config, owner, repo, ref, session=None):
        return dict(big), False

    monkeypatch.setattr("mirage.core.github.tree.fetch_tree", _fetch_tree)
    calls = _answer(monkeypatch, [_hit("src/main.py", "bbb222")])
    named = PathSpec(vfs_path="docs/model.gguf",
                     virtual="/docs/model.gguf",
                     directory="/docs",
                     resolved=False)
    stdout, _ = await grep(
        accessor, [_subdir(), named], ["import"],
        CommandOpts(index=index, flags={
            "r": True,
            "w": True
        }))
    body = (await materialize(stdout)).decode()
    assert calls == []
    assert "/docs/model.gguf:import weights" in body.splitlines()


@pytest.mark.asyncio
@pytest.mark.parametrize("command, flags", [
    (grep, {
        "r": True,
        "w": True
    }),
    (rg, {
        "word_regexp": True
    }),
])
async def test_a_narrowing_left_empty_matches_nothing_and_never_reads_stdin(
        mock_github_api, github_env, counting_read, monkeypatch, command,
        flags):
    # Every candidate here is a binary a walk skips, so the scan the
    # narrowing stands in for reads nothing and matches nothing, as on a
    # Dropbox or Box mount; handed on as an empty operand list it would
    # instead read standard input.
    accessor, index = github_env
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    big = dict(MOCK_TREE)
    big["src/model.gguf"] = TreeEntry(path="src/model.gguf",
                                      type="blob",
                                      sha="gguf01",
                                      size=400_000)

    async def _fetch_tree(config, owner, repo, ref, session=None):
        return dict(big), False

    monkeypatch.setattr("mirage.core.github.tree.fetch_tree", _fetch_tree)
    _answer(monkeypatch, [])
    stdout, io = await command(
        accessor, [_root()], ["import"],
        CommandOpts(index=index, stdin=b"import from stdin\n", flags=flags))
    assert (await materialize(stdout)).decode() == ""
    assert io.exit_code == 1
    assert counting_read == []


_GUIDE = PathSpec(vfs_path="docs/guide.md",
                  virtual="/docs/guide.md",
                  directory="/docs",
                  resolved=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("command, flags", [
    (grep, {
        "r": True,
        "w": True,
        "files_without_match": True
    }),
    (grep, {
        "r": True,
        "w": True,
        "file": [_GUIDE]
    }),
    (rg, {
        "word_regexp": True,
        "invert_match": True
    }),
    (rg, {
        "word_regexp": True,
        "files_without_match": True
    }),
    (rg, {
        "word_regexp": True,
        "file": [_GUIDE]
    }),
])
async def test_an_answer_that_depends_on_every_file_is_never_narrowed(
        mock_github_api, github_env, monkeypatch, command, flags):
    # A narrowing holds only files that match the searched literal: -L and
    # -v print from the files that do not, and -f adds patterns code search
    # never saw.
    accessor, index = github_env
    monkeypatch.setitem(_NGLOBALS, "SCOPE_WARN", 1)
    calls = _answer(monkeypatch, [_hit("src/main.py", "bbb222")])
    stdout, _ = await command(accessor, [_root()], ["import"],
                              CommandOpts(index=index, flags=flags))
    await materialize(stdout)
    assert calls == []
