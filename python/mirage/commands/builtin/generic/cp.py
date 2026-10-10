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

from collections.abc import Awaitable
from dataclasses import dataclass, replace
from functools import partial
from typing import Callable

from mirage.commands.builtin.utils.backup import backup_control, backup_target
from mirage.commands.builtin.utils.constants import DEFAULT_BACKUP_SUFFIX
from mirage.commands.builtin.utils.copy import (
    STAT_REFUSALS,
    backend_key_default,
    copy_targets,
    is_directory,
    path_exists,
)
from mirage.commands.builtin.utils.links import typed_link
from mirage.commands.builtin.utils.paths import (
    absent_dest_error,
    descendant_path,
    nearest_ancestor,
    spelled_from,
)
from mirage.commands.errors import UsageError
from mirage.commands.spec.argmatch import ArgmatchMatch, argmatch
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.usage import argmatch_error, extra_operand_error
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.errors.posix import posix_phrase
from mirage.errors.types import (
    DotWalkLoop,
    DotWalkMissing,
    FsCondition,
    WalkDeclinedError,
)
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.types import DispatchFn
from mirage.types import (
    LINK_TARGET_KEY,
    CopyDeref,
    CopyStrategy,
    FileStat,
    FileType,
    NativeCopy,
    NativeMove,
    PathSpec,
    PrimitiveCopy,
    PrimitiveMove,
    ReaddirFn,
    StatFn,
    Visibility,
)
from mirage.utils.dates import iso_timestamp
from mirage.utils.hidden import path_visible
from mirage.utils.key_prefix import mounted_path
from mirage.utils.path import CycleError, resolve_path
from mirage.utils.quote import shell_quote_always
from mirage.view.types import LinkView

UPDATE_MODES = ("all", "none", "none-fail", "older")


@dataclass(frozen=True, slots=True)
class CpFlags:
    recursive: bool = False
    no_clobber: bool = False
    interactive: bool = False
    verbose: bool = False
    update: str | None = None
    backup: str | None = None
    suffix: str = DEFAULT_BACKUP_SUFFIX
    target_dir: PathSpec | None = None
    no_target_dir: bool = False
    dereference: CopyDeref = CopyDeref.ALWAYS


@dataclass(frozen=True, slots=True)
class TransferLinks:
    """Namespace symlink facts and dispatcher primitives for cp and mv.

    Links live above every backend, so a tree copy recreates each by name.

    Attributes:
        links (LinkView): the namespace's symlink facts.
        dispatch (DispatchFn): the dispatcher, through which a link is made.
        cwd (str): the directory a typed operand resolves against.
        relay (PrimitiveCopy): the dispatcher's own transfer primitives, which
            copy what a followed link leads to on whatever mount it lives.
        relay_stat (StatFn): the dispatcher's stat, for the same walk.
        visibility (Visibility | None): the session's visibility; a link
            it hides is not copied.
    """

    links: LinkView
    dispatch: DispatchFn
    cwd: str
    relay: PrimitiveCopy
    relay_stat: StatFn
    visibility: Visibility | None = None


# Each option of cp's link policy, and what it asks for; the last typed
# wins (coreutils 9.7: `-L -P` copies the link, `-P -L` what it names).
_DEREF_OPTIONS = {
    "dereference": CopyDeref.ALWAYS,
    "no_dereference": CopyDeref.NEVER,
    "H": CopyDeref.COMMAND_LINE,
    "d": CopyDeref.NEVER,
    "archive": CopyDeref.NEVER,
}


@dataclass(frozen=True, slots=True)
class TransferPolicy:
    """Per-entry overwrite policy shared by cp and mv.

    Args:
        cmd_name (str): Command name for error prefixes.
        no_clobber (bool): ``-n``; skip existing targets silently.
        update (str | None): ``--update`` mode (``all``/``none``/
            ``none-fail``/``older``), or None.
        backup (str | None): Canonical backup control, or None.
        suffix (str): Simple-backup suffix.
        ask (Callable | None): ``-i``'s question for one target, None
            when the command does not ask.
    """

    cmd_name: str
    no_clobber: bool = False
    update: str | None = None
    backup: str | None = None
    suffix: str = DEFAULT_BACKUP_SUFFIX
    ask: Callable[[PathSpec], Awaitable[bool]] | None = None


def prompter(
    cmd_name: str,
    stdin: ByteSource | None,
    errors: list[str],
    accepted: list[str],
) -> Callable[[PathSpec], Awaitable[bool]]:
    """GNU's ``-i``: ask on stderr before replacing a target and read one
    line of stdin as the answer. Only a line starting with ``y`` or ``Y``
    is yes (rpmatch in the C locale); the end of input is no.

    Args:
        cmd_name (str): ``cp`` or ``mv``.
        stdin (ByteSource | None): the command's standard input.
        errors (list[str]): the stderr record the question joins.
        accepted (list[str]): the targets answered yes, which are no
            failure.
    """
    replies = AsyncLineIterator(stdin) if stdin is not None else None

    async def ask(target: PathSpec) -> bool:
        errors.append(
            f"{cmd_name}: overwrite {shell_quote_always(target.raw_path)}? "
        )
        reply = await replies.readline() if replies is not None else None
        if reply is None or reply[:1] not in (b"y", b"Y"):
            return False
        accepted.append(target.virtual)
        return True

    return ask


def stderr_of(errors: list[str]) -> bytes | None:
    """The collected messages as stderr: one per line, except that a
    question leaves the cursor after it, as a terminal prompt does.

    Args:
        errors (list[str]): the messages, in order.
    """
    if not errors:
        return None
    return "".join(
        line if line.endswith("? ") else f"{line}\n" for line in errors
    ).encode()


def update_gates(mode: str | None) -> bool:
    """Whether an ``--update`` mode can skip or fail an individual entry.

    ``all`` copies unconditionally, so it needs no per-entry decision and
    must not cost a target probe or forfeit a whole-tree ``dir_copy``.

    Args:
        mode (str | None): Update mode from ``update_mode``.
    """
    return mode is not None and mode != "all"


def backup_displaces(control: str | None) -> bool:
    """Whether a backup control actually moves an existing target aside.

    ``none`` is a no-op control, so it needs no per-entry decision.

    Args:
        control (str | None): Canonical control from ``backup_control``.
    """
    return control is not None and control != "none"


def update_mode(cmd_name: str, fl: FlagView) -> str | None:
    """Resolve ``-u``/``--update[=UPDATE]`` to a GNU update mode.

    Args:
        cmd_name (str): Command name for the invalid-argument error.
        fl (FlagView): Parsed flag view holding ``update``.
    """
    value = fl.raw("update")
    if value in (None, False):
        return None
    if value is True:
        return "older"
    word = str(value)
    match = argmatch(word, UPDATE_MODES)
    if isinstance(match, ArgmatchMatch):
        return match.word
    raise argmatch_error(
        cmd_name, "--update", word, UPDATE_MODES, 1, match.kind
    )


