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

from mirage.core.posix.constants import SHELL_PHRASES
from mirage.errors.fs import fs_error
from mirage.errors.posix import POSIX
from mirage.errors.types import FsCondition
from mirage.types import PathSpec


def refusal(path: PathSpec, err: bytes) -> OSError:
    """The error a POSIX tool that ran and failed reports, by the phrase
    its first complaint ends with (``mv: cannot stat 'a': No such file or
    directory``), or a shell's own wording of one (``SHELL_PHRASES``);
    anything else is EIO.

    Args:
        path (PathSpec): the path the error names.
        err (bytes): what the tool wrote to its error output.
    """
    first = err.decode(errors="replace").strip().split("\n")[0]
    for condition, posix in POSIX.items():
        if first.endswith(": " + posix.phrase):
            return fs_error(path, condition)
    for phrase, said in SHELL_PHRASES.items():
        if first.endswith(": " + phrase):
            return fs_error(path, said)
    return fs_error(path, FsCondition.EIO)
