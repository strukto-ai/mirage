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

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ExecResult:
    """Outcome of a shell command run for an agent harness.

    Args:
        output (str): stdout, with stderr appended when both are present.
        exit_code (int): the command's exit status.
    """

    output: str
    exit_code: int


@dataclass(frozen=True, slots=True)
class GrepMatch:
    """One `grep -n` hit.

    Args:
        path (str): file the match was found in.
        line (int): 1-based line number.
        text (str): the matching line's text.
    """

    path: str
    line: int
    text: str


@dataclass(frozen=True, slots=True)
class FileInfo:
    """A directory entry in its richest form.

    Carries every field any supported harness needs, so adapters project
    down rather than re-deriving. ``size`` is None when the listing did not
    report one.

    Args:
        path (str): full path of the entry.
        name (str): final path segment.
        is_dir (bool): whether the entry is a directory.
        size (int | None): byte size when known.
    """

    path: str
    name: str
    is_dir: bool
    size: int | None = None
