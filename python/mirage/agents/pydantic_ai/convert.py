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

import posixpath

from pydantic_ai.workspaces import CommandResult, FileEntry

from mirage.io.types import IOResult
from mirage.types import FileStat, FileType
from mirage.workspace.tools.io_text import with_refusal


async def io_to_command_result(io: IOResult) -> CommandResult:
    """A finished Mirage line as the result of a workspace command.

    Args:
        io (IOResult): the line's result; a refusal's reason is appended
            to stderr.
    """
    stdout = await io.stdout_str()
    stderr = with_refusal(await io.stderr_str(), io.refusal)
    return CommandResult(exit_code=io.exit_code, stdout=stdout, stderr=stderr)


def stat_to_entry(path: str, st: FileStat) -> FileEntry:
    """One stat row as a workspace entry.

    Args:
        path (str): the absolute path the row answers for.
        st (FileStat): the row, its target's when the path is a link.
    """
    is_dir = st.type == FileType.DIRECTORY
    return FileEntry(
        name=posixpath.basename(path),
        path=path,
        is_dir=is_dir,
        size=None if is_dir else st.size,
    )
