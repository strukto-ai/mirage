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

from mirage.workspace.dispatcher.constants import (
    NO_FOLLOW_OPS,
    STAMP_WRITE_OPS,
)


def test_link_entry_ops_never_follow():
    # lstat semantics: the operand names the link itself, so no stat
    # surface may rewrite it through the table.
    assert set(NO_FOLLOW_OPS) == {
        "unlink",
        "rename",
        "rmdir",
        "symlink",
        "readlink",
    }


def test_removals_do_not_stamp_an_mtime():
    assert "unlink" not in STAMP_WRITE_OPS
    assert "rmdir" not in STAMP_WRITE_OPS
    assert "write" in STAMP_WRITE_OPS
