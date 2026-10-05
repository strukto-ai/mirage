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

OpCoreFn = Callable[..., Any]


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
    def readdir(self) -> OpCoreFn: ...

    @property
    def read_bytes(self) -> OpCoreFn: ...

    @property
    def stat(self) -> OpCoreFn: ...

    @property
    def max_glob_matches(self) -> int | None: ...

    @property
    def read_range(self) -> OpCoreFn | None: ...

    @property
    def write(self) -> OpCoreFn | None: ...

    @property
    def mkdir(self) -> OpCoreFn | None: ...

    @property
    def unlink(self) -> OpCoreFn | None: ...

    @property
    def rmdir(self) -> OpCoreFn | None: ...

    @property
    def rename(self) -> OpCoreFn | None: ...

    @property
    def create(self) -> OpCoreFn | None: ...

    @property
    def truncate(self) -> OpCoreFn | None: ...

    @property
    def append(self) -> OpCoreFn | None: ...

    @property
    def pwrite(self) -> OpCoreFn | None: ...

    @property
    def set_attrs(self) -> OpCoreFn | None: ...