def backup_raw(fl: FlagView) -> str | bool | None:
    """The raw ``-b``/``--backup`` value, absent shapes reading as None.

    The parser lands both spellings on the canonical ``backup`` dest, so
    the key already carries GNU's last-occurrence-wins value.

    Args:
        fl (FlagView): Parsed flag view holding ``backup``.
    """
    value = fl.raw("backup")
    if isinstance(value, (str, bool)):
        return value
    return None


def suffix_flag(fl: FlagView) -> str | None:
    """The ``--suffix`` value, an empty one reading as absent.

    GNU 9.7 ``cp --backup --suffix= f g`` writes the default ``g~``, not
    a backup whose name is the original's.

    Args:
        fl (FlagView): Parsed flag view holding ``suffix``.
    """
    return fl.as_str("suffix") or None


def target_flags(cmd_name: str, fl: FlagView) -> tuple[PathSpec | None, bool]:
    """Resolve ``-t``/``--target-directory`` and ``-T``, rejecting both.

    Args:
        cmd_name (str): Command name for the conflict error.
        fl (FlagView): Parsed flag view.
    """
    raw = fl.raw("target_directory")
    target_dir = raw if isinstance(raw, PathSpec) else None
    no_target = fl.as_bool("no_target_directory")
    if target_dir is not None and no_target:
        raise UsageError(
            f"{cmd_name}: cannot combine --target-directory (-t) and "
            "--no-target-directory (-T)",
            1,
        )
    return target_dir, no_target


def parse_flags(fl: FlagView) -> CpFlags:
    """Parse the cp flag bag once into a frozen struct.

    ``-f`` is an accepted no-op, ``-i`` asks before each overwrite,
    and ``--strip-trailing-slashes`` is a no-op because PathSpec already
    normalizes trailing slashes.

    Args:
        fl (FlagView): Flag view constructed with the cp spec.
    """
    update = update_mode("cp", fl)
    suffix = suffix_flag(fl)
    control = backup_control("cp", backup_raw(fl), suffix)
    # -i and -n set one answer, so the later of the two wins.
    asking = fl.typed_order("interactive", "no_clobber")
    no_clobber = bool(asking) and asking[-1] == "no_clobber"
    if (
        control is not None
        and control != "none"
        and (no_clobber or update == "none-fail")
    ):
        raise UsageError(
            "cp: --backup is mutually exclusive with -n or "
            "--update=none-fail\nTry 'cp --help' for more information.",
            1,
        )
    target_dir, no_target = target_flags("cp", fl)
    recursive = (
        fl.as_bool("r") or fl.as_bool("recursive") or fl.as_bool("archive")
    )
    typed = fl.typed_order(*_DEREF_OPTIONS)
    # With no link option a recursive copy copies links as links and any
    # other copy follows them (cp.c's DEREF_UNDEFINED default).
    dereference = (
        _DEREF_OPTIONS[typed[-1]]
        if typed
        else CopyDeref.NEVER
        if recursive
        else CopyDeref.ALWAYS
    )
    return CpFlags(
        recursive=recursive,
        no_clobber=no_clobber,
        interactive=bool(asking) and asking[-1] == "interactive",
        verbose=fl.as_bool("verbose"),
        update=update,
        backup=control,
        suffix=suffix if suffix is not None else DEFAULT_BACKUP_SUFFIX,
        target_dir=target_dir,
        no_target_dir=no_target,
        dereference=dereference,
    )


async def _entry_at(dispatch: DispatchFn, spec: PathSpec) -> FileStat | None:
    """What stands at a path, asked through the dispatcher; None where nothing
    does, which is where a new link goes.

    Args:
        dispatch (DispatchFn): the dispatcher.
        spec (PathSpec): the path.
    """
    try:
        there, _ = await dispatch("stat", spec)
    except (FileNotFoundError, NotADirectoryError, DotWalkLoop):
        return None
    return there if isinstance(there, FileStat) else None


async def link_stat(copies: TransferLinks, path: PathSpec) -> FileStat:
    """Stat an entry itself for overwrite and backup decisions.

    Args:
        copies (TransferLinks): Namespace facts and transfer calls.
        path (PathSpec): Entry being transferred or replaced.
    """
    return copies.links.stat_at(path.virtual) or await copies.relay_stat(path)


async def rename_link(
    copies: TransferLinks, src: PathSpec, target: PathSpec
) -> None:
    """Rename through the namespace, including its admission checks.

    Args:
        copies (TransferLinks): Namespace facts and transfer calls.
        src (PathSpec): Entry being renamed.
        target (PathSpec): Destination entry.
    """
    await copies.dispatch("rename", src, dst=target)


async def make_link(
    copies: TransferLinks,
    src: PathSpec,
    target: PathSpec,
    text: str,
    policy: TransferPolicy,
    errors: list[str],
    lines: list[str] | None,
) -> bool:
    """Copy a symlink through the shared overwrite and backup policy.

    Args:
        copies (TransferLinks): Namespace facts and transfer calls.
        src (PathSpec): The link being copied.
        target (PathSpec): Its destination entry, without dereferencing.
        text (str): Link target verbatim.
        policy (TransferPolicy): Per-entry overwrite policy.
        errors (list[str]): Per-entry errors.
        lines (list[str] | None): Optional verbose output.

    Returns:
        bool: Whether the link was created; False on a skip or error.
    """
    stat = partial(link_stat, copies)
    target_link = copies.links.stat_at(target.virtual)
    there = target_link or await _entry_at(copies.dispatch, target)
    if there is not None and there.type == FileType.DIRECTORY:
        errors.append(
            f"{policy.cmd_name}: cannot overwrite directory "
            f"'{target.raw_path}' with non-directory"
        )
        return False
    if not await overwrite_gate(policy, stat, src, target, errors):
        return False
    backup_strategy = (
        NativeMove(rename=partial(rename_link, copies))
        if target_link is not None
        else copies.relay
    )
    backup, ok = await make_backup(
        policy,
        backup_strategy,
        stat,
        copies.relay.readdir,
        target,
        errors,
        copies,
    )
    if not ok:
        return False
    try:
        if await path_exists(stat, target):
            await copies.dispatch("unlink", target)
        await copies.dispatch("symlink", target, target=text)
    except FS_ERRORS as exc:
        errors.append(
            f"{policy.cmd_name}: cannot create symbolic link "
            f"'{target.raw_path}': {fs_strerror(exc)}"
        )
        return False
    if lines is not None:
        lines.append(transfer_line(src, target, backup))
    return True


