from types import SimpleNamespace

import pytest

from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def document(
    document_id: str,
    name: str,
    *,
    slug: object | None = None,
    enabled: bool = True,
    indexing_status: str = "completed",
    archived: bool = False,
    size: int | None = 123,
) -> dict:
    doc_metadata = []
    if slug is not None:
        doc_metadata = [{"name": "slug", "value": slug}]
    data_source_detail_dict = {}
    if size is not None:
        data_source_detail_dict = {"upload_file": {"size": size}}
    return {
        "id": document_id,
        "name": name,
        "doc_metadata": doc_metadata,
        "enabled": enabled,
        "indexing_status": indexing_status,
        "archived": archived,
        "tokens": 9,
        "data_source_type": "upload_file",
        "data_source_detail_dict": data_source_detail_dict,
        "created_at": 1716282000,
    }


async def list_basic_documents(config):
    return [
        document("doc-1", "Quickstart", slug="guides/quickstart", size=333),
        document("doc-2", "README.md", size=None),
    ]


@pytest.fixture
def dify_accessor() -> SimpleNamespace:
    return SimpleNamespace(
        config=SimpleNamespace(
            dataset_id="dataset-1", slug_metadata_name="slug"
        )
    )


@pytest.fixture
def guide_path() -> PathSpec:
    return PathSpec.from_str_path(
        "/knowledge/guides/quickstart",
        mount_key("/knowledge/guides/quickstart", "/knowledge"),
    )
