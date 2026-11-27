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

import aiohttp
import pytest

from mirage.core.github.search import (
    SearchResult,
    files_containing,
    narrow_paths,
    search_code,
)
from mirage.core.github.tree import ensure_tree
from mirage.policy.builtin.output_cap import ALL_COMMANDS
from mirage.types import Limit, MountMode, PathSpec, ReadSpec
from mirage.utils.key_prefix import mount_key
from mirage.vfs.github import GitHubConfig, GitHubVFS
from mirage.vfs.ram import RAMVFS
from mirage.vfs.registry import build_vfs
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from tests.core.github.conftest import SEARCH, TOKEN, GitHubRepo, blob_sha

# GitHub's documented code-search limit; files at or over it are not indexed.
SEARCH_LIMIT = 384 * 1024
SOURCES = {"src/main.py": b"import os\n", "src/utils.py": b"import os, sys\n"}


def _item(path: str, full_name: str | int | None) -> dict:
    return {"path": path, "sha": path, "repository": {"full_name": full_name}}


def _body(items: list[dict], total: int | None = None) -> dict:
    return {
        "total_count": len(items) if total is None else total,
        "incomplete_results": False,
        "items": items,
    }


async def _q(repo: GitHubRepo) -> list[str]:
    return [asked["q"] for asked in await repo.run.params("GET", SEARCH)]


@pytest.mark.asyncio
async def test_search_code_basic(repo):
    await repo.create(SOURCES)
    result, truncated = await search_code(
        repo.accessor().account, repo.owner, repo.name, "import os"
    )
    assert result == [
        SearchResult(path=p, sha=blob_sha(d)) for p, d in SOURCES.items()
    ]
    assert truncated is False
    assert await repo.run.params("GET", SEARCH) == [
        {"q": "import os repo:integ-user/repo", "per_page": "100"}
    ]


@pytest.mark.asyncio
async def test_search_code_empty_results(repo):
    await repo.create(SOURCES)
    result = await search_code(
        repo.accessor().account, repo.owner, repo.name, "nonexistent"
    )
    assert result == ([], False)


@pytest.mark.asyncio
async def test_search_code_with_path_filter(repo):
    await repo.create(SOURCES)
    await search_code(
        repo.accessor().account,
        repo.owner,
        repo.name,
        "import os",
        path_filter="src/",
    )
    assert await _q(repo) == ["import os repo:integ-user/repo path:src/"]


@pytest.mark.asyncio
async def test_narrow_paths_strips_leading_slash_in_filter(repo):
    await repo.create(SOURCES)
    paths = [PathSpec(vfs_path="src", virtual="/src", directory="/src")]
    await narrow_paths(repo.accessor(), "import", paths)
    assert await _q(repo) == ["import repo:integ-user/repo path:src"]


@pytest.mark.asyncio
async def test_narrow_paths_root_uses_no_filter(repo):
    await repo.create(SOURCES)
    paths = [PathSpec(vfs_path="", virtual="/", directory="/")]
    await narrow_paths(repo.accessor(), "import", paths)
    assert await _q(repo) == ["import repo:integ-user/repo"]


@pytest.mark.asyncio
async def test_narrow_paths_normalizes_results_with_leading_slash(repo):
    await repo.create(SOURCES)
    paths = [
        PathSpec(
            vfs_path=mount_key("/gh", "/gh"), virtual="/gh", directory="/gh"
        )
    ]
    out = await narrow_paths(repo.accessor(), "import", paths)
    assert [p.virtual for p in out] == ["/gh/src/main.py", "/gh/src/utils.py"]
    assert [p.vfs_path for p in out] == ["src/main.py", "src/utils.py"]


@pytest.mark.asyncio
async def test_narrow_paths_voids_the_narrowing_on_error(repo, caplog):
    await repo.create(SOURCES)
    await repo.refuse("search", 500, "boom")
    paths = [PathSpec(vfs_path="src", virtual="/src", directory="/src")]
    with caplog.at_level("DEBUG"):
        out = await narrow_paths(repo.accessor(), "import", paths)
    assert out is None
    assert "falling back to per-file scan" in caplog.text