async def copy_tree_links(
    copies: TransferLinks,
    deref: CopyDeref,
    src: PathSpec,
    target: PathSpec,
    errors: list[str],
    lines: list[str] | None,
    policy: TransferPolicy,
    seen: tuple[str, ...] = (),
) -> None:
    """Recreate the links below a copied directory, which its copy could
    not see.

    Without ``-L`` each lands as a link with its target verbatim, dangling
    and looping ones included. Under ``-L`` each is what it leads to: a
    file's bytes, a directory's whole tree (the links below it included),
    and ``cannot stat`` for one that leads nowhere or loops (coreutils
    9.7). A link that leads back into a tree being copied is refused as
    GNU names it, ``cannot copy cyclic symbolic link``, rather than
    copied until the name is too long, which is where GNU stops.

    Args:
        copies (TransferLinks): the namespace's links and the dispatcher.
        deref (CopyDeref): the line's link policy.
        src (PathSpec): the copied directory.
        target (PathSpec): where it was copied to.
        errors (list[str]): per-entry diagnostics.
        lines (list[str] | None): ``-v``'s lines, None without ``-v``.
        policy (TransferPolicy): Per-entry overwrite and backup policy.
        seen (tuple[str, ...]): the directories being copied above this
            one, which a followed link must not lead back into.
    """
    base = src.virtual.rstrip("/") or "/"
    dst_base = target.virtual.rstrip("/")
    shown_src = src.raw_path.rstrip("/") or src.raw_path
    shown_dst = target.raw_path.rstrip("/") or target.raw_path
    below = sorted(copies.links.subtree(base), key=lambda row: row[0])
    for virtual, row in below:
        if not path_visible(copies.visibility, virtual):
            continue
        rel = virtual[len(base.rstrip("/")) + 1 :]
        landing = f"{dst_base}/{rel}"
        shown = f"{shown_src}/{rel}"
        if deref is not CopyDeref.ALWAYS:
            text = str(row.extra.get(LINK_TARGET_KEY) or "")
            await make_link(
                copies,
                replace(PathSpec.from_str_path(virtual), raw_path=shown),
                replace(
                    PathSpec.from_str_path(landing),
                    raw_path=f"{shown_dst}/{rel}",
                ),
                text,
                policy,
                errors,
                lines,
            )
            continue
        try:
            resolved = copies.links.resolve(virtual)
        except CycleError:
            errors.append(
                f"cp: cannot stat '{shown}': {posix_phrase(FsCondition.ELOOP)}"
            )
            continue
        leads = await copies.links.target_stat(virtual)
        if leads is None:
            errors.append(
                f"cp: cannot stat '{shown}': No such file or directory"
            )
            continue
        if leads.type != FileType.DIRECTORY:
            await copy_entries(
                "cp",
                copies.relay,
                copies.relay_stat,
                replace(PathSpec.from_str_path(resolved), raw_path=shown),
                PathSpec.from_str_path(landing),
                [(PathSpec.from_str_path(resolved), False)],
                errors,
                policy=policy,
                lines=lines,
                copies=copies,
            )
            continue
        inside = resolved.rstrip("/") or "/"
        if any(
            inside == d or d.startswith(inside.rstrip("/") + "/")
            for d in (*seen, base)
        ):
            errors.append(f"cp: cannot copy cyclic symbolic link '{shown}'")
            continue
        followed = PathSpec.from_str_path(inside)
        placed = PathSpec.from_str_path(landing)
        entries = await walk(
            copies.relay.readdir,
            copies.relay_stat,
            followed,
            "cp",
            errors,
            copies.links,
        )
        await copy_entries(
            "cp",
            copies.relay,
            copies.relay_stat,
            followed,
            placed,
            entries,
            errors,
            policy=policy,
            lines=lines,
            copies=copies,
        )
        await copy_tree_links(
            copies,
            deref,
            replace(followed, raw_path=shown),
            replace(placed, raw_path=f"{shown_dst}/{rel}"),
            errors,
            lines,
            policy,
            (*seen, base),
        )


def split_operands(
    cmd_name: str,
    paths: list[PathSpec],
    target_dir: PathSpec | None,
    no_target_dir: bool,
) -> tuple[list[PathSpec], PathSpec]:
    """Split operands into sources and destination, GNU arity errors.

    With ``-t`` every operand is a source and the target directory is
    the destination. ``-T`` requires exactly two operands.

    Args:
        cmd_name (str): Command name for the usage errors.
        paths (list[PathSpec]): Positional path operands.
        target_dir (PathSpec | None): ``--target-directory`` value.
        no_target_dir (bool): ``-T``.
    """
    hint = f"Try '{cmd_name} --help' for more information."
    if not paths:
        raise UsageError(f"{cmd_name}: missing file operand\n{hint}", 1)
    if target_dir is not None:
        return list(paths), target_dir
    if len(paths) == 1:
        raise UsageError(
            f"{cmd_name}: missing destination file operand after "
            f"'{paths[0].raw_path}'\n{hint}",
            1,
        )
    if no_target_dir and len(paths) > 2:
        raise extra_operand_error(cmd_name, paths[2].raw_path)
    return list(paths[:-1]), paths[-1]


async def target_dir_error(
    cmd_name: str, stat: StatFn, target: PathSpec
) -> str | None:
    """The error line when a ``-t`` operand is missing or not a directory.

    Args:
        cmd_name (str): Command name for the error prefix.
        stat (StatFn): Stats a path; raises when missing.
        target (PathSpec): The ``--target-directory`` operand.
    """
    try:
        info = await stat(target)
    except NotADirectoryError:
        condition = FsCondition.ENOTDIR
    except DotWalkLoop:
        condition = FsCondition.ELOOP
    except (FileNotFoundError, ValueError):
        condition = FsCondition.ENOENT
    else:
        if info.type == FileType.DIRECTORY:
            return None
        condition = FsCondition.ENOTDIR
    return (
        f"{cmd_name}: target directory '{target.raw_path}': "
        f"{posix_phrase(condition)}"
    )


async def dest_kind(
    stat: StatFn, target: PathSpec
) -> tuple[bool, bool, FsCondition | None]:
    """Probe a destination for ``(exists, is_dir, condition)``.

    ``cp`` and ``mv`` are not ``mkdir -p``: neither creates the
    destination's parent, so a missing or non-directory component is a
    per-operand failure, and GNU surfaces the two at different phases.
    A non-directory fails the destination stat itself: ``reg/x`` at any
    depth, and ``reg/`` typed with a slash over a plain file, are both
    ``cannot stat 'DST': Not a directory``. A merely absent parent fails
    the create or the rename (``cannot create regular file`` for cp,
    ``cannot move`` for mv), so the condition comes back bare and each
    caller words it in its own voice. None means the destination exists
    or its parent is a usable directory.

    The backends answer ENOENT for a path under a plain file just as
    they do for a genuinely absent one (only a slashed operand makes the
    stat itself say ENOTDIR), so the chain is walked upward until
    something exists (:func:`absent_dest_error`); the common case
    (the parent is there) costs a single stat.

    Args:
        stat (StatFn): Stats a path; raises when missing.
        target (PathSpec): The destination operand.

    Returns:
        tuple[bool, bool, FsCondition | None]: Whether it exists, whether
        it is a directory, and the condition when it can be neither found
        nor created there.
    """
    try:
        info = await stat(target)
    except NotADirectoryError:
        return False, False, FsCondition.ENOTDIR
    except DotWalkLoop:
        return False, False, FsCondition.ELOOP
    except DotWalkMissing:
        # Its `..` passes a name that is not there: the chain of the path
        # it simplifies to says nothing about this one.
        return False, False, FsCondition.ENOENT
    except (FileNotFoundError, ValueError):
        pass
    else:
        return True, info.type == FileType.DIRECTORY, None
    return False, False, await absent_dest_error(stat, target)


