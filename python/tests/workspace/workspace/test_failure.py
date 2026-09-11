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

from mirage.commands.errors import (CommandTimeoutError, FindParseError,
                                    UsageError)
from mirage.runtime.routing import RouteDeny
from mirage.types import Refusal
from mirage.workspace.workspace.failure import failure_result


def test_timeout_reports_124_with_the_timeout_message():
    io = failure_result(CommandTimeoutError("sleep 99", 2.0), "sleep 99")
    assert io.exit_code == 124
    assert io.stderr == b"sleep 99: timed out after 2.0s\n"


def test_deny_reports_126_named_by_the_command():
    io = failure_result(RouteDeny("no writes"), "rm -rf /data")
    assert io.exit_code == 126
    assert io.stderr == b"rm: Permission denied\n"
    assert io.refusal == Refusal(kind="deny", reason="no writes")


def test_usage_error_keeps_its_own_exit_code():
    io = failure_result(UsageError("ls: bad option", exit_code=2), "ls -Z")
    assert io.exit_code == 2
    assert io.stderr == b"ls: bad option\n"


def test_find_parse_error_exits_1():
    io = failure_result(FindParseError("find: bad expression"), "find . -nope")
    assert io.exit_code == 1
    assert io.stderr == b"find: bad expression\n"


def test_os_error_is_formatted_as_a_filesystem_diagnostic():
    io = failure_result(FileNotFoundError(2, "No such file or directory"),
                        "cat /gone")
    assert io.exit_code == 1
    assert io.stderr.startswith(b"cat: ")


def test_unknown_exception_falls_back_to_exit_1():
    io = failure_result(ValueError("boom"), "wc -l x")
    assert io.exit_code == 1
    assert io.stderr == b"boom\n"


def test_blank_line_falls_back_to_the_raw_command():
    # No word to name, so the diagnostic keeps whatever was typed
    # rather than reporting an empty command name.
    io = failure_result(RouteDeny("nope"), "   ")
    assert io.stderr == b"   : Permission denied\n"
