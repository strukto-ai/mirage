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

from mirage.commands.cli.builtin.git.discover import (
    discover,
    require_work_tree,
)
from mirage.commands.cli.builtin.git.errors import (
    BadConfigValueError,
    InvalidGitFileError,
    NotARepositoryError,
    NotAWorkTreeError,
    NoWorkingDirectoryError,
    WorkTreeChdirError,
)
from mirage.types import ContentType, FileStat, FileType, PathSpec
from mirage.utils.path import typed_spec


def _stat_over(present: set[str], files: set[str] = frozenset()):
    """A stat_path that answers only for the given virtual paths.

    Args:
        present (set[str]): paths that exist as directories.
        files (set[str]): paths that exist as regular files.
    """

    async def stat_path(path: str | PathSpec) -> FileStat | None:
        path = path.virtual if isinstance(path, PathSpec) else path
        if path in files:
            return FileStat(
                name=path.rsplit("/", 1)[-1],
                type=FileType.FILE,
                content=ContentType.TEXT,
            )
        if path not in present:
            return None
        return FileStat(name=path.rsplit("/", 1)[-1], type=FileType.DIRECTORY)

    return stat_path


def _reads(contents: dict[str, bytes]):
    """A dispatcher that serves the given paths and misses everything else.

    Args:
        contents (dict[str, bytes]): virtual path to file body.
    """

    async def dispatch(op: str, path, **_kwargs):
        assert op == "read", op
        virtual = getattr(path, "virtual", path)
        if virtual not in contents:
            raise FileNotFoundError(virtual)
        return contents[virtual], None

    return dispatch


def _no_reads():
    """A dispatcher for a plain checkout, where nothing redirects."""
    return _reads({})


def _root(prefix: str):
    """A mount_root that reports one prefix for every path.

    Args:
        prefix (str): the mount prefix to report.
    """
    return lambda path: prefix


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "start, expected",
    [
        ("/repo", "/repo"),
        ("/repo/src/deep", "/repo"),
        ("/repo/src/", "/repo"),
        ("/repo/vendor/src", "/repo/vendor"),
    ],
)
async def test_discovers_the_nearest_repository(start, expected):
    scope = typed_spec(start, "/")
    repo = await discover(
        _no_reads(),
        _stat_over({"/repo/.git", "/repo/vendor/.git", scope.virtual}),
        _root("/repo/"),
        scope,
    )
    assert repo.gitdir.virtual == f"{expected}/.git"
    assert repo.commondir == repo.gitdir
    assert repo.worktree.virtual == expected
    assert repo.mount_root.virtual == "/repo"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "root, start, present",
    [
        ("/repo/", "/repo/src", {"/.git", "/repo/src"}),
        ("/repo/", "/repo/src", {"/repo/src"}),
        ("/", "/a/b/c", {"/a/b/c"}),
    ],
)
async def test_discovery_stops_at_the_mount_boundary(root, start, present):
    with pytest.raises(NotARepositoryError) as excinfo:
        await discover(
            _no_reads(),
            _stat_over(present),
            _root(root),
            typed_spec(start, "/"),
        )
    assert str(excinfo.value) == (
        "not a git repository (or any of the parent directories): .git"
    )


@pytest.mark.asyncio
async def test_a_linked_worktree_follows_its_gitdir_pointer():
    # `git worktree add` leaves a .git *file*, not a directory. Reading
    # it as one is ENOTDIR on the first byte of HEAD.
    stat_path = _stat_over(
        {"/repo/.git/worktrees/wt"}, files={"/repo/wt/.git"}
    )
    dispatch = _reads(
        {
            "/repo/wt/.git": b"gitdir: /repo/.git/worktrees/wt\n",
            "/repo/.git/worktrees/wt/commondir": b"../..\n",
        }
    )
    repo = await discover(
        dispatch, stat_path, _root("/repo/"), typed_spec("/repo/wt", "/")
    )
    assert repo.gitdir.virtual == "/repo/.git/worktrees/wt"
    assert repo.commondir.virtual == "/repo/.git"
    assert repo.worktree.virtual == "/repo/wt"


