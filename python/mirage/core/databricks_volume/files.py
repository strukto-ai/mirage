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
from datetime import datetime, timezone
from io import BytesIO
from typing import Any

from mirage.accessor.databricks_volume import DatabricksVolumeAccessor
from mirage.cache.index import IndexCacheStore, IndexEntry
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.filetype import filetype_from_mimetype, guess_type


def _base_path(accessor: DatabricksVolumeAccessor) -> str:
    cfg = accessor.config
    return f"/Volumes/{cfg.catalog}/{cfg.schema}/{cfg.volume}"


def _path_value(path: PathSpec | str) -> str:
    if isinstance(path, str):
        return path
    return path.strip_prefix


def _relative_parts(path: PathSpec | str) -> list[str]:
    raw = _path_value(path)
    parts = [p for p in raw.replace("\\", "/").split("/") if p and p != "."]
    if any(p == ".." for p in parts):
        raise ValueError(f"path escapes Databricks volume root: {raw!r}")
    return parts


def _remote_path(accessor: DatabricksVolumeAccessor,
                 path: PathSpec | str) -> str:
    parts = _relative_parts(path)
    base = _base_path(accessor)
    return base if not parts else f"{base}/{'/'.join(parts)}"


def _virtual_path(accessor: DatabricksVolumeAccessor, remote_path: str,
                  prefix: str) -> str:
    base = _base_path(accessor)
    rel = remote_path[len(base):].strip("/") if remote_path.startswith(
        base) else remote_path.strip("/")
    virtual = "/" + rel if rel else "/"
    if not prefix:
        return virtual
    mount = prefix.rstrip("/")
    return mount if virtual == "/" else mount + virtual


def _name(path: str) -> str:
    return path.rstrip("/").rsplit("/", 1)[-1] or "/"


def _modified_from_millis(value: int | None) -> str:
    if value is None:
        return ""
    return datetime.fromtimestamp(value / 1000, tz=timezone.utc).isoformat()


def _is_not_found(exc: Exception) -> bool:
    status_code = getattr(exc, "status_code", None)
    if status_code == 404:
        return True
    error_code = getattr(exc, "error_code", None)
    if error_code in {"RESOURCE_DOES_NOT_EXIST", "NOT_FOUND"}:
        return True
    response = getattr(exc, "response", None)
    if isinstance(response, dict):
        code = response.get("Error", {}).get("Code")
        if code in {"404", "NoSuchKey", "NotFound"}:
            return True
    message = str(exc)
    return ("RESOURCE_DOES_NOT_EXIST" in message or "NOT_FOUND" in message
            or "404" in message)


def _download_all(files: Any, remote_path: str) -> bytes:
    resp = files.download(remote_path)
    contents = resp.contents
    if contents is None:
        return b""
    if hasattr(contents, "__enter__"):
        with contents as stream:
            data = stream.read()
    else:
        data = contents.read()
    return data if isinstance(data, bytes) else bytes(data)


def _metadata_fingerprint(modified: str | None,
                          size: int | None) -> str | None:
    if not modified and size is None:
        return None
    return f"{modified or ''}:{size or 0}"


def _file_stat_from_metadata(path: str, metadata: Any) -> FileStat:
    content_type = getattr(metadata, "content_type", None)
    ftype = guess_type(path)
    if ftype == FileType.BINARY and content_type:
        ftype = filetype_from_mimetype(content_type)
    size = getattr(metadata, "content_length", None)
    modified = getattr(metadata, "last_modified", None)
    return FileStat(
        name=_name(path),
        size=size,
        modified=modified,
        fingerprint=_metadata_fingerprint(modified, size),
        type=ftype,
        extra={"content_type": content_type} if content_type else {},
    )


def _entry_to_index(entry: Any) -> tuple[str, IndexEntry]:
    name = entry.name or _name(entry.path or "")
    is_directory = bool(getattr(entry, "is_directory", False))
    modified = _modified_from_millis(getattr(entry, "last_modified", None))
    idx_entry = IndexEntry(
        id=entry.path or name,
        name=name,
        resource_type="folder" if is_directory else "file",
        remote_time=modified,
        size=getattr(entry, "file_size", None),
        extra={"path": entry.path},
    )
    return name, idx_entry


async def read_bytes(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    index: IndexCacheStore | None = None,
    offset: int = 0,
    size: int | None = None,
) -> bytes:
    remote = _remote_path(accessor, path)
    try:
        data = await asyncio.to_thread(_download_all, accessor.files, remote)
    except Exception as exc:
        if _is_not_found(exc):
            raise FileNotFoundError(_path_value(path))
        raise
    if offset or size is not None:
        end = offset + size if size is not None else None
        data = data[offset:end]
    return data


async def write_bytes(accessor: DatabricksVolumeAccessor, path: PathSpec,
                      data: bytes) -> None:
    remote = _remote_path(accessor, path)
    await asyncio.to_thread(accessor.files.upload,
                            remote,
                            BytesIO(data),
                            overwrite=True)


async def append_bytes(accessor: DatabricksVolumeAccessor, path: PathSpec,
                       data: bytes) -> None:
    try:
        current = await read_bytes(accessor, path)
    except FileNotFoundError:
        current = b""
    await write_bytes(accessor, path, current + data)


