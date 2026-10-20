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
from pathlib import Path

import pytest
from dulwich import porcelain
from dulwich.objects import ObjectID
from dulwich.repo import Repo

from mirage.commands.cli.builtin.git import GIT
from mirage.commands.cli.builtin.git.cat_file import typed_bytes
from mirage.commands.cli.builtin.git.discover import discover
from mirage.commands.cli.builtin.git.repo import open_repo
from mirage.commands.cli.builtin.git.seen import (
    located,
    place_of,
    readable,
    shown_entries,
)
from mirage.context.session_context import (
    bind_caller,
    current_caller,
    reset_caller,
)
from mirage.types import MountMode
from mirage.vfs.disk import DiskVFS
from mirage.workspace import Workspace
from tests.commands.cli.builtin.git.conftest import (
    REPO,
    commit_file,
    repo_context,
)

PROFILES = {
    "veiled": {
        "paths": {"hide": ["/repo/secret.txt", "/repo/box/secret.txt"]}
    },
    "boxed": {"paths": {"hide": ["/repo/box/secret.txt"]}},
    "sealed": {
        "commands": {
            "deny": [{"reason": "sealed", "paths": ["/repo/secret.txt"]}]
        }
    },
    "half": {"paths": {"hide": ["/repo/a/secret.txt"]}},
    "fresh": {
        "commands": {"deny": [{"reason": "fresh", "paths": ["/repo/new.txt"]}]}
    },
    "walled": {
        "commands": {
            "deny": [{"reason": "walled", "paths": ["/repo/boxf/secret.txt"]}]
        }
    },
}


@pytest.fixture
def history(tmp_path: Path) -> Path:
    """A repository whose secret was committed twice, beside a folder
    holding another secret and a public file; the second version's bytes
    are also committed at a public place.

    Args:
        tmp_path (Path): pytest temporary directory.
    """
    path = tmp_path / "work"
    (path / "box").mkdir(parents=True)
    Repo.init(str(path), default_branch=b"refs/heads/main").close()
    commit_file(path, "ok.txt", "public\n", "first")
    commit_file(path, "secret.txt", "S3CR3T one\n", "second")
    commit_file(path, "box/secret.txt", "S3CR3T boxed\n", "third")
    commit_file(path, "box/pub.txt", "pub\n", "fourth")
    commit_file(path, "secret.txt", "S3CR3T two\n", "fifth")
    commit_file(path, "copy.txt", "S3CR3T one\n", "sixth")
    return path


async def raw_shell(
    history: Path, line: str, session: str | None = None
) -> tuple[int, bytes, bytes]:
    """Run one line in /repo, as a session or unrestricted.

    Args:
        history (Path): the repository's working tree.
        line (str): the git line.
        session (str | None): the profile to run under, None for none.
    """
    with Workspace(
        {"/repo/": DiskVFS(root=str(history))},
        mode=MountMode.WRITE,
        profiles=PROFILES,
    ) as ws:
        ws.register_cli("git", GIT)
        kw = {}
        if session is not None:
            ws.create_session(session, profile=session)
            kw["session_id"] = session
        io = await ws.shell(f"cd /repo && {line}", **kw)
        return io.exit_code, io.stdout or b"", io.stderr or b""


async def shell(
    history: Path, line: str, session: str | None = None
) -> tuple[int, str, str]:
    """``raw_shell``'s answer as text.

    Args:
        history (Path): the repository's working tree.
        line (str): the git line.
        session (str | None): the profile to run under, None for none.
    """
    code, out, err = await raw_shell(history, line, session)
    return code, out.decode(), err.decode()


@pytest.mark.asyncio
async def test_a_hidden_path_is_one_the_history_never_had(history: Path):
    for line in (
        "git show HEAD:{}",
        "git cat-file -p HEAD:{}",
        "git cat-file -s HEAD:{}",
        "git show :{}",
    ):
        hidden = await shell(history, line.format("secret.txt"), "veiled")
        missing = await shell(history, line.format("nothere.txt"), "veiled")
        assert hidden == tuple(
            part.replace("nothere.txt", "secret.txt")
            if isinstance(part, str)
            else part
            for part in missing
        )
    assert await shell(history, "git log -S S3CR3T --format=%s", "veiled") == (
        0,
        "sixth\n",
        "",
    )
    assert await shell(history, "git grep -l S3CR3T HEAD~1", "veiled") == (
        1,
        "",
        "",
    )