@pytest.mark.asyncio
async def test_a_relative_pointer_resolves_against_the_file():
    # What a submodule writes, and what `git worktree add
    # --relative-paths` writes, so the pair can be moved together.
    stat_path = _stat_over(
        {"/repo/.git/modules/lib"}, files={"/repo/lib/.git"}
    )
    dispatch = _reads({"/repo/lib/.git": b"gitdir: ../.git/modules/lib\n"})
    repo = await discover(
        dispatch, stat_path, _root("/repo/"), typed_spec("/repo/lib", "/")
    )
    assert repo.gitdir.virtual == "/repo/.git/modules/lib"
    assert repo.commondir.virtual == "/repo/.git/modules/lib"


@pytest.mark.asyncio
async def test_a_pointer_out_of_the_mount_is_gits_unquoted_fatal():
    # A worktree mounted without the repository it was cut from: the
    # absolute path names the backend's own filesystem, which this mount
    # does not span. git words this one without quotes.
    stat_path = _stat_over(set(), files={"/repo/.git"})
    dispatch = _reads(
        {"/repo/.git": b"gitdir: /elsewhere/.git/worktrees/wt\n"}
    )
    with pytest.raises(NotARepositoryError) as excinfo:
        await discover(
            dispatch, stat_path, _root("/repo/"), typed_spec("/repo", "/")
        )
    assert str(excinfo.value) == (
        "not a git repository: /elsewhere/.git/worktrees/wt"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("contents", [b"not a pointer\n", b"gitdir:\n"])
async def test_invalid_gitfile_is_refused(contents):
    with pytest.raises(InvalidGitFileError) as excinfo:
        await discover(
            _reads({"/repo/.git": contents}),
            _stat_over(set(), files={"/repo/.git"}),
            _root("/repo/"),
            typed_spec("/repo", "/"),
        )
    assert str(excinfo.value) == "invalid gitfile format: /repo/.git"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "start, present, files, reason",
    [
        ("/repo/gone", set(), set(), "No such file or directory"),
        (
            "/repo/gone",
            {"/repo", "/repo/.git"},
            set(),
            "No such file or directory",
        ),
        (
            "/repo/a.txt",
            {"/repo", "/repo/.git"},
            {"/repo/a.txt"},
            "Not a directory",
        ),
    ],
)
async def test_bad_start_precedes_discovery(start, present, files, reason):
    with pytest.raises(NoWorkingDirectoryError) as excinfo:
        await discover(
            _no_reads(),
            _stat_over(present, files),
            _root("/repo/"),
            typed_spec(start, "/"),
        )
    assert str(excinfo.value) == f"cannot change to '{start}': {reason}"


@pytest.mark.asyncio
async def test_core_worktree_is_relative_to_the_git_directory():
    stat_path = _stat_over({"/repo/.git", "/repo/src"})
    dispatch = _reads({"/repo/.git/config": b"[core]\n\tworktree = ../src\n"})
    repo = await discover(
        dispatch, stat_path, _root("/repo/"), typed_spec("/repo", "/")
    )
    assert repo.worktree.virtual == "/repo/src"


@pytest.mark.asyncio
async def test_a_linked_worktree_ignores_its_repositorys_core_worktree():
    # git reads core.worktree only from a repository's own config, and a
    # linked worktree's config is the repository's: applying it would
    # put the tree next to the main checkout's metadata.
    stat_path = _stat_over(
        {"/repo/.git/worktrees/wt"}, files={"/repo/wt/.git"}
    )
    dispatch = _reads(
        {
            "/repo/wt/.git": b"gitdir: /repo/.git/worktrees/wt\n",
            "/repo/.git/worktrees/wt/commondir": b"../..\n",
            "/repo/.git/config": b"[core]\n\tworktree = ..\n",
        }
    )
    repo = await discover(
        dispatch, stat_path, _root("/repo/"), typed_spec("/repo/wt", "/")
    )
    assert repo.worktree.virtual == "/repo/wt"


@pytest.mark.asyncio
async def test_a_relative_core_worktree_git_cannot_enter_fails_every_verb():
    dispatch = _reads({"/repo/.git/config": b"[core]\n\tworktree = gone\n"})
    with pytest.raises(WorkTreeChdirError) as excinfo:
        await discover(
            dispatch,
            _stat_over({"/repo/.git"}),
            _root("/repo/"),
            typed_spec("/repo", "/"),
        )
    assert str(excinfo.value) == (
        "cannot chdir to 'gone': No such file or directory"
    )


@pytest.mark.asyncio
async def test_a_named_work_tree_beats_the_config():
    dispatch = _reads(
        {
            "/repo/.git/config": b"[core]\n\tbare = true\n\tworktree = gone\n",
        }
    )
    repo = await discover(
        dispatch,
        _stat_over({"/repo/.git"}),
        _root("/repo/"),
        typed_spec("/repo", "/"),
        None,
        typed_spec("../elsewhere", "/repo"),
    )
    assert repo.worktree.virtual == "/elsewhere"