# The mount's grep push-down rides its accessor's account, and so its pool,
# rather than opening an aiohttp session per code search: once the pool is
# warm, the search opens no session and still reaches GitHub.
@pytest.mark.asyncio
async def test_narrow_paths_rides_the_mount_account(repo, monkeypatch):
    await repo.create(SOURCES)
    accessor = repo.accessor()
    await ensure_tree(accessor)
    opened: list[aiohttp.ClientSession] = []
    real = aiohttp.ClientSession

    def counted(*args, **kwargs) -> aiohttp.ClientSession:
        session = real(*args, **kwargs)
        opened.append(session)
        return session

    monkeypatch.setattr(aiohttp, "ClientSession", counted)
    await narrow_paths(accessor, "needle", [PathSpec.from_str_path("/")])
    assert opened == []
    assert await repo.count("search") == 1


@pytest.mark.asyncio
async def test_search_code_asks_for_the_largest_page(repo):
    # The default page is 30 rows, and a first page read as the whole answer
    # silently narrows grep to 30 files.
    await repo.create(SOURCES)
    await search_code(repo.accessor().account, repo.owner, repo.name, "needle")
    ((asked,),) = [await repo.run.params("GET", SEARCH)]
    assert asked["per_page"] == "100"


# The answers below are code search's, with the rows or counts this case
# needs: the fake only answers rows of its own repositories, each counted.
@pytest.mark.asyncio
async def test_search_code_keeps_only_the_mounted_repository(repo):
    # The pattern is sent verbatim, so a qualifier inside it can rescope the
    # search; a fork shares the repository name and a prefix is not a match.
    await repo.answer(
        "search",
        _body(
            [
                _item("src/a.py", "acme/proj"),
                _item("src/a.py", "other/x"),
                _item("src/a.py", "other/proj"),
                _item("src/a.py", "acme/other"),
                _item("src/a.py", "acme/proj-fork"),
            ]
        ),
    )
    results, _ = await search_code(
        repo.accessor().account, "acme", "proj", "needle"
    )
    assert results == [SearchResult(path="src/a.py", sha="src/a.py")]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "full_name, owner, name",
    [
        ("Acme/Proj", "acme", "proj"),
        ("acme/proj", "Acme", "Proj"),
    ],
)
async def test_search_code_compares_the_repository_case_insensitively(
    repo, full_name, owner, name
):
    await repo.answer("search", _body([_item("src/a.py", full_name)]))
    results, _ = await search_code(
        repo.accessor().account, owner, name, "needle"
    )
    assert [r.path for r in results] == ["src/a.py"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "item",
    [
        {"path": "src/a.py", "sha": "x"},
        {"path": "src/a.py", "sha": "x", "repository": None},
        {"path": "src/a.py", "sha": "x", "repository": {}},
        _item("src/a.py", None),
        _item("src/a.py", 123),
    ],
)
async def test_search_code_drops_an_item_that_names_no_repository(repo, item):
    # Nothing vouches for such an item, and dropping it must not raise: a
    # raise inside narrow_paths voids the whole narrowing.
    await repo.answer("search", _body([item]))
    results, _ = await search_code(
        repo.accessor().account, "acme", "proj", "needle"
    )
    assert results == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "body, truncated",
    [
        ({"total_count": 1, "incomplete_results": False}, False),
        ({"total_count": 0, "incomplete_results": False}, False),
        ({"total_count": 2, "incomplete_results": False}, True),
        ({"total_count": 1, "incomplete_results": True}, True),
        ({"incomplete_results": False}, True),
        ({"total_count": "1", "incomplete_results": False}, True),
        ({"total_count": True, "incomplete_results": False}, True),
        ({"total_count": 0.5, "incomplete_results": False}, True),
        ({"total_count": 1}, True),
    ],
)
async def test_search_code_reports_an_answer_that_is_not_the_whole_set(
    repo, body, truncated
):
    # Only an answer that says it is complete, with a count no larger than
    # the rows it carries, is the whole set; anything else is truncated.
    await repo.answer(
        "search", {**body, "items": [_item("src/a.py", "acme/proj")]}
    )
    _, got = await search_code(
        repo.accessor().account, "acme", "proj", "needle"
    )
    assert got is truncated


@pytest.mark.asyncio
async def test_search_code_reads_null_items_as_no_rows(repo):
    await repo.answer(
        "search",
        {"total_count": 0, "incomplete_results": False, "items": None},
    )
    assert await search_code(
        repo.accessor().account, "acme", "proj", "needle"
    ) == ([], False)


