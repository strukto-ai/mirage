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

from dataclasses import dataclass
from typing import Callable

from mirage.commands.builtin.utils.backup import (DEFAULT_BACKUP_SUFFIX,
                                                  backup_control,
                                                  backup_target)
from mirage.commands.builtin.utils.copy import (backend_key_default,
                                                copy_targets, is_directory,
                                                path_exists)
from mirage.commands.errors import UsageError
from mirage.commands.spec.types import FlagValue, FlagView
from mirage.commands.spec.usage import extra_operand_error
from mirage.io.types import ByteSource, IOResult
from mirage.types import (CopyStrategy, FileType, NativeCopy, NativeMove,
                          PathSpec, PrimitiveCopy, PrimitiveMove, ReaddirFn,
                          StatFn)
from mirage.utils.dates import iso_timestamp
from mirage.utils.errors import FS_ERRORS, fs_strerror
from mirage.utils.key_prefix import mounted_path, rekey
from mirage.utils.path import norm, parent

UPDATE_MODES = ("all", "none", "none-fail", "older")


@dataclass(frozen=True, slots=True)
class CpFlags:
    recursive: bool = False
    no_clobber: bool = False
    verbose: bool = False
    update: str | None = None
    backup: str | None = None
    suffix: str = DEFAULT_BACKUP_SUFFIX
    # Single-mount dispatch delivers the -t value as PathSpec; the
    # cross-mount relay's string view is wrapped against the first source.
    target_dir: PathSpec | str | None = None
    no_target_dir: bool = False


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
    """
    cmd_name: str
    no_clobber: bool = False
    update: str | None = None
    backup: str | None = None
    suffix: str = DEFAULT_BACKUP_SUFFIX


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
    if isinstance(value, str) and value in UPDATE_MODES:
        return value
    raise UsageError(
        f"{cmd_name}: invalid argument '{value}' for '--update'\n"
        "Valid arguments are:\n"
        "  - 'all'\n"
        "  - 'none'\n"
        "  - 'none-fail'\n"
        "  - 'older'\n"
        f"Try '{cmd_name} --help' for more information.", 1)


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


def target_flags(cmd_name: str,
                 fl: FlagView) -> tuple[PathSpec | str | None, bool]:
    """Resolve ``-t``/``--target-directory`` and ``-T``, rejecting both.

    Args:
        cmd_name (str): Command name for the conflict error.
        fl (FlagView): Parsed flag view.
    """
    target_dir: FlagValue | None = fl.raw("target_directory")
    if not isinstance(target_dir, (PathSpec, str)):
        target_dir = None
    no_target = fl.as_bool("no_target_directory")
    if target_dir is not None and no_target:
        raise UsageError(
            f"{cmd_name}: cannot combine --target-directory (-t) and "
            "--no-target-directory (-T)", 1)
    return target_dir, no_target


def parse_cp_flags(fl: FlagView) -> CpFlags:
    """Parse the cp flag bag once into a frozen struct.

    ``-f``/``-i`` are accepted no-ops (non-interactive control plane:
    overwrite always proceeds unless ``-n``/``--update`` say otherwise),
    and ``--strip-trailing-slashes`` is a no-op because PathSpec already
    normalizes trailing slashes.

    Args:
        fl (FlagView): Flag view constructed with the cp spec.
    """
    update = update_mode("cp", fl)
    # An empty --suffix reads as absent: GNU 9.7 `cp --backup --suffix= f g`
    # writes the default `g~`, not a backup whose name is the original's.
    suffix = fl.as_str("suffix") or None
    control = backup_control("cp", backup_raw(fl), suffix)
    no_clobber = fl.as_bool("no_clobber")
    if control is not None and control != "none" and (no_clobber or update
                                                      == "none-fail"):
        raise UsageError(
            "cp: --backup is mutually exclusive with -n or "
            "--update=none-fail\nTry 'cp --help' for more information.", 1)
    target_dir, no_target = target_flags("cp", fl)
    return CpFlags(
        recursive=fl.as_bool("r") or fl.as_bool("recursive")
        or fl.as_bool("archive"),
        no_clobber=no_clobber,
        verbose=fl.as_bool("verbose"),
        update=update,
        backup=control,
        suffix=suffix if suffix is not None else DEFAULT_BACKUP_SUFFIX,
        target_dir=target_dir,
        no_target_dir=no_target,
    )


def split_operands(
        cmd_name: str, paths: list[PathSpec],
        target_dir: PathSpec | str | None,
        no_target_dir: bool) -> tuple[list[PathSpec], PathSpec | None]:
    """Split operands into sources and destination, GNU arity errors.

    With ``-t`` every operand is a source and the returned destination is
    None (the caller wraps the target-directory string itself). ``-T``
    requires exactly two operands.

    Args:
        cmd_name (str): Command name for the usage errors.
        paths (list[PathSpec]): Positional path operands.
        target_dir (str | None): ``--target-directory`` value.
        no_target_dir (bool): ``-T``.
    """
    hint = f"Try '{cmd_name} --help' for more information."
    if not paths:
        raise UsageError(f"{cmd_name}: missing file operand\n{hint}", 1)
    if target_dir is not None:
        return list(paths), None
    if len(paths) == 1:
        raise UsageError(
            f"{cmd_name}: missing destination file operand after "
            f"'{paths[0].raw_path}'\n{hint}", 1)
    if no_target_dir and len(paths) > 2:
        raise extra_operand_error(cmd_name, paths[2].raw_path)
    return list(paths[:-1]), paths[-1]


def wrap_target_dir(ref: PathSpec, virtual: str) -> PathSpec:
    """Build the ``-t`` directory PathSpec from a same-mount reference.

    Args:
        ref (PathSpec): Any operand on the destination's mount.
        virtual (str): Resolved virtual path of the target directory.
    """
    return PathSpec.from_str_path(
        virtual, rekey(ref.virtual, ref.resource_path, virtual))


async def target_dir_error(cmd_name: str, stat: StatFn,
                           target: PathSpec) -> str | None:
    """GNU error line when a ``-t`` operand is missing or not a directory.

    Args:
        cmd_name (str): Command name for the error prefix.
        stat (StatFn): Stats a path; raises when missing.
        target (PathSpec): The ``--target-directory`` operand.
    """
    try:
        info = await stat(target)
    except (FileNotFoundError, ValueError):
        return (f"{cmd_name}: target directory '{target.virtual}': "
                "No such file or directory")
    if info.type != FileType.DIRECTORY:
        return (f"{cmd_name}: target directory '{target.virtual}': "
                "Not a directory")
    return None


async def dest_parent_error(cmd_name: str, stat: StatFn, target: PathSpec,
                            src_is_dir: bool) -> str | None:
    """GNU error line when a destination's parent chain is unusable.

    ``cp`` is not ``mkdir -p``: it never creates the destination's parent,
    so a missing or non-directory component is a per-operand failure. GNU
    surfaces the two cases at different phases, and the wording follows:
    a component that is a plain file fails the destination stat
    (``cannot stat 'DST': Not a directory``, at any depth), while a merely
    absent parent fails the create (``cannot create regular file`` for a
    file source, ``cannot create directory`` for a recursive one).

    Only walks upward until it finds something that exists, so the common
    case (the parent is there) costs a single stat.

    Args:
        cmd_name (str): Command name for the error prefix.
        stat (StatFn): Stats a path; raises when missing.
        target (PathSpec): The destination operand.
        src_is_dir (bool): Whether the source is a directory, which picks
            between GNU's "regular file" and "directory" create wording.

    Returns:
        str | None: The GNU stderr line, or None when the parent chain is
        a usable directory path.
    """
    noun = "directory" if src_is_dir else "regular file"
    enoent_line = (f"{cmd_name}: cannot create {noun} '{target.virtual}': "
                   "No such file or directory")
    enotdir_line = (f"{cmd_name}: cannot stat '{target.virtual}': "
                    "Not a directory")
    immediate = parent(norm(target.virtual))
    node = immediate
    while node != "/":
        exists, is_dir = await entry_kind(stat, descendant_path(target, node))
        if exists:
            if not is_dir:
                return enotdir_line
            # An existing directory higher up means the intermediate
            # components are simply absent.
            return None if node == immediate else enoent_line
        node = parent(node)
    # The mount root always exists as a directory and is never stat-ed:
    # a backend that cannot stat "/" must not fail every copy into it.
    return None if immediate == "/" else enoent_line


async def entry_kind(stat: StatFn, path: PathSpec) -> tuple[bool, bool]:
    """Probe a path once for ``(exists, is_dir)``.

    ENOTDIR counts as "does not exist": a path whose parent chain runs
    through a plain file cannot exist, and the callers (cp/mv) turn that
    into GNU's own wording via :func:`dest_parent_error`. Only this probe
    absorbs it, so read-family commands keep reporting "Not a directory"
    verbatim. ``NotADirectoryError`` is not a ``FileNotFoundError``
    subclass, so it has to be named explicitly.

    Args:
        stat (StatFn): Stats a path; raises when missing.
        path (PathSpec): The probed path.
    """
    try:
        info = await stat(path)
    except (FileNotFoundError, NotADirectoryError, ValueError):
        return False, False
    return True, info.type == FileType.DIRECTORY


async def source_kind(stat: StatFn,
                      path: PathSpec) -> tuple[bool, bool, str | None]:
    """Probe a source operand for ``(exists, is_dir, strerror)``.

    A source keeps the errno GNU reports: ``cp /plain/child /dst`` is
    ``cannot stat 'X': Not a directory``, not "No such file or directory".
    The backends cannot supply that distinction, because ``stat`` answers
    ENOENT for a path under a plain file just as it does for a genuinely
    absent one (only ``readdir`` splits the two). So the chain is walked
    the way :func:`dest_parent_error` walks a destination's: the first
    component that does exist decides, and a plain file there means
    ENOTDIR. Walking happens only on the failure path.

    Args:
        stat (StatFn): Stats a path; raises when missing.
        path (PathSpec): The probed source operand.

    Returns:
        tuple[bool, bool, str | None]: Whether it exists, whether it is a
        directory, and the GNU strerror when it does not exist.
    """
    exists, is_dir = await entry_kind(stat, path)
    if exists:
        return True, is_dir, None
    node = parent(norm(path.virtual))
    while node != "/":
        node_exists, node_is_dir = await entry_kind(
            stat, descendant_path(path, node))
        if node_exists:
            if not node_is_dir:
                return False, False, "Not a directory"
            break
        node = parent(node)
    return False, False, "No such file or directory"


def overwrite_type_error(cmd_name: str, src: PathSpec, src_is_dir: bool,
                         target: PathSpec, target_exists: bool,
                         target_is_dir: bool) -> str | None:
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
        return (f"{cmd_name}: cannot overwrite non-directory "
                f"'{target.virtual}' with directory '{src.virtual}'")
    if not src_is_dir and target_is_dir:
        return (f"{cmd_name}: cannot overwrite directory "
                f"'{target.virtual}' with non-directory '{src.virtual}'")
    return None


async def overwrite_gate(policy: TransferPolicy, stat: StatFn, src: PathSpec,
                         target: PathSpec, errors: list[str]) -> bool:
    """Decide whether an existing target may be replaced.

    ``-n`` and ``--update=none`` skip silently; ``--update=none-fail``
    records GNU's ``not replacing`` error; ``--update=older`` replaces
    only when the source is strictly newer. A source or target with no
    usable mtime always replaces (freshness cannot be proven).

    Args:
        policy (TransferPolicy): Overwrite policy for this command.
        stat (StatFn): Stats a path; raises when missing.
        src (PathSpec): Source entry.
        target (PathSpec): Destination entry.
        errors (list[str]): Collected stderr lines, appended in place.

    Returns:
        bool: True when the transfer should proceed.
    """
    if not policy.no_clobber and not update_gates(policy.update):
        # No gating flag: skip the target probe entirely so API-backed
        # mounts pay no extra stat per entry.
        return True
    try:
        target_info = await stat(target)
    except (FileNotFoundError, ValueError):
        return True
    if policy.no_clobber or policy.update == "none":
        return False
    if policy.update == "none-fail":
        errors.append(f"{policy.cmd_name}: not replacing '{target.virtual}'")
        return False
    if policy.update == "older":
        try:
            src_info = await stat(src)
        except (FileNotFoundError, ValueError):
            return True
        src_ts = iso_timestamp(src_info.modified)
        target_ts = iso_timestamp(target_info.modified)
        if src_ts is not None and target_ts is not None \
                and src_ts <= target_ts:
            return False
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
        copied_all, _ = await copy_entries(cmd_name, strategy, stat, target,
                                           backup, entries, errors)
        return copied_all
    if not target_is_dir:
        await strategy.copy(target, backup)
        return True
    if strategy.dir_copy is None:
        errors.append(f"{cmd_name}: cannot backup '{target.virtual}': "
                      "Operation not supported")
        return False
    await strategy.dir_copy(target, backup)
    return True


async def make_backup(
    policy: TransferPolicy,
    strategy: CopyStrategy | PrimitiveMove | NativeMove,
    stat: StatFn,
    readdir: ReaddirFn | None,
    target: PathSpec,
    writes: dict[str, ByteSource],
    errors: list[str],
) -> tuple[PathSpec | None, bool]:
    """Back up an existing target before it is overwritten.

    Args:
        policy (TransferPolicy): Overwrite policy carrying the control.
        strategy: Transfer strategy owning the needed primitives.
        stat (StatFn): Stats a path; raises when missing.
        readdir (ReaddirFn | None): Directory lister for the version scan.
        target (PathSpec): The destination being replaced.
        writes (dict[str, ByteSource]): Recorded writes, updated in place.
        errors (list[str]): Collected stderr lines, appended in place.

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
        backup = await backup_target(readdir, target, policy.backup,
                                     policy.suffix)
    except FS_ERRORS as exc:
        errors.append(f"{policy.cmd_name}: cannot backup "
                      f"'{target.virtual}': {fs_strerror(exc)}")
        return None, False
    if backup is None:
        return None, True
    try:
        made = await _duplicate_for_backup(strategy, stat, target, backup,
                                           errors, policy.cmd_name)
    except FS_ERRORS as exc:
        errors.append(f"{policy.cmd_name}: cannot backup "
                      f"'{target.virtual}': {fs_strerror(exc)}")
        return None, False
    if not made:
        return None, False
    writes[backup.mount_path] = b""
    return backup, True


