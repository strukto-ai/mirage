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


from mirage.errors.fs import fs_strerror


class JqCompileError(ValueError):
    """jq's refusal of a program, which jq reports on stderr and exits 3
    for.

    Args:
        message (str): jq's report, numbered by the program's own lines.
    """


def load_failure(name: str, exc: BaseException) -> str:
    """Why jq could not load a whole file (jv_load_file): an -f program,
    a --rawfile or a --slurpfile. It opens the file itself, so a
    directory gets words of its own instead of a failed read.

    Args:
        name (str): the file as typed.
        exc (BaseException): why it could not be read.
    """
    if isinstance(exc, IsADirectoryError):
        return f"Could not open {name}: It's a directory"
    return f"Could not open {name}: {fs_strerror(exc)}"


__all__ = ["JqCompileError", "load_failure"]
