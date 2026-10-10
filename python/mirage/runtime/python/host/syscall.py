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

import asyncio
import functools
from collections.abc import Callable
from typing import Any, TypeVar

from mirage.errors import FsCondition, classify
from mirage.errors.fs import fs_error
from mirage.io import IOResult
from mirage.runtime.files import RuntimeFiles
from mirage.types import PathSpec
from mirage.workspace.files import Files

T = TypeVar("T")


def host_files(
    files: Files, loop: asyncio.AbstractEventLoop | None
) -> RuntimeFiles:
    """The file adapter ``open`` and ``os`` call inside ``with ws:``.

    A workspace op that fails with no errno (an upstream 502 a REST
    mount raises as it came) answers what ``classify`` names for it, and
    EIO when it names nothing, the kernel's word for a device that
    failed: a guest's file adapter answers the same, and a caller of ``os`` can
    only ``except OSError``. The original rides along as the cause.

    Args:
        files (Files): the workspace's ``ws.vfs``.
        loop (asyncio.AbstractEventLoop | None): the block's loop.
    """

    async def dispatch(
        name: str, path: PathSpec, /, **kwargs: Any
    ) -> tuple[Any, IOResult]:
        try:
            return await files.dispatch(name, path, **kwargs)
        except OSError:
            raise
        except Exception as exc:
            condition = classify(exc) or FsCondition.EIO
            raise fs_error(path, condition) from exc

    return RuntimeFiles(dispatch, loop)


def as_raised(exc: OSError) -> OSError:
    """`exc` as a syscall raises it: CPython's own class for its errno.

    A refusal leaves the workspace as one of mirage's subclasses
    (``ReadOnlyError`` is a ``PermissionError`` stamped EROFS), where a
    real filesystem gives the class CPython builds from the errno: plain
    ``OSError`` for EROFS, ``FileNotFoundError`` for ENOENT. The errno,
    message and paths carry over; an error with no errno is left as it
    is, since no class follows from it.

    Args:
        exc (OSError): what the entry point raised.
    """
    if exc.errno is None or type(exc).__module__ == "builtins":
        return exc
    return OSError(exc.errno, exc.strerror, exc.filename, None, exc.filename2)


def syscall(fn: Callable[..., T]) -> Callable[..., T]:
    """`fn` raising what ``as_raised`` makes of its errors.

    Args:
        fn (Callable[..., T]): one entry point function.
    """

    @functools.wraps(fn)
    def call(*args: Any, **kwargs: Any) -> T:
        try:
            return fn(*args, **kwargs)
        except OSError as exc:
            raised = as_raised(exc)
            if raised is exc:
                raise
            raise raised from exc

    return call
