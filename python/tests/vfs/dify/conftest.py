from types import SimpleNamespace

import pytest

from tests.fixtures.vfs_io import StubAccessor


def document(document_id: str, name: str, slug: str, size: int = 12) -> dict:
    return {
        "id": document_id,
        "name": name,
        "doc_metadata": [{"name": "slug", "value": slug}],
        "enabled": True,
        "indexing_status": "completed",
        "archived": False,
        "tokens": 4,
        "data_source_type": "upload_file",
        "data_source_detail_dict": {"upload_file": {"size": size}},
        "created_at": 1716282000,
    }


@pytest.fixture
def dify_accessor() -> StubAccessor:
    return StubAccessor(config=SimpleNamespace(slug_metadata_name="slug"))
