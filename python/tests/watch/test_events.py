from mirage.types import FileChangeKind, PathSpec
from mirage.watch.events import event_at, field, text_field, virtual_of


def _root(virtual: str, vfs_path: str) -> PathSpec:
    return PathSpec(virtual=virtual, directory=virtual, vfs_path=vfs_path)


def test_virtual_of_lifts_onto_the_mount_prefix():
    assert virtual_of(_root("/d", ""), "day/a.txt") == "/d/day/a.txt"


def test_virtual_of_accepts_a_leading_slash():
    assert virtual_of(_root("/d", ""), "/day/a.txt") == "/d/day/a.txt"


def test_virtual_of_on_an_unprefixed_mount():
    assert virtual_of(_root("/", ""), "day/a.txt") == "/day/a.txt"


def test_virtual_of_empty_relative_is_the_mount_root():
    assert virtual_of(_root("/d", ""), "/") == "/d"


def test_virtual_of_recovers_the_prefix_from_a_nested_root():
    assert virtual_of(_root("/d/day", "day"), "other/b.txt") == \
        "/d/other/b.txt"


def test_event_at_frames_both_halves_of_the_path():
    event = event_at(_root("/d", ""), "day/a.txt", FileChangeKind.CREATE)
    assert event.kind is FileChangeKind.CREATE
    assert event.path.virtual == "/d/day/a.txt"
    assert event.path.vfs_path == "day/a.txt"
    assert event.previous_path is None


def test_event_at_frames_a_previous_path_for_a_move():
    event = event_at(_root("/d", ""), "day/new.txt", FileChangeKind.MOVE,
                     "day/old.txt")
    assert event.previous_path is not None
    assert event.previous_path.virtual == "/d/day/old.txt"
    assert event.previous_path.vfs_path == "day/old.txt"


def test_event_at_stamps_an_aware_timestamp():
    event = event_at(_root("/d", ""), "a.txt", FileChangeKind.UPDATE)
    assert event.timestamp.tzinfo is not None


def test_field_reads_from_an_object():
    assert field({"a": 1}, "a") == 1
    assert field({"a": 1}, "b") is None


def test_field_tolerates_a_payload_that_is_not_an_object():
    assert field("a string", "a") is None
    assert field(["a", "list"], "a") is None
    assert field(None, "a") is None


def test_text_field_rejects_a_non_string_value():
    assert text_field({"a": "x"}, "a") == "x"
    assert text_field({"a": 7}, "a") is None
    assert text_field({"a": {"nested": "x"}}, "a") is None
