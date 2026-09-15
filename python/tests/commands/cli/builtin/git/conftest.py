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

import contextlib
import functools
from pathlib import Path

import pytest
from dulwich import porcelain
from dulwich.index import ConflictedIndexEntry, Index, IndexEntry
from dulwich.objects import Commit, Tree
from dulwich.repo import Repo

from mirage.commands.cli.builtin.git import GIT
from mirage.commands.cli.builtin.git.constants import GITLINK
from mirage.commands.cli.types import CLIDoors
from mirage.resource.disk import DiskResource
from mirage.types import MountMode
from mirage.workspace import Workspace
from mirage.workspace.executor.builtins.links import path_stat
from mirage.workspace.executor.command.run import (mount_root_of,
                                                   namespace_view_of)
from mirage.workspace.session import Session
from mirage.workspace.session.state import session_view

AUTHOR = b"Test Author <test@example.com>"
MOUNT = "/repo/"


def commit_file(repo_path: Path, name: str, content: str,
                message: str) -> bytes:
    """Write one file and commit it, returning the commit id.

    Args:
        repo_path (Path): the repository's working tree.
        name (str): file name relative to the working tree.
        content (str): file content.
        message (str): commit message.
    """
    (repo_path / name).write_text(content, encoding="utf-8")
    porcelain.add(str(repo_path), paths=[str(repo_path / name)])
    return porcelain.commit(str(repo_path),
                            message=message.encode(),
                            author=AUTHOR,
                            committer=AUTHOR)


@pytest.fixture
def repo_path(tmp_path: Path) -> Path:
    """A real on-disk repository with three commits on the default branch.

    Built with dulwich rather than hand-written bytes so the fixture is
    genuine git format: real zlib loose objects, a real HEAD, real refs.

    Args:
        tmp_path (Path): pytest temporary directory.
    """
    path = tmp_path / "work"
    path.mkdir()
    Repo.init(str(path), default_branch=b"refs/heads/main").close()
    commit_file(path, "a.txt", "one\n", "first")
    commit_file(path, "b.txt", "two\n", "second")
    commit_file(path, "a.txt", "one changed\n", "third")
    return path


def pack_everything(repo_path: Path) -> None:
    """Move every loose object into a packfile.

    The Toolathlon repositories arrive packed, so the read path has to
    serve a repository whose objects are not loose at all.

    Args:
        repo_path (Path): the repository's working tree.
    """
    with Repo(str(repo_path)) as repo:
        repo.object_store.pack_loose_objects()
        for fanout in (Path(repo.controldir()) / "objects").iterdir():
            if fanout.is_dir() and len(fanout.name) == 2:
                for obj in fanout.iterdir():
                    obj.unlink()
                fanout.rmdir()


def pack_refs(repo_path: Path) -> None:
    """Move every ref into ``packed-refs``, leaving none loose.

    What a fresh clone looks like: the Toolathlon repository keeps
    ``refs/remotes/origin/main`` there and nowhere else.

    Args:
        repo_path (Path): the repository's working tree.
    """
    with Repo(str(repo_path)) as repo:
        repo.refs.pack_refs(all=True)


def commit_merge(repo_path: Path, other: str, message: str) -> bytes:
    """Commit a merge of another branch, returning the commit id.

    Built with ``merge_heads`` rather than by running git, so the test
    needs no git binary. The tree is whatever is staged, which is what
    makes a merge that resolved a conflict expressible too.

    Args:
        repo_path (Path): the repository's working tree.
        other (str): branch to record as the second parent.
        message (str): commit message.
    """
    with Repo(str(repo_path)) as repo:
        head = repo.refs[f"refs/heads/{other}".encode()]
        return repo.get_worktree().commit(message=message.encode(),
                                          author=AUTHOR,
                                          committer=AUTHOR,
                                          merge_heads=[head])


def make_branch(repo_path: Path, name: str) -> None:
    """Create a branch, whose ref name may contain slashes.

    Args:
        repo_path (Path): the repository's working tree.
        name (str): branch name, e.g. ``feat/git-cli``.
    """
    porcelain.branch_create(str(repo_path), name.encode())


def commit_gitlink(repo_path: Path, name: str) -> None:
    """Record a gitlink at a path and commit it.

    Written straight into the index because reaching this state through
    the CLI would need a submodule, and what the callers exercise is
    what a verb does to a 160000 entry. It points at this repository's
    own HEAD so the commit it names resolves here: an ordinary
    submodule's does not, and the two failure modes differ.

    Args:
        repo_path (Path): the repository's working tree.
        name (str): the path to record, repository-relative.
    """
    with Repo(str(repo_path)) as repo:
        head = repo.refs[b"HEAD"]
        index = repo.open_index()
        index[name.encode()] = IndexEntry(ctime=0,
                                          mtime=0,
                                          dev=0,
                                          ino=0,
                                          mode=GITLINK,
                                          uid=0,
                                          gid=0,
                                          size=0,
                                          sha=head)
        index.write()
    porcelain.commit(str(repo_path),
                     message=b"gitlink",
                     author=AUTHOR,
                     committer=AUTHOR)


