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

import json
import os
import shlex
import shutil
import subprocess
from pathlib import Path

import pytest
from dulwich.object_store import MemoryObjectStore
from dulwich.objects import Blob
from dulwich.refs import DictRefsContainer
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git import GIT
from mirage.commands.cli.builtin.git.diff_output import commit_summary
from mirage.version import __version__
from tests.commands.cli.builtin.git.conftest import mounted

FIXTURE = Path(__file__).resolve().parents[6] / "integ/fixtures/git"
FORMS = json.loads((FIXTURE / "read-only.json").read_text())
ENV = {
    **os.environ,
    "LC_ALL": "C",
    "LANG": "C",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_CONFIG_NOSYSTEM": "1",
}


@pytest.fixture(scope="module")
def readonly_repo(tmp_path_factory):
    path = tmp_path_factory.mktemp("readonly")
    subprocess.run(
        ["bash", str(FIXTURE / "read-only.sh"), str(path)], check=True, env=ENV
    )
    return path


@pytest.mark.asyncio
@pytest.mark.parametrize("form", FORMS)
async def test_native_git(readonly_repo, form):
    native = subprocess.run(
        ["git", "-C", str(readonly_repo), *shlex.split(form)],
        capture_output=True,
        env=ENV,
    )
    with mounted(readonly_repo) as ws:
        ws.register_cli("git", GIT)
        got = await ws.shell("git -C /repo " + form)
    assert (got.exit_code, got.stdout or b"", got.stderr or b"") == (
        native.returncode,
        native.stdout,
        native.stderr,
    )


# A named commit always shows its header, even when the pathspec leaves no
# diff (git 2.55 in CI; Apple's git 2.54 drops the commit, so these stay
# out of the native list).
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "form,stdout",
    [
        ("show --format=%s --name-status HEAD~1 -- nothing", b"add app\n"),
        ("show --format=%s --name-status HEAD -- app.txt", b"merge side\n\n"),
        (
            "show --format=%s --first-parent --name-status HEAD -- app.txt",
            b"merge side\n",
        ),
    ],
)
async def test_a_named_commit_keeps_its_header(readonly_repo, form, stdout):
    with mounted(readonly_repo) as ws:
        ws.register_cli("git", GIT)
        got = await ws.shell("git -C /repo " + form)
    assert (got.exit_code, got.stdout) == (0, stdout)


# A commit with no parent in the walk is drawn a column apart from the
# commit below it (git 2.56 in CI; Apple's git 2.54 does not, so these stay
# out of the native list).
@pytest.mark.asyncio
@pytest.mark.parametrize(
    "form,stdout",
    [
        (
            "log --graph --oneline --merges --all",
            b"  * f72a17f evil merge\n* d07b9b4 merge side\n",
        ),
        (
            "log --graph --oneline --no-merges -6 --all",
            "* 9e9a1bb \u00e9lan aA\n \\ \n  * 0bddf6b \u00c9LAN Aa\n"
            "* a0c4dcf docs: FIX typo\n"
            "* eab4670 fix: Remove_Caching_Layer flag\n"
            " \\ \n  * c90354f Add caching layer\n* 6f45eae by Bob\n".encode(),
        ),
    ],
)
async def test_a_root_stands_apart(readonly_repo, form, stdout):
    with mounted(readonly_repo) as ws:
        ws.register_cli("git", GIT)
        got = await ws.shell("git -C /repo " + form)
    assert (got.exit_code, got.stdout) == (0, stdout)


@pytest.mark.asyncio
@pytest.mark.parametrize("form", ["--version", "version", "-v"])
async def test_version_without_repository(git_ws, form):
    result = await git_ws.shell("git " + form)
    assert result.exit_code == 0
    assert result.stdout == f"git version {__version__} (Mirage)\n".encode()


@pytest.mark.asyncio
@pytest.mark.parametrize("flag", ["", "--find-renames", "--no-renames"])
async def test_rename_config(readonly_repo, tmp_path, flag):
    path = tmp_path / "repo"
    shutil.copytree(readonly_repo, path)
    subprocess.run(
        ["git", "-C", str(path), "config", "diff.renames", "false"], check=True
    )
    form = f"show --format= --name-status {flag} HEAD~2"
    native = subprocess.run(
        ["git", "-C", str(path), *shlex.split(form)],
        capture_output=True,
        env=ENV,
    )
    with mounted(path) as ws:
        ws.register_cli("git", GIT)
        got = await ws.shell("git -C /repo " + form)
    assert (got.exit_code, got.stdout or b"", got.stderr or b"") == (
        native.returncode,
        native.stdout,
        native.stderr,
    )


MODE = 0o100644
EXECUTABLE = 0o100755


def repo_with(*contents: bytes) -> tuple[BaseRepo, list[bytes]]:
    """A repository holding each blob, and their ids in the same order.

    Args:
        contents (bytes): blob contents to store.
    """
    store = MemoryObjectStore()
    ids = []
    for content in contents:
        blob = Blob.from_string(content)
        store.add_object(blob)
        ids.append(blob.id)
    return BaseRepo(store, DictRefsContainer({})), ids


# Pinned against git 2.37 and 2.50: a binary blob counts as a changed
# file but zero lines, and in a mixed commit the untouched deletions
# clause drops off the line.
def test_commit_summary_counts_a_binary_file_but_no_lines():
    repo, (bin_id,) = repo_with(b"A\x00B\x00C")
    assert commit_summary(repo, {}, {b"blob.bin": (MODE, bin_id)}) == (
        b" 1 file changed, 0 insertions(+), 0 deletions(-)\n"
        b" create mode 100644 blob.bin\n"
    )


def test_commit_summary_mixes_binary_files_and_text_lines_like_git():
    repo, (txt, bin_id) = repo_with(b"x\ny\nz\n", b"DIFFERENT\x00BYTES")
    after = {b"text.txt": (MODE, txt), b"blob.bin": (MODE, bin_id)}
    assert commit_summary(repo, {}, after) == (
        b" 2 files changed, 3 insertions(+)\n"
        b" create mode 100644 blob.bin\n"
        b" create mode 100644 text.txt\n"
    )


def test_commit_summary_orders_every_line_by_path():
    repo, (one, two) = repo_with(b"one\n", b"two\n")
    before = {b"b": (MODE, one), b"z": (MODE, two)}
    after = {
        b"a": (EXECUTABLE, two),
        b"c": (MODE, one),
        b"z": (EXECUTABLE, two),
    }
    assert commit_summary(repo, before, after).splitlines()[1:] == [
        b" create mode 100755 a",
        b" rename b => c (100%)",
        b" mode change 100644 => 100755 z",
    ]
