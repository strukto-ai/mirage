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
from datetime import datetime, timezone

import pytest

from mirage.cache.index.constants import LISTING_TRUST_WINDOW
from mirage.cache.index.view import IndexView
from mirage.core.github.tree import fetch_tree
from mirage.types import MountMode, PathSpec, ReadPolicy, ReadSpec
from mirage.utils.clock import ManualClock
from mirage.vfs.github import GitHubVFS
from mirage.vfs.ram import RAMVFS
from mirage.vfs.registry import build_vfs
from mirage.workspace import Workspace
from mirage.workspace.mount import Mount
from tests.core.github.conftest import TOKEN, TREES, GitHubRepo

OLD = b"version one\n"
NEW = b"version two, longer\n"
LISTED = b"a.txt\nb.txt\n"
GROWN = b"a.txt\nb.txt\nc.txt\n"
T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
FILES = {
    "docs/a.txt": OLD,
    "docs/b.txt": b"bravo x\n",
    "top.txt": b"top\n",
}
THREE = {f"d{i}/{n}.txt": b"x\n" for i in (1, 2, 3) for n in "abc"}


def _vfs(repo: GitHubRepo):
    return build_vfs(
        "github",
        {
            "token": TOKEN,
            "owner": repo.owner,
            "repo": repo.name,
            "ref": "main",
            "base_url": repo.run.url,
        },
    )


def _mount(vfs, policy: ReadPolicy = ReadPolicy.BOUNDED, ttl: int = 1):
    return Mount(
        vfs=vfs, mode=MountMode.READ, read=ReadSpec(policy=policy, ttl=ttl)
    )


def _ws(vfs, prefix: str = "/gh", **kwargs) -> Workspace:
    return Workspace({prefix: _mount(vfs, **kwargs)})


def _sessions(ws: Workspace, count: int) -> list[str]:
    ids = [f"s{n}" for n in range(count)]
    for session_id in ids:
        ws.create_session(session_id)
    return ids


async def _out(ws: Workspace, line: str, session_id: str | None = None):
    kwargs = {} if session_id is None else {"session_id": session_id}
    result = await asyncio.wait_for(ws.shell(line, **kwargs), 10)
    out = await result.materialize_stdout()
    err = await result.stderr_str()
    assert (result.exit_code, err) == (0, ""), line
    return out


async def _expire(ws: Workspace, path: str) -> None:
    await ws._registry.mount_for(path).index.invalidate()


def _du_paths(out: bytes) -> list[str]:
    return [line.split("\t", 1)[1] for line in out.decode().splitlines()]


@pytest.mark.asyncio
async def test_concurrent_sessions_after_an_expiry_fetch_the_tree_once(repo):
    await repo.create(FILES)
    ws = _ws(_vfs(repo), ttl=600)
    try:
        ids = _sessions(ws, 7)
        assert await _out(ws, "ls /gh/docs") == LISTED
        await _expire(ws, "/gh/docs")
        await repo.run.record_requests()
        outs = await asyncio.wait_for(
            asyncio.gather(
                *(_out(ws, "ls /gh/docs", session_id) for session_id in ids)
            ),
            10,
        )
        assert await repo.counts() == (0, 1, 0)
        assert outs == [LISTED] * 7
    finally:
        await ws.close()


def _gate(monkeypatch) -> tuple[asyncio.Event, asyncio.Event]:
    # Pause outside the mutation fence so a competing reader can enter.
    wiped, release = asyncio.Event(), asyncio.Event()
    original = IndexView.invalidate_prefix
    fired = []

    async def gated(self, vfs_path: str) -> None:
        await original(self, vfs_path)
        if not fired:
            fired.append(vfs_path)
            wiped.set()
            await release.wait()

    monkeypatch.setattr(IndexView, "invalidate_prefix", gated)
    return wiped, release


@pytest.mark.asyncio
async def test_a_reader_arriving_mid_refill_waits_for_it(repo, monkeypatch):
    await repo.create(FILES)
    ws = _ws(_vfs(repo), ttl=600)
    first = second = None
    release = asyncio.Event()
    try:
        _sessions(ws, 2)
        assert await _out(ws, "ls /gh/docs") == LISTED
        await _expire(ws, "/gh/docs")
        await repo.run.record_requests()
        wiped, release = _gate(monkeypatch)
        first = asyncio.ensure_future(_out(ws, "ls /gh/docs", "s0"))
        await asyncio.wait_for(wiped.wait(), 5)
        second = asyncio.ensure_future(_out(ws, "ls /gh/docs", "s1"))
        await asyncio.sleep(0.02)
        waited = not second.done()
        release.set()
        outs = await asyncio.wait_for(asyncio.gather(first, second), 5)
        assert await repo.counts() == (0, 1, 0)
        assert outs == [LISTED, LISTED]
        assert waited
    finally:
        release.set()
        await asyncio.gather(
            *(task for task in (first, second) if task),
            return_exceptions=True,
        )
        await ws.close()