def transfer_line(src: PathSpec, target: PathSpec,
                  backup: PathSpec | None) -> str:
    """The cp verbose line, with GNU's backup annotation when one exists.

    Args:
        src (PathSpec): Source entry.
        target (PathSpec): Destination entry.
        backup (PathSpec | None): Backup made for this overwrite.
    """
    line = f"'{src.virtual}' -> '{target.virtual}'"
    if backup is not None:
        line += f" (backup: '{backup.virtual}')"
    return line


def descendant_path(root: PathSpec, virtual: str) -> PathSpec:
    return PathSpec.from_str_path(
        virtual, rekey(root.virtual, root.resource_path, virtual))


async def _tree_lines(strategy: NativeCopy, src: PathSpec, target: PathSpec,
                      src_base: str, dst_base: str) -> list[str]:
    """GNU ``-v`` lines for a natively copied tree, parents first.

    GNU ``cp -rv`` reports directories as well as files, including the
    source root itself. Deliberate divergence: GNU's sibling order follows
    readdir, which no backend can reproduce, so entries are sorted
    lexicographically instead. That keeps every parent ahead of its
    children (GNU's only load-bearing ordering guarantee) and is stable
    across backends.

    Args:
        strategy (NativeCopy): Native copy capability.
        src (PathSpec): Source root.
        target (PathSpec): Destination root.
        src_base (str): Source root's mount path, no trailing slash.
        dst_base (str): Destination root's mount path, no trailing slash.
    """
    dirs = await strategy.find(src, type="d")
    files = await strategy.find(src, type="f")
    lines: list[str] = []
    for entry_mount in sorted({src_base, *dirs, *files}):
        entry = mounted_path(src, entry_mount)
        entry_dst = mounted_path(target,
                                 dst_base + entry_mount[len(src_base):])
        lines.append(f"'{entry.virtual}' -> '{entry_dst.virtual}'")
    return lines


