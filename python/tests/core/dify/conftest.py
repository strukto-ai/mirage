from types import SimpleNamespace

import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.cache.index.config import IndexEntry
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


def file_entry(document_id: str, name: str, size: int = 123) -> IndexEntry:
    return IndexEntry(id=document_id,
                      name=name,
                      resource_type="file",
                      size=size)


def folder_entry(name: str) -> IndexEntry:
    return IndexEntry(id=name, name=name, resource_type="folder")


async def no_documents(config):
    return []


async def list_basic_documents(config):
    return [
        document("doc-1", "Quickstart", slug="guides/quickstart", size=333),
        document("doc-2", "README.md", size=None),
    ]


async def list_nested_documents(config):
    return [
        document("doc-1", "Quickstart", slug="guides/quickstart", size=333),
        document("doc-2", "Notes", slug="guides/deep/note", size=20),
        document("doc-3", "README.md", size=10),
    ]


async def noop_ensure_tree(accessor, index, prefix=""):
    return None


@pytest.fixture
def dify_accessor() -> SimpleNamespace:
    return SimpleNamespace(config=SimpleNamespace(dataset_id="dataset-1",
                                                  slug_metadata_name="slug"))


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
        "/knowledge/guides/quickstart",
        mount_key("/knowledge/guides/quickstart", "/knowledge"))
