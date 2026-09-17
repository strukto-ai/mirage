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

import posixpath
from dataclasses import dataclass
from functools import partial

from mirage.commands.builtin.utils.backup import backup_control, backup_target
from mirage.commands.builtin.utils.constants import DEFAULT_BACKUP_SUFFIX
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS, parse_command
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.parser import ParsedArgs, parse_to_kwargs
from mirage.commands.spec.types import FlagValue
from mirage.commands.spec.usage import (ambiguous_option_error,
                                        missing_value_error,
                                        unexpected_value_error,
                                        unknown_option_error, usage_hint)
from mirage.context import path_allowed
from mirage.io.stream import materialize
from mirage.runtime.types import DispatchFn
from mirage.types import FileStat, FileType, PathSpec, word_text
from mirage.utils.errors import FS_ERRORS, ReadOnlyError, fs_strerror
from mirage.utils.path import CycleError
from mirage.workspace.executor.builtins.links.probe import (path_readdir,
                                                            path_stat)
from mirage.workspace.executor.builtins.shared import (abs_path, fail,
                                                       read_only_error, result)
from mirage.workspace.executor.builtins.types import Result
from mirage.workspace.mount.namespace import Namespace
from mirage.workspace.session import Session

_TARGET_DIR_LONG = "--target-directory"
_SUFFIX_LONG = "--suffix"
_VALUED_SHORTS = "tS"


@dataclass(frozen=True, slots=True)
class LnFlags:
    """The ln flag bag, parsed once.

    Args:
        symbolic (bool): ``-s``; the link is a namespace symlink rather
            than a byte copy.
        force (bool): ``-f``; remove an occupied destination first.
        no_dereference (bool): ``-n``; a destination that is a link to a
            directory is the link itself, not the directory.
        verbose (bool): ``-v``; report each link made.
        relative (bool): ``-r``; store the target relative to the link.
        logical (bool): ``-L``; a hard link of a symlink copies the
            target's bytes instead of the link.
        directory (bool): ``-d``/``-F``; attempt a hard link of a
            directory, which GNU refuses for everyone but root.
        no_target (bool): ``-T``; the last operand is the link name
            even when it is a directory.
        backup (str | None): canonical backup control, or None.
        suffix (str): simple-backup suffix.
    """
    symbolic: bool
    force: bool
    no_dereference: bool
    verbose: bool
    relative: bool
    logical: bool
    directory: bool
    no_target: bool
    backup: str | None
    suffix: str


@dataclass(frozen=True, slots=True)
class LinkPlan:
    """One link to make: its source operand and where it lands.

    Args:
        source (str | PathSpec): the TARGET operand as classified.
        link_abs (str): absolute virtual path of the link name.
        link_typed (str): the link name as GNU would spell it in a
            message (``d/f.txt`` for a directory destination).
    """
    source: str | PathSpec
    link_abs: str
    link_typed: str


def parse_flags(fl: FlagView) -> LnFlags:
    """Parse the ln flag bag once into a frozen struct.

    ``-L`` and ``-P`` are one switch and the later occurrence wins, as
    in GNU (``-LP`` links the symlink itself, ``-PL`` its target); a
    hard link of a symlink is the ``-P`` default. Raises ``UsageError``
    for a ``--backup`` control GNU does not know.

    Args:
        fl (FlagView): flag view constructed with the ln spec.
    """
    raw: FlagValue | None = fl.raw("backup")
    backup_raw = raw if isinstance(raw, (str, bool)) else None
    suffix = fl.as_str("suffix") or None
    deref = fl.typed_order("logical", "physical")
    return LnFlags(
        symbolic=fl.as_bool("symbolic"),
        force=fl.as_bool("force"),
        no_dereference=fl.as_bool("no_dereference"),
        verbose=fl.as_bool("verbose"),
        relative=fl.as_bool("relative"),
        logical=bool(deref) and deref[-1] == "logical",
        directory=fl.as_bool("directory") or fl.as_bool("F"),
        no_target=fl.as_bool("no_target_directory"),
        backup=backup_control("ln", backup_raw, suffix),
        suffix=suffix if suffix is not None else DEFAULT_BACKUP_SUFFIX,
    )


