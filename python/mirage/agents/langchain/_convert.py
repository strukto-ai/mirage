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

from deepagents.backends.protocol import ExecuteResponse, FileInfo, GrepMatch

from mirage.agents import ops
from mirage.io.types import IOResult


def io_to_execute_response(io: IOResult) -> ExecuteResponse:
    """Map a command outcome onto the deepagents response type.

    Args:
        io (IOResult): the executed command's result.
    """
    result = ops.io_to_exec_result(io)
    return ExecuteResponse(output=result.output, exit_code=result.exit_code)


def io_to_grep_matches(io: IOResult) -> list[GrepMatch]:
    """Map grep matches onto the deepagents match type.

    Args:
        io (IOResult): result of a ``grep -n`` run.
    """
    return [
        GrepMatch(path=m.path, line=m.line, text=m.text)
        for m in ops.io_to_grep_matches(io)
    ]


def io_to_file_infos(io: IOResult) -> list[FileInfo]:
    """Map directory entries onto the deepagents file-info type.

    Args:
        io (IOResult): result of an ``ls`` run.
    """
    return [
        FileInfo(path=i.path, is_dir=i.is_dir)
        for i in ops.io_to_file_infos(io)
    ]