@pytest.mark.asyncio
async def test_search_code_judges_completeness_before_filtering(repo):
    # total_count counts every row the search matched, foreign ones too.
    await repo.answer(
        "search",
        _body([_item("src/a.py", "acme/proj"), _item("src/b.py", "other/x")]),
    )
    results, truncated = await search_code(
        repo.accessor().account, "acme", "proj", "needle"
    )
    assert [r.path for r in results] == ["src/a.py"]
    assert truncated is False


def _cut(path: str) -> dict:
    return _body([_item(path, "integ-user/repo")], total=2)


@pytest.mark.asyncio
async def test_narrow_paths_truncated_answer_returns_none(repo):
    await repo.create({"src/a.py": b"needle\n"})
    await repo.answer("search", _cut("src/a.py"))
    out = await narrow_paths(
        repo.accessor(), "needle", [PathSpec.from_str_path("/")]
    )
    assert out is None


@pytest.mark.asyncio
async def test_narrow_paths_stops_at_the_first_truncated_scope(repo):
    # Code search is rate limited; a narrowing already void asks nothing more.
    await repo.create({"src/a.py": b"needle\n", "docs/b.md": b"needle\n"})
    await repo.answer("search", _cut("src/a.py"), times=2)
    scopes = [
        PathSpec(vfs_path="src", virtual="/src", directory="/src"),
        PathSpec(vfs_path="docs", virtual="/docs", directory="/docs"),
    ]
    out = await narrow_paths(repo.accessor(), "needle", scopes)
    assert out is None
    assert await repo.count("search") == 1


@pytest.mark.asyncio
async def test_narrow_paths_a_failed_scope_voids_the_others(repo):
    # A scope whose search failed contributes nothing, so the hits of the
    # scopes that did answer are not the whole set either.
    await repo.create({"src/a.py": b"needle\n", "docs/b.md": b"needle\n"})
    await repo.run.answer_next(
        "GET",
        SEARCH,
        500,
        {"message": "boom"},
        query=repo.search_query("needle repo:integ-user/repo path:docs"),
    )
    scopes = [
        PathSpec(vfs_path="src", virtual="/src", directory="/src"),
        PathSpec(vfs_path="docs", virtual="/docs", directory="/docs"),
    ]
    out = await narrow_paths(repo.accessor(), "needle", scopes)
    assert out is None
    assert await repo.count("search") == 2


@pytest.mark.asyncio
async def test_narrow_paths_adds_the_files_search_never_indexes(repo):
    # Code search skips files at or over the limit, so a trusted narrowing
    # has to read them itself, off the tree the mount loaded; one an answer
    # also names is listed once.
    await repo.create(
        {
            "src/a.py": b"needle\n",
            "src/big.bin": b"needle\n".ljust(SEARCH_LIMIT),
        }
    )
    accessor = repo.accessor()
    await ensure_tree(accessor)
    root = [PathSpec.from_str_path("/")]
    out = await narrow_paths(accessor, "needle", root)
    assert out is not None
    assert [p.virtual for p in out] == ["/src/a.py", "/src/big.bin"]
    await repo.answer(
        "search",
        _body(
            [
                _item("src/a.py", "integ-user/repo"),
                _item("src/big.bin", "integ-user/repo"),
            ]
        ),
    )
    out = await narrow_paths(accessor, "needle", root)
    assert out is not None
    assert [p.virtual for p in out] == ["/src/a.py", "/src/big.bin"]


@pytest.mark.asyncio
async def test_narrow_paths_adds_big_files_only_from_the_scope(repo):
    # A big file elsewhere would put lines from outside the operand in the
    # output.
    big = b"needle\n".ljust(SEARCH_LIMIT)
    await repo.create(
        {"src/a.py": b"needle\n", "src/big.bin": big, "docs/big.md": big}
    )
    accessor = repo.accessor()
    await ensure_tree(accessor)
    out = await narrow_paths(
        accessor,
        "needle",
        [PathSpec(vfs_path="src", virtual="/src", directory="/src")],
    )
    assert out is not None
    assert [p.virtual for p in out] == ["/src/a.py", "/src/big.bin"]


@pytest.mark.asyncio
async def test_narrow_paths_big_files_do_not_rescue_a_truncated_answer(repo):
    await repo.create({"src/big.bin": b"needle\n".ljust(SEARCH_LIMIT)})
    await repo.answer("search", _cut("src/a.py"))
    out = await narrow_paths(
        repo.accessor(), "needle", [PathSpec.from_str_path("/")]
    )
    assert out is None


