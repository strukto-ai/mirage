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

from dataclasses import replace

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    Operation,
    require_op,
)
from mirage.commands.builtin.utils.paths import (
    descendant_path,
    entry_kind,
    nearest_ancestor,
)
from mirage.commands.builtin.utils.slash_links import mkdir_link_refusal
from mirage.commands.config import CommandIO, CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.usage import missing_operand_error
from mirage.context import DEFAULT_UMASK, get_walk_probe, session_umask
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import error_path, fs_strerror
from mirage.errors.posix import posix_phrase
from mirage.errors.render import operand_spelling
from mirage.errors.types import FsCondition
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import LinkView
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_prefix_of
from mirage.utils.mode import DEFAULT_DIR_MODE, parse_chmod
from mirage.utils.path import CycleError, norm, parent, walk_nodes
from mirage.vfs.types import OperationFn


async def mkdir(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["mkdir"])
    parents = fl.as_bool("parents")
    verbose = fl.as_bool("verbose")
    mode_text = fl.as_str("mode")
    if not ops.is_mounted(accessor) or not paths:
        raise missing_operand_error("mkdir", None)
    mode: int | None = None
    if mode_text is not None:
        # Symbolic clauses build on what mirage renders for a new
        # directory; `-m` is applied after the create, so the session's
        # umask does not reach it, which is GNU's rule too.
        mode = parse_chmod(mode_text, DEFAULT_DIR_MODE)
        if mode is None:
            raise ValueError(f"mkdir: invalid mode '{mode_text}'")
        if ops.set_attrs is None:
            raise NotImplementedError(
                "mkdir: --mode is not supported on this backend"
            )
    elif ops.set_attrs is not None:
        # A new directory is 0777 masked by the session's umask. Only a
        # mask away from bash's default costs a setattr, because 755 is
        # what every backend already renders for a fresh directory;
        # parents made by `-p` keep that default (GNU gives them
        # `u+wx` on top of the mask, which the one backend op cannot
        # tell apart from the named directory).
        umask = session_umask()
        if umask != DEFAULT_UMASK:
            mode = 0o777 & ~umask
    mkdir_fn = require_op(ops, Operation.MKDIR)
    paths = await ops.resolve_glob(accessor, paths, opts.index)
    lines: list[str] = []
    errors: list[str] = []
    links = opts.ns.links if opts.ns is not None else None
    for path in paths:
        taken, refusal = await mkdir_link_refusal(path, links, parents=parents)
        if taken:
            if refusal is not None:
                errors.append(refusal)
            continue
        names = await created_names(path, parents, links) if verbose else []
        failed = await make_directory(mkdir_fn, accessor, path, parents, links)
        if failed is not None:
            errors.append(failed)
            continue
        if mode is not None and ops.set_attrs is not None:
            # -m applies to the named directory only; any parents made by
            # -p keep the default mode (GNU).
            await ops.set_attrs(accessor, path, mode=mode)
        lines.extend(created_lines(names))
    output = ("\n".join(lines) + "\n").encode() if lines else None
    stderr = ("\n".join(errors) + "\n").encode() if errors else None
    return output, IOResult(stderr=stderr, exit_code=1 if errors else 0)


async def created_names(
    path: PathSpec, parents: bool, links: LinkView | None = None
) -> list[str]:
    """The names a verbose mkdir reports for ``path``, top-down, as GNU
    spells them.

    One backend mkdir makes a ``-p`` chain without saying which names it
    made, so the chain is probed before the create: every name below the
    nearest existing ancestor, or none when ``path`` already exists. A
    dotted operand is walked as typed, the way ``-p`` enters it, so
    ``nope/../m`` reports ``nope`` too, each name spelled by the prefix of
    the operand that reaches it. Outside a workspace there is nothing to
    probe with, and the operand alone is reported.

    Args:
        path (PathSpec): the operand.
        parents (bool): whether ``-p`` makes the missing ancestors.
        links (LinkView | None): the namespace's symlink facts.
    """
    probe = get_walk_probe()
    if not parents or probe is None:
        return [operand_spelling(path.virtual, path)]
    named = PathSpec.from_str_path(path.virtual)
    names: list[str] = []
    if path.dotted is not None:
        follow = links.resolve if links is not None else None
        made: set[str] = set()
        for node, spelled in walk_nodes(path.dotted, path.raw_path, follow):
            if (
                node in made
                or (
                    await entry_kind(probe.stat, PathSpec.from_str_path(node))
                )[0]
            ):
                continue
            made.add(node)
            names.append(spelled)
        if (
            norm(path.virtual) in made
            or (await entry_kind(probe.stat, named))[0]
        ):
            return names
        return [*names, operand_spelling(path.virtual, path)]
    exists, _ = await entry_kind(probe.stat, named)
    if exists:
        return []
    top, _ = await nearest_ancestor(probe.stat, named)
    node = norm(path.virtual)
    while node not in (top, "/"):
        names.append(operand_spelling(node, path))
        node = parent(node)
    return names[::-1]


