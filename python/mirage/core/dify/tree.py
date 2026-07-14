from datetime import datetime, timezone
from typing import Any

from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.dify._client import list_all_documents
from mirage.utils.path import gnu_basename, parent


async def ensure_tree(accessor,
                      index: IndexCacheStore = NULL_INDEX,
                      prefix: str = "") -> None:
    root_key = mount_root(prefix)
    listing = await index.list_dir(root_key)
    if listing.entries is not None:
        return

    # list_all_documents already filters to visible documents.
    documents = await list_all_documents(accessor.config)
    dir_entries = build_dir_entries(
        documents,
        prefix,
        accessor.config.slug_metadata_name,
    )
    for directory in sorted(dir_entries):
        await index.set_dir(
            directory, sorted(dir_entries[directory],
                              key=lambda item: item[0]))


def build_dir_entries(
    documents: list[dict[str, Any]],
    prefix: str,
    slug_metadata_name: str = "slug",
) -> dict[str, list[tuple[str, IndexEntry]]]:
    files: dict[str, dict[str, Any]] = {}
    raw_slugs: dict[str, str] = {}
    has_slugs: dict[str, bool] = {}
    for document in documents:
        slug, has_slug = extract_slug(document, slug_metadata_name)
        path = normalize_slug(slug)
        if path in files:
            value = path.strip("/")
            raise ValueError(
                f"Duplicate {slug_metadata_name} '{value}': documents "
                f"'{files[path].get('id')}' and '{document.get('id')}' share "
                "the same path.")
        files[path] = document
        raw_slugs[path] = str(slug)
        has_slugs[path] = has_slug

    raise_on_collisions(files)
    directories = collect_directories(set(files))
    dir_entries: dict[str, list[tuple[str, IndexEntry]]] = {
        virtual_path(directory, prefix): []
        for directory in directories
    }
    for directory in sorted(directories):
        if directory == "/":
            continue
        entry = IndexEntry(
            id=directory.strip("/"),
            name=gnu_basename(directory),
            resource_type="folder",
        )
        dir_entries[virtual_path(parent(directory), prefix)].append(
            (entry.name, entry))

    for path, document in sorted(files.items()):
        entry = IndexEntry(
            id=str(document["id"]),
            name=gnu_basename(path),
            resource_type="file",
            size=extract_document_size(document),
            remote_time=timestamp_to_iso(document.get("created_at")),
            extra={
                "slug": path.strip("/"),
                "slug_metadata_name": slug_metadata_name,
                "raw_slug": raw_slugs[path],
                "has_slug": has_slugs[path],
                "tokens": document.get("tokens"),
                "indexing_status": document.get("indexing_status"),
                "data_source_type": document.get("data_source_type"),
            },
        )
        dir_entries[virtual_path(parent(path), prefix)].append(
            (entry.name, entry))
    return dir_entries


def extract_slug(document: dict[str, Any],
                 slug_metadata_name: str = "slug") -> tuple[str, bool]:
    metadata = document.get("doc_metadata")
    if isinstance(metadata, list):
        for item in metadata:
            if (isinstance(item, dict)
                    and item.get("name") == slug_metadata_name):
                value = item.get("value")
                if value is not None:
                    return str(value), True
    if (isinstance(metadata, dict)
            and metadata.get(slug_metadata_name) is not None):
        return str(metadata[slug_metadata_name]), True
    return str(document["name"]), False


def normalize_slug(value: str) -> str:
    parts = [part for part in value.strip("/").split("/") if part]
    if not parts:
        raise ValueError("Invalid empty Dify document slug.")
    invalid = {".", ".."}
    for part in parts:
        if part in invalid:
            raise ValueError(f"Invalid Dify document slug segment: {part!r}")
    return "/" + "/".join(parts)


def raise_on_collisions(files: dict[str, dict[str, Any]]) -> None:
    paths = set(files)
    for path in sorted(paths):
        parts = path.strip("/").split("/")
        for index in range(1, len(parts)):
            ancestor = "/" + "/".join(parts[:index])
            if ancestor in paths:
                raise ValueError(
                    "Path collision: document "
                    f"'{files[ancestor].get('id')}' uses file path "
                    f"'{ancestor.strip('/')}' but document "
                    f"'{files[path].get('id')}' requires it as a directory "
                    "prefix.")


def collect_directories(paths: set[str]) -> set[str]:
    directories = {"/"}
    for path in paths:
        parts = path.strip("/").split("/")
        for index in range(1, len(parts)):
            directories.add("/" + "/".join(parts[:index]))
    return directories


def extract_document_size(document: dict[str, Any]) -> int | None:
    candidates = (
        document.get("data_source_detail_dict"),
        document.get("data_source_info"),
    )
    for candidate in candidates:
        if isinstance(candidate, dict):
            upload_file = candidate.get("upload_file")
            if isinstance(upload_file, dict):
                size = upload_file.get("size")
                if isinstance(size, int):
                    return size
    return None


def timestamp_to_iso(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, timezone.utc).isoformat()
    return str(value)


def mount_root(prefix: str) -> str:
    return prefix.rstrip("/") or "/"


def virtual_path(path: str, prefix: str) -> str:
    root = mount_root(prefix)
    if path == "/":
        return root
    if root == "/":
        return path
    return root + path
