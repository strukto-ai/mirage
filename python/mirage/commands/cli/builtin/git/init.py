import errno
from collections.abc import Sequence

from mirage.accessor.base import Accessor
from mirage.commands.cli.builtin.git.constants import DEFAULT_BRANCH
from mirage.commands.cli.builtin.git.discover import discover
from mirage.commands.cli.builtin.git.errors import (
    CannotMkdirError,
    ConfigLockError,
    GitError,
    InitReadOnlyError,
    NoWorkingDirectoryError,
    NoWorkspaceError,
)
from mirage.commands.cli.builtin.git.io import (
    ensure_dir,
    read_optional,
    stat_of,
    take_lock,
    write_once,
)
from mirage.commands.cli.builtin.git.refs import valid_ref_name
from mirage.commands.cli.builtin.git.util import fatal, start_point
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.types import FsCondition
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec
from mirage.workspace.files import Files


async def lay_out(
    vfs: Files, gitdir: PathSpec, branch: str, config: str
) -> None:
    """Write a new git directory's skeleton, keeping what is there.

    Args:
        vfs (Files): the session's files.
        gitdir (PathSpec): absolute virtual path of the git directory.
        branch (str): the branch HEAD starts on.
        config (str): the config file's contents.
    """
    for directory in (
        "objects/info",
        "objects/pack",
        "refs/heads",
        "refs/tags",
        "info",
    ):
        await ensure_dir(vfs, gitdir.join(directory))
    await write_once(
        vfs, gitdir.join("HEAD"), f"ref: refs/heads/{branch}\n".encode()
    )
    await write_once(vfs, gitdir.join("config"), config.encode())
    await write_once(
        vfs,
        gitdir.join("description"),
        b"Unnamed repository; edit this file 'description' "
        b"to name the repository.\n",
    )


def named_gitdir(fl: FlagView, texts: Sequence[str]) -> PathSpec:
    """The git directory an ``init`` line names: ``--git-dir``, the
    directory itself under ``--bare``, and its ``.git`` otherwise.

    Args:
        fl (FlagView): the line's flags.
        texts (Sequence[str]): the line's operands.
    """
    start = start_point(fl)
    explicit = fl.as_path("git_dir")
    if explicit:
        return explicit
    target = PathSpec.from_str_path(texts[0] if texts else ".", cwd=start)
    return target if fl.as_bool("bare") else target.join(".git")


async def init(
    accessor: Accessor, paths: list[PathSpec], texts: list[str], ctx: Context
) -> tuple[ByteSource | None, IOResult]:
    """Initialize through the dispatcher, preserving an existing repository.

    No host templates, hooks or default-branch advisory are installed.
    Reinitializing takes the config's lock as git does, so a read-only
    mount refuses a re-init too, in git's words for where it stopped: the
    directory an operand names, the config's lock, or the first other
    directory it had to make (pinned against git 2.47.3). With no
    templates, a bare repository in an existing directory stops at
    ``objects`` where git stops at its first template directory.

    Args:
        accessor (Accessor): git reaches no service.
        paths (list[PathSpec]): the path operands; git declares none.
        texts (list[str]): the optional directory.
        ctx (Context): the line's context, with the initialization flags.
    """
    fl = FlagView(ctx.flags)
    try:
        if ctx.vfs is None:
            raise NoWorkspaceError()
        vfs = ctx.vfs
        start = start_point(fl)
        here = await stat_of(vfs, start)
        if here is None or here.type is not FileType.DIRECTORY:
            raise NoWorkingDirectoryError(
                start.raw_path,
                FsCondition.ENOENT if here is None else FsCondition.ENOTDIR,
            )
        target = PathSpec.from_str_path(texts[0] if texts else ".", cwd=start)
        if target.walk_error == "ENOENT":
            raise CannotMkdirError(
                target.raw_path, "No such file or directory"
            )
        bare = fl.as_bool("bare")
        gitdir = named_gitdir(fl, texts)
        branch = fl.as_str("initial_branch", DEFAULT_BRANCH)
        # The ref rules alone: unlike a branch made later, the first one
        # may be named HEAD or start with a dash (pinned against git
        # 2.47.3 and 2.50.1).
        if not valid_ref_name(f"refs/heads/{branch}"):
            raise GitError(f"invalid initial branch name: '{branch}'")
        info = await stat_of(vfs, gitdir)
        if info is not None and (
            info.type is not FileType.DIRECTORY
            or await read_optional(vfs, gitdir.join("HEAD")) is not None
        ):
            location = await discover(
                vfs,
                target,
                gitdir,
                worktree if (worktree := fl.as_path("work_tree")) else None,
            )
            gitdir = location.commondir
        existing = await read_optional(vfs, gitdir.join("HEAD")) is not None
        made = bool(texts) and await stat_of(vfs, target) is None
        contents = (
            "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n"
            f"\tbare = {'true' if bare else 'false'}\n"
        )
        settings = gitdir.join("config")
        try:
            await lay_out(vfs, gitdir, branch, contents)
            if existing:
                await take_lock(vfs, settings)
        except OSError as exc:
            locked = exc.filename == f"{settings.virtual}.lock"
            if locked and exc.errno == errno.EEXIST:
                raise ConfigLockError(
                    settings.virtual, FsCondition.EEXIST
                ) from exc
            if exc.errno != errno.EROFS:
                raise
            if made:
                raise CannotMkdirError(texts[0]) from exc
            if locked:
                raise ConfigLockError(
                    settings.virtual, FsCondition.EROFS
                ) from exc
            raise InitReadOnlyError(exc.filename or gitdir.virtual) from exc
        action = "Reinitialized existing" if existing else "Initialized empty"
        text = f"{action} Git repository in {gitdir.virtual}/\n"
        warning = ""
        if existing and fl.as_str("initial_branch"):
            warning = f"warning: re-init: ignored --initial-branch={branch}\n"
        return b"" if fl.as_bool("quiet") else text.encode(), IOResult(
            stderr=warning.encode()
        )
    except GitError as exc:
        return fatal(exc)
