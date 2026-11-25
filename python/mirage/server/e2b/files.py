from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from stat import filemode
from typing import Literal, NotRequired, TypedDict

from mirage.commands.cli.operand import ensure_dir
from mirage.errors import classify
from mirage.errors.types import FsCondition
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.dates import rfc3339_of
from mirage.utils.remnants import entry_name
from mirage.utils.stat_view import posix_mode
from mirage.workspace.files import Files, reader_of

logger = logging.getLogger(__name__)

HOME = "/home/user"
FileCode = Literal[
    "already_exists",
    "failed_precondition",
    "internal",
    "invalid_argument",
    "not_found",
    "permission_denied",
    "resource_exhausted",
    "unimplemented",
]


class FileError(ValueError):
    def __init__(self, code: FileCode, message: str) -> None:
        super().__init__(message)
        self.code = code


ERRORS: dict[FsCondition, tuple[FileCode, str]] = {
    FsCondition.ENOENT: ("not_found", "file not found"),
    FsCondition.EEXIST: ("already_exists", "file or directory already exists"),
    FsCondition.EACCES: ("permission_denied", "permission denied"),
    FsCondition.EPERM: ("permission_denied", "permission denied"),
    FsCondition.EROFS: ("permission_denied", "read-only filesystem"),
    FsCondition.ENOTDIR: ("failed_precondition", "not a directory"),
    FsCondition.EISDIR: ("failed_precondition", "is a directory"),
    FsCondition.ENOTEMPTY: ("failed_precondition", "directory is not empty"),
    FsCondition.EBUSY: ("failed_precondition", "path is busy"),
    FsCondition.ELOOP: ("invalid_argument", "symbolic link loop"),
    FsCondition.EINVAL: ("invalid_argument", "invalid path"),
    FsCondition.EDQUOT: ("resource_exhausted", "disk quota exceeded"),
    FsCondition.EFBIG: ("resource_exhausted", "file is too large"),
    FsCondition.ENOTSUP: (
        "unimplemented",
        "filesystem operation is unsupported",
    ),
}


def file_error(exc: Exception) -> FileError:
    if isinstance(exc, FileError):
        return exc
    condition = classify(exc)
    if condition is not None and condition in ERRORS:
        return FileError(*ERRORS[condition])
    return FileError("internal", "filesystem operation failed")


class WriteInfo(TypedDict):
    name: str
    type: Literal["file"]
    path: str


class EntryInfo(TypedDict):
    name: str
    type: str
    path: str
    size: str
    mode: int
    permissions: str
    owner: NotRequired[str]
    group: NotRequired[str]
    modifiedTime: NotRequired[str]
    symlinkTarget: NotRequired[str]


TYPES = {
    FileType.FILE: "FILE_TYPE_FILE",
    FileType.DIRECTORY: "FILE_TYPE_DIRECTORY",
    FileType.SYMLINK: "FILE_TYPE_SYMLINK",
}


def _file_path(value: str) -> PathSpec:
    if not value or "\0" in value:
        raise FileError("invalid_argument", "invalid path")
    return PathSpec.from_str_path(value, cwd=HOME)


class SandboxFiles:
    def __init__(self, files: Files) -> None:
        self.files = files

    async def read(self, path: str) -> AsyncIterator[bytes]:
        return await self.files.read(_file_path(path), raw=True, stream=True)

    async def write(self, path: str, data: bytes) -> WriteInfo:
        spec = _file_path(path)
        try:
            await self.files.write(spec, data)
        except Exception as exc:
            if classify(exc) != FsCondition.ENOENT:
                raise
            await ensure_dir(self.files, spec.parent)
            await self.files.write(spec, data)
        return {
            "name": entry_name(spec.virtual),
            "type": "file",
            "path": spec.virtual,
        }

    async def stat(self, path: str) -> EntryInfo:
        spec = _file_path(path)
        info = await self.files.stat(spec, nofollow=True)
        return await self._entry(spec, info)

    async def list_dir(self, path: str, depth: int = 1) -> list[EntryInfo]:
        if depth not in (1, 2):
            raise FileError(
                "invalid_argument", "list depth must be one or two"
            )
        spec = _file_path(path)
        if (await self.files.stat(spec)).type != FileType.DIRECTORY:
            raise FileError("failed_precondition", "not a directory")
        return await self._list(spec, depth)

    async def mkdir(self, path: str) -> None:
        spec = _file_path(path)
        try:
            await self.files.mkdir(spec)
        except Exception as exc:
            if classify(exc) != FsCondition.ENOENT:
                raise
            await ensure_dir(self.files, spec.parent)
            await self.files.mkdir(spec)

    async def remove(self, path: str) -> None:
        await self._remove(_file_path(path))

    async def _entry(self, spec: PathSpec, info: FileStat) -> EntryInfo:
        mode = posix_mode(info)
        result: EntryInfo = {
            "name": entry_name(spec.virtual) or "/",
            "type": TYPES.get(info.type, "FILE_TYPE_UNSPECIFIED"),
            "path": spec.virtual,
            "size": str(info.size or 0),
            "mode": mode,
            "permissions": filemode(mode)[1:],
        }
        modified = rfc3339_of(info.modified)
        if modified is not None:
            result["modifiedTime"] = modified
        if info.uid is not None:
            result["owner"] = str(info.uid)
        if info.gid is not None:
            result["group"] = str(info.gid)
        if info.type == FileType.SYMLINK:
            result["symlinkTarget"] = await self.files.readlink(spec)
        return result

    async def _children(self, spec: PathSpec) -> list[PathSpec]:
        names = (entry_name(entry) for entry in await self.files.readdir(spec))
        return [
            spec.join(name) for name in names if name not in ("", ".", "..")
        ]

    async def _list(self, spec: PathSpec, depth: int) -> list[EntryInfo]:
        entries: list[EntryInfo] = []
        for child in await self._children(spec):
            try:
                info = await self.files.stat(child, nofollow=True)
            except Exception as exc:
                if classify(exc) != FsCondition.ENOENT:
                    raise
                logger.debug("file disappeared during listing: %s", exc)
                continue
            entries.append(await self._entry(child, info))
            if depth > 1 and info.type == FileType.DIRECTORY:
                entries.extend(await self._list(child, depth - 1))
        return entries

    async def _remove(self, spec: PathSpec) -> None:
        try:
            info = await self.files.stat(spec, nofollow=True)
            if info.type != FileType.DIRECTORY:
                await self.files.unlink(spec)
                return
            target = reader_of(self.files).follow_parent(
                spec.dotted or spec.virtual
            )
            if self.files.is_mount(target) or self.files.submounts(target):
                raise FileError("failed_precondition", "cannot remove a mount")
            for child in await self._children(spec):
                await self._remove(child)
            await self.files.rmdir(spec)
        except Exception as exc:
            if classify(exc) != FsCondition.ENOENT:
                raise
            logger.debug("file already absent during removal: %s", exc)