async def _mirror_dirs(
    strategy: NativeCopy,
    stat: StatFn,
    src: PathSpec,
    target: PathSpec,
    src_base: str,
    dst_base: str,
    writes: dict[str, ByteSource],
    errors: list[str],
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
        writes (dict[str, ByteSource]): Recorded writes, updated in place.
        errors (list[str]): Collected stderr lines, appended in place.
        lines (list[str] | None): Verbose sink for the directory entries
            GNU also reports; None keeps them silent.

    Returns:
        bool: False when a directory could not be created, so the caller
        skips this source's file pass.
    """
    if strategy.mkdir is None:
        return True
    mounts = [src_base, *await strategy.find(src, type="d")]
    for entry_mount in sorted(set(mounts), key=len):
        entry_dst = mounted_path(target,
                                 dst_base + entry_mount[len(src_base):])
        if lines is not None:
            entry = mounted_path(src, entry_mount)
            lines.append(f"'{entry.virtual}' -> '{entry_dst.virtual}'")
        if await is_directory(stat, entry_dst):
            continue
        try:
            await strategy.mkdir(entry_dst)
        except FS_ERRORS as exc:
            errors.append(f"cp: cannot create directory "
                          f"'{entry_dst.virtual}': {fs_strerror(exc)}")
            return False
        writes[entry_dst.mount_path] = b""
    return True


async def walk(
    readdir: ReaddirFn,
    stat: StatFn,
    root: PathSpec,
) -> list[tuple[PathSpec, bool]]:
    """List a tree as ``(path, is_dir)`` pairs, parents before children.

    The dir/file type is captured here, while the tree is intact, so a caller
    that deletes as it goes (mv) never re-stats a path whose virtual parent dir
    has since vanished (e.g. on S3). Used only by the primitive (no native
    ``copy``) path; backends that inject ``copy``/``find`` never reach it.

    Args:
        readdir (Callable): Lists a directory's full child paths.
        stat (Callable): Stats a path; ``.type`` distinguishes directories.
        root (PathSpec): Root of the tree.
    """
    info = await stat(root)
    if info.type != FileType.DIRECTORY:
        return [(root, False)]
    entries = [(root, True)]
    queue = [root]
    while queue:
        directory = queue.pop(0)
        for child_virtual in await readdir(directory):
            child = descendant_path(root, child_virtual)
            child_info = await stat(child)
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
    writes: dict[str, ByteSource] | None = None,
    reads: dict[str, ByteSource] | None = None,
    lines: list[str] | None = None,
) -> tuple[bool, bool]:
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
        writes (dict[str, ByteSource] | None): Per-entry write sink keyed
            by mount path; None skips recording.
        reads (dict[str, ByteSource] | None): Per-entry read sink keyed by
            virtual path; None skips recording.
        lines (list[str] | None): Verbose ``'src' -> 'dst'`` sink; None
            keeps the copy silent.

    Returns:
        tuple[bool, bool]: ``(copied_all, wrote_any)`` — whether every
        entry landed, and whether the destination changed at all.
    """
    copied_all = True
    wrote_any = False
    for entry, is_dir in entries:
        entry_dst = descendant_path(
            target,
            target.virtual.rstrip("/") +
            entry.virtual[len(src.virtual.rstrip("/")):],
        )
        if is_dir:
            try:
                if not await is_directory(stat, entry_dst):
                    await strategy.mkdir(entry_dst)
                    wrote_any = True
                    if writes is not None:
                        writes[entry_dst.mount_path] = b""
                    if lines is not None:
                        lines.append(f"'{entry.virtual}' -> "
                                     f"'{entry_dst.virtual}'")
            except FS_ERRORS as exc:
                # GNU stops this source: the children of a directory it
                # could not create cannot land.
                errors.append(f"{cmd_name}: cannot create directory "
                              f"'{entry_dst.virtual}': {fs_strerror(exc)}")
                return False, wrote_any
            continue
        backup: PathSpec | None = None
        if policy is not None:
            if not await overwrite_gate(policy, stat, entry, entry_dst,
                                        errors):
                continue
            backup, ok = await make_backup(
                policy, strategy, stat, strategy.readdir, entry_dst,
                writes if writes is not None else {}, errors)
            if not ok:
                copied_all = False
                continue
        try:
            data = await strategy.read_bytes(entry)
        except FS_ERRORS as exc:
            errors.append(f"{cmd_name}: cannot open '{entry.virtual}' "
                          f"for reading: {fs_strerror(exc)}")
            copied_all = False
            continue
        try:
            # write takes bytes, not a stream: file materialized here.
            await strategy.write(entry_dst, data=data)
        except FS_ERRORS as exc:
            errors.append(f"{cmd_name}: cannot create regular file "
                          f"'{entry_dst.virtual}': {fs_strerror(exc)}")
            copied_all = False
            continue
        wrote_any = True
        if reads is not None:
            reads[entry.virtual] = data
        if writes is not None:
            writes[entry_dst.mount_path] = b""
        if lines is not None:
            lines.append(transfer_line(entry, entry_dst, backup))
    return copied_all, wrote_any


async def cp(
    paths: list[PathSpec],
    *,
    stat: StatFn,
    strategy: CopyStrategy,
    flags: CpFlags,
    backend_key: Callable[[PathSpec], str] | None = None,
    readdir: ReaddirFn | None = None,
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

    Returns:
        tuple[ByteSource | None, IOResult]: Verbose output and recorded
        writes, with per-source coreutils errors on stderr and exit code 1
        when any source failed.
    """
    key_of = backend_key if backend_key is not None else backend_key_default
    sources, dst = split_operands("cp", paths, flags.target_dir,
                                  flags.no_target_dir)
    if dst is None:
        dst = (flags.target_dir if isinstance(flags.target_dir, PathSpec) else
               wrap_target_dir(sources[0], str(flags.target_dir)))
        err = await target_dir_error("cp", stat, dst)
        if err is not None:
            return None, IOResult(stderr=f"{err}\n".encode(), exit_code=1)
        dst_is_dir = True
        dst_exists = True
    elif flags.no_target_dir:
        dst_is_dir = False
        dst_exists = True
    else:
        dst_exists, dst_is_dir = await entry_kind(stat, dst)
    if readdir is None and isinstance(strategy, PrimitiveCopy):
        readdir = strategy.readdir
    policy = TransferPolicy(cmd_name="cp",
                            no_clobber=flags.no_clobber,
                            update=flags.update,
                            backup=flags.backup,
                            suffix=flags.suffix)
    per_entry_native = update_gates(flags.update) \
        or backup_displaces(flags.backup)
    writes: dict[str, ByteSource] = {}
    reads: dict[str, ByteSource] = {}
    lines: list[str] = []
    errors: list[str] = []
    for src, target in copy_targets(sources, dst, dst_is_dir, dst_exists):
        src_exists, src_is_dir, src_err = await source_kind(stat, src)
        if not src_exists:
            errors.append(f"cp: cannot stat '{src.virtual}': {src_err}")
            continue
        if key_of(src) == key_of(target):
            errors.append(f"cp: '{src.virtual}' and '{target.virtual}' "
                          "are the same file")
            continue
        if flags.recursive and key_of(target).startswith(key_of(src) + "/"):
            errors.append(f"cp: cannot copy a directory, '{src.virtual}', "
                          f"into itself, '{target.virtual}'")
            continue
        if not flags.recursive and src_is_dir:
            errors.append("cp: -r not specified; omitting directory "
                          f"'{src.virtual}'")
            continue
        target_exists, target_is_dir = await entry_kind(stat, target)
        if not target_exists:
            parent_err = await dest_parent_error("cp", stat, target,
                                                 src_is_dir)
            if parent_err is not None:
                errors.append(parent_err)
                continue
        mismatch = overwrite_type_error("cp", src, src_is_dir, target,
                                        target_exists, target_is_dir)
        if mismatch is not None:
            errors.append(mismatch)
            continue
        if flags.recursive and src_is_dir:
            src_base = src.mount_path.rstrip("/")
            dst_base = target.mount_path.rstrip("/")
            if isinstance(strategy, PrimitiveCopy):
                entries = await walk(strategy.readdir, stat, src)
                await copy_entries("cp",
                                   strategy,
                                   stat,
                                   src,
                                   target,
                                   entries,
                                   errors,
                                   policy=policy,
                                   writes=writes,
                                   reads=reads,
                                   lines=lines if flags.verbose else None)
                continue
            if strategy.dir_copy is not None and not per_entry_native:
                if flags.no_clobber and target_exists:
                    continue
                await strategy.dir_copy(src, target)
                for entry_mount in await strategy.find(src, type="f"):
                    entry_dst = mounted_path(
                        target, dst_base + entry_mount[len(src_base):])
                    writes[entry_dst.mount_path] = b""
                if flags.verbose:
                    lines.extend(await _tree_lines(strategy, src, target,
                                                   src_base, dst_base))
                continue
            # Per-entry policy forfeits dir_copy, so the tree's directories
            # are recreated here: a files-only pass would drop every
            # directory that holds no files (GNU keeps them).
            if not await _mirror_dirs(strategy, stat, src, target, src_base,
                                      dst_base, writes, errors,
                                      lines if flags.verbose else None):
                continue
            for entry_mount in await strategy.find(src, type="f"):
                entry = mounted_path(src, entry_mount)
                entry_dst = mounted_path(
                    target, dst_base + entry_mount[len(src_base):])
                if not await overwrite_gate(policy, stat, entry, entry_dst,
                                            errors):
                    continue
                backup, ok = await make_backup(policy, strategy, stat, readdir,
                                               entry_dst, writes, errors)
                if not ok:
                    continue
                await strategy.copy(entry, entry_dst)
                writes[entry_dst.mount_path] = b""
                if flags.verbose:
                    lines.append(transfer_line(entry, entry_dst, backup))
            continue
        if not await overwrite_gate(policy, stat, src, target, errors):
            continue
        backup, ok = await make_backup(policy, strategy, stat, readdir, target,
                                       writes, errors)
        if not ok:
            continue
        if isinstance(strategy, PrimitiveCopy):
            try:
                # write takes bytes, not a stream: the file is
                # materialized here.
                data = await strategy.read_bytes(src)
            except FS_ERRORS as exc:
                errors.append(f"cp: cannot open '{src.virtual}' "
                              f"for reading: {fs_strerror(exc)}")
                continue
            try:
                await strategy.write(target, data=data)
            except FS_ERRORS as exc:
                errors.append(f"cp: cannot create regular file "
                              f"'{target.virtual}': {fs_strerror(exc)}")
                continue
            reads[src.virtual] = data
        else:
            await strategy.copy(src, target)
        writes[target.mount_path] = b""
        if flags.verbose:
            lines.append(transfer_line(src, target, backup))
    output = "\n".join(lines) + "\n" if lines else None
    stderr = ("\n".join(errors) + "\n").encode() if errors else None
    # Sources that streamed through the client are recorded as reads so
    # apply_io can populate the file cache: a cp is also a full read.
    return output.encode() if output else None, IOResult(
        writes=writes,
        reads=dict(reads),
        cache=list(reads),
        stderr=stderr,
        exit_code=1 if errors else 0,
    )
