import base64
import gzip
import json

import pytest

from mirage.core.chroma import tree


@pytest.mark.asyncio
async def test_ensure_tree_builds_prefixed_entries_from_path_tree(
        chroma_accessor, chroma_index):
    await tree.ensure_tree(chroma_accessor, chroma_index, "/knowledge/")

    root = await chroma_index.list_dir("/knowledge")
    guides = await chroma_index.list_dir("/knowledge/guides")
    api = await chroma_index.list_dir("/knowledge/api")
    quickstart = await chroma_index.get("/knowledge/guides/quickstart")

    assert root.entries == ["/knowledge/api", "/knowledge/guides"]
    assert guides.entries == ["/knowledge/guides/quickstart"]
    assert api.entries == ["/knowledge/api/reference"]
    assert quickstart.entry.id == "guides/quickstart"
    # The path tree's own size never becomes the byte length: it describes
    # the producer's source document, so it rides in extra and the size is
    # measured later, from the rendered chunks.
    assert quickstart.entry.size is None
    assert quickstart.entry.remote_time == "2026-02-01T00:00:00Z"
    assert quickstart.entry.extra == {
        "slug": "guides/quickstart",
        "source_size": 12,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-02-01T00:00:00Z",
    }


@pytest.mark.asyncio
async def test_ensure_tree_uses_cached_tree(chroma_accessor, chroma_index):
    await tree.ensure_tree(chroma_accessor, chroma_index, "/knowledge/")
    chroma_accessor.collection.documents["__path_tree__"] = json.dumps(
        {"other": {}})

    await tree.ensure_tree(chroma_accessor, chroma_index, "/knowledge/")

    assert (await
            chroma_index.get("/knowledge/guides/quickstart")).entry is not None
    assert (await chroma_index.get("/knowledge/other")).entry is None


def test_parse_path_tree_accepts_gzip_base64():
    encoded = base64.b64encode(gzip.compress(b'{"docs/a": {}}')).decode()

    assert tree.parse_path_tree(encoded) == {"docs/a": {}}


def test_build_dir_entries_rejects_duplicate_and_collision():
    with pytest.raises(ValueError, match="Duplicate Chroma path"):
        tree.build_dir_entries({"a": {}, "/a/": {}}, "")

    with pytest.raises(ValueError, match="Path collision"):
        tree.build_dir_entries({"a": {}, "a/b": {}}, "")
