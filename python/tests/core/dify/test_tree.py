import pytest

from mirage.core.dify import tree
from mirage.core.dify.client import is_visible_document

from .conftest import document

tree_calls = {"documents": 0}


async def list_documents_with_hidden_and_fallbacks(config):
    # Mirrors the list_all_documents contract: hidden documents (archived,
    # disabled, still indexing) never leave the client.
    documents = [
        document("doc-1", "Quickstart", slug="guides/quickstart", size=333),
        document("doc-2", "API", slug="api", size=444, archived=True),
        document("doc-3", "Draft", slug="draft", indexing_status="indexing"),
        document("doc-4", "Disabled", slug="disabled", enabled=False),
        document("doc-5", "Archived", slug="archived", archived=True),
        document("doc-6", "README.md", size=None),
    ]
    return [doc for doc in documents if is_visible_document(doc)]


async def counted_documents(config):
    tree_calls["documents"] += 1
    return await list_documents_with_hidden_and_fallbacks(config)


async def duplicate_documents(config):
    return [
        document("doc-1", "one", slug="same"),
        document("doc-2", "two", slug="same"),
    ]


async def collision_documents(config):
    return [
        document("doc-1", "foo", slug="foo"),
        document("doc-2", "bar", slug="foo/bar"),
    ]


async def invalid_documents(config):
    return [
        document("doc-1", "valid", slug="valid"),
        {"id": "doc-2"},
        document("doc-3", "bad", slug="../bad"),
        document("", "missing-id", slug="missing-id"),
        {**document("doc-4", "unnamed"), "name": None},
    ]


def _names(rows, folder: str) -> list[str]:
    return [row.name for row in rows[folder]]


def _row(rows, folder: str, name: str):
    return next(row for row in rows[folder] if row.name == name)


@pytest.mark.asyncio
async def test_load_tree_keeps_the_source_size_in_extra(
    monkeypatch, dify_accessor
):
    tree_calls["documents"] = 0
    monkeypatch.setattr(tree, "list_all_documents", counted_documents)

    rows = await tree.load_tree(dify_accessor)

    quickstart = _row(rows, "/guides", "quickstart")
    readme = _row(rows, "/", "README.md")
    assert _names(rows, "/") == ["README.md", "guides"]
    assert _names(rows, "/guides") == ["quickstart"]
    assert quickstart.extra["document_id"] == "doc-1"
    assert quickstart.size is None
    assert quickstart.extra["source_size"] == 333
    assert quickstart.extra["slug"] == "guides/quickstart"
    assert quickstart.extra["raw_slug"] == "guides/quickstart"
    assert quickstart.extra["has_slug"] is True
    assert quickstart.modified == "2024-05-21T09:00:00Z"
    assert readme.extra["document_id"] == "doc-6"
    assert readme.extra["source_size"] is None
    assert readme.extra["raw_slug"] == "README.md"
    assert readme.extra["has_slug"] is False
    assert tree_calls["documents"] == 1


@pytest.mark.asyncio
async def test_load_tree_skips_duplicate_slug(
    monkeypatch, caplog, dify_accessor
):
    monkeypatch.setattr(tree, "list_all_documents", duplicate_documents)

    rows = await tree.load_tree(dify_accessor)

    assert _names(rows, "/") == ["same"]
    assert _row(rows, "/", "same").extra["document_id"] == "doc-1"
    assert "Skipping duplicate Dify document slug" in caplog.text


@pytest.mark.asyncio
async def test_load_tree_skips_path_collision(
    monkeypatch, caplog, dify_accessor
):
    monkeypatch.setattr(tree, "list_all_documents", collision_documents)

    rows = await tree.load_tree(dify_accessor)

    assert _names(rows, "/") == ["foo"]
    assert _row(rows, "/", "foo").extra["document_id"] == "doc-1"
    assert "/foo" not in rows
    assert "Skipping Dify document path collision" in caplog.text


@pytest.mark.asyncio
async def test_load_tree_skips_invalid_documents(
    monkeypatch, caplog, dify_accessor
):
    monkeypatch.setattr(tree, "list_all_documents", invalid_documents)

    rows = await tree.load_tree(dify_accessor)

    assert _names(rows, "/") == ["valid"]
    assert caplog.text.count("Skipping invalid Dify document") == 4


def test_tree_slug_and_timestamp_helpers():
    assert tree.extract_slug(
        {"doc_metadata": {"slug": "a/b"}, "name": "fallback"}
    ) == ("a/b", True)
    assert tree.extract_slug(
        {
            "doc_metadata": [{"name": "path", "value": "docs/start"}],
            "name": "fallback",
        },
        "path",
    ) == ("docs/start", True)
    assert tree.extract_slug(
        {"doc_metadata": {"path": "docs/map"}, "name": "fallback"}, "path"
    ) == ("docs/map", True)
    assert (
        tree.extract_document_size(
            {"data_source_info": {"upload_file": {"size": 7}}}
        )
        == 7
    )
    assert tree.epoch_text(1716282000) == "2024-05-21T09:00:00Z"
    assert tree.epoch_text("2026-01-01T00:00:00Z") == "2026-01-01T00:00:00Z"
    assert tree.epoch_text(None) is None