@pytest.mark.asyncio
async def test_an_id_held_only_at_a_hidden_place_names_nothing(
    history: Path,
):
    _, second, _ = await shell(history, "git rev-parse HEAD:secret.txt")
    blob = second.strip()
    assert await shell(history, f"git cat-file -p {blob}", "veiled") == (
        128,
        "",
        f"fatal: Not a valid object name {blob}\n",
    )
    assert (await shell(history, f"git cat-file -e {blob}", "veiled"))[0] == 1
    # The first version's bytes also stand at a public place.
    _, first, _ = await shell(history, "git rev-parse HEAD:copy.txt")
    assert await shell(
        history, f"git cat-file -p {first.strip()}", "veiled"
    ) == (0, "S3CR3T one\n", "")


@pytest.mark.asyncio
async def test_a_tree_lists_what_its_place_holds(history: Path):
    _, root, _ = await shell(history, "git ls-tree --name-only HEAD", "boxed")
    assert "secret.txt" in root.split()
    for line in (
        "git ls-tree --name-only HEAD:box",
        "git cat-file -p HEAD:box",
    ):
        code, out, _ = await shell(history, line, "boxed")
        assert code == 0 and "pub.txt" in out and "secret.txt" not in out
    _, box, _ = await shell(history, "git rev-parse HEAD:box")
    code, out, _ = await shell(
        history, f"git ls-tree --name-only {box.strip()}", "boxed"
    )
    assert (code, out) == (0, "pub.txt\n")
    assert await shell(history, "git show HEAD:box", "boxed") == (
        0,
        "tree HEAD:box\n\npub.txt\n",
        "",
    )
    code, out, _ = await shell(
        history, "git cat-file -p HEAD^{tree}", "veiled"
    )
    assert code == 0 and "secret.txt" not in out and "copy.txt" in out


@pytest.mark.asyncio
async def test_a_rule_keeps_history_content_but_not_names(history: Path):
    refused = (1, "", "git {}: /repo/secret.txt: Permission denied\n")
    for verb, line in (
        ("show", "git show HEAD:secret.txt"),
        ("log", "git log -p"),
        ("grep", "git grep S3CR3T HEAD"),
        ("cat-file", "git cat-file -s HEAD:secret.txt"),
    ):
        code, out, err = await shell(history, line, "sealed")
        assert (code, out, err) == (
            refused[0],
            refused[1],
            refused[2].format(verb),
        )
    code, out, _ = await shell(history, "git log -p -- ok.txt", "sealed")
    assert code == 0 and "public" in out
    code, out, _ = await shell(
        history, "git ls-tree --name-only HEAD", "sealed"
    )
    assert code == 0 and "secret.txt" in out.split()


@pytest.mark.asyncio
async def test_a_refused_checkout_leaves_the_index_as_it_was(history: Path):
    before = await shell(history, "git ls-files -s secret.txt")
    code, _, err = await shell(
        history, "git checkout HEAD~2 -- secret.txt", "sealed"
    )
    assert (code, err) == (
        1,
        "git checkout: /repo/secret.txt: Permission denied\n",
    )
    assert await shell(history, "git ls-files -s secret.txt") == before
    assert (history / "secret.txt").read_text() == "S3CR3T two\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("public_edit", [False, True])
async def test_a_switch_neither_names_nor_writes_a_hidden_file(
    history: Path, public_edit: bool
):
    # A hidden file is no part of the move: an edit to it neither blocks
    # the switch nor is named when another edit does, and it survives.
    (history / "secret.txt").write_text("S3CR3T edited\n")
    if public_edit:
        (history / "copy.txt").write_text("edited\n")
    _, out, err = await shell(
        history,
        "git checkout -q HEAD~2; echo $?; git log -1 --format=%s",
        "veiled",
    )
    if public_edit:
        assert (out, err) == (
            "1\nsixth\n",
            "error: Your local changes to the following files would be "
            "overwritten by checkout:\n\tcopy.txt\nPlease commit your "
            "changes or stash them before you switch branches.\nAborting\n",
        )
    else:
        assert (out, err) == ("0\nfourth\n", "")
    assert (history / "secret.txt").read_text() == "S3CR3T edited\n"


