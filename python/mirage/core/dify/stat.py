from datetime import datetime, timezone

from mirage.accessor.dify import DifyAccessor
from mirage.cache.index import NULL_INDEX, IndexCacheStore
from mirage.core.dify._client import get_document_detail
from mirage.core.dify.path import resolve_path
from mirage.core.dify.tree import extract_document_size
from mirage.types import FileStat, FileType, PathSpec


async def stat_light(accessor: DifyAccessor,
                     path: PathSpec,
                     index: IndexCacheStore = NULL_INDEX) -> FileStat:
    resolved = await resolve_path(accessor, path, index)
    if resolved.is_dir:
        return FileStat(
            name=stat_name(resolved.virtual_key, resolved.mount_prefix),
            type=FileType.DIRECTORY,
            extra={"children_count": 0},
        )
    # size stays None: the entry size is the uploaded source file (e.g. the
    # original PDF), not the rendered segment text this mount serves
    # (FileStat.size must be render-derived or None, see the CLAUDE.md FUSE
    # rules). The source size remains in extra.
    extra = dict(resolved.entry.extra)
    if resolved.entry.size is not None:
        extra["source_size"] = resolved.entry.size
    return FileStat(
        name=resolved.entry.name,
        type=FileType.TEXT,
        size=None,
        modified=timestamp_to_zulu(resolved.entry.remote_time),
        fingerprint=None,
        revision=None,
        extra=extra,
    )


async def stat(accessor: DifyAccessor,
               path: PathSpec,
               index: IndexCacheStore = NULL_INDEX) -> FileStat:
    resolved = await resolve_path(accessor, path, index)
    if resolved.is_dir:
        return FileStat(
            name=stat_name(resolved.virtual_key, resolved.mount_prefix),
            type=FileType.DIRECTORY,
            extra={"children_count": 0},
        )
    detail = await get_document_detail(accessor, resolved.entry.id)
    source_size = extract_document_size(detail)
    if source_size is None:
        source_size = resolved.entry.size
    extra = dict(resolved.entry.extra)
    extra["document_id"] = resolved.entry.id
    # size stays None: the API reports the uploaded source file's size (e.g.
    # the original PDF), not the rendered segment text this mount serves
    # (FileStat.size must be render-derived or None, see the CLAUDE.md FUSE
    # rules). The source size remains in extra.
    if source_size is not None:
        extra["source_size"] = source_size
    if "tokens" in detail:
        extra["tokens"] = detail.get("tokens")
    if "indexing_status" in detail:
        extra["indexing_status"] = detail.get("indexing_status")
    return FileStat(
        name=resolved.entry.name,
        type=FileType.TEXT,
        size=None,
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
