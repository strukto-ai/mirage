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
from mirage.cache.index.ram import ListingCheckStore
from mirage.core.github.config import GitHubConfig
from mirage.core.github.read import read, read_many, read_stream
from mirage.core.github.readdir import readdir
from mirage.core.github.stat import stat
from mirage.observe.context import RecordingScope
from mirage.types import FileStat, FileType, PathSpec
from mirage.vfs.github import GitHubVFS
from mirage.workspace import Workspace
from tests.core.github.conftest import GRAPHQL, GitHubRepo, blob_sha
from tests.fixtures.handed import entry_at


# A read is handed its row; with none, or a folder's, it asks nothing.
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "rel, entry, error",
    [
        ("src/gone.py", None, FileNotFoundError),
        (
            "src",
            FileStat(name="src", type=FileType.DIRECTORY),
            IsADirectoryError,
        ),
        ("", None, IsADirectoryError),
    ],
)
async def test_a_read_without_a_file_row_asks_nothing(repo, rel, entry, error):
    await repo.create({"src/a.txt": b"x"})
    with pytest.raises(error):
        await read(repo.accessor(), _at(rel, "/gh"), entry)
    assert await repo.log() == []


def _at(rel: str, prefix: str) -> PathSpec:
    virtual = (prefix.rstrip("/") + "/" + rel) if prefix != "/" else "/" + rel
    return PathSpec(
        virtual=virtual,
        directory=virtual.rsplit("/", 1)[0] or "/",
        vfs_path=rel,
    )


# A mount at the root, one at /gh, and one named like a directory inside the
# repository, so a record labelled with anything but the virtual path lands
# on a key the cache never asks for.
@pytest.mark.asyncio
@pytest.mark.parametrize("prefix", ["/", "/gh", "/src"])
async def test_a_read_records_the_blob_sha_under_the_virtual_path(
    repo, prefix
):
    data = b"payload"
    await repo.create({"src/a.txt": data})
    path = _at("src/a.txt", prefix)
    scope = RecordingScope()
    accessor = repo.accessor()
    row = await entry_at(readdir, accessor, path)
    try:
        assert await read(accessor, path, row) == data
    finally:
        scope.close()
    (rec,) = scope.records
    assert (rec.op, rec.path, rec.source, rec.bytes, rec.fingerprint) == (
        "read",
        path.virtual,
        "github",
        len(data),
        blob_sha(data),
    )
    # The stamped token is the sha the blob was fetched by.
    assert ("blob", rec.fingerprint) in await repo.log()


@pytest.mark.asyncio
async def test_the_synthesized_stream_records_once(repo):
    data = b"streamed"
    await repo.create({"a.txt": data})
    accessor = repo.accessor()
    path = _at("a.txt", "/gh")
    row = await entry_at(readdir, accessor, path)
    scope = RecordingScope()
    try:
        chunks = [c async for c in read_stream(accessor, path, row)]
    finally:
        scope.close()
    assert b"".join(chunks) == data
    assert [(r.op, r.fingerprint) for r in scope.records] == [
        ("read", blob_sha(data))
    ]


@pytest.mark.asyncio
async def test_a_read_stamps_the_sha_it_fetched_not_a_newer_one(repo):
    old, reseated, live = b"old", b"reseated", b"live"
    await repo.create({"a.txt": old})
    accessor = repo.accessor()
    path = _at("a.txt", "/gh")
    row = await entry_at(readdir, accessor, path)
    await repo.commit({"a.txt": reseated})
    # A later listing reseats the accessor's tree only.
    await readdir(accessor, _at("", "/gh"))
    assert accessor.tree["a.txt"].sha == blob_sha(reseated)
    await repo.commit({"a.txt": live})
    scope = RecordingScope()
    try:
        data = await read(accessor, path, row)
    finally:
        scope.close()
    # Three shas are in play: the handed row's, the accessor tree's and
    # the live one. Only the first names the bytes this read returned.
    assert data == old
    assert [r.fingerprint for r in scope.records] == [blob_sha(old)]
    # The check that follows sees the live sha, which is not the one the
    # read stamped, so the copy it left is stale rather than fresh.
    probe = await stat(accessor, path, None, ListingCheckStore())
    assert probe.fingerprint == blob_sha(live)
    assert probe.fingerprint != scope.records[0].fingerprint


