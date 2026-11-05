import pytest

from mirage.types import ContentType, FileStat, FileType

_NON_FILE = [k for k in FileType if k is not FileType.FILE]


@pytest.mark.parametrize("kind", _NON_FILE)
def test_content_is_rejected_on_a_non_file_kind(kind):
    # The one invariant the model enforces: content is a regular file's
    # rendering hint, so a directory, symlink or device may not carry
    # one. A FILE, by contrast, may carry content or leave it None.
    with pytest.raises(ValueError):
        FileStat(name="x", type=kind, content=ContentType.JSON)


def test_type_is_required():
    # No default on type: a construction that forgets the node kind fails
    # loud rather than silently defaulting to a regular file.
    with pytest.raises(TypeError):
        FileStat(name="x")