@pytest.mark.asyncio
async def test_a_switch_that_would_remove_a_hidden_file_is_refused(
    history: Path,
):
    # A branch recording a file at `box` cannot be written without
    # removing the directory and the hidden box/secret.txt in it, so the
    # switch is refused, naming the path the session sees.
    await shell(
        history,
        "git checkout -q -b flat && git rm -rq box && echo f > box"
        " && git add box && git commit -qm flat && git checkout -q main",
    )
    _, out, err = await shell(
        history,
        "git checkout -q flat; echo $?; git branch --show-current",
        "boxed",
    )
    assert (out, err) == (
        "1\nmain\n",
        "error: Your local changes to the following files would be "
        "overwritten by checkout:\n\tbox\nPlease commit your changes or "
        "stash them before you switch branches.\nAborting\n",
    )
    assert (history / "box" / "secret.txt").read_text() == "S3CR3T boxed\n"


@pytest.mark.asyncio
async def test_a_path_in_a_tree_named_by_id_stands_where_the_tree_does(
    history: Path,
):
    _, box, _ = await shell(history, "git rev-parse HEAD:box")
    tree = box.strip()
    code, out, _ = await shell(
        history, f"git cat-file -p {tree}:secret.txt", "boxed"
    )
    assert code == 128 and "S3CR3T" not in out
    assert await shell(
        history, f"git cat-file -p {tree}:pub.txt", "boxed"
    ) == (
        0,
        "pub\n",
        "",
    )


@pytest.mark.asyncio
async def test_a_tag_or_a_ref_naming_a_hidden_blob_names_nothing(
    history: Path,
):
    _, second, _ = await shell(history, "git rev-parse HEAD:secret.txt")
    blob = second.strip()
    porcelain.tag_create(
        str(history),
        b"atag",
        author=b"T <t@example.com>",
        message=b"points at a blob",
        annotated=True,
        objectish=blob.encode(),
    )
    (history / ".git" / "refs" / "tags" / "raw").write_text(blob + "\n")
    for line in (
        "git cat-file blob atag",
        "git show atag",
        "git for-each-ref --format='%(raw)' refs/tags/raw",
        "git for-each-ref --format='%(*raw)' refs/tags/atag",
    ):
        _, out, _ = await shell(history, line, "veiled")
        assert "S3CR3T" not in out, line
    assert await shell(
        history, "git for-each-ref --format='%(raw)' refs/tags/raw", "veiled"
    ) == (0, "", "error: refs/tags/raw does not point to a valid object!\n")
    _, out, _ = await shell(history, "git cat-file blob atag")
    assert out == "S3CR3T two\n"


@pytest.fixture
def twins(tmp_path: Path) -> Path:
    """Two directories holding the same files, so one tree id stands at
    two places.

    Args:
        tmp_path (Path): pytest temporary directory.
    """
    path = tmp_path / "twins"
    (path / "a").mkdir(parents=True)
    (path / "b").mkdir()
    Repo.init(str(path), default_branch=b"refs/heads/main").close()
    for side in ("a", "b"):
        commit_file(path, f"{side}/secret.txt", "S3CR3T twin\n", side)
        commit_file(path, f"{side}/pub.txt", "pub\n", side)
    return path


@pytest.mark.asyncio
async def test_an_operand_shows_its_tree_at_its_own_place(twins: Path):
    code, out, _ = await shell(
        twins, "git grep -l S3CR3T HEAD:a HEAD:b", "half"
    )
    assert (code, out) == (0, "HEAD:b:secret.txt\n")
    assert await shell(twins, "git show HEAD:a HEAD:b", "half") == (
        0,
        "tree HEAD:a\n\npub.txt\n\ntree HEAD:b\n\npub.txt\nsecret.txt\n",
        "",
    )


@pytest.mark.asyncio
async def test_staged_content_answers_to_the_rules(history: Path):
    (history / "new.txt").write_text("S3CR3T new\n")
    assert (await shell(history, "git add new.txt"))[0] == 0
    assert await shell(history, "git diff --cached", "fresh") == (
        1,
        "",
        "git diff: /repo/new.txt: Permission denied\n",
    )


@pytest.mark.asyncio
async def test_raw_tree_bytes_name_only_what_is_seen(history: Path):
    code, raw, _ = await raw_shell(history, "git cat-file tree HEAD", "veiled")
    assert code == 0 and b"copy.txt" in raw and b"secret.txt" not in raw
    _, size, _ = await shell(history, "git cat-file -s HEAD^{tree}", "veiled")
    assert int(size) == len(raw)
    _, batch, _ = await raw_shell(
        history, "echo 'HEAD^{tree}' | git cat-file --batch", "veiled"
    )
    assert b"copy.txt" in batch and b"secret.txt" not in batch
    _, tree, _ = await shell(history, "git rev-parse 'HEAD^{tree}'")
    (history / ".git" / "refs" / "tags" / "root").write_text(tree)
    _, listed, _ = await raw_shell(
        history, "git for-each-ref --format='%(raw)' refs/tags/root", "veiled"
    )
    assert b"copy.txt" in listed and b"secret.txt" not in listed


