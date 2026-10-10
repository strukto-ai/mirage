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
    COPY_OPS,
    DESTINATION_OPS,
    DISPATCH_READ_OPS,
    DISPATCH_WRITE_OPS,
    ENTRY_CREATE_OPS,
    FILE_CREATE_OPS,
    HIDDEN_CREATE_OPS,
    NAMESPACE_TABLE_OPS,
    NATIVE_WALK_OPS,
    NO_FOLLOW_OPS,
    POLICY_WRITE_OPS,
    SERIAL_WRITE_OPS,
    STAMP_WRITE_OPS,
    SUBTREE_OPS,
)

WRITES = {"write", "append", "pwrite", "create", "truncate"}


def test_the_op_classes_follow_the_declarations():
    # Every class is read off what the functions declare; this pins the
    # result so a declaration that moves an op between classes is seen.
    # A link-entry op never follows (lstat semantics) and a removal
    # stamps no mtime.
    assert DISPATCH_READ_OPS == {"read"}
    assert DISPATCH_WRITE_OPS == WRITES | {
        "mkdir",
        "unlink",
        "rmdir",
        "rm_r",
        "rename",
        "copy",
        "dir_copy",
    }
    assert POLICY_WRITE_OPS == DISPATCH_WRITE_OPS | {
        "setattr",
        "symlink",
        "setxattr",
        "removexattr",
    }
    assert NAMESPACE_TABLE_OPS == {"symlink", "readlink"}
    assert SERIAL_WRITE_OPS == WRITES | {"unlink", "rename", "copy"}
    assert FILE_CREATE_OPS == WRITES
    assert ENTRY_CREATE_OPS == {"mkdir", "symlink"}
    assert HIDDEN_CREATE_OPS == WRITES | ENTRY_CREATE_OPS
    assert NO_FOLLOW_OPS == {
        "unlink",
        "rename",
        "rmdir",
        "rm_r",
        "symlink",
        "readlink",
    }
    assert STAMP_WRITE_OPS == WRITES | {"mkdir"}
    assert COPY_OPS == {"copy", "dir_copy"}
    assert DESTINATION_OPS == {"rename", "copy", "dir_copy"}
    assert SUBTREE_OPS == {
        "rename",
        "rm_r",
        "dir_copy",
        "find",
        "du_size",
        "du_entries",
        "search",
    }
    assert NATIVE_WALK_OPS == SUBTREE_OPS - {"rename"} | {"copy"}
