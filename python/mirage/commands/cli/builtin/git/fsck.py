import asyncio
import hashlib

from dulwich.errors import ChecksumMismatch
from dulwich.objects import Commit, ObjectID, ShaFile, Tag, Tree
from dulwich.repo import BaseRepo

from mirage.commands.cli.builtin.git.errors import GitError
from mirage.commands.cli.builtin.git.index_file import read_index
from mirage.commands.cli.builtin.git.io import (
    basename,
    file_size,
    read_file,
    read_names,
    read_optional,
    read_range,
)
from mirage.commands.cli.builtin.git.repo import open_repo
from mirage.commands.cli.builtin.git.session import located
from mirage.commands.cli.builtin.git.util import fatal
from mirage.commands.cli.types import CLIDoors, CLIInvocation
from mirage.commands.spec.flag_view import FlagView
from mirage.doors.types import StatPath
from mirage.errors.constants import WALK_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.io.types import ByteSource, IOResult
from mirage.runtime.types import DispatchFn
from mirage.types import FileType, PathSpec

PACK_BLOCK = 1 << 18


async def check_pack(
    dispatch: DispatchFn, path: PathSpec, expected: bytes
) -> None:
    """Hash bounded ranges, retaining only the trailing SHA-1 between reads.

    Args:
        dispatch (DispatchFn): repository dispatcher.
        path (PathSpec): virtual pack path.
        expected (bytes): pack checksum recorded by the index.
    """
    digest = hashlib.sha1()
    tail = b""
    offset = 0
    try:
        size = await file_size(dispatch, path)
        while size is None or offset < size:
            count = (
                PACK_BLOCK if size is None else min(PACK_BLOCK, size - offset)
            )
            chunk = await read_range(dispatch, path, offset, count)
            if not chunk:
                if size is not None and offset < size:
                    raise GitError(f"truncated pack: {path.virtual}")
                break
            offset += len(chunk)
            buffered = tail + chunk
            if len(buffered) > 20:
                digest.update(buffered[:-20])
            tail = buffered[-20:]
            if size is None and len(chunk) < count:
                break
    except WALK_ERRORS as exc:
        raise GitError(
            f"cannot read pack {path.virtual}: {fs_strerror(exc) or str(exc)}"
        ) from exc
    if offset < 32:
        raise GitError(f"truncated pack: {path.virtual}")
    if digest.digest() != tail or tail != expected:
        raise GitError(f"pack checksum mismatch: {path.virtual}")


async def check_packs(dispatch: DispatchFn, commondir: PathSpec) -> None:
    """Validate indexes and stream packs before opening the object database.

    Args:
        dispatch (DispatchFn): repository dispatcher.
        commondir (PathSpec): shared Git directory.
    """
    root = commondir.join("objects/pack")
    for entry in await read_names(dispatch, root):
        name = basename(entry)
        if not name.endswith(".idx"):
            continue
        path = root.join(name)
        try:
            data = await read_file(dispatch, path)
        except WALK_ERRORS as exc:
            detail = fs_strerror(exc) or str(exc)
            raise GitError(
                f"cannot read pack index {path.virtual}: {detail}"
            ) from exc
        if len(data) < 1064:
            raise GitError(f"truncated pack index: {path.virtual}")
        if hashlib.sha1(data[:-20]).digest() != data[-20:]:
            raise GitError(f"pack index checksum mismatch: {path.virtual}")
        await check_pack(
            dispatch, root.join(f"{name[:-4]}.pack"), data[-40:-20]
        )


async def log_roots(
    dispatch: DispatchFn, stat_path: StatPath, path: PathSpec
) -> set[bytes]:
    """Collect reflog roots without assuming names or storage layout.

    Args:
        dispatch (DispatchFn): repository dispatcher.
        stat_path (StatPath): namespace-aware entry classification.
        path (PathSpec): logs directory or a log file.
    """
    found: set[bytes] = set()
    for entry in await read_names(dispatch, path):
        name = basename(entry)
        target = path.join(name)
        info = await stat_path(target)
        if info is not None and info.type is FileType.DIRECTORY:
            found.update(await log_roots(dispatch, stat_path, target))
        else:
            data = await read_optional(dispatch, target)
            for line in (data or b"").splitlines():
                found.update(
                    oid
                    for oid in line.split(b" ", 2)[:2]
                    if len(oid) == 40 and oid != b"0" * 40
                )
    return found


