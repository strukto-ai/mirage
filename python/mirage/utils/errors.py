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

import errno

from mirage.types import PathSpec


class OperationNotSupportedError(OSError):
    """A mount was asked for an op its backend does not register.

    Raised at the op-resolution boundary (``Mount.execute_op``) so a
    capability gap surfaces as a recoverable filesystem error
    (ENOTSUP, "Operation not supported") instead of an internal
    AttributeError: GNU-wise the backend behaves like a filesystem
    that does not allow the operation.
    """


_FS_STRERROR: list[tuple[type[OSError], str]] = [
    (FileNotFoundError, "No such file or directory"),
    (NotADirectoryError, "Not a directory"),
    (IsADirectoryError, "Is a directory"),
    (FileExistsError, "File exists"),
    (PermissionError, "Permission denied"),
    (OperationNotSupportedError, "Operation not supported"),
]

# The recoverable per-operand filesystem errors: every catch site that
# formats a GNU stderr line and keeps going uses this tuple, so the catch
# set and the strerror table can never drift apart (mirrors TS isFsError).
FS_ERRORS: tuple[type[OSError], ...] = tuple(t for t, _ in _FS_STRERROR)


def _virtual_of(path: object) -> str:
    original = getattr(path, "virtual", None)
    return original if original is not None else str(path)


def enoent(path: object) -> FileNotFoundError:
    return FileNotFoundError(_virtual_of(path))


def enotdir(path: object) -> NotADirectoryError:
    return NotADirectoryError(_virtual_of(path))


def eisdir(path: object) -> IsADirectoryError:
    return IsADirectoryError(_virtual_of(path))


def enotsup(resource: str, op_name: str,
            path: object) -> OperationNotSupportedError:
    """Missing-capability error for an op a backend does not register.

    ``filename`` carries the virtual path so ``format_fs_error`` reports
    the operand, while the strerror text keeps the resource and op name
    for raw tracebacks.

    Args:
        resource (str): Resource name of the mount that lacks the op.
        op_name (str): The unresolvable op (e.g. ``unlink``).
        path (object): The operand; ``virtual`` is the reported spelling.
    """
    return OperationNotSupportedError(errno.ENOTSUP,
                                      f"{resource}: no op {op_name!r}",
                                      _virtual_of(path))


def fs_strerror(exc: BaseException) -> str | None:
    for exc_type, strerror in _FS_STRERROR:
        if isinstance(exc, exc_type):
            return strerror
    return None


def fs_error_line(cmd_name: str, path: object, exc: BaseException) -> str:
    """GNU coreutils stderr line for one failed path operand.

    Produces ``<cmd>: <path>: <strerror>``, byte-identical with the
    TypeScript formatter. ``path`` is the operand itself when the caller
    knows it (read-family commands that keep processing remaining operands
    after one fails, reported as typed via ``raw_path``), or an
    already-resolved label string.

    Args:
        cmd_name (str): Command name for the ``<cmd>:`` prefix.
        path (object): The failed operand; ``raw_path`` (or ``virtual``) is
            the reported spelling, a plain string is used verbatim.
        exc (BaseException): The filesystem error.
    """
    label = getattr(path, "raw_path", None) or _virtual_of(path)
    strerror = fs_strerror(exc)
    if strerror is not None:
        return f"{cmd_name}: {label}: {strerror}\n"
    return f"{cmd_name}: {label}\n"


def format_fs_error(cmd_name: str,
                    exc: OSError,
                    paths: list[PathSpec] | None = None) -> bytes:
    """Format a filesystem OSError as a GNU coreutils stderr line.

    The chokepoint variant of ``fs_error_line`` for callers that only hold
    the exception: the path is recovered from it (``exc.filename`` when set,
    else ``str(exc)``); backends raise with the resolved absolute path
    (``PathSpec.virtual``). When ``paths`` is supplied, the absolute path is
    rewritten to the as-typed form (``PathSpec.raw_path``) so a relative
    argument is reported as typed, like GNU.

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
                path = p.raw_path
                break
    return fs_error_line(cmd_name, path, exc).encode()
