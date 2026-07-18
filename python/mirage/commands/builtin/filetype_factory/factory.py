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
from collections.abc import Callable

from mirage.accessor.base import Accessor
from mirage.cache.index import IndexCacheStore
from mirage.commands.builtin.filetype_factory.extensions import _EXT_MODULES
from mirage.commands.builtin.filetype_factory.handlers import _BUILDERS
from mirage.commands.config import command
from mirage.commands.spec import SPECS
from mirage.types import PathSpec


async def _drop_index(read_bytes: Callable, accessor: Accessor, path: PathSpec,
                      index: IndexCacheStore | None) -> bytes:
    return await read_bytes(accessor, path)


def make_filetype_commands(
    resource: str,
    resolve_glob: Callable,
    read_bytes: Callable,
    *,
    read_takes_index: bool = False,
    provision: Callable | None = None,
) -> list[Callable]:
    read = (read_bytes if read_takes_index else functools.partial(
        _drop_index, read_bytes))
    commands: list[Callable] = []
    for ext, module in _EXT_MODULES.items():
        for name, fn in _BUILDERS:
            bound = functools.partial(fn, resolve_glob, read, module)
            commands.append(
                command(name,
                        resource=resource,
                        spec=SPECS[name],
                        filetype=ext,
                        provision=provision)(bound))
    return commands
