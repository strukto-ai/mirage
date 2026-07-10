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

_FS_STRERROR: list[tuple[type[OSError], str]] = [
    (FileNotFoundError, "No such file or directory"),
    (NotADirectoryError, "Not a directory"),
    (IsADirectoryError, "Is a directory"),
    (FileExistsError, "File exists"),
    (PermissionError, "Permission denied"),
]


def _virtual_of(path: object) -> str:
    original = getattr(path, "virtual", None)
    return original if original is not None else str(path)


def enoent(path: object) -> FileNotFoundError:
    return FileNotFoundError(_virtual_of(path))


def enotdir(path: object) -> NotADirectoryError:
    return NotADirectoryError(_virtual_of(path))


def fs_strerror(exc: BaseException) -> str | None:
    for exc_type, strerror in _FS_STRERROR:
        if isinstance(exc, exc_type):
            return strerror
    return None


def fs_error_line(cmd_name: str, path: object, exc: BaseException) -> str:
    """GNU coreutils stderr line for one failed path operand.

    Produces ``<cmd>: <path>: <strerror>`` with the operand spelled as typed
    (``PathSpec.raw_path``), byte-identical with the executor chokepoint and
    the TypeScript formatter. Used by read-family commands that keep
    processing remaining operands after one fails.

    Args:
        cmd_name (str): Command name for the ``<cmd>:`` prefix.
        path (object): The failed operand; ``raw_path`` (or ``virtual``) is
            the reported spelling.
        exc (BaseException): The filesystem error.
    """
    label = getattr(path, "raw_path", None) or _virtual_of(path)
    strerror = fs_strerror(exc)
    if strerror is not None:
        return f"{cmd_name}: {label}: {strerror}\n"
    return f"{cmd_name}: {label}\n"
