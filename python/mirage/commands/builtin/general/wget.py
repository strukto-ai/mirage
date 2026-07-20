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

from typing import Any, Callable

from mirage.accessor.base import Accessor, NOOPAccessor
from mirage.commands.builtin.general.curl import _resolve_target
from mirage.commands.builtin.utils.http import _http_get
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.errors import OperationNotSupportedError


@command("wget", resource=None, spec=SPECS["wget"])
async def wget(
    accessor: Accessor = NOOPAccessor(),
    paths: list[PathSpec] | None = None,
    *texts: str,
    stdin: bytes | None = None,
    args_O: str | None = None,
    q: bool = False,
    spider: bool = False,
    dispatch: Callable[..., Any] | None = None,
    cwd: PathSpec | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    if not texts:
        raise ValueError("wget: missing URL")
    url = texts[0]

    if spider:
        data = _http_get(url)
        output = "" if q else f"Spider mode: {url} exists ({len(data)} bytes)"
        return output.encode(), IOResult()

    dest_raw: str | PathSpec
    if args_O:
        dest_raw = args_O
    elif paths:
        dest_raw = paths[0]
    else:
        dest_raw = url.rsplit("/", 1)[-1]
    dest_str = dest_raw.virtual if isinstance(dest_raw, PathSpec) else dest_raw
    data = _http_get(url)
    if dispatch is not None:
        scope = _resolve_target(dest_raw, cwd)
        try:
            await dispatch("write", scope, data=data)
        except (PermissionError, OperationNotSupportedError,
                ValueError) as exc:
            err = f"wget: {dest_str}: {exc}\n".encode()
            return None, IOResult(exit_code=1, stderr=err)
    output = "" if q else f"saved {len(data)} bytes to {dest_str}"
    return output.encode(), IOResult(writes={dest_str: data})
