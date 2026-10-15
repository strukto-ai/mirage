import pytest

from mirage.core.slug_tree.rows import dir_rows, normalize_slug
from mirage.types import FileType

from .conftest import FILES, file_row


def test_normalize_slug_folds_slashes_and_names_the_backend():
    assert normalize_slug("/a//b/", "Chroma path") == "/a/b"
    with pytest.raises(ValueError, match="Invalid empty Chroma path"):
        normalize_slug("//", "Chroma path")
    with pytest.raises(
        ValueError, match="Invalid Dify document slug segment: '..'"
    ):
        normalize_slug("a/../b", "Dify document slug")


def test_dir_rows_lays_each_folder_out_by_tree_path():
    rows = dir_rows(FILES, file_row)

    assert sorted(rows) == ["/", "/api", "/guides"]
    assert [(row.name, row.type) for row in rows["/"]] == [
        ("api", FileType.DIRECTORY),
        ("guides", FileType.DIRECTORY),
    ]
    assert [row.name for row in rows["/guides"]] == ["quickstart"]