REFUSED_AT_4 = b"more than 4 files in scope (walk_limit); narrow the path\n"

STOPPED_AT_4 = b"stopped after 4 files (walk_limit); narrow the path\n"

REPO = {
    "src/a.py": b"import os\nx = 1\n",
    "src/b.py": b"y = 2\n",
    "docs/c.md": b"imports are here\nIMPORT them\n",
    "docs/d.md": b"nothing\n",
    "big.txt": b"import\n" + b"x" * SEARCH_LIMIT,
}


async def _run(
    vfs, line: str, limit: int | None = None
) -> tuple[bytes, bytes, int]:
    limits = {} if limit is None else {ALL_COMMANDS: Limit(walk_limit=limit)}
    ws = Workspace(
        {"/gh": Mount(vfs=vfs, mode=MountMode.READ, command_limits=limits)}
    )
    try:
        result = await ws.shell(line)
        out = await result.materialize_stdout()
        return out, result.stderr or b"", result.exit_code
    finally:
        await ws.close()


def _ram() -> RAMVFS:
    vfs = RAMVFS()
    for key, data in REPO.items():
        parts = key.split("/")
        for depth in range(1, len(parts)):
            vfs._store.dirs.add("/" + "/".join(parts[:depth]))
        vfs._store.files["/" + key] = data
    return vfs


def _config(repo: GitHubRepo, **fields) -> dict:
    return {
        "token": TOKEN,
        "owner": repo.owner,
        "repo": repo.name,
        "base_url": repo.run.url,
        **fields,
    }


async def _on_github(
    repo: GitHubRepo,
    line: str,
    monkeypatch,
    pinned: bool = False,
    limit: int = 5000,
    refused: bool = False,
    truncated: bool = False,
) -> tuple[bytes, bytes, int]:
    monkeypatch.setattr("mirage.core.github.search.SCOPE_WARN", 1)
    head = await repo.create(dict(REPO))
    if truncated:
        await repo.truncate()
    if refused:
        await repo.refuse("search", 500, "boom")
    vfs = build_vfs(
        "github", _config(repo, **({"ref": head} if pinned else {}))
    )
    return await _run(vfs, line, limit)


async def _read(repo: GitHubRepo) -> list[str]:
    # A file is read by its blob, or in a batch the read-ahead sends.
    names = {blob_sha(data): path for path, data in REPO.items()}
    return sorted(
        names[sha]
        for route, raw in await repo.log()
        if route in ("blob", "graphql")
        for sha in raw.split(",")
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, read",
    [
        ("grep -rw import /gh", ["big.txt", "docs/c.md", "src/a.py"]),
        ("grep -rwi IMPORT /gh/src", ["src/a.py"]),
        ("grep -rwc import /gh", ["big.txt", "docs/c.md", "src/a.py"]),
        ("rg -w import /gh", ["big.txt", "docs/c.md", "src/a.py"]),
        ("rg -wl import /gh/docs", ["docs/c.md"]),
    ],
)
async def test_a_whole_word_reads_only_what_code_search_names(
    repo, line, read, monkeypatch
):
    # Code search matches whole words in any case and never indexes
    # big.txt, which is past its size limit, so that file is read anyway.
    got = await _on_github(repo, line, monkeypatch)
    assert got == await _run(_ram(), line)
    assert await repo.count("search") == 1
    assert await _read(repo) == read


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "grep -r import /gh",
        "grep -rw 'imp.rt' /gh",
        "grep -rwv import /gh",
        "rg -w --files-without-match import /gh",
        "grep -w import /gh/src/a.py /gh/src/b.py",
        "grep -rwF 'path:src' /gh",
    ],
)
async def test_a_line_code_search_cannot_answer_reads_every_file(
    repo, line, monkeypatch
):
    # The last line's word is a qualifier to code search, which would
    # rescope the query instead of searching for it.
    got = await _on_github(repo, line, monkeypatch)
    assert got == await _run(_ram(), line)
    assert await repo.count("search") == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "refused, truncated",
    [(True, False), (False, True)],
    ids=["failed", "truncated-tree"],
)
async def test_a_search_that_cannot_vouch_reads_every_file(
    repo, refused, truncated, monkeypatch
):
    # A truncated tree cannot list the files code search never indexes.
    line = "grep -rw import /gh"
    got = await _on_github(
        repo, line, monkeypatch, refused=refused, truncated=truncated
    )
    assert got == await _run(_ram(), line)
    assert await _read(repo) == sorted(REPO)