def option_refusal(parsed: ParsedArgs) -> tuple[str, int] | None:
    """The GNU option error the parser reported, if any.

    Args:
        parsed (ParsedArgs): the spec parse of the line.
    """
    if (parsed.option_error_kinds
            and parsed.option_error_kinds[0] == "ambiguous"
            and parsed.ambiguous_options):
        token, candidates = parsed.ambiguous_options[0]
        msg, code = ambiguous_option_error("ln", token, candidates)
        return msg.decode(), code
    if parsed.invalid_options:
        if parsed.option_error_kinds[:1] == ["unexpected_value"]:
            msg, code = unexpected_value_error("ln", parsed.invalid_options[0])
        else:
            msg, code = unknown_option_error("ln", parsed.invalid_options[0])
        return msg.decode(), code
    if parsed.ambiguous_options:
        token, candidates = parsed.ambiguous_options[0]
        msg, code = ambiguous_option_error("ln", token, candidates)
        return msg.decode(), code
    if parsed.needs_value_options:
        msg, code = missing_value_error("ln", parsed.needs_value_options[0])
        return msg.decode(), code
    return None


def operand_words(
        args: list[str | PathSpec]) -> tuple[list[str | PathSpec], str | None]:
    """The operands as classified, and ``-t``'s value as typed.

    The spec parse resolves every path against the cwd, which is what a
    link is made at, but a message spells what the user typed
    (``'e/f.txt'``), and only the classified words still carry that. The
    parse already validated the options, so this walk only has to know
    which of ln's spellings consume a word.

    Args:
        args (list[str | PathSpec]): args after the command name.
    """
    operands: list[str | PathSpec] = []
    target_typed: str | None = None
    parsing = True
    i = 0
    while i < len(args):
        tok = word_text(args[i])
        if parsing and tok == "--":
            parsing = False
        elif parsing and tok.startswith("--") and len(tok) > 2:
            name, eq, value = tok.partition("=")
            if _TARGET_DIR_LONG.startswith(name):
                if eq:
                    target_typed = value
                elif i + 1 < len(args):
                    i += 1
                    target_typed = word_text(args[i])
            elif _SUFFIX_LONG.startswith(name) and not eq and i + 1 < len(
                    args):
                i += 1
        elif parsing and tok.startswith("-") and len(tok) > 1:
            for j, letter in enumerate(tok[1:], start=1):
                if letter not in _VALUED_SHORTS:
                    continue
                value = tok[j + 1:]
                if not value and i + 1 < len(args):
                    i += 1
                    value = word_text(args[i])
                if letter == "t":
                    target_typed = value
                break
        else:
            operands.append(args[i])
        i += 1
    return operands, target_typed


def _visible_link(namespace: Namespace, virtual: str) -> bool:
    """Whether the session may know that a path is a link.

    A hidden path is nonexistent for the session, so a link there is
    not one ln may follow, copy or resolve. The door checks the typed
    path before it follows a link, and every namespace read in this
    module has to answer the same way, or a link inside hidden space
    leads ln out of it: into the directory it points at, or to the
    target string a hard link would copy.

    Args:
        namespace (Namespace): the link table.
        virtual (str): absolute virtual path.
    """
    return path_allowed(virtual) and namespace.is_link(virtual)


def _follow_visible(namespace: Namespace, virtual: str) -> str:
    """Resolve the links along a path the session may see; a hidden
    path stays as typed. Raises ``CycleError`` as ``follow`` does.

    Args:
        namespace (Namespace): the link table.
        virtual (str): absolute virtual path.
    """
    return namespace.follow(virtual) if path_allowed(virtual) else virtual