@pytest.mark.asyncio
async def test_a_named_git_file_leading_nowhere_names_its_target():
    # git's read_gitfile refuses the pointer's target, unquoted, before
    # it quotes the --git-dir it was handed.
    stat_path = _stat_over({"/", "/repo/docs"}, files={"/repo/stray"})
    dispatch = _reads({"/repo/stray": b"gitdir: docs\n"})
    with pytest.raises(NotARepositoryError) as excinfo:
        await discover(
            dispatch,
            stat_path,
            _root("/"),
            typed_spec("/", "/"),
            typed_spec("/repo/stray", "/"),
        )
    assert str(excinfo.value) == "not a git repository: /repo/docs"


@pytest.mark.asyncio
async def test_a_bare_repository_has_no_work_tree_to_enter():
    dispatch = _reads({"/repo/.git/config": b"[core]\n\tbare = true\n"})
    stat_path = _stat_over({"/repo", "/repo/.git"})
    repo = await discover(
        dispatch, stat_path, _root("/repo/"), typed_spec("/repo", "/")
    )
    with pytest.raises(NotAWorkTreeError):
        await require_work_tree(dispatch, stat_path, repo, False)
    await require_work_tree(dispatch, stat_path, repo, True)


@pytest.mark.asyncio
@pytest.mark.parametrize("worktree", ["/repo/missing", "/repo/a.txt"])
async def test_a_named_work_tree_must_be_a_directory(worktree):
    stat_path = _stat_over({"/repo", "/repo/.git"}, files={"/repo/a.txt"})
    repo = await discover(
        _no_reads(),
        stat_path,
        _root("/repo/"),
        typed_spec("/repo", "/"),
        None,
        typed_spec(worktree, "/"),
    )
    with pytest.raises(NotAWorkTreeError):
        await require_work_tree(_no_reads(), stat_path, repo, True)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "config",
    [
        b"[Core]\n\tBare = yes\n",
        b"[core]\n\tbare = 1\n",
        b"[core]\n\tbare\n",
    ],
)
async def test_core_bare_is_read_as_git_reads_a_boolean(config):
    dispatch = _reads({"/repo/.git/config": config})
    stat_path = _stat_over({"/repo", "/repo/.git"})
    repo = await discover(
        dispatch, stat_path, _root("/repo/"), typed_spec("/repo", "/")
    )
    with pytest.raises(NotAWorkTreeError):
        await require_work_tree(dispatch, stat_path, repo, False)


@pytest.mark.asyncio
async def test_an_unreadable_core_bare_fails_even_a_named_work_tree():
    # git parses core.bare at setup, before it asks which tree was named,
    # and dies at the first value it cannot read.
    dispatch = _reads(
        {"/repo/.git/config": b"[core]\n\tbare = maybe\n\tbare = false\n"}
    )
    with pytest.raises(BadConfigValueError) as excinfo:
        await discover(
            dispatch,
            _stat_over({"/repo", "/repo/.git"}),
            _root("/repo/"),
            typed_spec("/repo", "/"),
            None,
            typed_spec(".", "/repo"),
        )
    assert str(excinfo.value) == (
        "bad boolean config value 'maybe' for 'core.bare'"
    )


@pytest.mark.asyncio
async def test_a_linked_worktree_ignores_core_bare_but_still_parses_it():
    stat_path = _stat_over(
        {"/repo/.git/worktrees/wt", "/repo/wt"}, files={"/repo/wt/.git"}
    )
    contents = {
        "/repo/wt/.git": b"gitdir: /repo/.git/worktrees/wt\n",
        "/repo/.git/worktrees/wt/commondir": b"../..\n",
        "/repo/.git/config": b"[core]\n\tbare = true\n",
    }
    repo = await discover(
        _reads(contents),
        stat_path,
        _root("/repo/"),
        typed_spec("/repo/wt", "/"),
    )
    await require_work_tree(_reads(contents), stat_path, repo, False)
    contents["/repo/.git/config"] += b"\tbare = maybe\n"
    with pytest.raises(BadConfigValueError):
        await discover(
            _reads(contents),
            stat_path,
            _root("/repo/"),
            typed_spec("/repo/wt", "/"),
        )
