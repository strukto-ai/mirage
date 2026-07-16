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

from mirage.agents.io_text import decode
from mirage.io.types import IOResult


def io_to_execute_response(io: IOResult) -> ExecuteResponse:
    stdout = decode(io.stdout if isinstance(io.stdout, bytes) else None)
    stderr = decode(io.stderr if isinstance(io.stderr, bytes) else None)
    output = stdout
    if stderr:
        output = f"{stdout}\n{stderr}" if stdout else stderr
    return ExecuteResponse(output=output, exit_code=io.exit_code)


def io_to_grep_matches(io: IOResult) -> list[GrepMatch]:
    stdout = decode(
        io.stdout if isinstance(io.stdout, bytes) else None).strip()
    if not stdout:
        return []
    matches: list[GrepMatch] = []
    for line in stdout.split("\n"):
        parts = line.split(":", 2)
        if len(parts) >= 3:
            try:
                line_num = int(parts[1])
            except ValueError:
                continue
            matches.append(
                GrepMatch(path=parts[0], line=line_num, text=parts[2]))
    return matches


def io_to_file_infos(io: IOResult) -> list[FileInfo]:
    stdout = decode(
        io.stdout if isinstance(io.stdout, bytes) else None).strip()
    if not stdout:
        return []
    infos: list[FileInfo] = []
    for entry in stdout.split("\n"):
        entry = entry.strip()
        if not entry:
            continue
        is_dir = entry.endswith("/")
        infos.append(FileInfo(path=entry.rstrip("/"), is_dir=is_dir))
    return infos
