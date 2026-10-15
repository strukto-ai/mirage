import pytest

from mirage.core.slug_tree.read import file_entry
from mirage.core.slug_tree.rows import folder_row
from mirage.types import FileStat, FileType

from .conftest import spec


def test_file_entry_answers_a_file_and_refuses_the_rest():
    row = FileStat(name="quickstart", type=FileType.FILE)

    assert file_entry(spec("/knowledge/guides/quickstart"), row) is row
    with pytest.raises(IsADirectoryError):
        file_entry(spec("/knowledge/guides"), folder_row("guides"))
    with pytest.raises(IsADirectoryError):
        file_entry(spec("/knowledge"), None)
    with pytest.raises(FileNotFoundError):
        file_entry(spec("/knowledge/guides/missing"), None)
