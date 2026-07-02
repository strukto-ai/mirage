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

from mirage.types import PathSpec
from mirage.utils.errors import fs_strerror


def format_fs_error(cmd_name: str,
                    exc: OSError,
                    paths: list[PathSpec] | None = None) -> bytes:
    """Format a filesystem OSError as a GNU coreutils stderr line.

    Produces ``<cmd>: <path>: <strerror>`` so output is byte-identical with
    the TypeScript executor. The path is the bare path carried by the
    exception (``exc.filename`` when set, else ``str(exc)``); backends raise
    with the resolved absolute path (``PathSpec.virtual``). When ``paths`` is
    supplied, the absolute path is rewritten to the as-typed form
    (``PathSpec.display``) so a relative argument is reported as typed, like
    GNU.

    Args:
        cmd_name (str): Command name for the ``<cmd>:`` prefix.
        exc (OSError): The filesystem error.
        paths (list[PathSpec] | None): Command operands, used to map the
            resolved path back to the as-typed form.
    """
    path = exc.filename or str(exc)
    if paths:
        for p in paths:
            if p.virtual == path:
                path = p.display
                break
    strerror = fs_strerror(exc)
    if strerror is not None:
        return f"{cmd_name}: {path}: {strerror}\n".encode()
    return f"{cmd_name}: {path}\n".encode()