def slash_refuses_file(
    target: PathSpec, target_exists: bool, src_is_dir: bool
) -> bool:
    """Whether a slash-terminated destination refuses a non-directory.

    POSIX resolves ``missing/`` as ``missing/.``, so the name may only
    ever be a directory: rename(2) and open(2) refuse to put a file
    there with ENOTDIR where a bare ``missing`` would take it. GNU 9.7
    words it at the create (``mv: cannot move 'f' to 'missing/': Not a
    directory``, ``cp: cannot create regular file 'missing/': Not a
    directory``); a directory source passes, since the slash asked for
    exactly what it is. An existing destination never reaches this:
    a directory receives the move inside it, and a non-directory has
    already failed the stat.

    Args:
        target (PathSpec): The destination as typed.
        target_exists (bool): Whether the destination exists.
        src_is_dir (bool): Whether the source is a directory.
    """
    return (
        not target_exists and target.raw_path.endswith("/") and not src_is_dir
    )


async def source_kind(
    stat: StatFn, path: PathSpec
) -> tuple[bool, bool, FsCondition | None]:
    """Probe a source operand for ``(exists, is_dir, condition)``.

    A source keeps the errno the kernel reports: ``cp /plain/child /dst`` is
    ``cannot stat 'X': Not a directory``, not "No such file or directory",
    and so is ``cp reg/ /dst``, where the stat itself says ENOTDIR
    because the operand carries a slash. The backends cannot otherwise
    supply that distinction, because ``stat`` answers ENOENT for a path
    under a plain file just as it does for a genuinely absent one (only
    ``readdir`` splits the two). So the chain is walked the way
    :func:`dest_kind` walks a destination's: the first component that
    does exist decides, and a plain file there means ENOTDIR. Walking
    happens only on the failure path.

    Args:
        stat (StatFn): Stats a path; raises when missing.
        path (PathSpec): The probed source operand.

    Returns:
        tuple[bool, bool, FsCondition | None]: Whether it exists, whether
        it is a directory, and the condition when it does not exist.
    """
    try:
        info = await stat(path)
    except NotADirectoryError:
        return False, False, FsCondition.ENOTDIR
    except DotWalkLoop:
        return False, False, FsCondition.ELOOP
    except (FileNotFoundError, ValueError):
        pass
    else:
        return True, info.type == FileType.DIRECTORY, None
    _, is_dir = await nearest_ancestor(stat, path)
    return (
        False,
        False,
        FsCondition.ENOENT if is_dir else FsCondition.ENOTDIR,
    )


def overwrite_type_error(
    cmd_name: str,
    src: PathSpec,
    src_is_dir: bool,
    target: PathSpec,
    target_exists: bool,
    target_is_dir: bool,
) -> str | None:
    """GNU dir/non-dir overwrite mismatch line, or None when compatible.

    Args:
        cmd_name (str): Command name for the error prefix.
        src (PathSpec): Source operand.
        src_is_dir (bool): Whether the source is a directory.
        target (PathSpec): Destination path.
        target_exists (bool): Whether the destination exists.
        target_is_dir (bool): Whether the destination is a directory.
    """
    if not target_exists:
        return None
    if src_is_dir and not target_is_dir:
        return (
            f"{cmd_name}: cannot overwrite non-directory "
            f"'{target.raw_path}' with directory '{src.raw_path}'"
        )
    if not src_is_dir and target_is_dir:
        return (
            f"{cmd_name}: cannot overwrite directory "
            f"'{target.raw_path}' with non-directory '{src.raw_path}'"
        )
    return None


async def overwrite_gate(
    policy: TransferPolicy,
    stat: StatFn,
    src: PathSpec,
    target: PathSpec,
    errors: list[str],
) -> bool:
    """Decide whether an existing target may be replaced.

    ``-n`` and ``--update=none`` skip silently; ``--update=none-fail``
    records GNU's ``not replacing`` error; ``--update=older`` replaces
    only when the source is strictly newer. A source or target with no
    usable mtime always replaces (freshness cannot be proven). ``-i``
    asks last, once the target survived the update checks.

    Args:
        policy (TransferPolicy): Overwrite policy for this command.
        stat (StatFn): Stats a path; raises when missing.
        src (PathSpec): Source entry.
        target (PathSpec): Destination entry.
        errors (list[str]): Collected stderr lines, appended in place.

    Returns:
        bool: True when the transfer should proceed.
    """
    if (
        not policy.no_clobber
        and not update_gates(policy.update)
        and policy.ask is None
    ):
        # No gating flag: skip the target probe entirely so API-backed
        # mounts pay no extra stat per entry.
        return True
    try:
        target_info = await stat(target)
    except (FileNotFoundError, NotADirectoryError, ValueError):
        return True
    if policy.no_clobber or policy.update == "none":
        return False
    if policy.update == "none-fail":
        errors.append(f"{policy.cmd_name}: not replacing '{target.raw_path}'")
        return False
    if policy.update == "older":
        try:
            src_info = await stat(src)
        except (FileNotFoundError, NotADirectoryError, ValueError):
            return True
        src_ts = iso_timestamp(src_info.modified)
        target_ts = iso_timestamp(target_info.modified)
        if (
            src_ts is not None
            and target_ts is not None
            and src_ts <= target_ts
        ):
            return False
    if policy.ask is not None:
        return await policy.ask(target)
    return True


async def _duplicate_for_backup(
    strategy: CopyStrategy | PrimitiveMove | NativeMove,
    stat: StatFn,
    target: PathSpec,
    backup: PathSpec,
    errors: list[str],
    cmd_name: str,
) -> bool:
    """Materialize the backup: mv renames the target away, cp copies it.

    A directory target needs a tree transfer, not a byte copy: the
    primitive (cross-mount) strategies walk it entry by entry and a native
    copy defers to ``dir_copy``, while a native rename already carries a
    whole subtree.

    Args:
        strategy: Transfer strategy owning the needed primitives.
        stat (StatFn): Stats a path; raises when missing.
        target (PathSpec): The destination being replaced.
        backup (PathSpec): The backup destination.
        errors (list[str]): Collected stderr lines, appended in place.
        cmd_name (str): Command name for error prefixes.

    Returns:
        bool: True when the backup landed in full.
    """
    if isinstance(strategy, NativeMove):
        await strategy.rename(target, backup)
        return True
    target_is_dir = await is_directory(stat, target)
    if isinstance(strategy, (PrimitiveCopy, PrimitiveMove)):
        if not target_is_dir:
            data = await strategy.read_bytes(target)
            await strategy.write(backup, data=data)
            return True
        entries = await walk(strategy.readdir, stat, target)
        copied_all = await copy_entries(
            cmd_name, strategy, stat, target, backup, entries, errors
        )
        return copied_all
    if not target_is_dir:
        await strategy.copy(target, backup)
        return True
    if strategy.dir_copy is None:
        errors.append(
            f"{cmd_name}: cannot backup '{target.raw_path}': "
            "Operation not supported"
        )
        return False
    await strategy.dir_copy(target, backup)
    return True


