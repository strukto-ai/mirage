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

import pytest

from mirage.resource.dev.dev import _ZERO_CHUNK_SIZE, DevStore, _DevFiles


def test_contains_dev_names_with_or_without_slash():
    files = _DevFiles()
    assert "/null" in files
    assert "null" in files
    assert "/zero" in files
    assert "zero" in files
    assert "/other" not in files


def test_null_reads_empty_and_zero_reads_zeros():
    files = _DevFiles()
    assert files["/null"] == b""
    assert files["/zero"] == b"\x00" * _ZERO_CHUNK_SIZE
    with pytest.raises(KeyError):
        files["/missing"]


def test_set_on_active_device_is_discarded():
    files = _DevFiles()
    files["/null"] = b"overwrite"
    assert files["/null"] == b""
    assert files["/zero"] == b"\x00" * _ZERO_CHUNK_SIZE


def test_delete_tombstones_a_synthetic_device():
    files = _DevFiles()
    del files["/null"]
    assert "/null" not in files
    assert list(files.keys()) == ["/zero"]
    assert len(files) == 1
    with pytest.raises(KeyError):
        files["/null"]
    with pytest.raises(KeyError):
        del files["/null"]


def test_set_after_delete_stores_real_bytes():
    files = _DevFiles()
    del files["/null"]
    files["/null"] = b"recreated"
    assert "/null" in files
    assert files["/null"] == b"recreated"
    assert list(files.keys()) == ["/zero", "/null"]
    assert len(files) == 2


def test_delete_of_recreated_file_removes_it_again():
    files = _DevFiles()
    del files["/null"]
    files["/null"] = b"recreated"
    del files["/null"]
    assert "/null" not in files
    assert list(files.keys()) == ["/zero"]


def test_non_device_names_store_for_real():
    files = _DevFiles()
    files["/custom"] = b"bytes"
    assert "/custom" in files
    assert files["/custom"] == b"bytes"
    assert list(files.keys()) == ["/null", "/zero", "/custom"]
    del files["/custom"]
    assert "/custom" not in files


def test_pop_mirrors_delete_semantics():
    files = _DevFiles()
    assert files.pop("/null") == b""
    assert "/null" not in files
    assert files.pop("/null", b"gone") == b"gone"
    files["/null"] = b"real"
    assert files.pop("/null") == b"real"
    assert "/null" not in files


def test_iterates_synthetic_then_real():
    files = _DevFiles()
    assert list(files) == ["/null", "/zero"]
    assert len(files) == 2


def test_dev_store_starts_with_synthetic_files_and_root():
    store = DevStore()
    assert list(store.files.keys()) == ["/null", "/zero"]
    assert "/" in store.dirs
    assert store.modified == {}
