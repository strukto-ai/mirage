from types import SimpleNamespace

import pytest

from mirage.cache.index import RAMIndexCacheStore
from mirage.types import FileType, PathSpec
from mirage.utils.key_prefix import mount_key


def document(
    document_id: str,
    name: str,
    *,
    slug: str,
    size: int = 123,
) -> dict:
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
        "tokens": 9,
        "data_source_type": "upload_file",
        "data_source_detail_dict": {
            "upload_file": {
                "size": size
            }
        },
        "created_at": 1716282000,
    }


def accessor() -> SimpleNamespace:
    return SimpleNamespace(config=SimpleNamespace(slug_metadata_name="slug"))


@pytest.mark.asyncio
async def test_stat_light_uses_index_entry_without_detail_call(monkeypatch):
    from mirage.core.dify import stat, tree

    async def list_documents(config):
        return [document("doc-1", "Quickstart", slug="guides/quickstart")]

    async def get_detail(config, document_id):
        raise AssertionError("stat_light should not fetch document detail")

    monkeypatch.setattr(tree, "list_all_documents", list_documents)
    monkeypatch.setattr(stat, "get_document_detail", get_detail)

    index = RAMIndexCacheStore()
    path = PathSpec(
        resource_path=mount_key("/knowledge/guides/quickstart", "/knowledge"),
        virtual="/knowledge/guides/quickstart",
        directory="/knowledge/guides/quickstart",
    )

    item = await stat.stat_light(accessor(), path, index)

    assert item.name == "quickstart"
    assert item.type == FileType.TEXT
    assert item.size == 123
    assert item.modified == "2024-05-21T09:00:00+00:00"
    assert item.extra["slug"] == "guides/quickstart"


@pytest.mark.asyncio
async def test_stat_light_returns_directory_without_detail_call(monkeypatch):
    from mirage.core.dify import stat, tree

    async def list_documents(config):
        return [document("doc-1", "Quickstart", slug="guides/quickstart")]

    async def get_detail(config, document_id):
        raise AssertionError("stat_light should not fetch document detail")

    monkeypatch.setattr(tree, "list_all_documents", list_documents)
    monkeypatch.setattr(stat, "get_document_detail", get_detail)

    index = RAMIndexCacheStore()
    path = PathSpec(
        resource_path=mount_key("/knowledge/guides", "/knowledge"),
        virtual="/knowledge/guides",
        directory="/knowledge/guides",
    )

    item = await stat.stat_light(accessor(), path, index)

    assert item.name == "guides"
    assert item.type == FileType.DIRECTORY
    assert item.extra == {"children_count": 0}