async def _restore_backup_link(
    copies: TransferLinks,
    backup: PathSpec,
    link: FileStat,
    cmd_name: str,
    errors: list[str],
) -> None:
    """Restore a displaced backup link, removing any partial copy first.

    Args:
        copies (TransferLinks): Namespace facts and transfer calls.
        backup (PathSpec): Backup entry to restore.
        link (FileStat): The original link's row.
        cmd_name (str): Command name for error prefixes.
        errors (list[str]): Collected errors, including restoration failures.
    """
    try:
        if await path_exists(partial(link_stat, copies), backup):
            await copies.dispatch("unlink", backup)
        await copies.dispatch(
            "symlink",
            backup,
            target=str(link.extra.get(LINK_TARGET_KEY) or ""),
        )
    except FS_ERRORS as exc:
        errors.append(
            f"{cmd_name}: cannot restore backup "
            f"'{backup.raw_path}': {fs_strerror(exc)}"
        )


async def make_backup(
    policy: TransferPolicy,
    strategy: CopyStrategy | PrimitiveMove | NativeMove,
    stat: StatFn,
    readdir: ReaddirFn | None,
    target: PathSpec,
    errors: list[str],
    copies: TransferLinks | None = None,
) -> tuple[PathSpec | None, bool]:
    """Back up an existing target before it is overwritten.

    Args:
        policy (TransferPolicy): Overwrite policy carrying the control.
        strategy: Transfer strategy owning the needed primitives.
        stat (StatFn): Stats a path; raises when missing.
        readdir (ReaddirFn | None): Directory lister for the version scan.
        target (PathSpec): The destination being replaced.
        errors (list[str]): Collected stderr lines, appended in place.
        copies (TransferLinks | None): Namespace facts and transfer calls.

    Returns:
        tuple[PathSpec | None, bool]: The backup path (None when no
        backup was needed) and whether the transfer may proceed.
    """
    if policy.backup is None:
        return None, True
    if not await path_exists(stat, target):
        return None, True
    try:
        # A failed version scan must not degrade to ".~1~"/the simple
        # suffix: that would overwrite existing backup history.
        backup = await backup_target(
            copies.relay.readdir if copies is not None else readdir,
            target,
            policy.backup,
            policy.suffix,
        )
    except FS_ERRORS as exc:
        errors.append(
            f"{policy.cmd_name}: cannot backup "
            f"'{target.raw_path}': {fs_strerror(exc)}"
        )
        return None, False
    if backup is None:
        return None, True
    backup_link = (
        copies.links.stat_at(backup.virtual)
        if copies is not None and not isinstance(strategy, NativeMove)
        else None
    )
    removed_link = False
    made = False
    try:
        if copies is not None and backup_link is not None:
            await copies.dispatch("unlink", backup)
            removed_link = True
        made = await _duplicate_for_backup(
            strategy, stat, target, backup, errors, policy.cmd_name
        )
    except FS_ERRORS as exc:
        errors.append(
            f"{policy.cmd_name}: cannot backup "
            f"'{target.raw_path}': {fs_strerror(exc)}"
        )
        return None, False
    finally:
        if (
            removed_link
            and not made
            and copies is not None
            and backup_link is not None
        ):
            await _restore_backup_link(
                copies, backup, backup_link, policy.cmd_name, errors
            )
    if not made:
        return None, False
    return backup, True


def transfer_line(
    src: PathSpec, target: PathSpec, backup: PathSpec | None
) -> str:
    """The cp verbose line, with GNU's backup annotation when one exists.

    Args:
        src (PathSpec): Source entry.
        target (PathSpec): Destination entry.
        backup (PathSpec | None): Backup made for this overwrite.
    """
    line = f"'{src.raw_path}' -> '{target.raw_path}'"
    if backup is not None:
        line += f" (backup: '{backup.raw_path}')"
    return line


async def _tree_lines(
    strategy: NativeCopy,
    stat: StatFn,
    src: PathSpec,
    target: PathSpec,
    src_base: str,
    dst_base: str,
) -> list[str]:
    """GNU ``-v`` lines for a tree about to be copied natively, parents first.

    GNU ``cp -rv`` reports every file and every directory it creates,
    including the source root itself; a directory already at the
    destination is merged into without a line. Read before the copy, so
    the destination still shows which directories exist. Deliberate
    divergence: GNU's sibling order follows readdir, which no backend can
    reproduce, so entries are sorted lexicographically instead. That keeps
    every parent ahead of its children (GNU's only load-bearing ordering
    guarantee) and is stable across backends.

    Args:
        strategy (NativeCopy): Native copy capability.
        stat (StatFn): Stats a destination directory.
        src (PathSpec): Source root.
        target (PathSpec): Destination root.
        src_base (str): Source root's mount path, no trailing slash.
        dst_base (str): Destination root's mount path, no trailing slash.
    """
    dirs = {src_base, *await strategy.find(src, type="d")}
    files = await strategy.find(src, type="f")
    lines: list[str] = []
    for entry_mount in sorted({*dirs, *files}):
        entry = spelled_from(mounted_path(src, entry_mount), src)
        entry_dst = spelled_from(
            mounted_path(target, dst_base + entry_mount[len(src_base) :]),
            target,
        )
        if entry_mount in dirs and await is_directory(stat, entry_dst):
            continue
        lines.append(f"'{entry.raw_path}' -> '{entry_dst.raw_path}'")
    return lines


def within(path: str, root: str) -> bool:
    """Whether ``path`` is ``root`` or below it.

    Args:
        path (str): the path to place.
        root (str): the subtree's root.
    """
    base = root.rstrip("/")
    return path.rstrip("/") == base or path.startswith(f"{base}/")


