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

from collections.abc import Callable
from typing import Any, Protocol, runtime_checkable

OpFn = Callable[..., Any]


@runtime_checkable
class OpsTable(Protocol):
    """Structural subset of ``CommandIO`` the ops factory consumes.

    A backend's ``CommandIO`` (``commands/builtin/<b>/ops.py``) already
    carries every core function the VFS/FUSE op wrappers forward to, so
    the same table feeds both ``make_generic_commands`` and
    ``make_generic_ops``. The factory reads only these fields;
    command-only fields (``read_stream``, ``is_mounted``, ``find``, ...)
    are ignored.
    """

    @property
    def readdir(self) -> OpFn:
        ...

    @property
    def read_bytes(self) -> OpFn:
        ...

    @property
    def stat(self) -> OpFn:
        ...

    @property
    def write(self) -> OpFn | None:
        ...

    @property
    def mkdir(self) -> OpFn | None:
        ...

    @property
    def unlink(self) -> OpFn | None:
        ...

    @property
    def rmdir(self) -> OpFn | None:
        ...

    @property
    def rename(self) -> OpFn | None:
        ...

    @property
    def create(self) -> OpFn | None:
        ...

    @property
    def truncate(self) -> OpFn | None:
        ...

    @property
    def append(self) -> OpFn | None:
        ...

    @property
    def set_attrs(self) -> OpFn | None:
        ...
