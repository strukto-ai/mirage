from datetime import datetime, timezone

from mirage.cache.index import IndexCacheStore
from mirage.core.dify._client import get_document_detail
from mirage.core.dify.path import resolve_path
from mirage.core.dify.tree import extract_document_size
from mirage.types import FileStat, FileType, PathSpec
from mirage.utils.errors import enoent


async def stat_light(accessor, path: PathSpec,
                     index: IndexCacheStore) -> FileStat:
    resolved = await resolve_path(accessor, path, index)
    if resolved.is_dir:
        return FileStat(
            name=stat_name(resolved.virtual_key, resolved.mount_prefix),
            type=FileType.DIRECTORY,
            extra={"children_count": 0},
        )
    if resolved.entry is None:
        raise enoent(path)
    return FileStat(
        name=resolved.entry.name,
        type=FileType.TEXT,
        size=resolved.entry.size,
        modified=timestamp_to_zulu(resolved.entry.remote_time),
        fingerprint=None,
        revision=None,
        extra=dict(resolved.entry.extra),
    )


async def stat(accessor, path: PathSpec, index: IndexCacheStore) -> FileStat:
    resolved = await resolve_path(accessor, path, index)
    if resolved.is_dir:
        return FileStat(
            name=stat_name(resolved.virtual_key, resolved.mount_prefix),
            type=FileType.DIRECTORY,
            extra={"children_count": 0},
        )
    if resolved.entry is None:
        raise enoent(path)
    detail = await get_document_detail(accessor.config, resolved.entry.id)
    size = extract_document_size(detail)
    if size is None:
        size = resolved.entry.size
    extra = dict(resolved.entry.extra)
    extra["document_id"] = resolved.entry.id
    if "tokens" in detail:
        extra["tokens"] = detail.get("tokens")
    if "indexing_status" in detail:
        extra["indexing_status"] = detail.get("indexing_status")
    return FileStat(
        name=resolved.entry.name,
        type=FileType.TEXT,
        size=size,
        modified=timestamp_to_zulu(detail.get("updated_at")),
        fingerprint=None,
        revision=None,
        extra=extra,
    )


def timestamp_to_zulu(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(
            value, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return str(value)


def stat_name(virtual_key: str, mount_prefix: str) -> str:
    root = mount_prefix.rstrip("/") or "/"
    if virtual_key == root:
        return "/"
    return virtual_key.rstrip("/").rsplit("/", 1)[-1]
