from types import SimpleNamespace

import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.types import PathSpec
from mirage.utils.key_prefix import mount_key


def document(document_id: str, name: str, slug: str, size: int = 12) -> dict:
    return {
        "id": document_id,
        "name": name,
        "doc_metadata": [{
            "name": "slug",
            "value": slug
        }],
        "enabled": True,
        "indexing_status": "completed",
        "archived": False,
        "tokens": 4,
        "data_source_type": "upload_file",
        "data_source_detail_dict": {
            "upload_file": {
                "size": size
            }
        },
        "created_at": 1716282000,
    }


@pytest.fixture
def dify_accessor() -> SimpleNamespace:
    return SimpleNamespace(config=SimpleNamespace(slug_metadata_name="slug"))


@pytest.fixture
def dify_index() -> RAMIndexCacheStore:
    return RAMIndexCacheStore()


@pytest.fixture
def knowledge_root() -> PathSpec:
    return PathSpec(resource_path=mount_key("/knowledge", "/knowledge"),
                    virtual="/knowledge",
                    directory="/knowledge")


@pytest.fixture
def guide_path() -> PathSpec:
    return PathSpec.from_str_path(
        "/knowledge/guides/quickstart.md",
        mount_key("/knowledge/guides/quickstart.md", "/knowledge"))


@pytest.fixture
def guides_path() -> PathSpec:
    return PathSpec(resource_path=mount_key("/knowledge/guides", "/knowledge"),
                    virtual="/knowledge/guides",
                    directory="/knowledge/guides")
