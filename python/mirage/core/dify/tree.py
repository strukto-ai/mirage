import logging
from typing import Any

from mirage.accessor.dify import DifyAccessor
from mirage.core.dify.client import list_all_documents
from mirage.core.slug_tree.rows import (
    dir_rows,
    drop_collisions,
    normalize_slug,
)
from mirage.core.slug_tree.tree import SlugTree
from mirage.core.slug_tree.types import DirRows
from mirage.types import ContentType, FileStat, FileType, JsonValue
from mirage.utils.dates import epoch_to_iso
from mirage.utils.path import gnu_basename

logger = logging.getLogger(__name__)

SLUG_NOUN = "Dify document slug"


async def load_tree(accessor: DifyAccessor) -> DirRows:
    # list_all_documents already filters to visible documents.
    return build_dir_entries(
        await list_all_documents(accessor),
        accessor.config.slug_metadata_name,
    )


def build_dir_entries(
    documents: list[dict[str, Any]],
    slug_metadata_name: str = "slug",
) -> DirRows:
    files: dict[str, dict[str, Any]] = {}
    raw_slugs: dict[str, str] = {}
    has_slugs: dict[str, bool] = {}
    for document in documents:
        try:
            document_id = document.get("id")
            if document_id is None or not str(document_id).strip():
                raise ValueError("missing document id")
            slug, has_slug = extract_slug(document, slug_metadata_name)
            path = normalize_slug(slug, SLUG_NOUN)
        except ValueError as exc:
            logger.warning(
                "Skipping invalid Dify document %r: %s",
                document.get("id"),
                exc,
            )
            continue
        if path in files:
            logger.warning(
                "Skipping duplicate Dify document slug %r: documents %r and "
                "%r share the same path.",
                path.strip("/"),
                files[path].get("id"),
                document.get("id"),
            )
            continue
        files[path] = document
        raw_slugs[path] = slug
        has_slugs[path] = has_slug

    def skip_collision(ancestor: str, path: str) -> None:
        logger.warning(
            "Skipping Dify document path collision: document %r uses "
            "file path %r but document %r requires it as a directory "
            "prefix.",
            files[ancestor].get("id"),
            ancestor.strip("/"),
            files[path].get("id"),
        )

    def file_row(path: str, document: dict[str, Any]) -> FileStat:
        # No size: the API's is the uploaded source file (a PDF, say), not
        # the segment text this mount serves, so it rides in extra.
        created = epoch_text(document.get("created_at"))
        return FileStat(
            name=gnu_basename(path),
            type=FileType.FILE,
            content=ContentType.TEXT,
            modified=created,
            birthtime=created,
            extra={
                "slug": path.strip("/"),
                "source_size": extract_document_size(document),
                "slug_metadata_name": slug_metadata_name,
                "raw_slug": raw_slugs[path],
                "has_slug": has_slugs[path],
                "tokens": document.get("tokens"),
                "indexing_status": document.get("indexing_status"),
                "data_source_type": document.get("data_source_type"),
                "document_id": str(document["id"]),
            },
        )

    return dir_rows(drop_collisions(files, skip_collision), file_row)


def extract_slug(
    document: dict[str, Any], slug_metadata_name: str = "slug"
) -> tuple[str, bool]:
    metadata = document.get("doc_metadata")
    if isinstance(metadata, list):
        for item in metadata:
            if (
                isinstance(item, dict)
                and item.get("name") == slug_metadata_name
            ):
                value = item.get("value")
                if value is not None:
                    return str(value), True
    if (
        isinstance(metadata, dict)
        and metadata.get(slug_metadata_name) is not None
    ):
        return str(metadata[slug_metadata_name]), True
    name = document.get("name")
    if name is None:
        raise ValueError("missing document name")
    return str(name), False


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


def epoch_text(value: JsonValue) -> str | None:
    """A Dify timestamp as ``YYYY-MM-DDTHH:MM:SSZ``.

    Args:
        value (JsonValue): The API field, epoch seconds; a string passes
            through.
    """
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return epoch_to_iso(value)
    return str(value)


DIFY_TREE = SlugTree(load_tree)
