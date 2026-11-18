# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
# ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import errno

import pytest

from mirage.core.dev.pipe import DevicePipe
from mirage.vfs.dev.store import DevFiles, DevStore
from mirage.vfs.dev.types import DevFileState
from mirage.vfs.ram.store import RAMFiles

# The synthetic devices, as a fresh store lists them.
DEVICES = ["/null", "/random", "/tty", "/urandom", "/zero"]


def _with_pipe() -> tuple[DevFiles, str]:
    files = DevFiles("owner")
    path, _ = files.allocate_input(DevicePipe(True))
    return files, path[4:]


def test_contains_dev_names_with_or_without_slash():
    files = DevFiles()
    assert "/null" in files
    assert "null" in files
    assert "/zero" in files
    assert "zero" in files
    assert "/other" not in files


def test_synthetic_devices_use_empty_store_placeholders():
    files = DevFiles()
    assert files["/null"] == b""
    assert files["/zero"] == b""
    with pytest.raises(KeyError):
        files["/missing"]


def test_set_on_active_device_is_discarded():
    files = DevFiles()
    files["/null"] = b"overwrite"
    assert files["/null"] == b""
    assert files["/zero"] == b""


def test_delete_tombstones_a_synthetic_device():
    files = DevFiles()
    del files["/null"]
    assert "/null" not in files
    assert list(files.keys()) == DEVICES[1:]
    assert len(files) == len(DEVICES) - 1
    with pytest.raises(KeyError):
        files["/null"]
    with pytest.raises(KeyError):
        del files["/null"]


def test_set_after_delete_stores_real_bytes():
    files = DevFiles()
    del files["/null"]
    files["/null"] = b"recreated"
    assert "/null" in files
    assert files["/null"] == b"recreated"
    assert list(files.keys()) == [*DEVICES[1:], "/null"]
    assert len(files) == len(DEVICES)


def test_delete_of_recreated_file_removes_it_again():
    files = DevFiles()
    del files["/null"]
    files["/null"] = b"recreated"
    del files["/null"]
    assert "/null" not in files
    assert list(files.keys()) == DEVICES[1:]


def test_non_device_names_store_for_real():
    files = DevFiles()
    files["/custom"] = b"bytes"
    assert "/custom" in files
    assert files["/custom"] == b"bytes"
    assert list(files.keys()) == [*DEVICES, "/custom"]
    del files["/custom"]
    assert "/custom" not in files


def test_clear_keeps_the_device_overlay_and_backing_files():
    files = DevFiles()
    files["/custom"] = b"bytes"
    files.clear()
    assert files.items() == [
        *((name, b"") for name in DEVICES),
        ("/custom", b"bytes"),
    ]


def test_directory_discard_accepts_non_string_keys():
    store = DevStore()
    store.dirs.discard(42)
    assert list(store.dirs) == ["/"]


def test_pop_mirrors_delete_semantics():
    files = DevFiles()
    assert files.pop("/null") == b""
    assert "/null" not in files
    assert files.pop("/null", b"gone") == b"gone"
    files["/null"] = b"real"
    assert files.pop("/null") == b"real"
    assert "/null" not in files
    assert files.pop("/missing", None) is None
    assert files.pop("/missing", 42) == 42
    with pytest.raises(KeyError):
        files.pop("/missing")


def test_iterates_synthetic_then_real():
    files = DevFiles()
    assert list(files) == DEVICES
    assert len(files) == len(DEVICES)


def test_dev_store_starts_with_synthetic_files_and_root():
    store = DevStore()
    assert list(store.files.keys()) == DEVICES
    assert "/" in store.dirs
    assert store.modified == {}