def links(obj: ShaFile) -> list[bytes]:
    """Object links, excluding gitlinks into other repositories.

    Args:
        obj (ShaFile): a validated object.
    """
    if isinstance(obj, Commit):
        return [obj.tree, *obj.parents]
    if isinstance(obj, Tree):
        return [
            entry.sha for entry in obj.iteritems() if entry.mode != 0o160000
        ]
    if isinstance(obj, Tag):
        return [obj.object[1]]
    return []


def check(
    repo: BaseRepo, roots: set[bytes], dangling: bool
) -> tuple[bytes, IOResult]:
    """Hash, decode and check connectivity of loose and packed objects.

    Corruption diagnostics retain the object ID and underlying cause; wording
    differs from native Git, whose zlib/pack diagnostics are platform-specific.

    Args:
        repo (BaseRepo): lazily dispatched object store, driven on a worker.
        roots (set[bytes]): refs, index and reflog tips.
        dangling (bool): report unreferenced tips.
    """
    errors: list[str] = []
    objects: dict[bytes, ShaFile] = {}
    referenced = set(roots)
    for oid in sorted(
        set(repo.object_store) | {ObjectID(oid) for oid in roots}
    ):
        try:
            obj = repo.object_store[ObjectID(oid)]
            obj.check()
            if obj.id != oid:
                raise ValueError("hash mismatch")
            objects[oid] = obj
            referenced.update(links(obj))
        except Exception as exc:
            errors.append(f"error: object {oid.decode()}: {exc}\n")
    for missing in sorted(referenced - objects.keys()):
        if missing not in roots:
            errors.append(f"missing object {missing.decode()}\n")
    stdout = (
        "".join(
            f"dangling {objects[oid].type_name.decode()} {oid.decode()}\n"
            for oid in sorted(objects.keys() - referenced)
        )
        if dangling
        else ""
    )
    return stdout.encode(), IOResult(
        exit_code=1 if errors else 0, stderr="".join(errors).encode()
    )


async def fsck(inv: CLIInvocation[None]) -> tuple[ByteSource | None, IOResult]:
    """Check the mounted repository without invoking host Git.

    Args:
        inv (CLIInvocation[None]): repository and fsck options.
    """
    try:
        doors = inv.doors or CLIDoors()
        fl = FlagView(inv.flags)
        location = await located(fl, doors)
        assert doors.dispatch is not None and doors.stat_path is not None
        await check_packs(doors.dispatch, location.commondir)
        repo = await open_repo(doors.dispatch, location)
        roots: set[bytes] = set(repo.refs.as_dict().values())
        index = await read_index(doors.dispatch, location.gitdir)
        roots.update(
            entry.sha
            for entry in index.entries.values()
            if entry.mode != 0o160000
        )
        for directory in {location.gitdir, location.commondir}:
            roots.update(
                await log_roots(
                    doors.dispatch, doors.stat_path, directory.join("logs")
                )
            )
        out, io = await asyncio.to_thread(
            check, repo, roots, not fl.as_bool("no_dangling")
        )
        if not roots:
            head = await read_optional(
                doors.dispatch, location.gitdir.join("HEAD")
            )
            branch = (
                (head or b"").decode().strip().removeprefix("ref: refs/heads/")
            )
            notice = (
                f"notice: HEAD points to an unborn branch ({branch})\n"
                "notice: No default references\n"
            )
            io.stderr = notice.encode() + await io.materialize_stderr()
        return out, io
    except GitError as exc:
        return fatal(exc)
    except ChecksumMismatch as exc:
        return fatal(GitError(str(exc)))