def branch_with_gitlink(repo_path: Path, branch: str, name: str) -> None:
    """Write a branch whose tree records a gitlink, leaving HEAD alone.

    The index is untouched on purpose: a branch switch onto a gitlink
    is only reachable while the current branch does not carry one, and
    committing it here would put it in HEAD's tree as well.

    Args:
        repo_path (Path): the repository's working tree.
        branch (str): the branch to write, created from HEAD.
        name (str): the path to record, repository-relative.
    """
    with Repo(str(repo_path)) as repo:
        head = repo.refs[b"HEAD"]
        tree = repo[repo[head].tree]
        assert isinstance(tree, Tree)
        tree.add(name.encode(), GITLINK, head)
        repo.object_store.add_object(tree)
        commit = Commit()
        commit.tree = tree.id
        commit.parents = [head]
        commit.author = commit.committer = AUTHOR
        commit.commit_time = commit.author_time = 0
        commit.commit_timezone = commit.author_timezone = 0
        commit.message = b"gitlink"
        repo.object_store.add_object(commit)
        repo.refs[f"refs/heads/{branch}".encode()] = commit.id


def conflict_index(repo_path: Path, name: str) -> None:
    """Turn one staged path into an unmerged one, stages 1 to 3.

    Written straight into the index because reaching this state through
    the CLI would need a merge, and what the callers exercise is what a
    verb does to a path that is already conflicted.

    Args:
        repo_path (Path): the repository's working tree.
        name (str): the path to conflict, repository-relative.
    """
    index = Index(str(repo_path / ".git" / "index"))
    entry = index[name.encode()]
    assert isinstance(entry, IndexEntry)
    index[name.encode()] = ConflictedIndexEntry(ancestor=entry,
                                                this=entry,
                                                other=entry)
    index.write()


@contextlib.contextmanager
def mounted(repo_path: Path):
    """Mount a repository at /repo in a fresh workspace.

    Needed whenever the repository changes shape on disk mid-test: a
    mount caches its listings, so packing behind its back would leave it
    naming loose objects that no longer exist.

    Args:
        repo_path (Path): the repository's working tree.
    """
    with Workspace({MOUNT: DiskResource(root=str(repo_path))}) as ws:
        yield ws


@contextlib.contextmanager
def mounted_rw(repo_path: Path):
    """Mount a repository writably at /repo, with ``git`` installed.

    The writable twin of ``mounted``, for a test that has to reshape the
    repository on disk between two runs of a verb that writes.

    Args:
        repo_path (Path): the repository's working tree.
    """
    with Workspace({MOUNT: DiskResource(root=str(repo_path))},
                   mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        yield ws


@pytest.fixture
def workspace(repo_path: Path):
    """A workspace with the fixture repository mounted at /repo.

    Args:
        repo_path (Path): the repository's working tree.
    """
    with Workspace({MOUNT: DiskResource(root=str(repo_path))}) as ws:
        yield ws


@pytest.fixture
def git_ws(repo_path: Path):
    """A workspace with the repository mounted and ``git`` installed.

    What every end-to-end verb test needs: the CLI has to be registered
    before the shell can route a `git` line to it.

    Args:
        repo_path (Path): the repository's working tree.
    """
    with Workspace({MOUNT: DiskResource(root=str(repo_path))}) as ws:
        ws.register_cli("git", GIT)
        yield ws


@pytest.fixture
def git_rw(repo_path: Path):
    """A writable workspace with the repository mounted and git installed.

    Separate from ``git_ws`` because the read-only mount is the right
    default for every verb that only reads, and a mutation test that
    silently ran against one would pass for the wrong reason.

    Args:
        repo_path (Path): the repository's working tree.
    """
    with Workspace({MOUNT: DiskResource(root=str(repo_path))},
                   mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        yield ws


def repo_facts(ws):
    """The three discovery facts the dispatcher offers a git leaf.

    In the order ``discover`` takes them, so a call site can spread them.

    Args:
        ws (Workspace): the workspace under test.
    """
    return (ws.dispatch, functools.partial(path_stat, ws.dispatch),
            functools.partial(mount_root_of, ws._registry))


def repo_doors(ws) -> CLIDoors:
    """The doors the dispatcher offers a git leaf inside a workspace.

    Built the way ``handle_command`` builds them, so a test exercising
    a leaf directly sees the same planes a typed line would.

    Args:
        ws (Workspace): the workspace under test.
    """
    return CLIDoors(dispatch=ws.dispatch,
                    stat_path=functools.partial(path_stat, ws.dispatch),
                    ns=namespace_view_of(ws._registry, ws._namespace,
                                         ws.dispatch),
                    session_view=session_view(Session(session_id="test")))


@pytest.fixture
def unborn_path(tmp_path: Path) -> Path:
    """A repository before its first commit.

    HEAD is symbolic and the branch it names has no ref, which is the
    state git calls unborn. Several verbs answer differently here than
    they do anywhere else, so it is a fixture rather than a setup step.

    Args:
        tmp_path (Path): pytest temporary directory.
    """
    path = tmp_path / "fresh"
    path.mkdir()
    Repo.init(str(path), default_branch=b"refs/heads/main").close()
    return path


@pytest.fixture
def unborn_rw(unborn_path: Path):
    """A writable workspace on a repository before its first commit.

    Args:
        unborn_path (Path): the repository's working tree.
    """
    with Workspace({MOUNT: DiskResource(root=str(unborn_path))},
                   mode=MountMode.WRITE) as ws:
        ws.register_cli("git", GIT)
        yield ws
