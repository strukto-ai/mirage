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

from mirage.agents.io_text import decode
from mirage.agents.types import ExecResult, FileInfo, GrepMatch
from mirage.io.types import IOResult


def parse_grep(stdout: str) -> list[GrepMatch]:
    """Parse ``grep -n`` output into matches.

    Lines that are not ``path:line:text`` with a numeric line are skipped,
    which is how grep reports binary-file notices and similar asides.

    Args:
        stdout (str): raw grep output.
    """
    text = stdout.strip()
    if not text:
        return []
    matches: list[GrepMatch] = []
    for line in text.split("\n"):
        parts = line.split(":", 2)
        if len(parts) < 3:
            continue
        try:
            line_num = int(parts[1])
        except ValueError:
            continue
        matches.append(GrepMatch(path=parts[0], line=line_num, text=parts[2]))
    return matches


def parse_ls(stdout: str, base: str | None = None) -> list[FileInfo]:
    """Parse ``ls`` output into directory entries.

    A trailing ``/`` marks a directory and is stripped from the path.

    Args:
        stdout (str): raw ls output.
        base (str | None): when given, entries are joined onto this
            directory so paths are absolute; otherwise the entry is used
            as-is.
    """
    text = stdout.strip()
    if not text:
        return []
    prefix = base.rstrip("/") if base is not None else None
    infos: list[FileInfo] = []
    for entry in text.split("\n"):
        entry = entry.strip()
        if not entry:
            continue
        is_dir = entry.endswith("/")
        clean = entry.rstrip("/")
        path = f"{prefix}/{clean}" if prefix is not None else clean
        infos.append(
            FileInfo(path=path, name=clean.rsplit("/", 1)[-1], is_dir=is_dir))
    return infos


def io_to_exec_result(io: IOResult) -> ExecResult:
    """Fold an IOResult into an agent-facing command outcome.

    stderr is appended to stdout so a harness that shows one text blob
    still surfaces errors.

    Args:
        io (IOResult): the executed command's result.
    """
    stdout = decode(io.stdout if isinstance(io.stdout, bytes) else None)
    stderr = decode(io.stderr if isinstance(io.stderr, bytes) else None)
    output = stdout
    if stderr:
        output = f"{stdout}\n{stderr}" if stdout else stderr
    return ExecResult(output=output, exit_code=io.exit_code)


def io_to_grep_matches(io: IOResult) -> list[GrepMatch]:
    """Parse grep matches from an IOResult.

    Args:
        io (IOResult): result of a ``grep -n`` run.
    """
    return parse_grep(
        decode(io.stdout if isinstance(io.stdout, bytes) else None))


def io_to_file_infos(io: IOResult, base: str | None = None) -> list[FileInfo]:
    """Parse directory entries from an IOResult.

    Args:
        io (IOResult): result of an ``ls`` run.
        base (str | None): directory to join entries onto, when absolute
            paths are wanted.
    """
    return parse_ls(
        decode(io.stdout if isinstance(io.stdout, bytes) else None), base)