class OnePlaceGate:
    """A gate whose rules could reach every place but refuse only one."""

    scoped = True
    granted = ()

    def __init__(self, refused: str) -> None:
        self.refused = refused

    def scopes(self, virtual: str) -> bool:
        return True

    def refusal(self, virtual: str) -> str | None:
        return "sealed" if virtual == self.refused else None

    def check(self, virtual: str) -> None:
        if self.refusal(virtual) is not None:
            raise PermissionError(virtual)


async def guarded_repo(ws: Workspace):
    """The mounted repository, opened the way a git verb opens it.

    Args:
        ws (Workspace): the workspace with the repository at /repo.
    """
    ws.register_cli("git", GIT)
    vfs = repo_context(ws).vfs
    assert vfs is not None
    location = await discover(vfs, REPO)
    return await open_repo(vfs, replace(location, vfs=vfs))


@pytest.mark.asyncio
async def test_a_blob_reads_where_any_place_lets_it(history: Path):
    # The same bytes stand at secret.txt in history and at copy.txt; a
    # rule keeps only copy.txt, so they read at secret.txt.
    with Workspace(
        {"/repo/": DiskVFS(root=str(history))}, mode=MountMode.WRITE
    ) as ws:
        repo = await guarded_repo(ws)
        blob = ObjectID(repo[b"HEAD"].tree)
        _, copy = repo[blob].lookup_path(
            repo.object_store.__getitem__, b"copy.txt"
        )
        token = bind_caller(
            replace(current_caller(), gate=OnePlaceGate("/repo/copy.txt"))
        )
        try:
            found = await asyncio.to_thread(
                located, repo, repo.object_store[copy]
            )
            assert found is not None
            assert repo.places[copy] == "secret.txt"
            shown_entries(
                repo,
                {
                    b"copy.txt": (0o100644, copy),
                    b"other.txt": (0o100644, copy),
                },
            )
            readable(repo, copy)
        finally:
            reset_caller(token)


@pytest.mark.asyncio
async def test_a_refused_checkout_over_a_directory_leaves_the_index(
    tmp_path: Path,
):
    path = tmp_path / "work"
    path.mkdir()
    Repo.init(str(path), default_branch=b"refs/heads/main").close()
    commit_file(path, "boxf", "a file\n", "file")
    porcelain.remove(str(path), paths=[str(path / "boxf")])
    (path / "boxf").mkdir()
    commit_file(path, "boxf/secret.txt", "S3CR3T dir\n", "directory")
    before = await shell(path, "git ls-files -s")
    code, _, err = await shell(path, "git checkout HEAD~1 -- boxf", "walled")
    assert (code, err) == (
        1,
        "git checkout: /repo/boxf/secret.txt: Permission denied\n",
    )
    assert await shell(path, "git ls-files -s") == before
    assert (path / "boxf" / "secret.txt").read_text() == "S3CR3T dir\n"


@pytest.mark.asyncio
async def test_a_commit_read_walks_no_history(history: Path):
    with Workspace(
        {"/repo/": DiskVFS(root=str(history))}, mode=MountMode.WRITE
    ) as ws:
        repo = await guarded_repo(ws)
        token = bind_caller(
            replace(current_caller(), gate=OnePlaceGate("/repo/copy.txt"))
        )
        try:
            raw = await asyncio.to_thread(typed_bytes, repo, "HEAD", "commit")
            assert raw is not None and raw.startswith(b"tree ")
            assert repo.sightings is None
        finally:
            reset_caller(token)


@pytest.mark.asyncio
async def test_the_history_walk_sights_each_place_once(history: Path):
    with Workspace(
        {"/repo/": DiskVFS(root=str(history))}, mode=MountMode.WRITE
    ) as ws:
        repo = await guarded_repo(ws)
        head = repo[b"HEAD"]
        _, ok = repo[head.tree].lookup_path(
            repo.object_store.__getitem__, b"ok.txt"
        )
        token = bind_caller(
            replace(current_caller(), gate=OnePlaceGate("/repo/copy.txt"))
        )
        try:
            # A commit stands at no place, so this walks all of history.
            await asyncio.to_thread(place_of, repo, head.id)
            assert repo.seen[ok] == ["ok.txt"]
        finally:
            reset_caller(token)
