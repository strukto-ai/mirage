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

from mirage.errors.posix import POSIX
from mirage.errors.types import FsCondition


def test_posix_table_covers_the_whole_vocabulary():
    # The gate of R5a: a condition cannot be half-added. The shared base
    # is pinned here; each runtime dialect pins its own totality beside
    # its boundary (tests/runtime/wasm/test_abi.py for the preview1
    # wire, tests/runtime/python/monty/test_errors.py for CPython).
    assert set(POSIX) == set(FsCondition)


def test_vocabulary_names_the_probed_conditions():
    # The triage from the R5 inventory: what a mount, the namespace, a
    # policy, or the cross-mount guard can produce.
    names = {c.name for c in FsCondition}
    assert names == {
        "ENOENT", "ENOTDIR", "EISDIR", "EEXIST", "EACCES", "EPERM",
        "ENOTEMPTY", "EXDEV", "CROSS_MOUNT", "ENOTSUP", "ELOOP", "EINVAL",
        "EIO", "EBUSY", "EROFS", "NO_XATTR"
    }
