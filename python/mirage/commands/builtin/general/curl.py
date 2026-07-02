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

from typing import Callable

from mirage.accessor.base import Accessor, NOOPAccessor
from mirage.commands.builtin.utils.http import (_http_form_request,
                                                _http_request)
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec


def _resolve_target(o: str | PathSpec, cwd: PathSpec | None) -> PathSpec:
    if isinstance(o, PathSpec):
        return o
    if o.startswith("/"):
        path = o
    else:
        base = cwd.virtual.rstrip("/") if cwd is not None else ""
        path = f"{base}/{o}" if base else f"/{o}"
    last_slash = path.rfind("/")
    directory = path[:last_slash + 1] if last_slash >= 0 else "/"
    return PathSpec(resource_path=(path).strip("/"),
                    virtual=path,
                    directory=directory,
                    resolved=True)


@command("curl", resource=None, spec=SPECS["curl"])
async def curl(
    accessor: Accessor = NOOPAccessor(),
    paths: list[PathSpec] | None = None,
    *texts: str,
    stdin: bytes | None = None,
    H: str | None = None,
    A: str | None = None,
    X: str | None = None,
    d: str | None = None,
    F: str | None = None,
    o: str | None = None,
    L: bool = False,
    s: bool = False,
    S: bool = False,
    jina: bool = False,
    dispatch: Callable | None = None,
    cwd: PathSpec | None = None,
    **_extra: object,
) -> tuple[ByteSource | None, IOResult]:
    headers: dict[str, str] = {}
    if H:
        k, _, v = H.partition(":")
        headers[k.strip()] = v.strip()
    if A:
        headers["User-Agent"] = A
    if not texts:
        raise ValueError("curl: missing URL")
    if F:
        method = X or "POST"
        key, _, value = F.partition("=")
        result = _http_form_request(texts[0],
                                    method=method,
                                    form_data={key: value},
                                    headers=headers)
    else:
        method = X or ("POST" if d else "GET")
        body = d.encode() if d else None
        result = _http_request(texts[0],
                               method=method,
                               headers=headers,
                               data=body,
                               jina=jina)
    if o is not None:
        o_str = o.virtual if isinstance(o, PathSpec) else o
        if dispatch is not None:
            scope = _resolve_target(o, cwd)
            try:
                await dispatch("write", scope, data=result)
            except (PermissionError, AttributeError, ValueError) as exc:
                err = f"curl: {o_str}: {exc}\n".encode()
                return None, IOResult(exit_code=1, stderr=err)
        msg = f"saved to {o_str}".encode()
        if s:
            msg = b""
        return msg, IOResult(writes={o_str: result})
    if s:
        return result, IOResult()
    return result, IOResult()
