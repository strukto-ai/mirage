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
from typing import Any, Callable


@dataclass
class RegisteredOp:
    """One op a VFS answers.

    Args:
        name (str): the op name (``read``, ``stat``, ...).
        vfs (str): the VFS it is registered for.
        filetype (str | None): the extension it is scoped to, if any.
        fn (Callable): the op itself.
        write (bool): whether it mutates the mount.
        ranges (bool): a ``read`` that fetches a byte range from the
            store itself, rather than reading the whole file and slicing.
    """

    name: str
    vfs: str
    filetype: str | None
    fn: Callable[..., Any]
    write: bool = False
    ranges: bool = False


def op(
    name: str,
    *,
    vfs: str | list[str],
    filetype: str | None = None,
    write: bool = False,
) -> Callable[..., Any]:
    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        vfs_names = vfs if isinstance(vfs, list) else [vfs]
        ops = getattr(fn, "_registered_ops", [])
        for p in vfs_names:
            ro = RegisteredOp(
                name=name,
                vfs=p,
                filetype=filetype,
                fn=fn,
                write=write,
            )
            ops.append(ro)
        setattr(fn, "_registered_ops", ops)
        return fn

    return decorator
