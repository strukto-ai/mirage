from mirage.core.msgraph.drive_ops import (DriveLoc, _move_body,
                                           _parent_reference)


def _url(path: str, action: str = "") -> str:
    return f"https://graph.example/drives/d1/root:/{path}:{action}"


def _ref(folder: str) -> str:
    return f"/drives/d1/root:/{folder}"


def _loc(drive: str, path: str) -> DriveLoc:
    return DriveLoc(drive=drive,
                    path=path,
                    virt=f"/{path}",
                    url=_url,
                    ref=_ref)


def test_child_extends_path_and_virt():
    child = _loc("d1", "a/b").child("c.txt")
    assert child.path == "a/b/c.txt"
    assert child.virt == "/a/b/c.txt"
    assert child.drive == "d1"


def test_parent_of_top_level_item_is_empty():
    assert _loc("d1", "a.txt").parent() == ""
    assert _loc("d1", "a/b.txt").parent() == "a"


def test_parent_reference_same_drive_has_no_drive_id():
    ref = _parent_reference(_loc("d1", "a.txt"), _loc("d1", "sub/b.txt"))
    assert ref == {"path": _ref("sub")}


def test_parent_reference_cross_drive_adds_drive_id():
    ref = _parent_reference(_loc("d1", "a.txt"), _loc("d2", "sub/b.txt"))
    assert ref["driveId"] == "d2"


def test_move_body_same_parent_is_rename_only():
    body = _move_body(_loc("d1", "a.txt"), _loc("d1", "b.txt"))
    assert body == {"name": "b.txt"}


def test_move_body_new_parent_includes_reference():
    body = _move_body(_loc("d1", "a.txt"), _loc("d1", "sub/b.txt"))
    assert body["parentReference"] == {"path": _ref("sub")}
