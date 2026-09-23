from mirage.core.mem0.scope import detect_scope
from mirage.types import PathSpec


def test_root():
    match = detect_scope(
        PathSpec(virtual="/mem", directory="/mem", vfs_path=""))
    assert match.kind == "root"
    assert match.slots == {}


def test_memory_file():
    p = PathSpec(virtual="/mem/abc.json",
                 directory="/mem",
                 vfs_path="abc.json")
    match = detect_scope(p)
    assert match.kind == "memory"
    assert match.slots == {"memory_id": "abc"}


def test_hidden_is_invalid():
    p = PathSpec(virtual="/mem/.secret", directory="/mem", vfs_path=".secret")
    assert detect_scope(p).kind == "invalid"


def test_empty_memory_id_is_invalid():
    p = PathSpec(virtual="/mem/.json", directory="/mem", vfs_path=".json")
    assert detect_scope(p).kind == "invalid"


def test_nested_path_is_invalid():
    p = PathSpec(virtual="/mem/a.json/b",
                 directory="/mem",
                 vfs_path="a.json/b")
    assert detect_scope(p).kind == "invalid"
