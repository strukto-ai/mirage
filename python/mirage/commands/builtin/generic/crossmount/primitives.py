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

from collections.abc import AsyncIterator
from typing import Any, Callable

from mirage.io import IOResult
from mirage.io.types import ByteSource
from mirage.types import PathSpec

CrossResult = tuple[ByteSource | None, IOResult]


async def relay(dispatch: Callable,
                name: str,
                accessor: object,
                path: PathSpec | str,
                index: object = None,
                **kwargs: Any) -> Any:
    # Relay one op for one path to the mount that owns it. The generics call
    # ops as (accessor, path, index); dispatch ignores both and keys off the
    # path. It is also the single place a raw str (the generic's string path
    # arithmetic) is coerced to the PathSpec dispatch needs.
    spec = path if isinstance(path, PathSpec) else PathSpec.from_str_path(path)
    data, _ = await dispatch(name, spec, **kwargs)
    return data


async def stream(dispatch: Callable,
                 accessor: object,
                 path: PathSpec,
                 index: object = None) -> AsyncIterator[bytes]:
    yield await relay(dispatch, "read", accessor, path)
