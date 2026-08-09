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
from mirage.commands.builtin.utils.http import (HttpConnectError,
                                                _http_form_request,
                                                _http_request)
from mirage.commands.errors import UsageError
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagValue
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.errors import (WALK_ERRORS, OperationNotSupportedError,
                                 fs_strerror)

# Exit codes real curl uses for the failures mirage can hit. An HTTP error
# status is deliberately absent: curl treats 4xx/5xx as a successful transfer
# and prints the body, and only -f/--fail turns it into EXIT_HTTP_ERROR.
EXIT_NO_URL = 2
EXIT_CONNECT = 7
EXIT_HTTP_ERROR = 22
EXIT_WRITE = 23


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
    fail: bool = False,
    s: bool = False,
    S: bool = False,
    dispatch: Callable[..., Any] | None = None,
    cwd: PathSpec | None = None,
    **_extra: FlagValue,
) -> tuple[ByteSource | None, IOResult]:
    headers: dict[str, str] = {}
    if H:
        k, _, v = H.partition(":")
        headers[k.strip()] = v.strip()
    if A:
        headers["User-Agent"] = A
    if not texts:
        raise UsageError(
            "curl: (2) no URL specified\n"
            "curl: try 'curl --help' or 'curl --manual' for more information",
            exit_code=EXIT_NO_URL)
    # -s silences the message, -S puts it back. Neither changes the exit code.
    quiet = s and not S
    try:
        if F:
            method = X or "POST"
            key, _, value = F.partition("=")
            resp = _http_form_request(texts[0],
                                      method=method,
                                      form_data={key: value},
                                      headers=headers,
                                      follow_redirects=L)
        else:
            method = X or ("POST" if d else "GET")
            body = d.encode() if d else None
            resp = _http_request(texts[0],
                                 method=method,
                                 headers=headers,
                                 data=body,
                                 follow_redirects=L)
    except HttpConnectError as exc:
        err = b"" if quiet else (
            f"curl: ({EXIT_CONNECT}) Failed to connect to {exc.host} port "
            f"{exc.port}: Could not connect to server\n").encode()
        return None, IOResult(exit_code=EXIT_CONNECT, stderr=err)
    # Only -f makes an error status an error, and then nothing is written.
    if fail and resp.is_error:
        err = b"" if quiet else (
            f"curl: ({EXIT_HTTP_ERROR}) The requested URL returned error: "
            f"{resp.status}\n").encode()
        return None, IOResult(exit_code=EXIT_HTTP_ERROR, stderr=err)
    result = resp.body
    if o is not None:
        o_str = o.virtual if isinstance(o, PathSpec) else o
        if dispatch is not None:
            scope = _resolve_target(o, cwd)
            try:
                await dispatch("write", scope, data=result)
            # WALK_ERRORS is the shared recoverable set (every filesystem error
            # plus the ValueError store backends raise for "not a directory"),
            # so a missing parent cannot escape the way it did when this caught
            # only three types.
            except WALK_ERRORS as exc:
                # Deliberate divergence: real curl says "client returned ERROR
                # on write of N bytes" and drops the cause. A mirage write can
                # fail for reasons a local file cannot (read-only mount,
                # unsupported op), so the exit code matches curl while the
                # message keeps the path and the reason.
                #
                # The refusals whose wording is load-bearing (read-only mount,
                # unsupported op) keep their raw message; an unusable path
                # carries only the path as its message, so it needs the GNU
                # strerror.
                # str() on an OSError renders "[Errno 13] msg: 'path'", so the
                # errno and a python repr would reach stderr; strerror is the
                # message on its own.
                detail = getattr(exc, "strerror", None) or str(exc)
                if not isinstance(
                        exc, (PermissionError, OperationNotSupportedError)):
                    strerror = fs_strerror(exc)
                    if strerror is not None:
                        detail = strerror
                err = b"" if quiet else (
                    f"curl: ({EXIT_WRITE}) {o_str}: {detail}\n").encode()
                return None, IOResult(exit_code=EXIT_WRITE, stderr=err)
        # Real curl writes the body to the file and prints nothing on stdout.
        return None, IOResult(writes={o_str: result})
    return result, IOResult()