async def _listed_by_parent(dispatch: DispatchFn, virtual: str) -> bool:
    """Whether a path's own name is in its parent's listing.

    The door's proof of a directory, repeated here because a stat row
    settles nothing: an API tree synthesizes its directories (a postgres
    schema lists ``tables/`` and ``views/`` for a schema nobody created,
    a grouping mount stats every path under a live collection as one),
    and linking *into* an invented directory would bury the name the
    user typed. Compared on the final segment, because backends disagree
    on entry shape.

    Args:
        dispatch (DispatchFn): op dispatcher.
        virtual (str): absolute virtual path of the candidate directory.
    """
    parent, _, name = virtual.rstrip("/").rpartition("/")
    if not name:
        return False
    listing = await path_readdir(dispatch, parent or "/")
    return any(
        str(entry).rstrip("/").rsplit("/", 1)[-1] == name for entry in listing)


async def _dir_at(namespace: Namespace, dispatch: DispatchFn, virtual: str,
                  no_dereference: bool) -> tuple[str, FileStat | None]:
    """What a destination operand names once links are resolved.

    GNU dereferences a destination that is a link to a directory and
    links inside that directory; ``-n`` keeps the link itself as the
    name. A real directory is the directory either way, and a directory
    row counts only when the door would (a mount root, or a name its
    parent lists).

    Args:
        namespace (Namespace): the link table.
        dispatch (DispatchFn): op dispatcher.
        virtual (str): absolute virtual path of the operand.
        no_dereference (bool): ``-n``.
    """
    if _visible_link(namespace, virtual):
        if no_dereference:
            return virtual, None
        try:
            virtual = namespace.follow(virtual)
        except CycleError:
            return virtual, None
    stat = await path_stat(dispatch, virtual)
    if (stat is not None and stat.type == FileType.DIRECTORY
            and not namespace.is_mount_root(virtual)
            and not await _listed_by_parent(dispatch, virtual)):
        return virtual, None
    return virtual, stat


def _into(source: str | PathSpec, dir_abs: str, dir_typed: str) -> LinkPlan:
    """The link a TARGET gets inside a directory: GNU names it after the
    target's basename, spelled under the directory as typed.

    Args:
        source (str | PathSpec): the TARGET operand.
        dir_abs (str): absolute virtual path of the directory.
        dir_typed (str): the directory operand as typed.
    """
    base = posixpath.basename(word_text(source).rstrip("/"))
    return LinkPlan(source, posixpath.join(dir_abs, base),
                    f"{dir_typed.rstrip('/')}/{base}")


async def plan_links(
    namespace: Namespace,
    dispatch: DispatchFn,
    cwd: str,
    operands: list[str | PathSpec],
    target_dir: str | None,
    target_typed: str | None,
    flags: LnFlags,
) -> tuple[list[LinkPlan], str | None]:
    """Turn ln's operands into the links to make, GNU's four forms.

    ``ln -t DIR TARGET...`` and ``ln TARGET... DIR`` link every target
    into the directory; ``ln TARGET`` links into the cwd; ``ln TARGET
    LINK`` names the link, unless LINK is a directory and ``-T`` did not
    forbid descending into it.

    Args:
        namespace (Namespace): the link table.
        dispatch (DispatchFn): op dispatcher.
        cwd (str): session working directory.
        operands (list[str | PathSpec]): the positional operands.
        target_dir (str | None): ``-t``'s value, cwd-resolved.
        target_typed (str | None): ``-t``'s value as typed.
        flags (LnFlags): the parsed flags.

    Returns:
        tuple: the plans, or an empty list with the refusal to print.
    """
    hint = usage_hint("ln") + "\n"
    if target_dir is not None:
        typed = target_typed if target_typed is not None else target_dir
        resolved, stat = await _dir_at(namespace, dispatch,
                                       abs_path(target_dir, cwd),
                                       flags.no_dereference)
        if stat is None:
            return [], (f"ln: failed to access '{typed}': "
                        "No such file or directory\n")
        if stat.type != FileType.DIRECTORY:
            return [], f"ln: target '{typed}' is not a directory\n"
        return [_into(op, resolved, typed) for op in operands], None
    if len(operands) == 1:
        if flags.no_target:
            return [], (f"ln: missing destination file operand after "
                        f"'{word_text(operands[0])}'\n{hint}")
        return [_into(operands[0], cwd, ".")], None
    if flags.no_target:
        if len(operands) > 2:
            return [], (f"ln: extra operand '{word_text(operands[2])}'\n"
                        f"{hint}")
        return [
            LinkPlan(operands[0], abs_path(operands[1], cwd),
                     word_text(operands[1]))
        ], None
    last = operands[-1]
    last_abs = abs_path(last, cwd)
    resolved, stat = await _dir_at(namespace, dispatch, last_abs,
                                   flags.no_dereference)
    is_dir = stat is not None and stat.type == FileType.DIRECTORY
    if len(operands) == 2 and not is_dir:
        return [LinkPlan(operands[0], last_abs, word_text(last))], None
    if not is_dir:
        if stat is None:
            return [], (f"ln: target '{word_text(last)}': "
                        "No such file or directory\n")
        return [], f"ln: target '{word_text(last)}': Not a directory\n"
    return [_into(op, resolved, word_text(last)) for op in operands[:-1]], None


