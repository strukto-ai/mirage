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
import posixpath
from dataclasses import replace

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind.adapter import (
    GenericCommand,
    Operation,
    require_op,
)
from mirage.commands.builtin.utils.output import format_optional_records
from mirage.commands.config import CommandIO, CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.constants import FS_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.errors.posix import posix_phrase
from mirage.errors.types import FsCondition
from mirage.io.types import ByteSource, IOResult
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_prefix_of, mounted_path
from mirage.utils.path import CycleError, resolve_path
from mirage.view.types import LinkView

logger = logging.getLogger(__name__)


def followed_parent(virtual: str, links: LinkView | None) -> str:
    """``virtual`` with its parent resolved through the namespace's links.

    rmdir(2) follows every component but the last, which stays as named,
    so a link there is refused rather than followed.

    Args:
        virtual (str): the absolute path, without a trailing slash.
        links (LinkView | None): the namespace's symlink facts.
    """
    if links is None:
        return virtual
    parent, name = posixpath.split(virtual)
    try:
        return f"{links.resolve(parent).rstrip('/')}/{name}"
    except CycleError as exc:
        logger.debug("rmdir: following %s failed: %s", parent, exc)
        return virtual


def ancestors(
    path: PathSpec, cwd: str, links: LinkView | None = None
) -> list[tuple[PathSpec | None, str]]:
    """The directories ``-p`` removes after ``path``, as GNU cuts them from
    the operand as typed, each with its spelling. None stands for the mount
    root, which is a mount point and is never removed. Each is reached
    through the links in its parent, as GNU's rmdir(2) is: ``rmdir -p
    link/nested/leaf`` removes the directory ``link/nested`` names.

    Args:
        path (PathSpec): the removed operand.
        cwd (str): the directory a relative operand resolves against.
        links (LinkView | None): the namespace's symlink facts.
    """
    prefix = mount_prefix_of(path.virtual, path.vfs_path)
    typed = path.raw_path.rstrip("/") or "/"
    chain: list[tuple[PathSpec | None, str]] = []
    while "/" in typed:
        cut = typed.rindex("/")
        while cut > 0 and typed[cut] == "/":
            cut -= 1
        typed = typed[: cut + 1]
        literal = resolve_path(typed, cwd).rstrip("/")
        if not literal.startswith(f"{prefix}/"):
            chain.append((None, typed))
            break
        # A parent linked onto another mount is out of this mount's reach,
        # so the name is tried here as typed.
        followed = followed_parent(literal, links)
        virtual = followed if followed.startswith(f"{prefix}/") else literal
        below = mounted_path(path, virtual[len(prefix) :])
        chain.append((replace(below, raw_path=typed), typed))
    return chain


async def rmdir(
    ops: CommandIO,
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["rmdir"])
    v = fl.as_bool("verbose")
    ignore = fl.as_bool("ignore_fail_on_non_empty")
    if not ops.is_mounted(accessor) or not paths:
        raise UsageError(
            "rmdir: missing operand\nTry 'rmdir --help' for more information.",
            1,
        )
    rmdir_fn = require_op(ops, Operation.RMDIR)
    paths = await ops.resolve_glob(accessor, paths, opts.index)
    links = opts.ns.links if opts.ns is not None else None
    verbose_parts: list[str] = []
    errors: list[str] = []

    async def remove(p: PathSpec) -> str | None:
        # rmdir(2) never follows, so a link operand never reaches the
        # directory it points at. GNU words the two spellings apart: a
        # bare link is the plain ENOTDIR, while one typed with a
        # trailing slash gets rmdir's own "Symbolic link not followed",
        # since the slash asked for a directory the call refuses to
        # resolve. No backend can see a link, so the name plane answers.
        if links is not None and links.stat_at(p.virtual) is not None:
            if p.raw_path.endswith("/"):
                return "Symbolic link not followed"
            return posix_phrase(FsCondition.ENOTDIR)
        try:
            s = await ops.stat(accessor, p, index=opts.index)
        except FS_ERRORS as exc:
            return fs_strerror(exc)
        if s.type != FileType.DIRECTORY:
            return posix_phrase(FsCondition.ENOTDIR)
        if await ops.readdir(accessor, p, index=opts.index):
            return posix_phrase(FsCondition.ENOTEMPTY)
        try:
            await rmdir_fn(accessor, p, index=opts.index)
        except OSError as exc:
            # The listing above showed the session an empty directory,
            # but the slot may still refuse not-empty: the hidden-
            # remnant guard re-raises the backend's refusal when its
            # cascade cannot finish (a mode-protected remnant, a
            # visible entry appearing mid-walk). A read-only region
            # refuses here too. GNU's voice, not the raw errno repr.
            reason = (
                posix_phrase(FsCondition.ENOTEMPTY)
                if exc.errno in (errno.ENOTEMPTY, errno.EEXIST)
                else fs_strerror(exc)
            )
            if reason is None:
                raise
            return reason
        return None

    for p in paths:
        if v:
            verbose_parts.append(f"rmdir: removing directory, '{p.raw_path}'")
        reason = await remove(p)
        if reason is not None:
            if not (ignore and reason == posix_phrase(FsCondition.ENOTEMPTY)):
                errors.append(
                    f"rmdir: failed to remove '{p.raw_path}': {reason}"
                )
            continue
        if not fl.as_bool("parents"):
            continue
        for ancestor, typed in ancestors(p, opts.cwd.virtual, links):
            if v:
                verbose_parts.append(f"rmdir: removing directory, '{typed}'")
            # The walk up meets the mount root, which rmdir(2) answers
            # with EBUSY. An ancestor already gone held the entry just
            # removed, so it was a keyed store's implicit prefix that
            # vanished with its last key: it counts as removed.
            reason = (
                posix_phrase(FsCondition.EBUSY)
                if ancestor is None
                else await remove(ancestor)
            )
            if (
                reason == posix_phrase(FsCondition.ENOENT)
                and ancestor is not None
            ) or reason is None:
                continue
            if not (ignore and reason == posix_phrase(FsCondition.ENOTEMPTY)):
                what = (
                    ""
                    if reason == posix_phrase(FsCondition.ENOTDIR)
                    else "directory "
                )
                errors.append(
                    f"rmdir: failed to remove {what}'{typed}': {reason}"
                )
            break
    output = format_optional_records(verbose_parts) if v else None
    stderr = ("\n".join(errors) + "\n").encode() if errors else None
    return output, IOResult(stderr=stderr, exit_code=1 if errors else 0)


BUILDER = GenericCommand("rmdir", rmdir, write=True)
