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

import functools
import inspect
from typing import Any
from weakref import WeakKeyDictionary

from mirage.cache.index import RAMIndexCacheStore
from mirage.vfs.base import BaseVFS


class BoundVFS:
    """A VFS whose functions share one index store, as a mount's do.

    Args:
        vfs (BaseVFS): the VFS under test.
    """

    def __init__(self, vfs: BaseVFS) -> None:
        self.vfs = vfs
        self.index = RAMIndexCacheStore(ttl=vfs.index_ttl)

    def __getattr__(self, name: str) -> Any:
        method = getattr(self.vfs, name)
        if "index" in inspect.signature(method).parameters:
            return functools.partial(method, index=self.index)
        return method


_BOUND: WeakKeyDictionary[BaseVFS, BoundVFS] = WeakKeyDictionary()


def ops(vfs: BaseVFS) -> BoundVFS:
    """The functions of ``vfs``, bound once per instance so its index
    store persists across calls.

    Args:
        vfs (BaseVFS): the driver under test.
    """
    bound = _BOUND.get(vfs)
    if bound is None:
        bound = BoundVFS(vfs)
        _BOUND[vfs] = bound
    return bound