@pytest.mark.asyncio
async def test_a_ref_off_the_default_branch_reads_every_file(
    repo, monkeypatch
):
    # Code search indexes the default branch only, so a mount pinned to a
    # commit reads every file as a plain scan does.
    line = "grep -rw import /gh"
    got = await _on_github(repo, line, monkeypatch, pinned=True)
    assert got == await _run(_ram(), line)
    assert await repo.count("search") == 0
    assert await _read(repo) == sorted(REPO)


@pytest.mark.asyncio
async def test_a_ref_off_the_default_branch_stops_at_the_cap(
    repo, monkeypatch
):
    line = "grep -rw import /gh"
    got = await _on_github(repo, line, monkeypatch, pinned=True, limit=4)
    assert got == await _run(_ram(), line, 4)
    assert got[1:] == (b"grep: /gh: " + STOPPED_AT_4, 2)
    # The walk reads four and warms none past them: the two it read in a
    # row in docs set no pace for src.
    assert await _read(repo) == sorted(REPO)[:4]


@pytest.mark.asyncio
async def test_a_scope_cheaper_to_read_is_not_searched(repo):
    line = "grep -rw import /gh"
    await repo.create(dict(REPO))
    vfs = build_vfs("github", _config(repo))
    assert await _run(vfs, line) == await _run(_ram(), line)
    assert await repo.count("search") == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line, name",
    [
        ("grep -r import /gh", "grep"),
        ("grep -rwv import /gh", "grep"),
        ("rg 'imp.rt' /gh", "rg"),
    ],
)
async def test_a_search_past_the_scope_cap_stops_there(
    repo, line, name, monkeypatch
):
    got = await _on_github(repo, line, monkeypatch, limit=4)
    assert got == await _run(_ram(), line, 4)
    assert got[1:] == (f"{name}: /gh: ".encode() + STOPPED_AT_4, 2)
    assert await repo.count("blob") == 4


@pytest.mark.asyncio
async def test_a_tree_diff_past_the_scope_cap_is_refused(repo, monkeypatch):
    out, err, code = await _on_github(
        repo, "diff -r /gh /gh", monkeypatch, limit=4
    )
    assert (out, err, code) == (b"", b"diff: " + REFUSED_AT_4, 1)
    assert await repo.count("blob") == 0


@pytest.mark.asyncio
async def test_an_archive_past_the_scope_cap_is_refused(repo, monkeypatch):
    out, err, code = await _on_github(
        repo, "tar -cf - /gh/src", monkeypatch, limit=1
    )
    assert (out, err, code) == (
        b"",
        b"tar: more than 1 files in scope (walk_limit); narrow the path\n",
        1,
    )
    assert await repo.count("blob") == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    [
        "grep -rw import /gh",
        "grep -rwa import /gh",
        "rg -w --binary import /gh",
    ],
)
async def test_a_narrowed_search_under_the_scope_cap_runs(
    repo, line, monkeypatch
):
    # Code search names three files, so a cap of four reads them all.
    got = await _on_github(repo, line, monkeypatch, limit=4)
    assert got == await _run(_ram(), line)
    assert await _read(repo) == ["big.txt", "docs/c.md", "src/a.py"]


@pytest.mark.asyncio
async def test_a_narrowed_search_past_the_scope_cap_stops_there(
    repo, monkeypatch
):
    out, err, code = await _on_github(
        repo, "grep -rw import /gh", monkeypatch, limit=2
    )
    assert (out, err, code) == (
        b"/gh/big.txt:import\n",
        b"grep: /gh: stopped after 2 files (walk_limit); narrow the path\n",
        2,
    )
    assert await _read(repo) == ["big.txt", "docs/c.md"]


@pytest.mark.asyncio
async def test_a_binary_the_walk_skips_does_not_count_to_the_cap(
    repo, monkeypatch
):
    # Code search never indexes a big file, so the answer names it; the walk
    # skips a binary extension without -a, so it is not a read to cap.
    monkeypatch.setattr("mirage.core.github.search.SCOPE_WARN", 1)
    weights = {f"w{i}.bin": REPO["big.txt"] for i in range(2)}
    line = "grep -rw import /gh"
    await repo.create(dict(REPO) | weights)
    vfs = build_vfs("github", _config(repo))
    assert await _run(vfs, line, 3) == await _run(_ram(), line)
    assert await repo.count("search") == 1


