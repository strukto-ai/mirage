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

from mirage.core.disk.errors import disk_errors
from mirage.utils.errors import fs_strerror


def test_disk_errors_passes_success_through():
    with disk_errors("/data/a.txt"):
        value = 1
    assert value == 1


def test_disk_errors_replaces_the_host_path_with_the_virtual_one():
    with pytest.raises(NotADirectoryError) as caught:
        with disk_errors("/data/plain/x.txt"):
            raise NotADirectoryError(
                errno.ENOTDIR, "Not a directory",
                "/private/var/folders/tmpabc/plain/x.txt")
    assert caught.value.filename == "/data/plain/x.txt"
    assert "/private/var" not in str(caught.value)


def test_disk_errors_preserves_the_type_and_errno():
    with pytest.raises(FileExistsError) as caught:
        with disk_errors("/data/a.txt"):
            raise FileExistsError(errno.EEXIST, "File exists", "/real/a.txt")
    assert caught.value.errno == errno.EEXIST
    assert fs_strerror(caught.value) == "File exists"


def test_disk_errors_leaves_non_os_errors_alone():
    with pytest.raises(ValueError, match="boom"):
        with disk_errors("/data/a.txt"):
            raise ValueError("boom")
