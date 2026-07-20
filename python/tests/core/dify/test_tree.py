import pytest

from mirage.core.dify import tree
from mirage.core.dify._client import is_visible_document

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
        {
            "id": "doc-2"
        },
        document("doc-3", "bad", slug="../bad"),
        document("", "missing-id", slug="missing-id"),
    ]


@pytest.mark.asyncio
async def test_ensure_tree_builds_prefixed_entries_and_uses_api_size(
        monkeypatch, dify_accessor, dify_index):
    tree_calls["documents"] = 0
    monkeypatch.setattr(tree, "list_all_documents", counted_documents)

    await tree.ensure_tree(dify_accessor, dify_index, "/knowledge/")

    root = await dify_index.list_dir("/knowledge")
    guides = await dify_index.list_dir("/knowledge/guides")
    quickstart = await dify_index.get("/knowledge/guides/quickstart")
    readme = await dify_index.get("/knowledge/README.md")

    assert root.entries == ["/knowledge/README.md", "/knowledge/guides"]
    assert guides.entries == ["/knowledge/guides/quickstart"]
    assert quickstart.entry.id == "doc-1"
    assert quickstart.entry.size == 333
    assert quickstart.entry.extra["slug"] == "guides/quickstart"
    assert quickstart.entry.extra["raw_slug"] == "guides/quickstart"
    assert quickstart.entry.extra["has_slug"] is True
    assert readme.entry.id == "doc-6"
    assert readme.entry.size is None
    assert readme.entry.extra["raw_slug"] == "README.md"
    assert readme.entry.extra["has_slug"] is False

    await tree.ensure_tree(dify_accessor, dify_index, "/knowledge/")
    assert tree_calls["documents"] == 1


@pytest.mark.asyncio
async def test_ensure_tree_skips_duplicate_slug(monkeypatch, caplog,
                                                dify_accessor, dify_index):
    monkeypatch.setattr(tree, "list_all_documents", duplicate_documents)

    await tree.ensure_tree(dify_accessor, dify_index, "")

    root = await dify_index.list_dir("/")
    kept = await dify_index.get("/same")
    assert root.entries == ["/same"]
    assert kept.entry.id == "doc-1"
    assert "Skipping duplicate Dify document slug" in caplog.text


@pytest.mark.asyncio
async def test_ensure_tree_skips_path_collision(monkeypatch, caplog,
                                                dify_accessor, dify_index):
    monkeypatch.setattr(tree, "list_all_documents", collision_documents)

    await tree.ensure_tree(dify_accessor, dify_index, "")

    root = await dify_index.list_dir("/")
    kept = await dify_index.get("/foo")
    skipped = await dify_index.get("/foo/bar")
    assert root.entries == ["/foo"]
    assert kept.entry.id == "doc-1"
    assert skipped.entry is None
    assert "Skipping Dify document path collision" in caplog.text


@pytest.mark.asyncio
async def test_ensure_tree_skips_invalid_documents(monkeypatch, caplog,
                                                   dify_accessor, dify_index):
    monkeypatch.setattr(tree, "list_all_documents", invalid_documents)

    await tree.ensure_tree(dify_accessor, dify_index, "")

    root = await dify_index.list_dir("/")
    assert root.entries == ["/valid"]
    assert caplog.text.count("Skipping invalid Dify document") == 3


def test_tree_slug_and_timestamp_helpers():
    assert tree.extract_slug({
        "doc_metadata": {
            "slug": "a/b"
        },
        "name": "fallback"
    }) == ("a/b", True)
    assert tree.extract_slug(
        {
            "doc_metadata": [{
                "name": "path",
                "value": "docs/start"
            }],
            "name": "fallback"
        }, "path") == ("docs/start", True)
    assert tree.extract_slug(
        {
            "doc_metadata": {
                "path": "docs/map"
            },
            "name": "fallback"
        }, "path") == ("docs/map", True)
    assert tree.normalize_slug("/a//b/") == "/a/b"
    assert tree.extract_document_size(
        {"data_source_info": {
            "upload_file": {
                "size": 7
            }
        }}) == 7
    assert tree.timestamp_to_iso(None) == ""
    assert tree.virtual_path("/a", "/knowledge/") == "/knowledge/a"
    assert tree.parent("/a/b") == "/a"
    assert tree.gnu_basename("/a/b") == "b"


def test_normalize_slug_rejects_invalid_segments():
    with pytest.raises(ValueError, match="Invalid empty"):
        tree.normalize_slug("/")
    with pytest.raises(ValueError, match="Invalid Dify document slug segment"):
        tree.normalize_slug("../x")
