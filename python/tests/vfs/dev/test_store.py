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
    assert list(files.keys()) == ["/zero"]
    assert len(files) == 1
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
    assert list(files.keys()) == ["/zero", "/null"]
    assert len(files) == 2


def test_delete_of_recreated_file_removes_it_again():
    files = DevFiles()
    del files["/null"]
    files["/null"] = b"recreated"
    del files["/null"]
    assert "/null" not in files
    assert list(files.keys()) == ["/zero"]


def test_non_device_names_store_for_real():
    files = DevFiles()
    files["/custom"] = b"bytes"
    assert "/custom" in files
    assert files["/custom"] == b"bytes"
    assert list(files.keys()) == ["/null", "/zero", "/custom"]
    del files["/custom"]
    assert "/custom" not in files


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
    assert list(files) == ["/null", "/zero"]
    assert len(files) == 2


def test_dev_store_starts_with_synthetic_files_and_root():
    store = DevStore()
    assert list(store.files.keys()) == ["/null", "/zero"]
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
    assert list(files) == ["/null", "/zero", key]
    assert len(files) == 3
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