async def _mirror_dirs(
    strategy: NativeCopy,
    stat: StatFn,
    src: PathSpec,
    target: PathSpec,
    src_base: str,
    dst_base: str,
    errors: list[str],
    into_itself: bool,
    lines: list[str] | None = None,
) -> bool:
    """Recreate a source tree's directories under the destination root.

    Only needed on the per-entry policy path, where a whole-tree
    ``dir_copy`` cannot be used: without this, a directory holding no
    files would never appear at the destination, and an entirely empty
    tree would copy to nothing. A backend exposing no ``mkdir``
    (directories are implied by keys) is a no-op. Parents sort before
    children so a nested tree lands in order.

    A failed ``mkdir`` stops the whole source, mirroring ``copy_entries``
    and GNU: the children of a directory that could not be created cannot
    land, so reporting one line per descendant (and then copying the files
    anyway) would be both noisy and wrong.

    Args:
        strategy (NativeCopy): Native copy capability.
        stat (StatFn): Stats a path; raises when missing.
        src (PathSpec): Source root.
        target (PathSpec): Destination root.
        src_base (str): Source root's mount path, no trailing slash.
        dst_base (str): Destination root's mount path, no trailing slash.
        errors (list[str]): Collected stderr lines, appended in place.
        into_itself (bool): Whether the destination lies inside the
            source; its subtree is then left out, as the file pass does.
        lines (list[str] | None): Verbose sink for the directories this
            creates, which GNU also reports; one already at the
            destination is merged into silently. None keeps them silent.

    Returns:
        bool: False when a directory could not be created, so the caller
        skips this source's file pass.
    """
    if strategy.mkdir is None:
        return True
    mounts = [
        found
        for found in [src_base, *await strategy.find(src, type="d")]
        if not (into_itself and within(found, dst_base))
    ]
    # Shortest first so a parent is created before its children. The name is
    # the tiebreak because `sorted` is stable and set iteration over strings
    # is PYTHONHASHSEED-dependent, so sibling directories of equal length
    # used to come out in a different order run to run -- and in a different
    # order from TypeScript, whose Set keeps insertion order.
    for entry_mount in sorted(set(mounts), key=lambda p: (len(p), p)):
        entry_dst = spelled_from(
            mounted_path(target, dst_base + entry_mount[len(src_base) :]),
            target,
        )
        if await is_directory(stat, entry_dst):
            continue
        try:
            await strategy.mkdir(entry_dst)
        except FS_ERRORS as exc:
            errors.append(
                f"cp: cannot create directory "
                f"'{entry_dst.raw_path}': {fs_strerror(exc)}"
            )
            return False
        if lines is not None:
            entry = spelled_from(mounted_path(src, entry_mount), src)
            lines.append(f"'{entry.raw_path}' -> '{entry_dst.raw_path}'")
    return True


async def walk(
    readdir: ReaddirFn,
    stat: StatFn,
    root: PathSpec,
    cmd_name: str = "cp",
    errors: list[str] | None = None,
    links: LinkView | None = None,
) -> list[tuple[PathSpec, bool]]:
    """List a tree as ``(path, is_dir)`` pairs, parents before children.

    The dir/file type is captured here, while the tree is intact, so a caller
    that deletes as it goes (mv) never re-stats a path whose virtual parent dir
    has since vanished (e.g. on S3). Used only by the primitive (no native
    ``copy``) path; backends that inject ``copy``/``find`` never reach it.

    A folder a backend lists with a trailing slash (box, dropbox,
    gdrive) is walked without it. A directory the session may not open,
    or an entry it may not stat (a rule refused it below the operand), is
    GNU's ``cannot access`` / ``cannot stat`` line when ``errors`` is
    given and the walk goes on without its contents; with no channel the
    refusal propagates rather than leave a silent gap.

    Args:
        readdir (Callable): Lists a directory's full child paths.
        stat (Callable): Stats a path; ``.type`` distinguishes directories.
        root (PathSpec): Root of the tree.
        cmd_name (str): the command the diagnostics name.
        errors (list[str] | None): where a per-entry refusal is reported.
        links (LinkView | None): Namespace links handled separately, which
            this byte traversal skips instead of opening as regular files.
    """
    info = await stat(root)
    if info.type != FileType.DIRECTORY:
        return [(root, False)]
    entries = [(root, True)]
    queue = [root]
    while queue:
        directory = queue.pop(0)
        try:
            children = await readdir(directory)
        except PermissionError as exc:
            if errors is None:
                raise
            errors.append(
                f"{cmd_name}: cannot access '{directory.raw_path}': "
                f"{fs_strerror(exc)}"
            )
            continue
        for child_virtual in children:
            child = descendant_path(root, child_virtual.rstrip("/"))
            if links is not None and links.stat_at(child.virtual) is not None:
                continue
            try:
                child_info = await stat(child)
            except PermissionError as exc:
                if errors is None:
                    raise
                errors.append(
                    f"{cmd_name}: cannot stat '{child.raw_path}': "
                    f"{fs_strerror(exc)}"
                )
                continue
            is_dir = child_info.type == FileType.DIRECTORY
            entries.append((child, is_dir))
            if is_dir:
                queue.append(child)
    return entries


async def copy_entries(
    cmd_name: str,
    strategy: PrimitiveCopy | PrimitiveMove,
    stat: StatFn,
    src: PathSpec,
    target: PathSpec,
    entries: list[tuple[PathSpec, bool]],
    errors: list[str],
    *,
    policy: TransferPolicy | None = None,
    lines: list[str] | None = None,
    copies: TransferLinks | None = None,
) -> bool:
    """Copy a walked source tree entry by entry with GNU per-entry errors.

    The shared primitive-transfer loop of cp and mv. A failed ``mkdir``
    aborts the source (the children of a directory that could not be
    created cannot land); a failed read or write is reported and the
    remaining entries still copy, like GNU cp/mv on a cross-device
    transfer. Every error line carries ``fs_strerror``, so a backend
    missing the needed op (``OperationNotSupportedError``) reports
    ``Operation not supported`` instead of aborting the command.
    ``-n``/``--update``/``--backup`` apply per file entry, like GNU
    during a recursive merge.

    Args:
        cmd_name (str): Command name for the error prefix (``cp``/``mv``).
        strategy (PrimitiveCopy | PrimitiveMove): Transfer primitives for
            both mounts.
        stat (StatFn): Stats a path; raises when missing.
        src (PathSpec): Source operand the entries were walked from.
        target (PathSpec): Destination root for the copied tree.
        entries (list[tuple[PathSpec, bool]]): ``walk`` output, parents
            first.
        errors (list[str]): Collected stderr lines, appended in place.
        policy (TransferPolicy | None): Per-entry overwrite policy; None
            overwrites unconditionally.
        lines (list[str] | None): Verbose ``'src' -> 'dst'`` sink; None
            keeps the copy silent.
        copies (TransferLinks | None): Namespace links to preserve verbatim.

    Returns:
        bool: Whether every entry landed.
    """
    copied_all = True
    for entry, is_dir in entries:
        entry_dst = descendant_path(
            target,
            target.virtual.rstrip("/")
            + entry.virtual[len(src.virtual.rstrip("/")) :],
        )
        if is_dir:
            try:
                if not await is_directory(stat, entry_dst):
                    await strategy.mkdir(entry_dst)
                    if lines is not None:
                        lines.append(
                            f"'{entry.raw_path}' -> '{entry_dst.raw_path}'"
                        )
            except FS_ERRORS as exc:
                # GNU stops this source: the children of a directory it
                # could not create cannot land.
                errors.append(
                    f"{cmd_name}: cannot create directory "
                    f"'{entry_dst.raw_path}': {fs_strerror(exc)}"
                )
                return False
            continue
        link = (
            copies.links.stat_at(entry.virtual) if copies is not None else None
        )
        if copies is not None and link is not None:
            error_count = len(errors)
            await make_link(
                copies,
                entry,
                entry_dst,
                str(link.extra.get(LINK_TARGET_KEY) or ""),
                policy or TransferPolicy(cmd_name=cmd_name),
                errors,
                lines,
            )
            if len(errors) > error_count:
                copied_all = False
            continue
        backup: PathSpec | None = None
        if policy is not None:
            if not await overwrite_gate(
                policy, stat, entry, entry_dst, errors
            ):
                continue
            backup, ok = await make_backup(
                policy,
                strategy,
                stat,
                strategy.readdir,
                entry_dst,
                errors,
                copies,
            )
            if not ok:
                copied_all = False
                continue
        try:
            data = await strategy.read_bytes(entry)
        except FS_ERRORS as exc:
            errors.append(
                f"{cmd_name}: cannot open '{entry.raw_path}' "
                f"for reading: {fs_strerror(exc)}"
            )
            copied_all = False
            continue
        try:
            # write takes bytes, not a stream: file materialized here.
            await strategy.write(entry_dst, data=data)
        except FS_ERRORS as exc:
            errors.append(
                f"{cmd_name}: cannot create regular file "
                f"'{entry_dst.raw_path}': {fs_strerror(exc)}"
            )
            copied_all = False
            continue
        if lines is not None:
            lines.append(transfer_line(entry, entry_dst, backup))
    return copied_all


