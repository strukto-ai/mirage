import base64
import gzip
import json
from typing import Any

from mirage.accessor.chroma import ChromaAccessor
from mirage.core.chroma.client import fetch_path_tree
from mirage.core.slug_tree.rows import (
    dir_rows,
    drop_collisions,
    normalize_slug,
)
from mirage.core.slug_tree.tree import SlugTree
from mirage.core.slug_tree.types import DirRows
from mirage.types import ContentType, FileStat, FileType
from mirage.utils.path import gnu_basename


async def load_tree(accessor: ChromaAccessor) -> DirRows:
    return build_dir_entries(parse_path_tree(await fetch_path_tree(accessor)))


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


def build_dir_entries(path_tree: dict[str, dict[str, Any]]) -> DirRows:
    files: dict[str, dict[str, Any]] = {}
    for raw_slug, metadata in path_tree.items():
        path = normalize_slug(raw_slug, "Chroma path")
        if path in files:
            raise ValueError(f"Duplicate Chroma path '{path.strip('/')}'")
        files[path] = metadata
    return dir_rows(drop_collisions(files, refuse_collision), file_row)


def refuse_collision(ancestor: str, path: str) -> None:
    raise ValueError(
        "Path collision: Chroma path "
        f"'{ancestor.strip('/')}' is both a file and a directory "
        f"prefix for '{path.strip('/')}'."
    )


def file_row(path: str, metadata: dict[str, Any]) -> FileStat:
    slug = path.strip("/")
    updated_at = metadata_or_none(metadata, "updated_at")
    # The path tree's `size` describes the producer's source document,
    # not the chunk join mirage serves, so it rides in extra and never
    # becomes the reported byte length: sizes.ensure_dir_sizes measures
    # the rendered bytes instead.
    return FileStat(
        name=gnu_basename(path),
        type=FileType.FILE,
        content=ContentType.TEXT,
        modified=updated_at,
        extra={
            "slug": slug,
            "source_size": metadata_int_or_none(metadata, "size"),
            "created_at": metadata_or_none(metadata, "created_at"),
            "updated_at": updated_at,
        },
    )


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


CHROMA_TREE = SlugTree(load_tree)
