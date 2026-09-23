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

from collections.abc import Mapping
from urllib.parse import urlsplit

from mirage.accessor.base import Accessor
from mirage.commands.builtin.errors import HttpConnectError, HttpTimeoutError
from mirage.commands.builtin.utils.http import (DEFAULT_USER_AGENT,
                                                HttpResponse,
                                                http_form_request,
                                                http_request)
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.errors import (WALK_ERRORS, OperationNotSupportedError,
                                 fs_strerror)

# Exit codes real curl uses for the failures mirage can hit. An HTTP error
# status is deliberately absent: curl treats 4xx/5xx as a successful transfer
# and prints the body, and only -f/--fail turns it into EXIT_HTTP_ERROR.
# 2 is any line curl refuses before a transfer.
EXIT_USAGE = 2
EXIT_CONNECT = 7
EXIT_HTTP_ERROR = 22
EXIT_WRITE = 23
EXIT_TIMEOUT = 28

DEFAULT_TIMEOUT = 30.0
CRLF = "\r\n"
HELP_HINT = "curl: try 'curl --help' or 'curl --manual' for more information"
# curl 8.7.1's wording, wrapped where it wraps it (the trailing space is
# the wrap point).
HEAD_DATA_WARNING = ("Warning: You can only select one HTTP request method! "
                     "You asked for both POST \n"
                     "Warning: (-d, --data) and HEAD (-I, --head).\n")
HEAD_FORM_WARNING = ("Warning: You can only select one HTTP request method! "
                     "You asked for both \n"
                     "Warning: multipart formpost (-F, --form) and HEAD "
                     "(-I, --head).\n")
# curl's own Content-Type for a -d body, sent unless the line names one:
# httpx's `content=` and fetch's body carry no type of their own.
BODY_CONTENT_TYPE = "application/x-www-form-urlencoded"


def resolve_target(o: str | PathSpec, cwd: PathSpec | str | None) -> PathSpec:
    if isinstance(o, PathSpec):
        return o
    if o.startswith("/"):
        path = o
    else:
        base = (cwd.virtual if isinstance(cwd, PathSpec) else
                (cwd or "")).rstrip("/")
        path = f"{base}/{o}" if base else f"/{o}"
    last_slash = path.rfind("/")
    directory = path[:last_slash + 1] if last_slash >= 0 else "/"
    return PathSpec(vfs_path=(path).strip("/"),
                    virtual=path,
                    directory=directory,
                    resolved=True)


def names_content_type(headers: Mapping[str, str]) -> bool:
    """Whether the line's headers already carry a Content-Type.

    Args:
        headers (Mapping[str, str]): the headers the line added.
    """
    return any(k.lower() == "content-type" for k in headers)


def request_lines(url: str, method: str, headers: Mapping[str, str],
                  body_len: int | None, body_type: str | None) -> list[str]:
    """The request curl -v shows, as far as mirage can see it.

    Only what leaves mirage is dumped: the request line, Host, the
    User-Agent, curl's own Accept, the headers the line added, and the
    two a -d body adds. curl's ``*`` transport lines (resolving,
    connecting, TLS) have no source here and are omitted, as are the
    headers the HTTP stack appends on its own and a -F body's encoding,
    which the client builds.

    Args:
        url (str): the request URL.
        method (str): the HTTP method sent.
        headers (Mapping[str, str]): the headers the line added,
            User-Agent included.
        body_len (int | None): the -d body's byte length, None without
            one.
        body_type (str | None): the Content-Type curl added for the body
            itself, None when the line named one or there is no body.
    """
    parts = urlsplit(url)
    target = (parts.path or "/") + (f"?{parts.query}" if parts.query else "")
    host = parts.hostname or ""
    if parts.port is not None:
        host = f"{host}:{parts.port}"
    lines = [
        f"{method} {target} HTTP/1.1",
        f"Host: {host}",
        f"User-Agent: {headers.get('User-Agent', DEFAULT_USER_AGENT)}",
        "Accept: */*",
    ]
    lines.extend(f"{k}: {v}" for k, v in headers.items() if k != "User-Agent")
    if body_len is not None:
        lines.append(f"Content-Length: {body_len}")
    if body_type is not None:
        lines.append(f"Content-Type: {body_type}")
    return lines


def response_lines(resp: HttpResponse) -> list[str]:
    """The status line and headers -i, -I and -v print.

    Three deliberate divergences from curl, which prints the bytes as
    received: names render lowercase, because fetch never exposes the
    wire casing; they come sorted by name, because the Headers class
    iterates that way and wire order is gone by then; and the version
    always reads HTTP/1.1, because fetch cannot observe it. Both hosts
    therefore print one shape.

    Args:
        resp (HttpResponse): the response as the client reported it.
    """
    lines = [f"HTTP/1.1 {resp.status} {resp.reason}"]
    lines.extend(f"{k}: {v}"
                 for k, v in sorted(((k.lower(), v) for k, v in resp.headers),
                                    key=lambda kv: kv[0]))
    return lines


def _dump(lines: list[str], prefix: str = "") -> str:
    return "".join(f"{prefix}{line}{CRLF}" for line in [*lines, ""])