@pytest.mark.asyncio
async def test_a_glob_waits_on_a_refill_in_progress_as_a_listing_does(
    repo, monkeypatch
):
    await repo.create(FILES)
    ws = _ws(_vfs(repo), ttl=600)
    first = globbed = None
    release = asyncio.Event()
    try:
        _sessions(ws, 2)
        assert await _out(ws, "ls /gh/docs") == LISTED
        await _expire(ws, "/gh/docs")
        await repo.run.record_requests()
        wiped, release = _gate(monkeypatch)
        first = asyncio.ensure_future(_out(ws, "ls /gh/docs", "s0"))
        await asyncio.wait_for(wiped.wait(), 5)
        globbed = asyncio.ensure_future(_out(ws, "echo /gh/docs/*", "s1"))
        done, _ = await asyncio.wait({globbed}, timeout=0.02)
        release.set()
        assert await asyncio.wait_for(first, 5) == LISTED
        assert (
            await asyncio.wait_for(globbed, 5)
            == b"/gh/docs/a.txt /gh/docs/b.txt\n"
        )
        # The glob lists through the dispatcher, so it waits on the
        # refill the first ls holds and answers from what that one kept.
        assert not done
        assert await repo.counts() == (0, 1, 0)
    finally:
        release.set()
        await asyncio.gather(
            *[task for task in (first, globbed) if task],
            return_exceptions=True,
        )
        await ws.close()


MIXED = [
    "ls /gh/docs",
    "find /gh -name a.txt",
    "du -a /gh",
    "grep -rl x /gh",
    "echo /gh/docs/*",
    "cat /gh/docs/a.txt",
]


# Rotations 2 and 3 expose lock inversion if refills lock the raw store.
@pytest.mark.asyncio
@pytest.mark.parametrize("rotation", [0, 2, 3])
async def test_mixed_commands_after_an_expiry_never_deadlock(repo, rotation):
    order = MIXED[rotation:] + MIXED[:rotation]
    await repo.create(FILES)
    ws = _ws(_vfs(repo), ttl=600)
    try:
        ids = _sessions(ws, 3)
        expected = {line: await _out(ws, line) for line in MIXED}
        await _expire(ws, "/gh/docs")
        outs = await asyncio.wait_for(
            asyncio.gather(
                *(_out(ws, line, ids[n % 3]) for n, line in enumerate(order))
            ),
            5,
        )
        assert outs == [expected[line] for line in order]
    finally:
        await ws.close()


TREE_WALKS = [
    ("/gh", "find /gh -name c.txt", "/gh/docs/c.txt"),
    ("/gh", "cd /gh && find . -name c.txt", "./docs/c.txt"),
    ("/gh", "du -a /gh", "/gh/docs/c.txt"),
    ("/gh", "cd /gh && du -a", "./docs/c.txt"),
    ("/r/gh", "find /r/gh -name c.txt", "/r/gh/docs/c.txt"),
]
TREE_WALKS_BELOW_ROOT = [
    ("/gh", "find /gh/docs -name c.txt", "/gh/docs/c.txt"),
    ("/gh", "cd /gh/docs && du -a", "./c.txt"),
]


async def _walk_after_an_add(
    repo: GitHubRepo, prefix: str, line: str, path: str
) -> None:
    await repo.create(FILES)
    ws = _ws(_vfs(repo), prefix=prefix, ttl=600)
    try:
        assert await _out(ws, f"ls {prefix}/docs") == LISTED
        await repo.commit({"docs/c.txt": b"charlie\n"})
        await _expire(ws, prefix + "/docs")
        await repo.run.record_requests()
        out = await _out(ws, line)
        printed = _du_paths(out) if "du" in line else out.decode().split()
        assert path in printed
        assert await repo.counts() == (0, 1, 0)
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix,line,path", TREE_WALKS)
async def test_a_tree_walk_after_an_expiry_sees_a_remote_add(
    repo, prefix, line, path
):
    await _walk_after_an_add(repo, prefix, line, path)