async def _readdir(dispatch: DispatchFn, path: PathSpec) -> list[str]:
    return await path_readdir(dispatch, path.virtual)


async def _source_bytes(
    namespace: Namespace,
    dispatch: DispatchFn,
    src_abs: str,
    typed: str,
    link_typed: str,
    flags: LnFlags,
) -> tuple[bytes | None, str | None]:
    """The bytes a hard link copies, or the refusal in ln's words.

    A source whose stat passes but whose read fails (a policy deny, a
    backend that answers stat but not read) is refused the way GNU
    refuses a source it cannot reach at all, ``failed to access``, so
    the remaining operands still link.

    Args:
        namespace (Namespace): the link table.
        dispatch (DispatchFn): op dispatcher.
        src_abs (str): absolute virtual path of the TARGET.
        typed (str): the TARGET as typed.
        link_typed (str): the link name as typed, for ``-d``'s refusal.
        flags (LnFlags): the parsed flags.
    """
    if _visible_link(namespace, src_abs):
        try:
            src_abs = namespace.follow(src_abs)
        except CycleError:
            return None, (f"ln: failed to access '{typed}': "
                          "Too many levels of symbolic links\n")
    stat = await path_stat(dispatch, src_abs)
    if stat is None:
        return None, (f"ln: failed to access '{typed}': "
                      "No such file or directory\n")
    if stat.type == FileType.DIRECTORY:
        if flags.directory:
            return None, (f"ln: failed to create hard link '{link_typed}' "
                          f"=> '{typed}': Operation not permitted\n")
        return None, f"ln: {typed}: hard link not allowed for directory\n"
    try:
        data, _ = await dispatch("read", PathSpec.from_str_path(src_abs))
        if not isinstance(data, bytes):
            data = await materialize(data)
    except FS_ERRORS as exc:
        return None, f"ln: failed to access '{typed}': {fs_strerror(exc)}\n"
    return data, None


