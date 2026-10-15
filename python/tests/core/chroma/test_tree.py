import base64
import gzip

import pytest

from mirage.core.chroma import tree


@pytest.mark.asyncio
async def test_load_tree_lays_out_rows_from_the_path_tree(chroma_accessor):
    rows = await tree.load_tree(chroma_accessor)

    assert [row.name for row in rows["/"]] == ["api", "guides"]
    assert [row.name for row in rows["/api"]] == ["reference"]
    (quickstart,) = rows["/guides"]
    assert quickstart.name == "quickstart"
    # The path tree's own size never becomes the byte length: it describes
    # the producer's source document, so it rides in extra and the size is
    # measured later, from the rendered chunks.
    assert quickstart.size is None
    assert quickstart.modified == "2026-02-01T00:00:00Z"
    assert quickstart.extra == {
        "slug": "guides/quickstart",
        "source_size": 12,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-02-01T00:00:00Z",
    }


def test_parse_path_tree_accepts_gzip_base64():
    encoded = base64.b64encode(gzip.compress(b'{"docs/a": {}}')).decode()

    assert tree.parse_path_tree(encoded) == {"docs/a": {}}


def test_build_dir_entries_rejects_duplicate_and_collision():
    with pytest.raises(ValueError, match="Duplicate Chroma path"):
        tree.build_dir_entries({"a": {}, "/a/": {}})

    with pytest.raises(ValueError, match="Path collision"):
        tree.build_dir_entries({"a": {}, "a/b": {}})