@pytest.mark.asyncio
@pytest.mark.parametrize("prefix,line,path", TREE_WALKS_BELOW_ROOT)
async def test_a_tree_walk_below_the_root_refills_once(
    repo, prefix, line, path
):
    await _walk_after_an_add(repo, prefix, line, path)


@pytest.mark.asyncio
async def test_a_truncated_tree_is_not_refetched_by_every_find(repo):
    await repo.create({"top.txt": b"t", "docs/a.txt": OLD})
    await repo.truncate()
    async with repo.accessor().account as account:
        tree, truncated, _ = await fetch_tree(
            account, repo.owner, repo.name, "main"
        )
    vfs = GitHubVFS(
        repo.config(),
        repo.owner,
        repo.name,
        "main",
        default_branch="main",
        tree=tree,
        truncated=truncated,
    )
    ws = _ws(vfs, ttl=600)
    try:
        await _out(ws, "find /gh -name a.txt")
        walks = await repo.count("recursive")
        await _out(ws, "find /gh -name a.txt")
        assert await repo.count("recursive") == walks
    finally:
        await ws.close()


FIRST_READERS = [
    "ls /gh/docs",
    "echo /gh/docs/*",
    "for f in /gh/docs/*; do echo $f; done",
]


@pytest.mark.asyncio
@pytest.mark.parametrize("policy", [ReadPolicy.BOUNDED, ReadPolicy.FRESH])
@pytest.mark.parametrize("first", FIRST_READERS)
async def test_a_listing_is_served_until_the_mount_ttl_then_refetched(
    repo, first, policy
):
    await repo.create(FILES)
    ws = _ws(_vfs(repo), policy=policy, ttl=1)
    try:
        await _out(ws, first)
        await repo.commit({"docs/c.txt": b"charlie\n"})
        # fresh checks the listing, so it sees the add at once; bounded
        # serves the cached one until the mount's ttl runs out.
        assert await _out(ws, "ls /gh/docs") == (
            LISTED if policy is ReadPolicy.BOUNDED else GROWN
        )
        await asyncio.sleep(1.1)
        assert await _out(ws, "ls /gh/docs") == GROWN
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,expected",
    [
        ("ls /gh/docs", GROWN),
        ("cat /gh/docs/a.txt", NEW),
        ("find /gh -name c.txt", b"/gh/docs/c.txt\n"),
    ],
)
async def test_the_first_reader_after_the_ttl_sees_the_remote_change(
    repo, line, expected
):
    await repo.create(FILES)
    ws = _ws(_vfs(repo), ttl=1)
    try:
        assert await _out(ws, "ls /gh/docs") == LISTED
        await repo.commit({"docs/c.txt": b"charlie\n", "docs/a.txt": NEW})
        await asyncio.sleep(1.1)
        assert await _out(ws, line) == expected
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_two_mounts_of_one_repo_keep_their_own_bound(repo):
    await repo.create(FILES)
    ws = Workspace(
        {"/a": _mount(_vfs(repo), ttl=1), "/b": _mount(_vfs(repo), ttl=600)}
    )
    try:
        assert await _out(ws, "ls /a/docs") == LISTED
        assert await _out(ws, "ls /b/docs") == LISTED
        await repo.commit({"docs/c.txt": b"charlie\n"})
        await asyncio.sleep(1.1)
        assert await _out(ws, "ls /a/docs") == GROWN
        assert await _out(ws, "ls /b/docs") == LISTED
    finally:
        await ws.close()


# Keep T0 before the real clock used by the GitHub seed.
@pytest.mark.asyncio
@pytest.mark.parametrize("after,expected", [(599, LISTED), (601, GROWN)])
async def test_a_mount_without_a_ttl_caps_listings_at_the_default(
    repo, after, expected
):
    clock = ManualClock(start=T0.timestamp())
    await repo.create(FILES)
    ws = Workspace(
        {"/gh": Mount(vfs=_vfs(repo), mode=MountMode.READ)}, clock=clock
    )
    try:
        assert await _out(ws, "ls /gh/docs") == LISTED
        await repo.commit({"docs/c.txt": b"charlie\n"})
        clock.advance(after)
        assert await _out(ws, "ls /gh/docs") == expected
    finally:
        await ws.close()


# du refills an expired tree only after it has validated its flags, and
# find's expression is refused before its handler runs: a usage error
# answers locally, with no request at all.
@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["du -s -a /gh", "find /gh -maxdepth nope"])
async def test_an_invalid_walk_after_an_expiry_fetches_nothing(repo, line):
    await repo.create(FILES)
    ws = _ws(_vfs(repo))
    try:
        await _out(ws, "ls /gh/docs")
        await _expire(ws, "/gh")
        before = await repo.counts()
        result = await asyncio.wait_for(ws.shell(line), 10)
        await result.materialize_stdout()
        assert result.exit_code == 1
        assert await result.stderr_str() != ""
        assert await repo.counts() == before
    finally:
        await ws.close()


