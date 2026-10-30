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

import asyncio
import ctypes
import functools
import logging
import os
import stat
import sys
from collections.abc import Iterator
from pathlib import Path
from typing import BinaryIO

from mirage.core.disk.errors import disk_error
from mirage.errors.fs import enoent
from mirage.types import PathSpec

logger = logging.getLogger(__name__)


def open_flags(flags: int, path: str, _mode: int) -> int:
    """An ``opener`` for ``aiofiles.open`` that opens with ``flags``, so a
    write can create a file without truncating one that exists.

    Args:
        flags (int): the ``os.open`` flags.
        path (str): the host path.
        _mode (int): the mode ``open`` would have used, ignored.
    """
    return os.open(path, flags, 0o666)


@functools.cache
def _libc() -> ctypes.CDLL:
    libc = ctypes.CDLL(None, use_errno=True)
    libc.realpath.argtypes = [ctypes.c_char_p, ctypes.c_void_p]
    libc.realpath.restype = ctypes.c_void_p
    libc.free.argtypes = [ctypes.c_void_p]
    libc.free.restype = None
    return libc


def native_realpath(path: str) -> str:
    """Ask the host for a canonical path without Python's POSIX emulation.

    Args:
        path (str): an existing host path.
    """
    if sys.platform != "darwin":
        return os.path.realpath(path, strict=True)
    libc = _libc()
    resolved = libc.realpath(os.fsencode(path), None)
    if not resolved:
        code = ctypes.get_errno()
        raise OSError(code, os.strerror(code), path)
    try:
        return os.fsdecode(ctypes.string_at(resolved))
    finally:
        libc.free(resolved)


def exact_name(parent: str, part: str, info: os.stat_result) -> bool:
    """Prove the requested spelling is the entry's own, listing the
    parent's names only when nothing cheaper proves it.

    An ASCII name has one spelling unless the directory folds case, and
    the name with one letter's case flipped tells: absent, a link or
    another entry means the directory keeps case apart, so the name that
    resolved is exact. Where it folds, native realpath may preserve its
    input on some filesystems, so it is trusted only when the flipped,
    non-link spelling resolves to the identical full path whose leaf has
    exactly the requested name. A name past ASCII may also fold or
    normalize in ways one probe cannot see. Every proof that skips the
    listing still opens the parent, so permissions stay uniform. No path
    names or directory versions are cached.

    Args:
        parent (str): already checked host parent.
        part (str): requested component.
        info (os.stat_result): fresh lstat of that component.
    """
    index = next(
        (i for i, c in enumerate(part) if c.isascii() and c.isalpha()), None
    )
    alternate = None
    folds = False
    if index is not None:
        other = part[:index] + part[index].swapcase() + part[index + 1 :]
        alternate = os.path.join(parent, other)
        try:
            alias = os.lstat(alternate)
            folds = not stat.S_ISLNK(alias.st_mode) and os.path.samestat(
                info, alias
            )
        except (FileNotFoundError, NotADirectoryError):
            folds = False
        except OSError:
            logger.debug("Disk spelling probe unavailable", exc_info=True)
            return part in os.listdir(parent)
    if part.isascii() and not folds:
        _open_parent(parent)
        return True
    if folds and alternate and sys.platform in ("darwin", "win32"):
        try:
            canonical = native_realpath(os.path.join(parent, part))
            if (
                os.path.basename(canonical) == part
                and native_realpath(alternate) == canonical
            ):
                _open_parent(parent)
                return True
        except OSError:
            logger.debug(
                "Native disk spelling proof unavailable", exc_info=True
            )
    return part in os.listdir(parent)


def _open_parent(parent: str) -> None:
    with os.scandir(parent) as entries:
        next(entries, None)


def resolve_inside_sync(
    root: Path, spec: PathSpec, path: str | None = None
) -> Path:
    """Resolve an exact host operand without following links below the root.

    Fresh native spelling proofs avoid scanning siblings where supported.
    Other names require listing existing parents. Parents must be readable,
    including on the native fast path, so permission semantics stay uniform.

    Missing components are left to the operation, allowing creates. The root
    itself may be an infrastructure symlink. This check is not atomic with
    subsequent I/O: protection against concurrent host replacement requires
    descriptor-relative operations with O_NOFOLLOW throughout.

    Call on a worker thread, or from a synchronous snapshot API. Async
    operations use resolve_inside, which hands the whole check to one worker.

    Args:
        root (Path): mount root on the host.
        spec (PathSpec): operand retained for virtual-path errors.
        path (str | None): alternate mount-relative key, otherwise spec's.
    """
    key = spec.mount_path if path is None else path
    base = os.path.abspath(root)
    full = os.path.normpath(os.path.join(base, key.lstrip("/")))
    prefix = base if base.endswith(os.sep) else base + os.sep
    if full != base and not full.startswith(prefix):
        raise ValueError(f"path escapes root: {spec.virtual}")
    at = base
    for part in full[len(base) :].split(os.sep):
        if not part:
            continue
        parent = at
        at = os.path.join(parent, part)
        try:
            info = os.lstat(at)
            exact = (
                False
                if stat.S_ISLNK(info.st_mode)
                else exact_name(parent, part, info)
            )
        except (FileNotFoundError, NotADirectoryError):
            return Path(full)
        except OSError as exc:
            raise disk_error(exc, spec.virtual) from exc
        if not exact or stat.S_ISLNK(info.st_mode):
            raise enoent(spec)
    return Path(full)


async def resolve_inside(
    root: Path, spec: PathSpec, path: str | None = None
) -> Path:
    """Run the complete path check off the event loop.

    Args:
        root (Path): mount root on the host.
        spec (PathSpec): operand retained for virtual-path errors.
        path (str | None): alternate mount-relative key.
    """
    return await asyncio.to_thread(resolve_inside_sync, root, spec, path)


def open_regular(path: Path) -> BinaryIO:
    """Open a host file a state named, without following a link.

    A captured file read later (a snapshot's tar, a copy) is refused
    when a link or anything but a regular file has replaced it since.

    Args:
        path (Path): the host file.

    Raises:
        ValueError: the path no longer names a regular file.
    """
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    f = os.fdopen(fd, "rb")
    if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
        f.close()
        raise ValueError(f"not a regular file: {path}")
    return f


def read_entries(directory: Path) -> list[os.DirEntry[str]]:
    """List visible host entries using metadata that never follows links.

    All disk traversals use this policy. Errors propagate to the caller,
    which decides whether absence is expected or the traversal is incomplete.

    Args:
        directory (Path): checked host directory.
    """
    with os.scandir(directory) as listing:
        return [entry for entry in listing if not entry.is_symlink()]


def walk_entries(start: Path) -> Iterator[tuple[Path, list[str], list[str]]]:
    """Walk visible entries, allowing callers to prune the directory list.

    Args:
        start (Path): checked host directory.
    """
    pending = [start]
    while pending:
        directory = pending.pop()
        dirs: list[str] = []
        files: list[str] = []
        try:
            entries = read_entries(directory)
        except FileNotFoundError:
            logger.debug(
                "Directory vanished during disk traversal", exc_info=True
            )
            continue
        for entry in entries:
            if entry.is_dir(follow_symlinks=False):
                dirs.append(entry.name)
            else:
                files.append(entry.name)
        yield directory, dirs, files
        pending.extend(directory / name for name in reversed(dirs))