async def make_link(
    namespace: Namespace,
    dispatch: DispatchFn,
    cwd: str,
    plan: LinkPlan,
    flags: LnFlags,
    errors: list[str],
    out: list[str],
) -> None:
    """Make one link, appending GNU's line to ``errors`` or ``out``.

    A symlink stores the target as typed (or relative under ``-r``). A
    hard link of a symlink is the link itself, so it becomes a second
    symlink with the same target, unless ``-L`` asks for the target's
    bytes; a hard link of a file is a byte copy through the op door.
    Under ``-f`` a destination that is the source's own name is refused
    as GNU's ``are the same file`` before any backup or removal, since
    removing it would remove the source; GNU waives that when a backup
    keeps the original, so ``ln -sfb a a`` still goes through.

    Args:
        namespace (Namespace): the link table.
        dispatch (DispatchFn): op dispatcher.
        cwd (str): session working directory.
        plan (LinkPlan): the link to make.
        flags (LnFlags): the parsed flags.
        errors (list[str]): stderr lines, appended in place.
        out (list[str]): ``-v`` lines, appended in place.
    """
    kind = "symbolic link" if flags.symbolic else "hard link"
    typed = plan.link_typed
    target_typed = word_text(plan.source)
    link_target: str | None = None
    data: bytes | None = None
    if flags.symbolic:
        link_target = target_typed
        if flags.relative:
            # --relative: rewrite the target relative to the link's own
            # directory so the link stays valid addressed from anywhere.
            # GNU canonicalizes existing symlink components of both ends
            # first, so an aliased directory resolves to its real path
            # (the link survives the alias being moved/removed); a loop
            # falls back to the lexical answer.
            link_dir = posixpath.dirname(plan.link_abs) or "/"
            target_abs = abs_path(plan.source, cwd)
            try:
                target_abs = _follow_visible(namespace, target_abs)
                link_dir = _follow_visible(namespace, link_dir)
            except CycleError:
                pass
            link_target = posixpath.relpath(target_abs, link_dir)
    else:
        src_abs = abs_path(plan.source, cwd)
        if _visible_link(namespace, src_abs) and not flags.logical:
            link_target = namespace.readlink(src_abs)
        else:
            data, refusal = await _source_bytes(namespace, dispatch, src_abs,
                                                target_typed, typed, flags)
            if refusal is not None:
                errors.append(refusal)
                return
    if path_allowed(plan.link_abs) and namespace.is_mount_root(plan.link_abs):
        errors.append(f"ln: failed to create {kind} '{typed}': File exists\n")
        return
    link_spec = PathSpec.from_str_path(plan.link_abs)
    backs = flags.backup not in (None, "none")
    if (flags.force and not backs
            and abs_path(plan.source, cwd) == plan.link_abs
            and (_visible_link(namespace, plan.link_abs)
                 or await path_stat(dispatch, plan.link_abs) is not None)):
        errors.append(
            f"ln: '{target_typed}' and '{typed}' are the same file\n")
        return
    backup_note = ""
    # The door refuses an occupied name for a symlink; a byte copy would
    # overwrite one, and a backup has to see it first, so those two probe.
    # A backup moves a file aside, never a directory: GNU refuses the
    # directory (`ln -bT a d` is `cannot overwrite directory`) where it
    # would otherwise rename the whole tree to `d~`. A symlink standing
    # there is what -T names, and that one is backed up.
    occupied = False
    if data is not None or backs:
        found = (None if _visible_link(namespace, plan.link_abs) else await
                 path_stat(dispatch, plan.link_abs))
        if (backs and found is not None and found.type is FileType.DIRECTORY):
            errors.append(f"ln: {typed}: cannot overwrite directory\n")
            return
        occupied = found is not None or _visible_link(namespace, plan.link_abs)
    if occupied and backs:
        backup = await backup_target(partial(_readdir, dispatch), link_spec,
                                     flags.backup or "existing", flags.suffix)
        if backup is not None:
            try:
                await dispatch("rename", link_spec, dst=backup)
            except (OSError, ReadOnlyError) as exc:
                errors.append(f"ln: cannot backup '{typed}': "
                              f"{fs_strerror(exc)}\n")
                return
            backup_note = (f"'{typed}{backup.virtual[len(plan.link_abs):]}'"
                           " ~ ")
            occupied = False
    elif flags.force:
        # GNU -f is "remove the destination, then link", which is why it
        # replaces a regular file and not only a link. The door refuses
        # an occupied name (symlink(2)'s EEXIST), so the removal is what
        # makes the flag work rather than a formality; a destination
        # that is not there is what -f is for, so its miss is the
        # expected case and not an error.
        try:
            await dispatch("unlink", link_spec)
        except FileNotFoundError:
            pass
        except IsADirectoryError:
            errors.append(f"ln: {typed}: cannot overwrite directory\n")
            return
        occupied = False
    if occupied:
        errors.append(f"ln: failed to create {kind} '{typed}': File exists\n")
        return
    try:
        if link_target is not None:
            await dispatch("symlink", link_spec, target=link_target)
        else:
            await dispatch("write", link_spec, data=data)
    except FileExistsError:
        # The door owns the existence rule (it is the only layer that
        # can see both the node table and the backend); ln owns the
        # wording.
        errors.append(f"ln: failed to create {kind} '{typed}': File exists\n")
        return
    except ReadOnlyError:
        # The mount voice, as `touch` on the same read-only mount
        # answers: the refusal is about the mount, and one grant must
        # not describe itself two ways.
        errors.append(read_only_error("ln", namespace, link_spec))
        return
    except PermissionError as exc:
        # A policy deny, which ln voices as its own per-operand line.
        errors.append(f"ln: failed to create {kind} '{typed}': "
                      f"{fs_strerror(exc)}\n")
        return
    if flags.verbose:
        # A symlink reports the target it stored (relative under -r); a
        # hard link reports its source as typed.
        shown = link_target if flags.symbolic and link_target else target_typed
        arrow = "->" if flags.symbolic else "=>"
        out.append(f"{backup_note}'{typed}' {arrow} '{shown}'\n")