def _fresh(
    repo: GitHubRepo, prefix: str = "/gh", clock: ManualClock | None = None
) -> Workspace:
    return Workspace(
        {
            prefix: _mount(_vfs(repo), policy=ReadPolicy.FRESH, ttl=600),
            "/r": (RAMVFS(), MountMode.WRITE),
        },
        clock=clock,
    )


# One version check per command: the head it answers is trusted for the rest
# of that command, whatever the command reads the listing for. The version
# check replaces the tree refetch (Task 1.3).
FRESH_BUDGET = [
    ("ls /gh/d1", (1, 0, 0)),
    ("ls -R /gh", (1, 0, 0)),
    ("ls /gh/d1 /gh/d2 /gh/d3", (1, 0, 0)),
    ("echo /gh/*/*.txt", (1, 0, 0)),
    ("find /gh", (1, 0, 0)),
    ("du -a /gh", (1, 0, 0)),
    ("stat /gh/d1/a.txt", (1, 0, 0)),
    ("ls -l /gh/d1", (1, 0, 0)),
    ("ls /gh/d1 | cat", (1, 0, 0)),
    ("echo /gh/d1/* $(true) /gh/d2/*", (1, 0, 0)),
    ("for f in /gh/*/*.txt; do echo $f; done", (1, 0, 0)),
    ("x=(/gh/*/*.txt); echo ${x[@]}", (1, 0, 0)),
    ("f() { local x=(/gh/*/*.txt); echo ${x[@]}; }; f", (1, 0, 0)),
    ("select f in /gh/*/*.txt; do break; done <<< 1 2>/dev/null", (1, 0, 0)),
    ("cp /gh/d1/*.txt /r/", (1, 0, 3)),
]


@pytest.mark.asyncio
@pytest.mark.parametrize("line,expected", FRESH_BUDGET)
async def test_a_fresh_command_checks_the_version_once(repo, line, expected):
    await repo.create(THREE)
    ws = _fresh(repo)
    try:
        await _out(ws, "ls /gh")
        await repo.run.record_requests()
        await _out(ws, line)
        assert await repo.counts() == expected
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_fresh_ls_sees_a_file_added_outside_mirage(repo):
    # The task's own report: before, the second ls sent nothing and did not
    # show the file.
    await repo.create(THREE)
    ws = _fresh(repo)
    try:
        assert await _out(ws, "ls /gh/d1") == b"a.txt\nb.txt\nc.txt\n"
        await repo.commit({"d1/new.txt": b"new\n"})
        await repo.run.record_requests()
        assert await _out(ws, "ls /gh/d1") == b"a.txt\nb.txt\nc.txt\nnew.txt\n"
        # The check misses, then the tree is fetched once (Task 1.3).
        assert await repo.counts() == (1, 1, 0)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_each_command_of_a_loop_sees_changes_made_before_it(repo):
    # One line, two commands: a scope per line would serve the second ls
    # the listing the first one fetched.
    await repo.create(THREE)
    ws = _fresh(repo)

    async def add_before_the_second_check() -> None:
        await repo.run.before_next(
            [("GET", TREES)],
            lambda: repo.commit({"d1/new.txt": b"new\n"}),
            query="",
        )

    try:
        await _out(ws, "ls /gh")
        await repo.run.record_requests()
        # The first command's head check goes on once it has armed the add,
        # which lands while the second command's check waits.
        await repo.run.before_next(
            [("GET", TREES)], add_before_the_second_check, query=""
        )
        out = await _out(ws, "for i in 1 2; do ls /gh/d1; done")
        assert out.count(b"new.txt") == 1
        # Each command checks the head once; the add lands after the
        # first check, so only the second misses and walks (Task 1.3).
        assert await repo.counts() == (2, 1, 0)
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_bounded_mount_next_to_a_fresh_one_keeps_serving(
    repo, github_origin
):
    bounded = GitHubRepo(github_origin)
    try:
        await repo.create(THREE)
        await bounded.create(THREE)
        ws = Workspace(
            {
                "/gh": _mount(_vfs(repo), policy=ReadPolicy.FRESH, ttl=600),
                "/gb": _mount(_vfs(bounded), ttl=600),
            }
        )
        try:
            await _out(ws, "ls /gh/d1 /gb/d1")
            await repo.run.record_requests()
            await bounded.run.record_requests()
            await _out(ws, "ls /gh/d1 /gb/d1")
            # The version check replaces the tree refetch (Task 1.3).
            assert await repo.counts() == (1, 0, 0)
            assert await bounded.counts() == (0, 0, 0)
        finally:
            await ws.close()
    finally:
        await bounded.run.close()