def created_lines(names: list[str]) -> list[str]:
    """GNU's ``mkdir -v`` lines.

    Args:
        names (list[str]): the made names as spelled, from
            :func:`created_names`.
    """
    return [f"mkdir: created directory '{name}'" for name in names]


async def make_directory(
    mkdir_fn: OperationFn,
    accessor: Accessor,
    path: PathSpec,
    parents: bool,
    links: LinkView | None = None,
) -> str | None:
    """Make one mkdir operand, or the line GNU reports when it cannot.

    One unusable operand is not an aborted command: GNU reports it and
    still makes the remaining directories. The error names the path to
    quote: usually the operand, but ``mkdir -p`` blames the component of
    the chain it tripped on. Every mkdir makes its operands here, a keyed
    store's override included, so they report alike.

    Args:
        mkdir_fn (OperationFn): the guarded backend mkdir.
        accessor (Accessor): backend handle.
        path (PathSpec): the operand.
        parents (bool): whether ``-p`` makes the missing ancestors.
        links (LinkView | None): the namespace's symlink facts.
    """
    # -p enters the names in front of the operand one at a time, so a
    # dot among them, or a link loop the walk refused the operand for,
    # is met at that name and GNU quotes it rather than the operand.
    if parents and (path.dotted is not None or path.walk_error == "ELOOP"):
        failed = await _make_walked(
            mkdir_fn, accessor, path, path.dotted or path.virtual, links
        )
        if failed is not None:
            return failed
        # The walk has entered every name the spelling passes through, so
        # the operand is made by its resolved path alone: walking it again
        # would ask a store that shows no empty directory (hf) for one the
        # walk just made.
        path = replace(path, dotted=None)
    try:
        await mkdir_fn(accessor, path, parents=parents)
    except FS_ERRORS as exc:
        named = operand_spelling(error_path(exc), path)
        return f"mkdir: cannot create directory '{named}': {fs_strerror(exc)}"
    return None


async def _make_walked(
    mkdir_fn: OperationFn,
    accessor: Accessor,
    path: PathSpec,
    dotted: str,
    links: LinkView | None,
) -> str | None:
    """Make every name an operand's walk enters, GNU ``mkdir -p`` style.

    The backend's ``parents`` makes the ancestors of the simplified path,
    which skips a name the walk passes through on its way to a ``..``:
    GNU creates ``nope`` for ``mkdir -p nope/../m``. The operand itself
    is left to the caller; a name in the way is quoted as the operand
    spells it. None when every name is made.

    Args:
        mkdir_fn (OperationFn): the guarded backend mkdir.
        accessor (Accessor): backend handle.
        path (PathSpec): the operand.
        dotted (str): its dotted spelling.
        links (LinkView | None): the namespace's symlink facts.
    """
    root = mount_prefix_of(path.virtual, path.vfs_path).rstrip("/")
    follow = links.resolve if links is not None else None
    for node, spelled in walk_nodes(dotted, path.raw_path, follow):
        try:
            why = await _enter_node(
                mkdir_fn, accessor, path, node, root, links
            )
        except FileExistsError:
            why = posix_phrase(FsCondition.ENOTDIR)
        except FS_ERRORS as exc:
            why = fs_strerror(exc)
        if why is not None:
            return f"mkdir: cannot create directory '{spelled}': {why}"
    return None


async def _enter_node(
    mkdir_fn: OperationFn,
    accessor: Accessor,
    path: PathSpec,
    node: str,
    root: str,
    links: LinkView | None,
) -> str | None:
    """Make one name of a walk a directory, or say why it is not one.

    Judged the way GNU's walk into the name is, before anything is made:
    a directory, or a link to one, is passed through; a plain file, or a
    link to one, is ENOTDIR; a dangling link is EEXIST, and a looping one
    ELOOP. Only a missing
    name is made, where its links lead, so no store is asked to make a
    directory over a file or under a link it cannot see. Outside a
    workspace command there is no stat to judge with, and the store's
    own mkdir answers.

    Args:
        mkdir_fn (OperationFn): the guarded backend mkdir.
        accessor (Accessor): backend handle.
        path (PathSpec): the operand the walk belongs to.
        node (str): the name entered, absolute and link-spelled.
        root (str): the operand's mount root, without a trailing slash.
        links (LinkView | None): the namespace's symlink facts.
    """
    if links is not None and links.stat_at(node) is not None:
        try:
            links.resolve(node)
        except CycleError:
            return posix_phrase(FsCondition.ELOOP)
        target = await links.target_stat(node)
        if target is None:
            return posix_phrase(FsCondition.EEXIST)
        if target.type != FileType.DIRECTORY:
            return posix_phrase(FsCondition.ENOTDIR)
        return None
    probe = get_walk_probe()
    if probe is not None:
        exists, is_dir = await entry_kind(
            probe.stat, PathSpec.from_str_path(node)
        )
        if exists:
            return None if is_dir else posix_phrase(FsCondition.ENOTDIR)
    real = links.resolve(node) if links is not None else node
    if real.startswith(root + "/"):
        await mkdir_fn(accessor, descendant_path(path, real), parents=True)
    return None


BUILDER = GenericCommand("mkdir", mkdir, write=True)