async def handle_ln(
    namespace: Namespace,
    dispatch: DispatchFn,
    session: Session,
    args: list[str | PathSpec],
) -> Result:
    """ln [OPTION]... TARGET... : GNU ln over the namespace and the op door.

    ``-s`` makes a namespace symbolic link. Without it mirage has no hard
    link to offer, so the "link" is a byte copy through the op door, with
    one faithful exception: a hard link of a symlink is the link itself
    (GNU's default, ``-P``), so it becomes a second symlink with the same
    target, and ``-L`` copies the target's bytes instead.

    The operand grammar is GNU's: ``-t DIR``, a trailing directory
    operand, a single operand (into the cwd) and ``-T``; a destination
    that is a link to a directory is dereferenced unless ``-n``. ``-b``,
    ``--backup=CONTROL`` and ``-S`` move an occupant aside before the
    link is made; ``-f`` removes it. ``-d``/``-F`` only change the
    wording of the refusal a directory source gets, since nobody is root
    here. Every write is a dispatch op, so session grants and admission
    policies fire at the door; this handler keeps the operand semantics
    and renders refusals in ln's own words.

    Args:
        namespace (Namespace): addressing authority holding the link table.
        dispatch (DispatchFn): op dispatcher.
        session (Session): session whose cwd resolves relative operands.
        args (list[str | PathSpec]): args after the command name.
    """
    parsed = parse_command(SPECS["ln"], [word_text(a) for a in args],
                           session.cwd, "ln")
    refusal = option_refusal(parsed)
    if refusal is not None:
        return fail("ln", refusal[0], refusal[1])
    fl = FlagView(parse_to_kwargs(parsed), spec=SPECS["ln"])
    try:
        flags = parse_flags(fl)
    except UsageError as exc:
        return fail("ln", f"{exc}\n", exc.exit_code)
    operands, target_typed = operand_words(args)
    if not operands:
        return fail("ln", f"ln: missing file operand\n{usage_hint('ln')}\n")
    # GNU's order: the operand count first, then -r, then the -T/-t clash.
    if flags.relative and not flags.symbolic:
        return fail("ln", "ln: cannot do --relative without --symbolic\n")
    raw_dir = fl.raw("target_directory")
    target_dir = raw_dir.virtual if isinstance(
        raw_dir, PathSpec) else (raw_dir if isinstance(raw_dir, str) else None)
    if target_dir is not None and flags.no_target:
        return fail(
            "ln", "ln: cannot combine --target-directory and "
            "--no-target-directory\n")
    plans, refused = await plan_links(namespace, dispatch, session.cwd,
                                      operands, target_dir, target_typed,
                                      flags)
    if refused is not None:
        return fail("ln", refused)
    errors: list[str] = []
    out: list[str] = []
    for plan in plans:
        await make_link(namespace, dispatch, session.cwd, plan, flags, errors,
                        out)
    return result("ln",
                  out="".join(out).encode() or None,
                  exit_code=1 if errors else 0,
                  stderr="".join(errors) or None)