@pytest.mark.asyncio
async def test_seven_fresh_sessions_share_one_refetch(repo):
    # Each session may send its own small check, since one sent before its
    # command began is not trusted; the walk they all miss is fetched once.
    # The version check replaces the tree refetch (Task 1.3).
    await repo.create(THREE)
    ws = _fresh(repo)

    async def checks_settle() -> None:
        # The tree is held until no session's head check is still coming.
        seen = -1
        for _ in range(200):
            await asyncio.sleep(0.05)
            now = await repo.count("dir")
            if now == seen:
                return
            seen = now

    try:
        ids = _sessions(ws, 7)
        await _out(ws, "ls /gh")
        await repo.commit({"d1/new.txt": b"new\n"})
        await repo.run.record_requests()
        await repo.run.before_next(
            [("GET", TREES)], checks_settle, query="recursive=1"
        )
        outs = await asyncio.wait_for(
            asyncio.gather(
                *(_out(ws, "ls /gh/d1", session_id) for session_id in ids)
            ),
            20,
        )
        assert all(b"new.txt" in out for out in outs)
        assert await repo.count("recursive") == 1
        assert 1 <= await repo.count("dir") <= 7
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_an_unscoped_read_trusts_a_listing_for_the_window(repo):
    # A FUSE or programmatic read belongs to no command, so it trusts a
    # listing written within the window: a burst refetches once, not once
    # per call. Task 1.3 is what makes the refetch itself cheaper.
    clock = ManualClock(start=100.0)
    readdir = PathSpec(virtual="/gh/d1", directory="/gh/d1", vfs_path="d1")
    stat = PathSpec(
        virtual="/gh/d1/a.txt", directory="/gh/d1", vfs_path="d1/a.txt"
    )
    await repo.create(THREE)
    ws = _fresh(repo, clock=clock)
    try:
        await _out(ws, "ls /gh")
        await repo.run.record_requests()
        listed, _ = await ws.dispatch("readdir", readdir)
        assert listed == ["/gh/d1/a.txt", "/gh/d1/b.txt", "/gh/d1/c.txt"]
        await ws.dispatch("stat", stat)
        assert await repo.counts() == (0, 0, 0)
        clock.advance(LISTING_TRUST_WINDOW)
        await ws.dispatch("readdir", readdir)
        await ws.dispatch("stat", stat)
        # One version check answers both calls inside the window; it
        # replaces the tree refetch (Task 1.3).
        assert await repo.counts() == (1, 0, 0)
    finally:
        await ws.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("line", ["find /gh", "du -a /gh"])
async def test_a_truncated_tree_walk_sees_every_folder_and_an_outside_add(
    repo, line
):
    # A truncated tree is never refetched and names only the top level, so
    # walking it misses whole folders; the walk goes folder by folder.
    await repo.create(THREE)
    await repo.truncate()
    ws = _fresh(repo)
    try:
        await _out(ws, "ls /gh")
        await repo.commit({"d1/new.txt": b"new\n"})
        out = await _out(ws, line)
        printed = _du_paths(out) if "du" in line else out.decode().split()
        assert "/gh/d2/b.txt" in printed
        assert "/gh/d1/new.txt" in printed
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_truncated_find_honours_maxdepth(repo):
    await repo.create(THREE)
    await repo.truncate()
    ws = _fresh(repo)
    try:
        await _out(ws, "ls /gh")
        out = await _out(ws, "find /gh -maxdepth 1")
        assert sorted(out.decode().split()) == [
            "/gh",
            "/gh/d1",
            "/gh/d2",
            "/gh/d3",
        ]
    finally:
        await ws.close()


@pytest.mark.asyncio
async def test_a_complete_tree_walk_still_reads_the_tree(repo):
    # The folder-by-folder walk is only for a truncated tree; a complete one
    # stays on the tree with no per-folder listing, and an unchanged head
    # costs one check instead of a refetch (Task 1.3).
    await repo.create(THREE)
    ws = _fresh(repo)
    try:
        await _out(ws, "ls /gh")
        await repo.run.record_requests()
        await _out(ws, "find /gh")
        assert await repo.counts() == (1, 0, 0)
    finally:
        await ws.close()
