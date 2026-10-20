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

from pathlib import Path

import pytest
from dulwich import porcelain
from dulwich.repo import Repo

from mirage.commands.cli.builtin.git import GIT
from mirage.types import MountMode
from mirage.vfs.disk import DiskVFS
from mirage.workspace import Workspace
from tests.commands.cli.builtin.git.conftest import commit_file

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


async def shell(
    history: Path, line: str, session: str | None = None
) -> tuple[int, str, str]:
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
        return (
            io.exit_code,
            (io.stdout or b"").decode(),
            (io.stderr or b"").decode(),
        )


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