async def cp_generic(
    paths: list[PathSpec],
    *,
    stat: StatFn,
    strategy: CopyStrategy,
    flags: CpFlags,
    backend_key: Callable[[PathSpec], str] | None = None,
    readdir: ReaddirFn | None = None,
    link_at: Callable[[PathSpec], FileStat | None] | None = None,
    copies: TransferLinks | None = None,
    stdin: ByteSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Copy sources to a destination, fanning out into a directory.

    ``NativeCopy`` uses backend ``copy``/``find`` operations for an efficient
    same-store copy. ``PrimitiveCopy`` handles cross-mount copies by walking
    via ``readdir``/``stat`` and applying ``mkdir`` or
    ``write(read_bytes(...))`` to each entry. ``--update``/``--backup``
    force the per-entry native loop (a whole-tree ``dir_copy`` cannot
    honor per-file decisions).

    Args:
        paths (list[PathSpec]): Source operands, plus the destination
            unless ``flags.target_dir`` carries it.
        stat (Callable): Stats a path; raises when missing.
        strategy (CopyStrategy): Complete native or primitive copy capability.
        flags (CpFlags): Parsed cp flags.
        backend_key (Callable | None): Maps a path to its backend storage key
            for the same-file and into-own-subtree guards; defaults to the
            normalized mount-relative path.
        readdir (ReaddirFn | None): Directory lister for backup version
            scans; the primitive strategy's own lister is used when None.
        link_at (Callable | None): The link standing at the name a
            destination was typed as, its own row, None where none stands
            (the router has followed the operand by the time cp runs);
            None outside a workspace.
        copies (TransferLinks | None): The namespace's links and the dispatcher
            that makes them, so a link is copied as a link where the
            policy says to; None outside a workspace, where no link can
            stand.
        stdin (ByteSource | None): where ``-i`` reads its answers.

    Returns:
        tuple[ByteSource | None, IOResult]: Verbose output, with
        per-source coreutils errors on stderr and exit code 1
        when any source failed.
    """
    key_of = backend_key if backend_key is not None else backend_key_default
    sources, dst = split_operands(
        "cp", paths, flags.target_dir, flags.no_target_dir
    )
    if flags.target_dir is not None:
        err = await target_dir_error("cp", stat, dst)
        if err is not None:
            return None, IOResult(stderr=f"{err}\n".encode(), exit_code=1)
        dst_is_dir = True
        dst_exists = True
        dst_err = None
    elif flags.no_target_dir:
        dst_is_dir = False
        dst_exists = True
        dst_err = None
    else:
        dst_exists, dst_is_dir, dst_err = await dest_kind(stat, dst)
    if readdir is None and isinstance(strategy, PrimitiveCopy):
        readdir = strategy.readdir
    errors: list[str] = []
    accepted: list[str] = []
    policy = TransferPolicy(
        cmd_name="cp",
        no_clobber=flags.no_clobber,
        update=flags.update,
        backup=flags.backup,
        suffix=flags.suffix,
        ask=(
            prompter("cp", stdin, errors, accepted)
            if flags.interactive
            else None
        ),
    )
    per_entry_native = (
        flags.no_clobber
        or flags.interactive
        or update_gates(flags.update)
        or backup_displaces(flags.backup)
    )
    lines: list[str] = []
    warned = 0
    seen: set[str] = set()
    created: set[str] = set()
    guards_created = not (
        flags.no_clobber
        or update_gates(flags.update)
        or flags.backup == "numbered"
    )
    for src, target in copy_targets(
        sources, dst, dst_is_dir, dst_exists, dst_err
    ):
        if (
            dst_is_dir
            and key_of(src) in seen
            and not backup_displaces(flags.backup)
        ):
            errors.append(
                f"cp: warning: source file '{src.raw_path}' "
                "specified more than once"
            )
            warned += 1
            continue
        seen.add(key_of(src))
        link = (
            typed_link(copies.links, src, copies.cwd)
            if copies is not None and flags.dereference is CopyDeref.NEVER
            else None
        )
        if copies is not None and link is not None:
            # The router followed the operand, but the policy copies the
            # link itself, whatever it leads to (coreutils 9.7). Onto a
            # destination that is no directory the link replaces the name
            # as typed, never what a link standing there leads to.
            named = resolve_path(src.raw_path or src.virtual, copies.cwd)
            landing = (
                target.virtual
                if target is not dst
                else resolve_path(dst.raw_path or dst.virtual, copies.cwd)
            )
            if named == landing:
                errors.append(
                    f"cp: '{src.raw_path}' and '{target.raw_path}' "
                    "are the same file"
                )
                continue
            if guards_created and key_of(target) in created:
                if policy.ask is not None and not await policy.ask(target):
                    continue
                errors.append(
                    f"cp: will not overwrite just-created '{target.raw_path}' "
                    f"with '{src.raw_path}'"
                )
                continue
            if await make_link(
                copies,
                replace(PathSpec.from_str_path(named), raw_path=src.raw_path),
                replace(
                    PathSpec.from_str_path(landing), raw_path=target.raw_path
                ),
                str(link.extra.get(LINK_TARGET_KEY) or ""),
                policy,
                errors,
                lines if flags.verbose else None,
            ):
                created.add(key_of(target))
            continue
        src_exists, src_is_dir, src_err = await source_kind(stat, src)
        if src_err is not None:
            errors.append(
                f"cp: cannot stat '{src.raw_path}': {posix_phrase(src_err)}"
            )
            continue
        if (
            flags.no_target_dir
            and not src_is_dir
            and target.walk_error is not None
            and target.raw_path == ""
        ):
            # Under -T, GNU stats an empty destination as the directory it
            # is typed in, which a file cannot overwrite (coreutils 9.7).
            # A directory source it merges into the working directory;
            # mirage refuses that at the create, since reading the empty
            # name as the working directory is what `walk_error` is for.
            errors.append(
                "cp: cannot overwrite directory '' with "
                f"non-directory '{src.raw_path}'"
            )
            continue
        if key_of(src) == key_of(target):
            errors.append(
                f"cp: '{src.raw_path}' and '{target.raw_path}' are the same file"
            )
            continue
        # GNU copies a directory into its own subtree too: everything but
        # the new copy itself, before it says it could not (cp -r d d).
        into_itself = flags.recursive and key_of(target).startswith(
            key_of(src) + "/"
        )
        if not flags.recursive and src_is_dir:
            errors.append(
                f"cp: -r not specified; omitting directory '{src.raw_path}'"
            )
            continue
        if not flags.no_target_dir and target.virtual == dst.virtual:
            target_exists, target_is_dir, target_err = (
                dst_exists,
                dst_is_dir,
                dst_err,
            )
        else:
            target_exists, target_is_dir, target_err = await dest_kind(
                stat, target
            )
        if target_err is not None and target_err in STAT_REFUSALS:
            errors.append(
                f"cp: cannot stat '{target.raw_path}': "
                f"{posix_phrase(target_err)}"
            )
            continue
        # The create fails on the absent parent before the slash matters,
        # so a chain verdict keeps its ENOENT (`cp f deep/missing/`).
        if slash_refuses_file(target, target_exists, src_is_dir):
            target_err = target_err or FsCondition.ENOTDIR
        if target_err is not None:
            noun = "directory" if src_is_dir else "regular file"
            errors.append(
                f"cp: cannot create {noun} '{target.raw_path}': "
                f"{posix_phrase(target_err)}"
            )
            continue
        mismatch = overwrite_type_error(
            "cp", src, src_is_dir, target, target_exists, target_is_dir
        )
        if mismatch is not None:
            errors.append(mismatch)
            continue
        if (
            not target_exists
            and link_at is not None
            and link_at(target) is not None
        ):
            # A dangling link: the stat followed it to nothing, but the
            # name is taken. GNU will not create the file it points at
            # (POSIX would), and the link is a non-directory to a tree.
            if src_is_dir:
                errors.append(
                    f"cp: cannot overwrite non-directory "
                    f"'{target.raw_path}' with directory "
                    f"'{src.raw_path}'"
                )
                continue
            if flags.verbose:
                lines.append(transfer_line(src, target, None))
            errors.append(
                f"cp: not writing through dangling symlink '{target.raw_path}'"
            )
            continue
        if into_itself:
            errors.append(
                f"cp: cannot copy a directory, '{src.raw_path}', "
                f"into itself, '{target.raw_path}'"
            )
        if flags.recursive and src_is_dir:
            src_base = src.mount_path.rstrip("/")
            dst_base = target.mount_path.rstrip("/")
            if isinstance(strategy, PrimitiveCopy):
                entries = await walk(
                    strategy.readdir,
                    stat,
                    src,
                    "cp",
                    errors,
                    copies.links if copies is not None else None,
                )
                if into_itself:
                    entries = [
                        (path, is_dir)
                        for path, is_dir in entries
                        if not within(path.virtual, target.virtual)
                    ]
                await copy_entries(
                    "cp",
                    strategy,
                    stat,
                    src,
                    target,
                    entries,
                    errors,
                    policy=policy,
                    lines=lines if flags.verbose else None,
                    copies=copies,
                )
                if copies is not None:
                    await copy_tree_links(
                        copies,
                        flags.dereference,
                        src,
                        target,
                        errors,
                        lines if flags.verbose else None,
                        policy,
                    )
                continue
            if (
                strategy.dir_copy is not None
                and not per_entry_native
                and not into_itself
            ):
                tree = (
                    await _tree_lines(
                        strategy, stat, src, target, src_base, dst_base
                    )
                    if flags.verbose
                    else []
                )
                copied = True
                try:
                    await strategy.dir_copy(src, target)
                except WalkDeclinedError:
                    copied = False
                if copied:
                    lines.extend(tree)
                    if copies is not None:
                        await copy_tree_links(
                            copies,
                            flags.dereference,
                            src,
                            target,
                            errors,
                            lines if flags.verbose else None,
                            policy,
                        )
                    continue
            # Per-entry policy forfeits dir_copy, as does a tree copy the
            # dispatcher declines, so the tree's directories are recreated
            # here: a files-only pass would drop every directory that
            # holds no files (GNU keeps them).
            if not await _mirror_dirs(
                strategy,
                stat,
                src,
                target,
                src_base,
                dst_base,
                errors,
                into_itself,
                lines if flags.verbose else None,
            ):
                continue
            for entry_mount in await strategy.find(src, type="f"):
                if into_itself and within(entry_mount, dst_base):
                    continue
                entry = spelled_from(mounted_path(src, entry_mount), src)
                entry_dst = spelled_from(
                    mounted_path(
                        target, dst_base + entry_mount[len(src_base) :]
                    ),
                    target,
                )
                if not await overwrite_gate(
                    policy, stat, entry, entry_dst, errors
                ):
                    continue
                backup, ok = await make_backup(
                    policy,
                    strategy,
                    stat,
                    readdir,
                    entry_dst,
                    errors,
                    copies,
                )
                if not ok:
                    continue
                try:
                    await strategy.copy(entry, entry_dst)
                except FS_ERRORS as exc:
                    errors.append(
                        f"cp: cannot create regular file "
                        f"'{entry_dst.raw_path}': {fs_strerror(exc)}"
                    )
                    continue
                if flags.verbose:
                    lines.append(transfer_line(entry, entry_dst, backup))
            if copies is not None:
                await copy_tree_links(
                    copies,
                    flags.dereference,
                    src,
                    target,
                    errors,
                    lines if flags.verbose else None,
                    policy,
                )
            continue
        if guards_created and key_of(target) in created:
            # -i asks first: GNU only meets the just-created rule once
            # the answer says to replace.
            if policy.ask is not None and not await policy.ask(target):
                continue
            errors.append(
                f"cp: will not overwrite just-created '{target.raw_path}' "
                f"with '{src.raw_path}'"
            )
            continue
        if not await overwrite_gate(policy, stat, src, target, errors):
            continue
        backup, ok = await make_backup(
            policy, strategy, stat, readdir, target, errors, copies
        )
        if not ok:
            continue
        if isinstance(strategy, PrimitiveCopy):
            try:
                # write takes bytes, not a stream: the file is
                # materialized here.
                data = await strategy.read_bytes(src)
            except FS_ERRORS as exc:
                errors.append(
                    f"cp: cannot open '{src.raw_path}' "
                    f"for reading: {fs_strerror(exc)}"
                )
                continue
            try:
                await strategy.write(target, data=data)
            except FS_ERRORS as exc:
                errors.append(
                    f"cp: cannot create regular file "
                    f"'{target.raw_path}': {fs_strerror(exc)}"
                )
                continue
        else:
            try:
                await strategy.copy(src, target)
            except FS_ERRORS as exc:
                errors.append(
                    f"cp: cannot create regular file "
                    f"'{target.raw_path}': {fs_strerror(exc)}"
                )
                continue
        created.add(key_of(target))
        if flags.verbose:
            lines.append(transfer_line(src, target, backup))
    output = "\n".join(lines) + "\n" if lines else None
    return output.encode() if output else None, IOResult(
        stderr=stderr_of(errors),
        exit_code=1 if len(errors) > warned + len(accepted) else 0,
    )
