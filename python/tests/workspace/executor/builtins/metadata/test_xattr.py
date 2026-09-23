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

from mirage.commands.spec import SPECS, parse_command
from mirage.errors import FsCondition, posix_errno
from mirage.workspace.executor.builtins.metadata.xattr import (
    GETFATTR_USAGE, attr_error, attr_operands, attr_usage_refusal)


def test_attr_error_says_no_such_attribute_whatever_the_platform_errno():
    missing = OSError(posix_errno(FsCondition.NO_XATTR), "x", "/f")
    assert attr_error(missing) == "No such attribute"
    assert attr_error(PermissionError(errno.EPERM, "x",
                                      "/f")) == "Operation not permitted"
    assert attr_error(FileNotFoundError("/f")) == "No such file or directory"


def test_attr_operands_resolve_against_the_cwd_and_keep_the_typed_word():
    parsed = parse_command(SPECS["getfattr"], ["-d", "d/f", "/abs"], "/r",
                           "getfattr")
    found = [(p.virtual, p.raw_path) for p in attr_operands(parsed)]
    assert found == [("/r/d/f", "d/f"), ("/abs", "/abs")]


def test_a_refused_line_gets_getopts_line_then_the_usage_block():
    parsed = parse_command(SPECS["getfattr"], ["-Z", "f"], "/", "getfattr")
    _, io, _ = attr_usage_refusal("getfattr", parsed, GETFATTR_USAGE)
    assert io.exit_code == 2
    assert io.stderr == ("getfattr: invalid option -- 'Z'\n" +
                         GETFATTR_USAGE).encode()


def test_an_accepted_line_is_not_refused():
    parsed = parse_command(SPECS["getfattr"], ["-d", "f"], "/", "getfattr")
    assert attr_usage_refusal("getfattr", parsed, GETFATTR_USAGE) is None