@pytest.mark.parametrize(
    "access,code",
    [
        (lambda files, key: files[key], errno.EINVAL),
        (lambda files, key: files.get(key), errno.EINVAL),
        (lambda files, key: files.__setitem__(key, b"lost"), errno.EINVAL),
        (lambda files, key: files.__delitem__(key), errno.EPERM),
        (lambda files, key: files.pop(key), errno.EPERM),
    ],
)
def test_pipe_row_refuses_byte_access_and_stays(access, code):
    files, key = _with_pipe()
    with pytest.raises(OSError) as caught:
        access(files, key)
    assert caught.value.errno == code
    assert files.pipe_of(key) is not None


def test_pipe_row_is_listed_and_counted_empty():
    files, key = _with_pipe()
    assert key in files
    assert list(files) == [*DEVICES, key]
    assert len(files) == len(DEVICES) + 1
    assert files.items()[-1] == (key, b"")
    assert files.values()[-1] == b""


def test_session_views_share_files_but_hide_each_others_descriptors():
    root = DevFiles()
    left, right = root.for_session("left"), root.for_session("right")
    endpoint = DevicePipe(True)
    path, allocation = left.allocate_input(endpoint)
    assert left.pipe_of(path[4:]) is endpoint
    assert path[4:] not in right
    assert right.pipe_of(path[4:]) is None
    assert (left.holds_pipe("/fd"), left.holds_pipe("/")) == (True, True)
    assert not right.holds_pipe("/fd")
    left["/ordinary"] = b"shared"
    assert right["/ordinary"] == b"shared"
    assert left.release_input(path, allocation)
    replacement, next_allocation = right.allocate_input(DevicePipe(False))
    assert replacement == path
    assert not left.release_input(path, allocation)
    assert right.release_input(replacement, next_allocation)


class _CountedReads(RAMFiles):
    """A RAM table that counts the reads that copy a whole file out."""

    def __init__(self) -> None:
        super().__init__()
        self.reads = 0

    def __getitem__(self, key: str) -> bytes:
        self.reads += 1
        return super().__getitem__(key)


def test_a_run_of_splices_lands_in_place_and_a_reader_keeps_its_bytes():
    table = _CountedReads()
    files = DevFiles(state=DevFileState(files=table))
    for at in range(0, 64, 4):
        files.splice("/log", at, b"abcd")
    assert table.reads == 0
    held = files["/log"]
    files.splice("/log", 64, b"tail")
    files.splice("/log", 0, b"ABCD")
    assert held == b"abcd" * 16
    assert files["/log"] == b"ABCD" + b"abcd" * 15 + b"tail"
    assert files.size("/log") == 68


def test_a_splice_past_the_end_fills_the_gap_and_an_empty_one_creates():
    files = DevFiles()
    files.splice("/gap", 0, b"ab")
    files.splice("/gap", 4, b"z")
    assert files["/gap"] == b"ab\0\0z"
    files.splice("/empty", 3, b"")
    assert files["/empty"] == b""


def test_a_splice_into_a_device_is_swallowed_until_it_is_removed():
    files = DevFiles()
    files.splice("/null", 0, b"lost")
    assert files["/null"] == b""
    del files["/null"]
    files.splice("/null", 0, b"kept")
    assert files["/null"] == b"kept"
    assert files.device_of("/null") is None


@pytest.mark.parametrize("access", ["splice", "size"])
def test_a_pipe_row_refuses_a_splice_and_its_size(access):
    files, key = _with_pipe()
    with pytest.raises(OSError) as caught:
        if access == "splice":
            files.splice(key, 0, b"lost")
        else:
            files.size(key)
    assert caught.value.errno == errno.EINVAL


def test_the_terminal_refuses_reads_and_writes_with_enxio():
    files = DevFiles()
    for touch in (
        lambda: files["/tty"],
        lambda: files.__setitem__("/tty", b"x"),
        lambda: files.splice("/tty", 0, b"x"),
    ):
        with pytest.raises(OSError) as caught:
            touch()
        assert caught.value.errno == errno.ENXIO


def test_random_devices_swallow_writes():
    files = DevFiles()
    files["/urandom"] = b"seed"
    files.splice("/random", 0, b"seed")
    assert files["/urandom"] == b""
    assert "/urandom" in files
