import errno
import posixpath

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
    take_lock,
    write_once,
)
from mirage.commands.cli.builtin.git.refs import valid_ref_name
from mirage.commands.cli.builtin.git.util import fatal, start_point
from mirage.commands.cli.types import CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.types import FsCondition
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.types import DispatchFn
from mirage.types import FileType


async def lay_out(
    dispatch: DispatchFn, gitdir: str, branch: str, config: str
) -> None:
    """Write a new git directory's skeleton, keeping what is there.

    Args:
        dispatch (DispatchFn): workspace op dispatcher.
        gitdir (str): absolute virtual path of the git directory.
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
        await ensure_dir(dispatch, f"{gitdir}/{directory}")
    await write_once(
        dispatch, f"{gitdir}/HEAD", f"ref: refs/heads/{branch}\n".encode()
    )
    await write_once(dispatch, f"{gitdir}/config", config.encode())
    await write_once(
        dispatch,
        f"{gitdir}/description",
        b"Unnamed repository; edit this file 'description' "
        b"to name the repository.\n",
    )


def named_gitdir(fl: FlagView, texts: tuple[str, ...]) -> str:
    """The git directory an ``init`` line names: ``--git-dir``, the
    directory itself under ``--bare``, and its ``.git`` otherwise.

    Args:
        fl (FlagView): the line's flags.
        texts (tuple[str, ...]): the line's operands.
    """
    start = start_point(fl)
    explicit = fl.as_str("git_dir")
    if explicit:
        return posixpath.normpath(posixpath.join(start, explicit))
    target = posixpath.normpath(
        posixpath.join(start, texts[0] if texts else ".")
    )
    return target if fl.as_bool("bare") else posixpath.join(target, ".git")


async def init(inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    """Initialize through the dispatcher, preserving an existing repository.

    No host templates, hooks or default-branch advisory are installed.
    Reinitializing takes the config's lock as git does, so a read-only
    mount refuses a re-init too, in git's words for where it stopped: the
    directory an operand names, the config's lock, or the first other
    directory it had to make (pinned against git 2.47.3). With no
    templates, a bare repository in an existing directory stops at
    ``objects`` where git stops at its first template directory.

    Args:
        inv (CLIInvocation[None]): location and initialization flags.
    """
    fl = FlagView(inv.flags)
    doors = inv.doors
    try:
        if (
            doors is None
            or doors.dispatch is None
            or doors.stat_path is None
            or doors.ns is None
            or doors.ns.mounts is None
        ):
            raise NoWorkspaceError()
        dispatch = doors.dispatch
        start = start_point(fl)
        here = await doors.stat_path(start)
        if here is None or here.type is not FileType.DIRECTORY:
            raise NoWorkingDirectoryError(
                start,
                FsCondition.ENOENT if here is None else FsCondition.ENOTDIR,
            )
        target = posixpath.normpath(
            posixpath.join(start, inv.texts[0] if inv.texts else ".")
        )
        bare = fl.as_bool("bare")
        gitdir = named_gitdir(fl, inv.texts)
        branch = fl.as_str("initial_branch") or "master"
        if not valid_ref_name(f"refs/heads/{branch}") or branch.startswith(
            "-"
        ):
            raise GitError(f"invalid branch name: '{branch}'")
        info = await doors.stat_path(gitdir)
        if info is not None and (
            info.type is not FileType.DIRECTORY
            or await read_optional(dispatch, f"{gitdir}/HEAD") is not None
        ):
            location = await discover(
                dispatch,
                doors.stat_path,
                doors.ns.mounts.root_of,
                target,
                gitdir,
                fl.as_str("work_tree"),
            )
            gitdir = location.commondir
        existing = await read_optional(dispatch, f"{gitdir}/HEAD") is not None
        made = bool(inv.texts) and await doors.stat_path(target) is None
        config = (
            "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n"
            f"\tbare = {'true' if bare else 'false'}\n"
        )
        settings = f"{gitdir}/config"
        try:
            await lay_out(dispatch, gitdir, branch, config)
            if existing:
                await take_lock(dispatch, settings)
        except OSError as exc:
            locked = exc.filename == f"{settings}.lock"
            if locked and exc.errno == errno.EEXIST:
                raise ConfigLockError(settings, FsCondition.EEXIST) from exc
            if exc.errno != errno.EROFS:
                raise
            if made:
                raise CannotMkdirError(inv.texts[0]) from exc
            if locked:
                raise ConfigLockError(settings, FsCondition.EROFS) from exc
            raise InitReadOnlyError(exc.filename or gitdir) from exc
        action = "Reinitialized existing" if existing else "Initialized empty"
        text = f"{action} Git repository in {gitdir}/\n"
        warning = ""
        if existing and fl.as_str("initial_branch"):
            warning = f"warning: re-init: ignored --initial-branch={branch}\n"
        return b"" if fl.as_bool("quiet") else text.encode(), IOResult(
            stderr=warning.encode()
        )
    except GitError as exc:
        return fatal(exc)