async def readdir(accessor: DatabricksVolumeAccessor, path: PathSpec,
                  index: IndexCacheStore | None) -> list[str]:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    list_path = path.directory if path.pattern else path.original
    scope = PathSpec(original=list_path,
                     directory=list_path,
                     pattern=path.pattern,
                     prefix=path.prefix)
    virtual_key = list_path.rstrip("/") or "/"
    if index is not None:
        listing = await index.list_dir(virtual_key)
        if listing.entries is not None:
            return listing.entries

    remote = _remote_path(accessor, scope)
    try:
        entries = await asyncio.to_thread(
            lambda: list(accessor.files.list_directory_contents(remote)))
    except Exception as exc:
        if _is_not_found(exc):
            raise FileNotFoundError(list_path)
        raise

    children: list[tuple[str, str, IndexEntry]] = []
    for entry in entries:
        entry_path = entry.path or f"{remote.rstrip('/')}/{entry.name}"
        virtual = _virtual_path(accessor, entry_path, path.prefix)
        name, idx_entry = _entry_to_index(entry)
        children.append((virtual, name, idx_entry))
    children.sort(key=lambda item: item[0])
    result = [virtual for virtual, _, _ in children]
    if index is not None:
        index_entries = [(name, entry) for _, name, entry in children]
        await index.set_dir(virtual_key, index_entries)
    return result


async def stat(
    accessor: DatabricksVolumeAccessor,
    path: PathSpec,
    index: IndexCacheStore | None = None,
) -> FileStat:
    if isinstance(path, str):
        path = PathSpec(original=path, directory=path)
    if not _relative_parts(path):
        return FileStat(name="/", type=FileType.DIRECTORY)

    if index is not None:
        lookup = await index.get(path.original)
        if lookup.entry is not None:
            entry = lookup.entry
            if entry.resource_type == "folder":
                return FileStat(name=entry.name, type=FileType.DIRECTORY)
            fingerprint = _metadata_fingerprint(entry.remote_time, entry.size)
            return FileStat(
                name=entry.name,
                size=entry.size,
                modified=entry.remote_time or None,
                fingerprint=fingerprint,
                type=guess_type(entry.name),
                extra=entry.extra,
            )

    remote = _remote_path(accessor, path)
    try:
        metadata = await asyncio.to_thread(accessor.files.get_metadata, remote)
        return _file_stat_from_metadata(path.original, metadata)
    except Exception as exc:
        if not _is_not_found(exc):
            raise

    try:
        await asyncio.to_thread(accessor.files.get_directory_metadata, remote)
    except Exception as exc:
        if _is_not_found(exc):
            raise FileNotFoundError(path.original)
        raise
    return FileStat(name=_name(path.original), type=FileType.DIRECTORY)


async def mkdir(accessor: DatabricksVolumeAccessor, path: PathSpec) -> None:
    await asyncio.to_thread(accessor.files.create_directory,
                            _remote_path(accessor, path))


async def unlink(accessor: DatabricksVolumeAccessor, path: PathSpec) -> None:
    remote = _remote_path(accessor, path)
    try:
        await asyncio.to_thread(accessor.files.delete, remote)
    except Exception as exc:
        if _is_not_found(exc):
            raise FileNotFoundError(_path_value(path))
        raise


async def rmdir(accessor: DatabricksVolumeAccessor, path: PathSpec) -> None:
    remote = _remote_path(accessor, path)
    try:
        await asyncio.to_thread(accessor.files.delete_directory, remote)
    except Exception as exc:
        if _is_not_found(exc):
            raise FileNotFoundError(_path_value(path))
        raise


async def create(accessor: DatabricksVolumeAccessor, path: PathSpec) -> None:
    remote = _remote_path(accessor, path)
    await asyncio.to_thread(accessor.files.upload,
                            remote,
                            BytesIO(b""),
                            overwrite=False)


async def truncate(accessor: DatabricksVolumeAccessor, path: PathSpec,
                   length: int) -> None:
    try:
        data = await read_bytes(accessor, path)
    except FileNotFoundError:
        data = b""
    await write_bytes(accessor, path, data[:length].ljust(length, b"\0"))


async def exists(accessor: DatabricksVolumeAccessor, path: PathSpec) -> bool:
    try:
        await stat(accessor, path)
        return True
    except FileNotFoundError:
        return False


async def rename(accessor: DatabricksVolumeAccessor, src: PathSpec,
                 dst: PathSpec) -> None:
    source_stat = await stat(accessor, src)
    if source_stat.type == FileType.DIRECTORY:
        raise IsADirectoryError(src.original)
    data = await read_bytes(accessor, src)
    await write_bytes(accessor, dst, data)
    await unlink(accessor, src)


async def rm_r(accessor: DatabricksVolumeAccessor, path: PathSpec) -> None:
    try:
        entries = await readdir(accessor, path, index=None)
    except FileNotFoundError:
        await unlink(accessor, path)
        return
    for entry in entries:
        child = PathSpec.from_str_path(entry, path.prefix)
        child_stat = await stat(accessor, child)
        if child_stat.type == FileType.DIRECTORY:
            await rm_r(accessor, child)
        else:
            await unlink(accessor, child)
    await rmdir(accessor, path)
