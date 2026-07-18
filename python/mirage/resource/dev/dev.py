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

from mirage.accessor.ram import RAMAccessor
from mirage.commands.builtin.ram import COMMANDS
from mirage.ops.ram import OPS as RAM_OPS
from mirage.resource.base import BaseResource
from mirage.resource.ram.store import RAMStore
from mirage.types import ResourceName

_DEV_NAMES = frozenset({"null", "zero"})
_ZERO_CHUNK_SIZE = 1 << 20


class _DevFiles(dict[str, bytes]):

    def __contains__(self, key: object) -> bool:
        if not isinstance(key, str):
            return False
        name = key.strip("/")
        return name in _DEV_NAMES

    def __getitem__(self, key: str) -> bytes:
        name = key.strip("/")
        if name == "null":
            return b""
        if name == "zero":
            return b"\x00" * _ZERO_CHUNK_SIZE
        raise KeyError(key)

    def __setitem__(self, key: str, value: bytes) -> None:
        pass

    def pop(self, key: str, default=None):
        return default

    def __iter__(self):
        return iter(["/null", "/zero"])

    def keys(self):
        return ["/null", "/zero"]


class DevStore(RAMStore):

    def __init__(self) -> None:
        self.files = _DevFiles()
        self.dirs = {"/"}
        self.modified = {}
        self.attrs = {}


class DevResource(BaseResource):

    accessor: RAMAccessor
    name: str = ResourceName.RAM

    def __init__(self) -> None:
        super().__init__()
        self._store = DevStore()
        self.accessor = RAMAccessor(self._store)
        for fn in COMMANDS:
            self.register(fn)
        for ro in RAM_OPS:
            self.register_op(ro)
