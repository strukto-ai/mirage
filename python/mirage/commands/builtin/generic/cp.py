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

import errno
import logging
from collections.abc import Awaitable, Sequence
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
    typed_name,
)
from mirage.commands.builtin.utils.links import name_location, typed_link
from mirage.commands.builtin.utils.paths import (
    absent_dest_error,
    descendant_path,
    entry_kind,
    nearest_ancestor,
    spelled_from,
)
from mirage.commands.builtin.utils.tree import before_full_walk
from mirage.commands.errors import UsageError
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.usage import (
    extra_operand_error,
    usage_hint,
    word_refusal_error,
)
from mirage.commands.spec.word_choice import WordMatch, match_word
from mirage.errors.classify import classify
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import enoent, fs_strerror
from mirage.errors.posix import posix_phrase
from mirage.errors.types import (
    DotWalkLoop,
    DotWalkMissing,
    FsCondition,
    OperationNotSupportedError,
    WalkDeclinedError,
)
from mirage.io.async_line_iterator import AsyncLineIterator
from mirage.io.stream import close_quietly, prime_stream
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
)
from mirage.utils.dates import iso_timestamp
from mirage.utils.path import CycleError, parent, resolve_path
from mirage.utils.quote import shell_quote_always
from mirage.view.namespace_view import followed_stat
from mirage.view.types import LinkView

_logger = logging.getLogger(__name__)

UPDATE_MODES = ("all", "none", "none-fail", "older")
SPECIAL_FILE_NOUNS = {
    FileType.FIFO: "fifo",
    FileType.CHAR_DEVICE: "special file",
    FileType.BLOCK_DEVICE: "special file",
    FileType.SOCKET: "special file",
}


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
        owns (Callable[[str], bool] | None): whether the mount the copy
            runs on serves a path; None where every path is its own.
    """

    links: LinkView
    dispatch: DispatchFn
    cwd: str
    relay: PrimitiveCopy
    relay_stat: StatFn
    owns: Callable[[str], bool] | None = None


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
    match = match_word(word, UPDATE_MODES)
    if isinstance(match, WordMatch):
        return match.word
    raise word_refusal_error(
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
            f"--update=none-fail\n{usage_hint('cp')}",
            1,
        )
    target_dir, no_target = target_flags("cp", fl)
    recursive = (
        fl.as_bool("r") or fl.as_bool("recursive") or fl.as_bool("archive")
    )
    typed = fl.typed_order(*_DEREF_OPTIONS)
    # With no link option a recursive copy copies links as links and any
    # other copy follows them (GNU cp 9.7 with none of -H, -L, -P, -d).
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


async def dest_stat(
    stat: StatFn, copies: TransferLinks | None, path: PathSpec
) -> FileStat:
    """stat(2) of a destination, over a table whose stat is lstat(2).

    cp opens its destination the way open(2) does, through a link at the
    name: a link to a directory is that directory, one to a file is the
    file it writes through, and one that leads nowhere is no destination
    at all (cp then refuses to write through it).

    Args:
        stat (StatFn): the table's stat, a link's own row for a link.
        copies (TransferLinks | None): Namespace facts, None outside a
            workspace, where no link stands anywhere.
        path (PathSpec): the destination.
    """
    links = copies.links if copies is not None else None
    row = await followed_stat(stat, links, path)
    if row.type == FileType.SYMLINK:
        raise enoent(path)
    return row


def link_name(copies: TransferLinks, target: PathSpec) -> PathSpec | None:
    """The destination as the link standing at its name, None where none
    does.

    The router follows a destination to what its link leads to, which is
    what a plain copy writes, through the link. GNU's backup renames the
    destination itself, a link included, and the copy then lands at the
    name, so a backup is made of this and the copy goes here: through
    the mount's own copy, which keeps the source's mode, or through the
    dispatcher where the name sits on another mount (``owns``).

    Args:
        copies (TransferLinks): Namespace facts and transfer calls.
        target (PathSpec): the destination, as the router left it.
    """
    where = name_location(copies.links, target, copies.cwd)
    if where is None or copies.links.stat_at(where) is None:
        return None
    if where == target.virtual:
        return target
    return PathSpec(
        virtual=where,
        directory=where[: where.rfind("/") + 1] or "/",
        vfs_path=where.strip("/"),
        raw_path=target.raw_path,
    )


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
    if lines is not None:
        lines.append(transfer_line(src, target, backup, policy.cmd_name))
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
    blocked: Sequence[str] = (),
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
        blocked (Sequence[str]): source directories whose trees the copy
            left out, so their links are left out too.
    """
    base = src.virtual.rstrip("/") or "/"
    dst_base = target.virtual.rstrip("/")
    shown_src = src.raw_path.rstrip("/") or src.raw_path
    shown_dst = target.raw_path.rstrip("/") or target.raw_path
    below = sorted(copies.links.subtree(base), key=lambda row: row[0])
    for virtual, row in below:
        if any(within(virtual, root) for root in blocked):
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
                f"cp: cannot stat '{shown}': "
                f"{posix_phrase(FsCondition.ENOENT)}"
            )
            continue
        placed = replace(
            PathSpec.from_str_path(landing), raw_path=f"{shown_dst}/{rel}"
        )
        if leads.type != FileType.DIRECTORY:
            entry = replace(PathSpec.from_str_path(resolved), raw_path=shown)
            await copy_entries(
                "cp",
                copies.relay,
                copies.relay_stat,
                entry,
                placed,
                [(entry, leads.type)],
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
        followed = replace(PathSpec.from_str_path(inside), raw_path=shown)
        entries = await walk(
            copies.relay.readdir,
            copies.relay_stat,
            followed,
            "cp",
            errors,
            copies.links,
        )
        roots: list[str] = []
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
            blocked=roots,
        )
        await copy_tree_links(
            copies,
            deref,
            followed,
            placed,
            errors,
            lines,
            policy,
            (*seen, base),
            roots,
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
    hint = usage_hint(cmd_name)
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
    except (FileNotFoundError, ValueError) as exc:
        _logger.debug("no destination at %s: %s", target.virtual, exc)
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
) -> tuple[FileType | None, FsCondition | None]:
    """Probe a source operand for ``(kind, condition)``.

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
        tuple[FileType | None, FsCondition | None]: Its kind, or None and
        the condition when it does not exist.
    """
    try:
        info = await stat(path)
    except NotADirectoryError:
        return None, FsCondition.ENOTDIR
    except DotWalkLoop:
        return None, FsCondition.ELOOP
    except (FileNotFoundError, ValueError) as exc:
        _logger.debug("no source at %s: %s", path.virtual, exc)
    else:
        return info.type, None
    _, is_dir = await nearest_ancestor(stat, path)
    return None, FsCondition.ENOENT if is_dir else FsCondition.ENOTDIR