# One GraphQL query reads the batch, and what each file kept is recorded
# with: the sha its row names. Bytes that are not UTF-8 come back with no
# text, so that file is left to its own read.
@pytest.mark.asyncio
async def test_read_many_reads_a_batch_in_one_query_and_records_each(repo):
    files = {
        "a.txt": b"alpha\n",
        "b.txt": b"beta\r\n",
        "latin.txt": b"caf\xe9\n",
    }
    await repo.create(files)
    accessor = repo.accessor()
    paths = [_at(rel, "/gh") for rel in files]
    rows = [await entry_at(readdir, accessor, p) for p in paths]
    scope = RecordingScope()
    try:
        got = await read_many(accessor, paths, 1 << 20, rows)
    finally:
        scope.close()
    assert got == {"/gh/a.txt": b"alpha\n", "/gh/b.txt": b"beta\r\n"}
    assert (await repo.count("graphql"), await repo.count("blob")) == (1, 0)
    assert [(r.op, r.path, r.fingerprint) for r in scope.records] == [
        ("read", "/gh/a.txt", blob_sha(b"alpha\n")),
        ("read", "/gh/b.txt", blob_sha(b"beta\r\n")),
    ]


# A blob GraphQL hands over cut short, or as text that is not its bytes, is
# left out: only text whose own sha is the row's is kept. The fake answers
# every blob whole, so the batch's answer is GitHub's with those two blobs
# changed, one alias per file in the order they were asked.
@pytest.mark.asyncio
async def test_read_many_leaves_out_text_cut_short_or_not_its_bytes(repo):
    files = {"a.txt": b"alpha\n", "long.txt": b"x" * 64, "latin.txt": b"caf"}
    await repo.create(files)
    accessor = repo.accessor()
    paths = [_at(rel, "/gh") for rel in files]
    rows = [await entry_at(readdir, accessor, p) for p in paths]
    await repo.run.answer_next(
        "POST",
        GRAPHQL,
        200,
        {
            "data": {
                "repository": {
                    "f0": {"text": "alpha\n", "isTruncated": False},
                    "f1": {"text": "x" * 32, "isTruncated": True},
                    "f2": {"text": "caf�", "isTruncated": False},
                }
            }
        },
    )
    got = await read_many(accessor, paths, 1 << 20, rows)
    assert got == {"/gh/a.txt": b"alpha\n"}


# A file past the limit, a folder and a path with no row are left out
# before anything is asked.
@pytest.mark.asyncio
async def test_read_many_asks_nothing_for_a_file_it_leaves_out(repo):
    await repo.create({"a.txt": b"alpha", "src/b.txt": b"b"})
    accessor = repo.accessor()
    a, src = _at("a.txt", "/gh"), _at("src", "/gh")
    rows = [
        await entry_at(readdir, accessor, a),
        await entry_at(readdir, accessor, src),
        None,
    ]
    gone = _at("gone.txt", "/gh")
    assert await read_many(accessor, [a, src, gone], 4, rows) == {}
    assert await repo.count("graphql") == 0


# cat reads its first operand and reads ahead the rest in one query.
@pytest.mark.asyncio
async def test_cat_reads_ahead_its_operands_in_one_query(repo):
    files = {f"{name}.txt": f"{name}\n".encode() for name in "abcd"}
    await repo.create(files)
    ws = Workspace({"/gh": GitHubVFS(repo.config())})
    try:
        result = await ws.shell("cat /gh/a.txt /gh/b.txt /gh/c.txt /gh/d.txt")
        assert await result.stdout_str() == "a\nb\nc\nd\n"
    finally:
        await ws.close()
    assert (await repo.count("blob"), await repo.count("graphql")) == (1, 1)


