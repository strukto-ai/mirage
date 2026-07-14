import base64
import gzip
import json
from typing import Any

from mirage.cache.index import NULL_INDEX, IndexCacheStore, IndexEntry
from mirage.core.chroma._client import fetch_path_tree
from mirage.utils.path import gnu_basename, parent


async def ensure_tree(accessor,
                      index: IndexCacheStore = NULL_INDEX,
                      prefix: str = "") -> None:
    root_key = mount_root(prefix)
    listing = await index.list_dir(root_key)
    if listing.entries is not None:
        return

    path_tree = parse_path_tree(await fetch_path_tree(accessor))
    dir_entries = build_dir_entries(path_tree, prefix)
    for directory in sorted(dir_entries):
        await index.set_dir(
            directory, sorted(dir_entries[directory],
                              key=lambda item: item[0]))


def parse_path_tree(raw: str) -> dict[str, dict[str, Any]]:
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        try:
            decoded = gzip.decompress(base64.b64decode(raw)).decode()
            parsed = json.loads(decoded)
        except Exception as exc:
            raise ValueError("Invalid Chroma path tree document") from exc
    if not isinstance(parsed, dict):
        raise ValueError("Chroma path tree must be a JSON object")
    result: dict[str, dict[str, Any]] = {}
    for key, value in parsed.items():
        if not isinstance(key, str):
            raise ValueError("Chroma path tree keys must be strings")
        result[key] = value if isinstance(value, dict) else {}
    return result


def build_dir_entries(
    path_tree: dict[str, dict[str, Any]],
    prefix: str,
) -> dict[str, list[tuple[str, IndexEntry]]]:
    files: dict[str, dict[str, Any]] = {}
    raw_slugs: dict[str, str] = {}
    for raw_slug, metadata in path_tree.items():
        path = normalize_slug(raw_slug)
        if path in files:
            value = path.strip("/")
            raise ValueError(f"Duplicate Chroma path '{value}'")
        files[path] = metadata
        raw_slugs[path] = raw_slug

    raise_on_collisions(files)
    directories = collect_directories(set(files))
    dir_entries: dict[str, list[tuple[str, IndexEntry]]] = {
        virtual_path(directory, prefix): []
        for directory in directories
    }

    for directory in sorted(directories):
        if directory == "/":
            continue
        entry = IndexEntry(id=directory.strip("/"),
                           name=gnu_basename(directory),
                           resource_type="folder")
        dir_entries[virtual_path(parent(directory), prefix)].append(
            (entry.name, entry))

    for path, metadata in sorted(files.items()):
        slug = path.strip("/")
        size = metadata_int_or_none(metadata, "size")
        updated_at = metadata_or_none(metadata, "updated_at")
        entry = IndexEntry(
            id=slug,
            name=gnu_basename(path),
            resource_type="file",
            size=size,
            remote_time=updated_at or "",
            extra={
                "slug": slug,
                "size": size,
                "created_at": metadata_or_none(metadata, "created_at"),
                "updated_at": updated_at,
            },
        )
        dir_entries[virtual_path(parent(path), prefix)].append(
            (entry.name, entry))
    return dir_entries


def normalize_slug(value: str) -> str:
    parts = [part for part in value.strip("/").split("/") if part]
    if not parts:
        raise ValueError("Invalid empty Chroma path")
    invalid = {".", ".."}
    for part in parts:
        if part in invalid:
            raise ValueError(f"Invalid Chroma path segment: {part!r}")
    return "/" + "/".join(parts)


def raise_on_collisions(files: dict[str, dict[str, Any]]) -> None:
    paths = set(files)
    for path in sorted(paths):
        parts = path.strip("/").split("/")
        for index in range(1, len(parts)):
            ancestor = "/" + "/".join(parts[:index])
            if ancestor in paths:
                raise ValueError(
                    "Path collision: Chroma path "
                    f"'{ancestor.strip('/')}' is both a file and a directory "
                    f"prefix for '{path.strip()}'.")


def collect_directories(paths: set[str]) -> set[str]:
    directories = {"/"}
    for path in paths:
        parts = path.strip("/").split("/")
        for index in range(1, len(parts)):
            directories.add("/" + "/".join(parts[:index]))
    return directories


def metadata_or_none(metadata: dict[str, Any], key: str) -> str | None:
    value = metadata.get(key)
    if value is None:
        return None
    return str(value)


def metadata_int_or_none(metadata: dict[str, Any], key: str) -> int | None:
    value = metadata.get(key)
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def mount_root(prefix: str) -> str:
    return prefix.rstrip("/") or "/"


def virtual_path(path: str, prefix: str) -> str:
    root = mount_root(prefix)
    if path == "/":
        return root
    if root == "/":
        return path
    return root + path
