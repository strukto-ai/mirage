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

from mirage.errors.guest import GUEST
from mirage.errors.posix import POSIX
from mirage.errors.types import FsCondition
from mirage.errors.wasi import WASI


def test_every_number_table_covers_the_whole_vocabulary():
    # The gate of R5a: a condition cannot be half-added. Every boundary
    # table keys on exactly the enum, no more, no fewer.
    conditions = set(FsCondition)
    assert set(POSIX) == conditions
    assert set(WASI) == conditions
    assert set(GUEST) == conditions


def test_vocabulary_names_the_probed_conditions():
    # The triage from the R5 inventory: what a mount, the namespace, a
    # policy, or the cross-mount guard can produce.
    names = {c.name for c in FsCondition}
    assert names == {
        "ENOENT", "ENOTDIR", "EISDIR", "EEXIST", "EACCES", "EPERM",
        "ENOTEMPTY", "EXDEV", "CROSS_MOUNT", "ENOTSUP", "ELOOP", "EINVAL",
        "EIO", "EBUSY", "EROFS", "NO_XATTR"
    }