@pytest.mark.asyncio
async def test_files_containing_judges_the_tree_it_loads(repo, monkeypatch):
    # A cold mount learns its tree is truncated only once it loads it.
    monkeypatch.setattr("mirage.core.github.search.SCOPE_WARN", 0)
    await repo.create({"src/a.py": b"needle\n"})
    await repo.truncate()
    out = await files_containing(
        repo.accessor(), "needle", [PathSpec.from_str_path("/")]
    )
    assert out is None
    assert await repo.count("recursive") == 1
    assert await repo.count("search") == 0


def _on_github_com(repo: GitHubRepo, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("mirage.accessor.github.API_BASE", repo.run.url)
    monkeypatch.setattr(
        "mirage.accessor.github.RAW_BASE", repo.run.url + "/raw"
    )


@pytest.mark.asyncio
async def test_files_containing_asks_nothing_of_an_anonymous_account(
    repo, monkeypatch
):
    # Code search refuses a call with no credential, so it is not asked, and
    # neither is the tree its scope count would load.
    monkeypatch.setattr("mirage.core.github.search.SCOPE_WARN", 0)
    await repo.create({"src/a.py": b"needle\n"})
    _on_github_com(repo, monkeypatch)
    accessor = GitHubVFS(
        GitHubConfig(owner=repo.owner, repo=repo.name, ref="main")
    ).accessor
    out = await files_containing(
        accessor, "needle", [PathSpec.from_str_path("/")]
    )
    assert out is None
    assert await repo.log() == []


@pytest.mark.asyncio
async def test_files_containing_leaves_a_branch_off_the_default_to_the_walk(
    repo, monkeypatch
):
    # Code search indexes the default branch only, so a mount on any other
    # branch is not narrowed by it, even one named main.
    monkeypatch.setattr("mirage.core.github.search.SCOPE_WARN", 0)
    await repo.create({"src/a.py": b"needle\n"})
    await repo.branch("trunk")
    await repo.set_default_branch("trunk")
    out = await files_containing(
        repo.accessor("main"), "needle", [PathSpec.from_str_path("/")]
    )
    assert out is None
    assert await repo.count("search") == 0


@pytest.mark.asyncio
async def test_an_anonymous_mount_scans_instead_of_searching(
    repo, monkeypatch
):
    monkeypatch.setattr("mirage.core.github.search.SCOPE_WARN", 1)
    line = "grep -rw import /gh"
    await repo.create(dict(REPO))
    _on_github_com(repo, monkeypatch)
    got = await _run(
        build_vfs("github", {"owner": repo.owner, "repo": repo.name}), line
    )
    assert got == await _run(_ram(), line)
    counts = [await repo.count(r) for r in ("search", "blob", "graphql")]
    assert counts == [0, 0, 0]
    log = await repo.log()
    downloaded = {raw.split("/", 1)[1] for r, raw in log if r == "raw"}
    assert downloaded == set(REPO)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "prefix, scope, count",
    [("/gh", "", 5), ("/gh", "/docs", 3), ("/r/gh", "", 5)],
    ids=["root", "subdir", "nested"],
)
async def test_the_scope_count_after_an_expiry_counts_the_refetched_tree(
    repo, prefix, scope, count
):
    # One under the refetched count: a count off the expired tree is
    # smaller, and would let the walk run.
    await repo.create(
        {"docs/a.txt": b"a", "docs/b.txt": b"b", "top.txt": b"t"}
    )
    vfs = build_vfs("github", _config(repo, ref="main"))
    ws = Workspace(
        {
            prefix: Mount(
                vfs=vfs,
                mode=MountMode.READ,
                read=ReadSpec(ttl=600),
                command_limits={ALL_COMMANDS: Limit(walk_limit=count - 1)},
            )
        }
    )
    try:
        assert (await ws.shell(f"ls {prefix}/docs")).exit_code == 0
        await repo.commit({"docs/c.txt": b"c", "new/d.txt": b"d"})
        await ws._registry.mount_for(prefix).index.invalidate()
        await repo.run.record_requests()
        target = f"{prefix}{scope}"
        result = await ws.shell(f"diff -r {target} {target}")
        assert (
            result.stderr
            == (
                f"diff: more than {count - 1} files in scope "
                "(walk_limit); narrow the path\n"
            ).encode()
        )
        assert await repo.counts() == (0, 1, 0)
    finally:
        await ws.close()