@command("curl", vfs=None, spec=SPECS["curl"])
async def curl(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["curl"])
    header = fl.as_str("header")
    user_agent = fl.as_str("user_agent")
    request = fl.as_str("request")
    data = fl.as_str("data")
    form = fl.as_str("form")
    output = fl.raw("output")
    location = fl.as_bool("location")
    verbose = fl.as_bool("verbose")
    include = fl.as_bool("include")
    head = fl.as_bool("head")
    max_time = fl.as_float("max_time")
    headers: dict[str, str] = {}
    if header:
        k, _, v = header.partition(":")
        headers[k.strip()] = v.strip()
    if user_agent:
        headers["User-Agent"] = user_agent
    # curl refuses these lines before any transfer (curl 8.7.1, exit 2).
    # A negative --max-time is not a number curl takes; curl names the
    # spelling typed, which the handler cannot see, so the long one.
    if max_time is not None and max_time < 0:
        raise UsageError(
            "curl: option --max-time: expected a positive numerical "
            f"parameter\n{HELP_HINT}",
            exit_code=EXIT_USAGE)
    # -I beside a body option asks two methods of one request: curl warns
    # and refuses. -s mutes the warning and -S does not bring it back; the
    # option error -F adds is never muted.
    if head and (data is not None or form is not None):
        warning = HEAD_DATA_WARNING if data is not None else HEAD_FORM_WARNING
        refusal = "" if fl.as_bool("silent") else warning
        if data is None:
            refusal += f"curl: option -F: is badly used here\n{HELP_HINT}\n"
        return None, IOResult(exit_code=EXIT_USAGE, stderr=refusal.encode())
    if not texts:
        raise UsageError(f"curl: (2) no URL specified\n{HELP_HINT}",
                         exit_code=EXIT_USAGE)
    url = texts[0]
    # -s silences the message, -S puts it back. Neither changes the exit code.
    quiet = fl.as_bool("silent") and not fl.as_bool("show_error")
    # A zero --max-time is curl's "no limit", not a deadline of zero.
    timeout: float | None = DEFAULT_TIMEOUT
    if max_time is not None:
        timeout = None if max_time == 0 else max_time
    body_len: int | None = None
    body_type: str | None = None
    try:
        if form:
            method = request or "POST"
            key, _, value = form.partition("=")
            resp = http_form_request(url,
                                     method=method,
                                     form_data={key: value},
                                     headers=headers,
                                     timeout=timeout,
                                     follow_redirects=location)
        else:
            method = request or ("HEAD" if head else
                                 ("POST" if data else "GET"))
            body = data.encode() if data else None
            body_len = len(body) if body is not None else None
            # -v shows what is sent, so curl's default for the body goes
            # on the request, not on the trace alone.
            if body is not None and not names_content_type(headers):
                body_type = BODY_CONTENT_TYPE
            sent = ({
                **headers, "Content-Type": body_type
            } if body_type is not None else headers)
            resp = http_request(url,
                                method=method,
                                headers=sent,
                                data=body,
                                timeout=timeout,
                                follow_redirects=location)
    except HttpTimeoutError as exc:
        # Nothing was received: the body is read whole, so a deadline
        # that hits mid-transfer still counts as zero bytes here.
        err = b"" if quiet else (
            f"curl: ({EXIT_TIMEOUT}) Operation timed out after "
            f"{exc.elapsed_ms} milliseconds with 0 bytes received\n").encode()
        return None, IOResult(exit_code=EXIT_TIMEOUT, stderr=err)
    except HttpConnectError as exc:
        err = b"" if quiet else (
            f"curl: ({EXIT_CONNECT}) Failed to connect to {exc.host} port "
            f"{exc.port}: Could not connect to server\n").encode()
        return None, IOResult(exit_code=EXIT_CONNECT, stderr=err)
    hops = [*resp.history, resp]
    # The first request is the one this handler built; each redirect's is
    # the one the client reports, at the URL the server named.
    requests = [(url, method), *((hop.url, hop.method) for hop in hops[1:])]
    # -v is not a message, so -s leaves it alone. A followed redirect is
    # a request of its own, traced in turn; the body rides only the hops
    # that kept the method (a 302 turns a POST into a GET without one).
    trace = b""
    if verbose:
        dumped: list[str] = []
        for (target, sent_as), hop in zip(requests, hops):
            carries = sent_as == method
            dumped.append(
                _dump(
                    request_lines(target, sent_as, headers,
                                  body_len if carries else None,
                                  body_type if carries else None), "> "))
            dumped.append(_dump(response_lines(hop), "< "))
        trace = "".join(dumped).encode()
    # Only -f makes an error status an error, and then nothing is written.
    if fl.as_bool("fail") and resp.is_error:
        err = b"" if quiet else (
            f"curl: ({EXIT_HTTP_ERROR}) The requested URL returned error: "
            f"{resp.status}\n").encode()
        return None, IOResult(exit_code=EXIT_HTTP_ERROR, stderr=trace + err)
    result = resp.body
    # -i and -I print every hop's header block (curl 8.7.1); the body a
    # redirect carried is never written, only the final one.
    blocks = "".join(_dump(response_lines(hop)) for hop in hops).encode()
    if head:
        # -I prints the headers alone, whatever method -X made it send.
        result = blocks
    elif include:
        result = blocks + result
    if isinstance(output, (PathSpec, str)):
        o_str = output.virtual if isinstance(output, PathSpec) else output
        if opts.dispatch is not None:
            scope = resolve_target(output, opts.cwd)
            try:
                await opts.dispatch("write", scope, data=result)
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
                return None, IOResult(exit_code=EXIT_WRITE, stderr=trace + err)
        # Real curl writes the body to the file and prints nothing on stdout.
        return None, IOResult(writes={o_str: result}, stderr=trace)
    return result, IOResult(stderr=trace)