def _special_file_error(
    cmd_name: str, kind: FileType | None, dst: PathSpec
) -> str | None:
    """GNU's line for a special file that a recursive copy cannot make.

    Under ``-R`` GNU recreates a FIFO or a device instead of reading it.
    No mount can store one, so the create fails as ``mknod`` would, with
    ENOTSUP, and the source is never read: a live pipe keeps its bytes.

    Args:
        cmd_name (str): the command the line names.
        kind (FileType | None): the source entry's kind.
        dst (PathSpec): where the copy was to land.

    Returns:
        str | None: the stderr line, None for a kind copied as bytes.
    """
    noun = SPECIAL_FILE_NOUNS.get(kind) if kind is not None else None
    if noun is None:
        return None
    return (
        f"{cmd_name}: cannot create {noun} '{dst.raw_path}': "
        f"{posix_phrase(FsCondition.ENOTSUP)}"
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
    if not target_exists or src_is_dir == target_is_dir:
        return None
    return type_mismatch_error(cmd_name, src, target, src_is_dir)


def type_mismatch_error(
    cmd_name: str, src: PathSpec, target: PathSpec, src_is_dir: bool
) -> str:
    """GNU's line for a directory and a non-directory meeting at one name.

    Args:
        cmd_name (str): Command name for the error prefix.
        src (PathSpec): Source operand.
        target (PathSpec): Destination path, of the other kind.
        src_is_dir (bool): Whether the source is the directory.
    """
    if src_is_dir:
        return (
            f"{cmd_name}: cannot overwrite non-directory "
            f"'{target.raw_path}' with directory '{src.raw_path}'"
        )
    return (
        f"{cmd_name}: cannot overwrite directory "
        f"'{target.raw_path}' with non-directory '{src.raw_path}'"
    )


def same_file_error(cmd_name: str, src: PathSpec, target: PathSpec) -> str:
    """GNU's line for a source that is its own destination.

    Args:
        cmd_name (str): Command name for the error prefix.
        src (PathSpec): Source operand.
        target (PathSpec): Destination path naming the same file.
    """
    return (
        f"{cmd_name}: '{src.raw_path}' and '{target.raw_path}' "
        "are the same file"
    )


def just_created_error(cmd_name: str, src: PathSpec, target: PathSpec) -> str:
    """GNU's line for a destination this line already wrote.

    Args:
        cmd_name (str): Command name for the error prefix.
        src (PathSpec): The later source landing on it.
        target (PathSpec): Destination path an earlier source created.
    """
    return (
        f"{cmd_name}: will not overwrite just-created "
        f"'{target.raw_path}' with '{src.raw_path}'"
    )


async def _holds_directory(stat: StatFn, path: PathSpec) -> bool:
    """Whether a directory stands where a file is about to be copied.

    A probe the backend refuses answers False, so the create that follows
    reports the refusal in its own words, as it did before the probe.

    Args:
        stat (StatFn): Stats a path; raises when missing.
        path (PathSpec): The file's destination.
    """
    try:
        return await is_directory(stat, path)
    except FS_ERRORS as exc:
        _logger.debug(
            "cp: destination probe of %s failed: %s", path.virtual, exc
        )
        return False


def _onto_directory(
    cmd_name: str, src: PathSpec, target: PathSpec, backup: str | None
) -> str:
    """GNU's line for a file a directory stands in the way of.

    It is met once the overwrite gates let the file through (``-n`` and
    ``-u`` skip it, ``-i`` asks first). Under a backup cp tries the
    create, which the directory refuses; otherwise it refuses the
    overwrite itself (coreutils 9.7).

    Args:
        cmd_name (str): the command the line names.
        src (PathSpec): the file being copied.
        target (PathSpec): the directory standing there.
        backup (str | None): the canonical backup control.
    """
    if backup_displaces(backup):
        return (
            f"{cmd_name}: cannot create regular file '{target.raw_path}': "
            f"{posix_phrase(FsCondition.EISDIR)}"
        )
    return type_mismatch_error(cmd_name, src, target, False)


async def _clear_for_directory(
    policy: TransferPolicy,
    copies: TransferLinks | None,
    stat: StatFn,
    src: PathSpec,
    target: PathSpec,
    errors: list[str],
    lines: list[str] | None,
) -> PathSpec | None:
    """Free a non-directory's name for a directory copied onto it.

    GNU refuses the overwrite unless a backup moves the entry aside, and
    then renames it to its backup name. A source typed as ``.`` or ``..``
    is never backed up, so the entry is removed instead, which ``-v``
    reports. No gate or ``-i`` question applies to a directory source
    (coreutils 9.7). Outside a workspace nothing can rename the entry,
    so the overwrite is refused as it is without a backup. A link at the
    name is the entry moved or removed, not what it leads to, and the
    tree then lands at its name (``link_name``).

    Args:
        policy (TransferPolicy): The command's overwrite policy.
        copies (TransferLinks | None): The dispatcher that renames or
            removes the entry; None outside a workspace.
        stat (StatFn): Stats a path; raises when missing.
        src (PathSpec): The directory being copied.
        target (PathSpec): The non-directory holding its name.
        errors (list[str]): Collected stderr lines, appended in place.
        lines (list[str] | None): Verbose sink for the removal.

    Returns:
        PathSpec | None: The name freed for the directory, None when it
        stays taken.
    """
    if copies is None or not backup_displaces(policy.backup):
        errors.append(type_mismatch_error(policy.cmd_name, src, target, True))
        return None
    target = link_name(copies, target) or target
    if typed_name(src) in (".", ".."):
        try:
            await copies.dispatch("unlink", target)
        except FS_ERRORS as exc:
            errors.append(
                f"{policy.cmd_name}: cannot remove '{target.raw_path}': "
                f"{fs_strerror(exc)}"
            )
            return None
        if lines is not None:
            lines.append(f"removed '{target.raw_path}'")
        return target
    _, ok = await make_backup(
        policy,
        NativeMove(rename=partial(rename_link, copies)),
        stat,
        None,
        target,
        errors,
        copies,
    )
    return target if ok else None


async def overwrite_gate(
    policy: TransferPolicy,
    stat: StatFn,
    src: PathSpec,
    target: PathSpec,
    errors: list[str],
    copies: TransferLinks | None = None,
) -> bool:
    """Decide whether an existing target may be replaced.

    ``-n`` and ``--update=none`` skip silently; ``--update=none-fail``
    records GNU's ``not replacing`` error; ``--update=older`` replaces
    only when the source is strictly newer. A source or target with no
    usable mtime always replaces (freshness cannot be proven). ``-i``
    asks last, once the target survived the update checks.

    A copy that writes through a link at the target's name compares
    the source with what the link leads to; one whose backup moves the
    link aside compares with the link itself (GNU cp 9.7).

    Args:
        policy (TransferPolicy): Overwrite policy for this command.
        stat (StatFn): Stats a path; raises when missing.
        src (PathSpec): Source entry.
        target (PathSpec): Destination entry.
        errors (list[str]): Collected stderr lines, appended in place.
        copies (TransferLinks | None): Namespace facts for a copy that
            writes through a link at the target's name; None for one
            that renames onto it or copies a link as a link.

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
        if copies is not None and policy.backup is None:
            try:
                target_info = await dest_stat(stat, copies, target)
            except (FileNotFoundError, NotADirectoryError, ValueError):
                return True
            except FS_ERRORS as exc:
                # GNU names a link whose target its stat may not reach
                # and goes on with the next entry (coreutils 9.7).
                errors.append(
                    f"{policy.cmd_name}: cannot stat '{target.raw_path}': "
                    f"{fs_strerror(exc)}"
                )
                return False
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
            data = (
                await prime_stream(strategy.read_stream(target))
                if strategy.read_stream is not None
                else await strategy.read_bytes(target)
            )
            try:
                await strategy.write(backup, data=data)
            finally:
                await close_quietly(data)
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
            f"{posix_phrase(FsCondition.ENOTSUP)}"
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
    src: PathSpec,
    target: PathSpec,
    backup: PathSpec | None,
    cmd_name: str = "cp",
) -> str:
    """The verbose line for one copied entry, with GNU's backup note.

    GNU prints it before the create, so a create that fails still shows
    it; mv words a copy across mounts ``copied``.

    Args:
        src (PathSpec): Source entry.
        target (PathSpec): Destination entry.
        backup (PathSpec | None): Backup made for this overwrite.
        cmd_name (str): the command copying it (``cp``/``mv``).
    """
    line = f"'{src.raw_path}' -> '{target.raw_path}'"
    if backup is not None:
        line += f" (backup: '{backup.raw_path}')"
    return f"copied {line}" if cmd_name == "mv" else line


def _repeated_source(
    earlier: PathSpec | None,
    src: PathSpec,
    target: PathSpec,
    src_is_dir: bool,
    flags: CpFlags,
    key_of: Callable[[PathSpec], str],
) -> tuple[str, bool] | None:
    """GNU's verdict on a source this cp already began to copy.

    Copied again to the same place, it is a warning and is skipped. A
    directory meeting a second place would be a hard link to a
    directory, which cp refuses unless -L or -H followed it there; a
    file is copied again (coreutils 9.7). A file under a backup that
    moves the first copy aside goes on to the just-created rule.

    Args:
        earlier (PathSpec | None): where its first copy went, None if
            it has none.
        src (PathSpec): the source operand.
        target (PathSpec): where it would land this time.
        src_is_dir (bool): whether the source is a directory.
        flags (CpFlags): parsed cp flags.
        key_of (Callable[[PathSpec], str]): the backend key of a path.

    Returns:
        tuple[str, bool] | None: the stderr line and whether it is only
        a warning, or None to copy it.
    """
    if earlier is None:
        return None
    if key_of(earlier) == key_of(target):
        if not src_is_dir and backup_displaces(flags.backup):
            return None
        noun = "directory" if src_is_dir else "file"
        return (
            f"cp: warning: source {noun} '{src.raw_path}' "
            "specified more than once",
            True,
        )
    if src_is_dir and flags.dereference is CopyDeref.NEVER:
        return (
            f"cp: will not create hard link '{target.raw_path}' "
            f"to directory '{earlier.raw_path}'",
            False,
        )
    return None


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
        src_base (str): Source root's virtual path, no trailing slash.
        dst_base (str): Destination root's virtual path, no trailing slash.
    """
    dirs = {src_base, *await strategy.find(src, type="d")}
    files = await strategy.find(src, type="f")
    lines: list[str] = []
    for entry_mount in sorted({*dirs, *files}):
        entry = spelled_from(PathSpec.from_str_path(entry_mount), src)
        entry_dst = spelled_from(
            PathSpec.from_str_path(dst_base + entry_mount[len(src_base) :]),
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


async def _copy_entry(
    strategy: NativeCopy,
    copies: TransferLinks | None,
    src: PathSpec,
    dst: PathSpec,
) -> None:
    """Copy one entry natively, or by bytes where a link leads elsewhere.

    The dispatcher follows a link standing at the destination name, so a
    native copy whose link leads onto another mount answers EXDEV; that
    entry goes through the relay's read and write instead, which follow
    the link wherever it lands. Every other entry keeps the backend's
    copy (a Drive document stays a document).

    Args:
        strategy (NativeCopy): the mount's native copy.
        copies (TransferLinks | None): the relay; None outside a
            workspace, where no link can stand.
        src (PathSpec): the entry to copy.
        dst (PathSpec): where it goes.
    """
    try:
        await strategy.copy(src, dst)
    except OSError as exc:
        if exc.errno != errno.EXDEV or copies is None:
            raise
        data = (
            await prime_stream(copies.relay.read_stream(src))
            if copies.relay.read_stream is not None
            else await copies.relay.read_bytes(src)
        )
        try:
            await copies.relay.write(dst, data=data)
        finally:
            await close_quietly(data)


async def transfer_file(
    strategy: PrimitiveCopy | PrimitiveMove,
    src: PathSpec,
    dst: PathSpec,
    cmd_name: str,
    errors: list[str],
) -> bool:
    """Copy one file between the strategy's mounts, reporting a failure
    in GNU's words; False when it failed.

    A store-to-store copy goes first where the strategy has one: the
    destination's store copies from the source's without the bytes
    passing through mirage. EXDEV from it says the stores cannot, and a
    declined walk says a hide or rule wants the copy made by parts;
    either way the bytes move through a read and a write, the file
    materialized in between.

    Args:
        strategy (PrimitiveCopy | PrimitiveMove): the transfer
            primitives.
        src (PathSpec): the file.
        dst (PathSpec): where it goes.
        cmd_name (str): ``cp`` or ``mv``, for the error lines.
        errors (list[str]): collects the error lines.
    """
    if strategy.copy is not None:
        try:
            await strategy.copy(src, dst)
            return True
        except OSError as exc:
            if isinstance(exc, WalkDeclinedError):
                _logger.debug("copy %s declined: %s", src.virtual, exc)
            elif classify(exc) is not FsCondition.EXDEV:
                if not isinstance(exc, FS_ERRORS):
                    raise
                errors.append(
                    f"{cmd_name}: cannot open '{src.raw_path}' "
                    f"for reading: {fs_strerror(exc)}"
                    if getattr(exc, "filename", None) == src.virtual
                    else f"{cmd_name}: cannot create regular file "
                    f"'{dst.raw_path}': {fs_strerror(exc)}"
                )
                return False
    read_failed = False

    def failed(exc: Exception) -> None:
        nonlocal read_failed
        read_failed = True

    try:
        data = (
            await prime_stream(strategy.read_stream(src), failed)
            if strategy.read_stream is not None
            else await strategy.read_bytes(src)
        )
    except FS_ERRORS as exc:
        errors.append(
            f"{cmd_name}: cannot open '{src.raw_path}' "
            f"for reading: {fs_strerror(exc)}"
        )
        return False
    try:
        await strategy.write(dst, data=data)
    except FS_ERRORS as exc:
        errors.append(
            f"{cmd_name}: error reading '{src.raw_path}': {fs_strerror(exc)}"
            if read_failed
            else (
                f"{cmd_name}: cannot create regular file "
                f"'{dst.raw_path}': {fs_strerror(exc)}"
            )
        )
        return False
    finally:
        await close_quietly(data)
    return True


async def _mirror_dirs(
    strategy: NativeCopy,
    stat: StatFn,
    src: PathSpec,
    target: PathSpec,
    src_base: str,
    dst_base: str,
    errors: list[str],
    policy: TransferPolicy,
    copies: TransferLinks | None,
    into_itself: bool,
    lines: list[str] | None = None,
    unreadable: list[str] | None = None,
) -> tuple[list[str], set[str] | None]:
    """Recreate a source tree's directories under the destination root.

    Only needed on the per-entry policy path, where a whole-tree
    ``dir_copy`` cannot be used: without this, a directory holding no
    files would never appear at the destination, and an entirely empty
    tree would copy to nothing. A backend exposing no ``mkdir``
    (directories are implied by keys) is a no-op. Parents sort before
    children so a nested tree lands in order.

    A directory that cannot be made, or whose name a non-directory
    holds that no backup moves aside, is GNU's line and its tree is left
    out; its siblings still copy, as GNU's walk goes on (coreutils 9.7).

    Args:
        strategy (NativeCopy): Native copy capability.
        stat (StatFn): Stats a path; raises when missing.
        src (PathSpec): Source root.
        target (PathSpec): Destination root.
        src_base (str): Source root's virtual path, no trailing slash.
        dst_base (str): Destination root's virtual path, no trailing slash.
        errors (list[str]): Collected stderr lines, appended in place.
        policy (TransferPolicy): The copy's overwrite policy, whose
            backup moves a non-directory out of a directory's way.
        copies (TransferLinks | None): The dispatcher that moves it.
        into_itself (bool): Whether the destination lies inside the
            source; its subtree is then left out, as the file pass does.
        lines (list[str] | None): Verbose sink for the directories this
            creates, which GNU also reports; one already at the
            destination is merged into silently. None keeps them silent.
        unreadable (list[str] | None): Collects the source directories
            the walk may not open, which are still made at the
            destination; None lets the refusal propagate.

    Returns:
        tuple[list[str], set[str] | None]: the source directories whose
        trees the file pass leaves out, and the destination directories
        this made, whose entries cannot be taken yet (None where the
        backend has no directories).
    """
    if strategy.mkdir is None:
        return [], None
    mounts = [
        found
        for found in [
            src_base,
            *await strategy.find(src, type="d", unreadable=unreadable),
        ]
        if not (into_itself and within(found, dst_base))
    ]
    blocked: list[str] = []
    made: set[str] = set()
    # Shortest first so a parent is created before its children. The name is
    # the tiebreak because `sorted` is stable and set iteration over strings
    # is PYTHONHASHSEED-dependent, so sibling directories of equal length
    # used to come out in a different order run to run -- and in a different
    # order from TypeScript, whose Set keeps insertion order.
    for entry_mount in sorted(set(mounts), key=lambda p: (len(p), p)):
        if any(within(entry_mount, root) for root in blocked):
            continue
        dst_mount = dst_base + entry_mount[len(src_base) :]
        entry_dst = spelled_from(PathSpec.from_str_path(dst_mount), target)
        entry = spelled_from(PathSpec.from_str_path(entry_mount), src)
        try:
            # A directory meets a link at its name as the link itself,
            # where a file writes through it (GNU's lstat for a directory
            # source, coreutils 9.7).
            exists, is_dir = await entry_kind(stat, entry_dst)
            if is_dir:
                continue
            free = (
                not exists
                or await _clear_for_directory(
                    policy, copies, stat, entry, entry_dst, errors, lines
                )
                is not None
            )
            if free:
                await strategy.mkdir(entry_dst)
        except FS_ERRORS as exc:
            errors.append(
                f"cp: cannot create directory "
                f"'{entry_dst.raw_path}': {fs_strerror(exc)}"
            )
        else:
            if free:
                made.add(dst_mount)
                if lines is not None:
                    lines.append(
                        f"'{entry.raw_path}' -> '{entry_dst.raw_path}'"
                    )
                continue
        blocked.append(entry_mount)
    return blocked, made


async def walk(
    readdir: ReaddirFn,
    stat: StatFn,
    root: PathSpec,
    cmd_name: str = "cp",
    errors: list[str] | None = None,
    links: LinkView | None = None,
) -> list[tuple[PathSpec, FileType]]:
    """List a tree as ``(path, kind)`` pairs, parents before children.

    The kind is captured here, while the tree is intact, so a caller that
    deletes as it goes (mv) never re-stats a path whose virtual parent dir
    has since vanished (e.g. on S3), and a copy knows a FIFO from a file
    without opening it. Used only by the primitive (no native
    ``copy``) path; backends that inject ``copy``/``find`` never reach it.

    A folder a backend lists with a trailing slash (box, dropbox,
    gdrive) is walked without it. A directory the session may not open,
    or an entry it may not stat (a rule refused it below the operand), is
    GNU's ``cannot access`` / ``cannot stat`` line when ``errors`` is
    given and the walk goes on without its contents; with no channel the
    refusal propagates rather than leave a silent gap.

    Args:
        readdir (Callable): Lists a directory's full child paths.
        stat (Callable): Stats a path; ``.type`` is the entry's kind.
        root (PathSpec): Root of the tree.
        cmd_name (str): the command the diagnostics name.
        errors (list[str] | None): where a per-entry refusal is reported.
        links (LinkView | None): Namespace links handled separately, which
            this byte traversal skips instead of opening as regular files.
    """
    info = await stat(root)
    if info.type != FileType.DIRECTORY:
        return [(root, info.type)]
    entries = [(root, FileType.DIRECTORY)]
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
            entries.append((child, child_info.type))
            if child_info.type == FileType.DIRECTORY:
                queue.append(child)
    return entries


async def copy_entries(
    cmd_name: str,
    strategy: PrimitiveCopy | PrimitiveMove,
    stat: StatFn,
    src: PathSpec,
    target: PathSpec,
    entries: list[tuple[PathSpec, FileType]],
    errors: list[str],
    *,
    policy: TransferPolicy | None = None,
    lines: list[str] | None = None,
    copies: TransferLinks | None = None,
    root_backup: PathSpec | None = None,
    blocked: list[str] | None = None,
) -> bool:
    """Copy a walked source tree entry by entry with GNU per-entry errors.

    The shared primitive-transfer loop of cp and mv. A directory that
    cannot be made, or whose name a non-directory holds that no backup
    moves aside, leaves its own tree out; a failed read or write is
    reported; either way the remaining entries still copy, like GNU
    cp/mv on a cross-device transfer. Every error line carries
    ``fs_strerror``, so a backend missing the needed op
    (``OperationNotSupportedError``) reports ``Operation not supported``
    instead of aborting the command. A FIFO
    or device is GNU's failed recreate (``_special_file_error``), never
    read.
    ``-n``/``--update``/``--backup`` apply per file entry, like GNU
    during a recursive merge.

    Args:
        cmd_name (str): Command name for the error prefix (``cp``/``mv``).
        strategy (PrimitiveCopy | PrimitiveMove): Transfer primitives for
            both mounts.
        stat (StatFn): Stats a path; raises when missing.
        src (PathSpec): Source operand the entries were walked from.
        target (PathSpec): Destination root for the copied tree.
        entries (list[tuple[PathSpec, FileType]]): ``walk`` output,
            parents first.
        errors (list[str]): Collected stderr lines, appended in place.
        policy (TransferPolicy | None): Per-entry overwrite policy; None
            overwrites unconditionally.
        lines (list[str] | None): Verbose sink, a file's line written
            before its create; None keeps the copy silent.
        copies (TransferLinks | None): Namespace links to preserve verbatim.
        root_backup (PathSpec | None): the backup the caller made of the
            target, which the source's own line notes.
        blocked (list[str] | None): filled with the source directories
            whose trees were left out, for a caller that copies their
            links next.

    Returns:
        bool: Whether every entry landed.
    """
    copied_all = True
    blocked = [] if blocked is None else blocked
    made: set[str] = set()
    for entry, kind in entries:
        if any(within(entry.virtual, root) for root in blocked):
            continue
        entry_dst = descendant_path(
            target,
            target.virtual.rstrip("/")
            + entry.virtual[len(src.virtual.rstrip("/")) :],
        )
        if kind == FileType.DIRECTORY:
            try:
                exists, is_dir = await entry_kind(stat, entry_dst)
                if is_dir:
                    continue
                free = (
                    not exists
                    or await _clear_for_directory(
                        policy or TransferPolicy(cmd_name=cmd_name),
                        copies,
                        stat,
                        entry,
                        entry_dst,
                        errors,
                        lines,
                    )
                    is not None
                )
                if free:
                    await strategy.mkdir(entry_dst)
            except FS_ERRORS as exc:
                errors.append(
                    f"{cmd_name}: cannot create directory "
                    f"'{entry_dst.raw_path}': {fs_strerror(exc)}"
                )
            else:
                if free:
                    made.add(entry_dst.virtual)
                    if lines is not None:
                        lines.append(
                            f"created directory '{entry_dst.raw_path}'"
                            if cmd_name == "mv"
                            else f"'{entry.raw_path}' -> "
                            f"'{entry_dst.raw_path}'"
                        )
                    continue
            copied_all = False
            blocked.append(entry.virtual)
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
        if policy is not None and not await overwrite_gate(
            policy,
            stat,
            entry,
            entry_dst,
            errors,
            copies if isinstance(strategy, PrimitiveCopy) else None,
        ):
            continue
        if (
            entry is not src
            and parent(entry_dst.virtual) not in made
            and await _holds_directory(stat, entry_dst)
        ):
            backup_control = policy.backup if policy is not None else None
            errors.append(
                _onto_directory(cmd_name, entry, entry_dst, backup_control)
            )
            copied_all = False
            continue
        refusal = _special_file_error(cmd_name, kind, entry_dst)
        if refusal is not None:
            if lines is not None:
                lines.append(transfer_line(entry, entry_dst, None, cmd_name))
            errors.append(refusal)
            copied_all = False
            continue
        backup = root_backup if entry is src else None
        if policy is not None:
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
        if lines is not None:
            lines.append(transfer_line(entry, entry_dst, backup, cmd_name))
        if not await transfer_file(
            strategy, entry, entry_dst, cmd_name, errors
        ):
            copied_all = False
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
    dispatch: DispatchFn | None = None,
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
            normalized virtual path.
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
        dispatch (DispatchFn | None): the command's dispatcher, which
            lets a source's mount refuse a tree copied file by file;
            None outside a workspace.

    Returns:
        tuple[ByteSource | None, IOResult]: Verbose output, with
        per-source coreutils errors on stderr and exit code 1
        when any source failed.
    """
    key_of = backend_key if backend_key is not None else backend_key_default
    sources, dst = split_operands(
        "cp", paths, flags.target_dir, flags.no_target_dir
    )
    to_dest = partial(dest_stat, stat, copies)
    if flags.target_dir is not None:
        err = await target_dir_error("cp", to_dest, dst)
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
        dst_exists, dst_is_dir, dst_err = await dest_kind(to_dest, dst)
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
    # Where each source's first copy went, by source and by link name.
    first_copy: dict[str, PathSpec] = {}
    first_link: dict[str, PathSpec] = {}
    created: set[str] = set()
    guards_created = not (
        flags.no_clobber
        or update_gates(flags.update)
        or flags.backup == "numbered"
    )
    for src, target in copy_targets(
        sources, dst, dst_is_dir, dst_exists, dst_err, dotdot="."
    ):
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
                errors.append(same_file_error("cp", src, target))
                continue
            repeat = _repeated_source(
                first_link.get(named), src, target, False, flags, key_of
            )
            if repeat is not None:
                errors.append(repeat[0])
                warned += repeat[1]
                continue
            first_link.setdefault(named, target)
            if guards_created and key_of(target) in created:
                if policy.ask is not None and not await policy.ask(target):
                    continue
                errors.append(just_created_error("cp", src, target))
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
        src_kind, src_err = await source_kind(stat, src)
        if src_err is not None:
            errors.append(
                f"cp: cannot stat '{src.raw_path}': {posix_phrase(src_err)}"
            )
            continue
        src_is_dir = src_kind == FileType.DIRECTORY
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
            errors.append(type_mismatch_error("cp", src, target, False))
            continue
        if key_of(src) == key_of(target):
            errors.append(same_file_error("cp", src, target))
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
                to_dest, target
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
            # GNU announces a file before the create this refuses; a
            # directory's line waits for its mkdir.
            if flags.verbose and not src_is_dir:
                lines.append(transfer_line(src, target, None))
            errors.append(
                f"cp: cannot create {noun} '{target.raw_path}': "
                f"{posix_phrase(target_err)}"
            )
            continue
        # A directory onto a non-directory is refused before any gate,
        # unless a backup moves the entry aside (below); a file a directory
        # stands in the way of waits for the gates (further below).
        mismatch = (
            overwrite_type_error(
                "cp", src, src_is_dir, target, target_exists, target_is_dir
            )
            if src_is_dir
            and (copies is None or not backup_displaces(flags.backup))
            else None
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
                errors.append(type_mismatch_error("cp", src, target, True))
                continue
            if flags.verbose:
                lines.append(transfer_line(src, target, None))
            errors.append(
                f"cp: not writing through dangling symlink '{target.raw_path}'"
            )
            continue
        repeat = _repeated_source(
            first_copy.get(key_of(src)), src, target, src_is_dir, flags, key_of
        )
        if repeat is not None:
            errors.append(repeat[0])
            warned += repeat[1]
            continue
        first_copy.setdefault(key_of(src), target)
        if into_itself:
            errors.append(
                f"cp: cannot copy a directory, '{src.raw_path}', "
                f"into itself, '{target.raw_path}'"
            )
        if flags.recursive and src_is_dir:
            if guards_created and key_of(target) in created:
                # As a file would be, but a directory is asked nothing.
                errors.append(just_created_error("cp", src, target))
                continue
            # A whole-tree copy reads nothing here; any other copy goes
            # file by file, so the source's mount is asked before the
            # destination is touched.
            whole_tree = (
                not isinstance(strategy, PrimitiveCopy)
                and strategy.dir_copy is not None
                and not per_entry_native
                and not into_itself
                and not target_exists
            )
            if not whole_tree:
                await before_full_walk(dispatch, src, "cp")
            if target_exists and not target_is_dir:
                freed = await _clear_for_directory(
                    policy,
                    copies,
                    stat,
                    src,
                    target,
                    errors,
                    lines if flags.verbose else None,
                )
                if freed is None:
                    continue
                target = freed
            src_base = src.virtual.rstrip("/")
            dst_base = target.virtual.rstrip("/")
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
                        (path, kind)
                        for path, kind in entries
                        if not within(path.virtual, target.virtual)
                    ]
                left_out: list[str] = []
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
                    blocked=left_out,
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
                        blocked=left_out,
                    )
                continue
            # A whole-tree copy cannot honor a merge's per-entry rules (a
            # Drive copy adds a second entry of the same name, a Box one
            # refuses the tree), so only a fresh destination takes it.
            if whole_tree and strategy.dir_copy is not None:
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
                except OperationNotSupportedError:
                    copied = False
                except OSError as exc:
                    reason = fs_strerror(exc)
                    if reason is None:
                        raise
                    errors.append(
                        f"cp: cannot open directory '{src.raw_path}': {reason}"
                        if getattr(exc, "filename", None) == src.virtual
                        else "cp: cannot create directory "
                        f"'{target.raw_path}': {reason}"
                    )
                    continue
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
            # dispatcher declines or the backend cannot make in one call,
            # so the tree's directories are recreated here: a files-only
            # pass would drop every directory that holds no files (GNU
            # keeps them).
            if whole_tree:
                await before_full_walk(dispatch, src, "cp")
            # A directory the walk may not open is GNU's line; it is made at
            # the destination and the rest of the tree still copies.
            unreadable: list[str] = []
            blocked, made = await _mirror_dirs(
                strategy,
                stat,
                src,
                target,
                src_base,
                dst_base,
                errors,
                policy,
                copies,
                into_itself,
                lines if flags.verbose else None,
                unreadable,
            )
            files = await strategy.find(src, type="f", unreadable=unreadable)
            errors.extend(
                "cp: cannot access "
                f"'{spelled_from(PathSpec.from_str_path(root), src).raw_path}': "
                f"{posix_phrase(FsCondition.EACCES)}"
                for root in dict.fromkeys(unreadable)
            )
            for entry_mount in files:
                if into_itself and within(entry_mount, dst_base):
                    continue
                if any(within(entry_mount, root) for root in blocked):
                    continue
                dst_mount = dst_base + entry_mount[len(src_base) :]
                entry = spelled_from(PathSpec.from_str_path(entry_mount), src)
                entry_dst = spelled_from(
                    PathSpec.from_str_path(dst_mount), target
                )
                if not await overwrite_gate(
                    policy, stat, entry, entry_dst, errors, copies
                ):
                    continue
                if (
                    made is not None
                    and parent(dst_mount) not in made
                    and await _holds_directory(stat, entry_dst)
                ):
                    errors.append(
                        _onto_directory("cp", entry, entry_dst, flags.backup)
                    )
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
                if flags.verbose:
                    lines.append(transfer_line(entry, entry_dst, backup))
                try:
                    await _copy_entry(strategy, copies, entry, entry_dst)
                except FS_ERRORS as exc:
                    errors.append(
                        f"cp: cannot create regular file "
                        f"'{entry_dst.raw_path}': {fs_strerror(exc)}"
                    )
                    continue
            if copies is not None:
                await copy_tree_links(
                    copies,
                    flags.dereference,
                    src,
                    target,
                    errors,
                    lines if flags.verbose else None,
                    policy,
                    blocked=[
                        PathSpec.from_str_path(root).virtual
                        for root in blocked
                    ],
                )
            continue
        if guards_created and key_of(target) in created:
            # -i asks first: GNU only meets the just-created rule once
            # the answer says to replace.
            if policy.ask is not None and not await policy.ask(target):
                continue
            errors.append(just_created_error("cp", src, target))
            continue
        if not await overwrite_gate(policy, stat, src, target, errors, copies):
            continue
        if target_is_dir:
            errors.append(_onto_directory("cp", src, target, flags.backup))
            continue
        refusal = (
            _special_file_error("cp", src_kind, target)
            if flags.recursive
            else None
        )
        if refusal is not None:
            if flags.verbose:
                lines.append(transfer_line(src, target, None))
            errors.append(refusal)
            continue
        copier: CopyStrategy = strategy
        mover: CopyStrategy | NativeMove = strategy
        if copies is not None and policy.backup is not None:
            linked = link_name(copies, target)
            if linked is not None:
                target = linked
                mover = NativeMove(rename=partial(rename_link, copies))
                if copies.owns is not None and not copies.owns(target.virtual):
                    copier = copies.relay
        backup, ok = await make_backup(
            policy, mover, stat, readdir, target, errors, copies
        )
        if not ok:
            continue
        if flags.verbose:
            lines.append(transfer_line(src, target, backup))
        if isinstance(copier, PrimitiveCopy):
            if not await transfer_file(copier, src, target, "cp", errors):
                continue
        else:
            try:
                await copier.copy(src, target)
            except FS_ERRORS as exc:
                errors.append(
                    f"cp: cannot create regular file "
                    f"'{target.raw_path}': {fs_strerror(exc)}"
                )
                continue
        created.add(key_of(target))
    output = "\n".join(lines) + "\n" if lines else None
    return output.encode() if output else None, IOResult(
        stderr=stderr_of(errors),
        exit_code=1 if len(errors) > warned + len(accepted) else 0,
    )