def _on_github_com(repo: GitHubRepo, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("mirage.accessor.github.API_BASE", repo.run.url)
    monkeypatch.setattr(
        "mirage.accessor.github.RAW_BASE", repo.run.url + "/raw"
    )


def _anonymous(
    repo: GitHubRepo, base_url: str | None = None
) -> GitHubAccessor:
    config = GitHubConfig(
        owner=repo.owner, repo=repo.name, ref="main", base_url=base_url
    )
    return GitHubVFS(config).accessor


# With no credential on github.com each blob request would spend one of the
# 60 an hour the REST API allows, so a file is downloaded instead, at the
# commit its listing named even after the branch moved on.
@pytest.mark.asyncio
async def test_an_anonymous_read_downloads_the_file_at_the_listed_commit(
    repo, monkeypatch
):
    data = b"payload"
    listed = await repo.create({"src/a b.txt": data})
    _on_github_com(repo, monkeypatch)
    accessor = _anonymous(repo)
    path = _at("src/a b.txt", "/gh")
    row = await entry_at(readdir, accessor, path)
    await repo.commit({"src/a b.txt": b"moved on"})
    scope = RecordingScope()
    try:
        assert await read(accessor, path, row) == data
        streamed = [c async for c in read_stream(accessor, path, row)]
    finally:
        scope.close()
    assert b"".join(streamed) == data
    assert [r.fingerprint for r in scope.records] == [blob_sha(data)] * 2
    log = await repo.log()
    assert sum(1 for name, _ in log if name == "blob") == 0
    assert log.count(("raw", f"{listed}/src/a b.txt")) == 2


# A row the accessor's tree no longer holds names a blob that commit lacks,
# so it is asked by sha as before.
@pytest.mark.asyncio
async def test_an_anonymous_read_of_an_older_row_asks_its_blob(
    repo, monkeypatch
):
    await repo.create({"a.txt": b"old"})
    _on_github_com(repo, monkeypatch)
    accessor = _anonymous(repo)
    path = _at("a.txt", "/gh")
    row = await entry_at(readdir, accessor, path)
    await repo.commit({"a.txt": b"new"})
    await readdir(accessor, _at("", "/gh"))
    assert await read(accessor, path, row) == b"old"
    assert (await repo.count("blob"), await repo.count("raw")) == (1, 0)


# A GitHub Enterprise host has no raw.githubusercontent.com, and a token
# reads blobs as it always has.
@pytest.mark.asyncio
@pytest.mark.parametrize("credential", ["enterprise", "token"])
async def test_a_read_off_github_com_or_with_a_token_asks_the_blob(
    repo, monkeypatch, credential
):
    await repo.create({"a.txt": b"x"})
    if credential == "token":
        _on_github_com(repo, monkeypatch)
        accessor = GitHubVFS(
            GitHubConfig(
                token="unit", owner=repo.owner, repo=repo.name, ref="main"
            )
        ).accessor
    else:
        accessor = _anonymous(repo, base_url=repo.run.url)
    path = _at("a.txt", "/gh")
    row = await entry_at(readdir, accessor, path)
    assert await read(accessor, path, row) == b"x"
    assert (await repo.count("blob"), await repo.count("raw")) == (1, 0)


# GraphQL refuses a call with no credential, so a batch asks nothing and
# leaves each file to its own read.
@pytest.mark.asyncio
async def test_an_anonymous_read_many_asks_nothing(repo, monkeypatch):
    await repo.create({"a.txt": b"alpha"})
    _on_github_com(repo, monkeypatch)
    accessor = _anonymous(repo)
    path = _at("a.txt", "/gh")
    row = await entry_at(readdir, accessor, path)
    assert await read_many(accessor, [path], 1 << 20, [row]) == {}
    assert await repo.count("graphql") == 0


@pytest.mark.asyncio
async def test_cat_reads_a_public_repository_with_no_credential(
    repo, monkeypatch
):
    files = {f"{name}.txt": f"{name}\n".encode() for name in "abcd"}
    await repo.create(files)
    await repo.run.record_requests("authorization")
    _on_github_com(repo, monkeypatch)
    config = GitHubConfig(owner=repo.owner, repo=repo.name)
    ws = Workspace({"/gh": GitHubVFS(config)})
    try:
        result = await ws.shell("cat /gh/a.txt /gh/b.txt /gh/c.txt /gh/d.txt")
        assert await result.stdout_str() == "a\nb\nc\nd\n"
    finally:
        await ws.close()
    assert (
        await repo.count("blob"),
        await repo.count("graphql"),
        await repo.count("raw"),
    ) == (0, 0, 4)
    listed = await repo.run.call("GET", "/_kit/requests")
    assert listed["requests"]
    assert all(r["headers"] == {} for r in listed["requests"])
