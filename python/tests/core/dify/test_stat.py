import pytest

from mirage.core.dify import stat, tree
from mirage.types import ContentType, FileType, PathSpec
from mirage.utils.key_prefix import mount_key

from .conftest import document


async def list_documents(config):
    return [document("doc-1", "Quickstart", slug="guides/quickstart")]


async def get_detail(config, document_id):
    return {"updated_at": 1716285600, "tokens": 21}


async def refuse_detail(config, document_id):
    raise AssertionError("this stat should not fetch document detail")


@pytest.fixture(autouse=True)
def documents(monkeypatch):
    monkeypatch.setattr(tree, "list_all_documents", list_documents)


@pytest.mark.asyncio
async def test_stat_light_uses_index_entry_without_detail_call(
    monkeypatch, dify_accessor, dify_index, guide_path
):
    monkeypatch.setattr(stat, "get_document_detail", refuse_detail)

    item = await stat.stat_light(dify_accessor, guide_path, dify_index)

    assert item.name == "quickstart"
    assert item.content == ContentType.TEXT
    assert item.size is None
    assert item.extra["source_size"] == 123
    assert item.modified == "2024-05-21T09:00:00Z"
    assert item.birthtime == "2024-05-21T09:00:00Z"
    assert item.extra["slug"] == "guides/quickstart"


@pytest.mark.asyncio
async def test_stat_of_a_directory_skips_the_detail_call(
    monkeypatch, dify_accessor, dify_index
):
    monkeypatch.setattr(stat, "get_document_detail", refuse_detail)
    guides = PathSpec.from_str_path(
        "/knowledge/guides", mount_key("/knowledge/guides", "/knowledge")
    )

    item = await stat.stat(dify_accessor, guides, dify_index)

    assert item.name == "guides"
    assert item.type == FileType.DIRECTORY


@pytest.mark.asyncio
async def test_stat_fills_the_detail_fields(
    monkeypatch, dify_accessor, dify_index, guide_path
):
    monkeypatch.setattr(stat, "get_document_detail", get_detail)

    item = await stat.stat(dify_accessor, guide_path, dify_index)

    assert item.size is None
    assert item.extra["document_id"] == "doc-1"
    assert item.extra["source_size"] == 123
    assert item.extra["tokens"] == 21
    assert item.modified == "2024-05-21T10:00:00Z"
    assert item.birthtime == "2024-05-21T09:00:00Z"


@pytest.mark.asyncio
async def test_stat_falls_back_to_the_listing_without_detail_times(
    monkeypatch, dify_accessor, dify_index, guide_path
):
    async def bare_detail(config, document_id):
        return {}

    monkeypatch.setattr(stat, "get_document_detail", bare_detail)

    item = await stat.stat(dify_accessor, guide_path, dify_index)

    assert item.extra["source_size"] == 123
    assert item.modified == "2024-05-21T09:00:00Z"
    assert item.birthtime == "2024-05-21T09:00:00Z"
