import pytest

from mirage.core.slug_tree.stat import tree_stat
from mirage.types import FileStat, FileType

from .conftest import spec


def test_tree_stat_names_the_root_slash_and_answers_rows():
    root = tree_stat(spec("/knowledge"), None)
    row = FileStat(name="guides", type=FileType.DIRECTORY)

    assert root.name == "/"
    assert root.type == FileType.DIRECTORY
    assert root.extra == {"children_count": 0}
    assert tree_stat(spec("/knowledge/guides"), row) is row
    with pytest.raises(FileNotFoundError):
        tree_stat(spec("/knowledge/missing"), None)
