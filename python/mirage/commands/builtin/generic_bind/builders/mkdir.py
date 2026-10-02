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
import os
from dataclasses import replace

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind.adapter import (
    Builder,
    CommandIO,
    Operation,
    bound_op,
)
from mirage.commands.builtin.utils.paths import descendant_path, entry_kind
from mirage.commands.builtin.utils.slash_links import mkdir_link_refusal
from mirage.commands.config import CommandOpts
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.context import DEFAULT_UMASK, get_walk_probe, session_umask
from mirage.io.types import ByteSource, IOResult
from mirage.ops.types import LinkView
from mirage.types import FileType, PathSpec, StatFn
from mirage.utils.errors import (
    ELOOP_STRERROR,
    FS_ERRORS,
    error_path,
    fs_strerror,
    operand_spelling,
)
from mirage.utils.key_prefix import mount_prefix_of
from mirage.utils.mode import DEFAULT_DIR_MODE, parse_chmod
from mirage.utils.path import CycleError, walk_nodes
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
        raise ValueError("mkdir: missing operand")
    mode = mkdir_mode(ops, opts, mode_text)
    mkdir_fn = ops.require(Operation.MKDIR)
    stat = bound_op(ops.stat, accessor, opts.index)
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
        made, failed = await make_directory(
            mkdir_fn, accessor, path, parents, links, stat
        )
        if failed is not None:
            errors.append(failed)
        if not made:
            continue
        if mode is not None:
            # -m applies to the named directory only; any parents made by
            # -p keep the default mode (GNU).
            await apply_mode(ops, accessor, path, mode, opts)
        if verbose:
            lines.append(f"mkdir: created directory '{path.virtual}'")
    output = ("\n".join(lines) + "\n").encode() if lines else None
    stderr = ("\n".join(errors) + "\n").encode() if errors else None
    return output, IOResult(stderr=stderr, exit_code=1 if errors else 0)


def mkdir_mode(
    ops: CommandIO, opts: CommandOpts, mode_text: str | None
) -> int | None:
    """The mode a mkdir gives each directory it names.

    The mode goes through the op door, the way chmod's does (see
    ``apply_mode``). Shared by the generic builder and the keyed-store
    override, so a mode means the same on every backend.

    Args:
        ops (CommandIO): the backend's IO adapter.
        opts (CommandOpts): the invocation, whose dispatch is the door.
        mode_text (str | None): the ``-m`` operand, None without one.

    Raises:
        ValueError: the mode is one GNU cannot read.
        NotImplementedError: this mount has no way to set a mode.
    """
    can_set_mode = ops.set_attrs is not None or opts.dispatch is not None
    if mode_text is not None:
        # Symbolic clauses build on what mirage renders for a new
        # directory; `-m` is applied after the create, so the session's
        # umask does not reach it, which is GNU's rule too.
        mode = parse_chmod(mode_text, DEFAULT_DIR_MODE)
        if mode is None:
            raise ValueError(f"mkdir: invalid mode '{mode_text}'")
        if not can_set_mode:
            raise NotImplementedError(
                "mkdir: --mode is not supported on this backend"
            )
        return mode
    if not can_set_mode:
        return None
    # A new directory is 0777 masked by the session's umask. Only a mask
    # away from bash's default costs a setattr, because 755 is what every
    # backend already renders for a fresh directory; parents made by
    # `-p` keep that default (GNU gives them `u+wx` on top of the mask,
    # which the one backend op cannot tell apart from the named
    # directory).
    umask = session_umask()
    return 0o777 & ~umask if umask != DEFAULT_UMASK else None


async def apply_mode(
    ops: CommandIO,
    accessor: Accessor,
    path: PathSpec,
    mode: int,
    opts: CommandOpts,
) -> None:
    """Set a made directory's mode through the op door, else the slot.

    The door applies what the backend holds natively and keeps the rest
    in the attr overlay, where a bare ``set_attrs`` slot drops what its
    store cannot hold. The slot answers only outside a workspace, with
    no door.

    Args:
        ops (CommandIO): the backend's IO adapter.
        accessor (Accessor): backend handle.
        path (PathSpec): the directory made.
        mode (int): the permission bits.
        opts (CommandOpts): the invocation, whose dispatch is the door.
    """
    if opts.dispatch is not None:
        await opts.dispatch("setattr", path, mode=mode)
    elif ops.set_attrs is not None:
        await ops.set_attrs(accessor, path, mode=mode)


async def make_directory(
    mkdir_fn: OperationFn,
    accessor: Accessor,
    path: PathSpec,
    parents: bool,
    links: LinkView | None = None,
    stat: StatFn | None = None,
) -> tuple[bool, str | None]:
    """Make one mkdir operand: whether it was made, and the line GNU
    reports when it cannot be.

    One unusable operand is not an aborted command: GNU reports it and
    still makes the remaining directories. The error names the path to
    quote: usually the operand, but ``mkdir -p`` blames the component of
    the chain it tripped on. ``mkdir -p`` leaves a directory the
    backend already holds alone, so it gets no new time, no ``-m`` mode
    and no ``-v`` line (GNU); the backend's own stat says so, since the
    workspace also shows a directory a nested mount implies. Every mkdir
    makes its operands here, a keyed store's override included, so they
    report alike.

    Args:
        mkdir_fn (OperationFn): the guarded backend mkdir.
        accessor (Accessor): backend handle.
        path (PathSpec): the operand.
        parents (bool): whether ``-p`` makes the missing ancestors.
        links (LinkView | None): the namespace's symlink facts.
        stat (StatFn | None): the backend's stat, None to always make.
    """
    # -p enters the names in front of the operand one at a time, so a
    # dot among them, or a link loop the walk refused the operand for,
    # is met at that name and GNU quotes it rather than the operand.
    if parents and (path.dotted is not None or path.walk_error == "ELOOP"):
        failed = await _make_walked(
            mkdir_fn, accessor, path, path.dotted or path.virtual, links
        )
        if failed is not None:
            return False, failed
        # The walk has entered every name the spelling passes through, so
        # the operand is made by its resolved path alone: walking it again
        # would ask a store that shows no empty directory (hf) for one the
        # walk just made.
        path = replace(path, dotted=None)
    if parents and stat is not None and path.walk_error is None:
        exists, is_dir = await entry_kind(stat, path)
        if exists and is_dir:
            return False, None
    try:
        await mkdir_fn(accessor, path, parents=parents)
    except FS_ERRORS as exc:
        named = operand_spelling(error_path(exc), path)
        return False, (
            f"mkdir: cannot create directory '{named}': {fs_strerror(exc)}"
        )
    return True, None


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
    for node, spelled in walk_nodes(dotted, path.raw_path):
        try:
            why = await _enter_node(
                mkdir_fn, accessor, path, node, root, links
            )
        except FileExistsError:
            why = os.strerror(errno.ENOTDIR)
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
            return ELOOP_STRERROR
        target = await links.target_stat(node)
        if target is None:
            return os.strerror(errno.EEXIST)
        if target.type != FileType.DIRECTORY:
            return os.strerror(errno.ENOTDIR)
        return None
    probe = get_walk_probe()
    if probe is not None:
        exists, is_dir = await entry_kind(
            probe.stat, PathSpec.from_str_path(node)
        )
        if exists:
            return None if is_dir else os.strerror(errno.ENOTDIR)
    real = links.resolve(node) if links is not None else node
    if real.startswith(root + "/"):
        await mkdir_fn(accessor, descendant_path(path, real), parents=True)
    return None


BUILDER = Builder("mkdir", mkdir, write=True)
