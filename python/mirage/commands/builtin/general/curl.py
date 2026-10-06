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

import base64
import time
from collections.abc import Sequence
from urllib.parse import quote, urlsplit

from mirage.accessor.base import Accessor
from mirage.commands.builtin.errors import HttpConnectError, HttpTimeoutError
from mirage.commands.builtin.general.curl_write_out import render_write_out
from mirage.commands.builtin.utils.http import (
    DEFAULT_USER_AGENT,
    HttpResponse,
    http_form_request,
    http_request,
)
from mirage.commands.config import CommandOpts, command
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import PathSpec
from mirage.utils.errors import (
    WALK_ERRORS,
    OperationNotSupportedError,
    fs_strerror,
)

# Exit codes real curl uses for the failures mirage can hit. An HTTP error
# status is deliberately absent: curl treats 4xx/5xx as a successful transfer
# and prints the body, and only -f/--fail turns it into EXIT_HTTP_ERROR.
# 2 is any line curl refuses before a transfer.
EXIT_USAGE = 2
EXIT_CONNECT = 7
EXIT_HTTP_ERROR = 22
EXIT_WRITE = 23
EXIT_READ = 26
EXIT_TIMEOUT = 28

DEFAULT_TIMEOUT = 30.0
CRLF = "\r\n"
HELP_HINT = "curl: try 'curl --help' or 'curl --manual' for more information"
# curl 8.7.1's wording, wrapped where it wraps it (the trailing space is
# the wrap point).
HEAD_DATA_WARNING = (
    "Warning: You can only select one HTTP request method! "
    "You asked for both POST \n"
    "Warning: (-d, --data) and HEAD (-I, --head).\n"
)
HEAD_FORM_WARNING = (
    "Warning: You can only select one HTTP request method! "
    "You asked for both \n"
    "Warning: multipart formpost (-F, --form) and HEAD "
    "(-I, --head).\n"
)
# curl's own Content-Type for a -d body, sent unless the line names one:
# httpx's `content=` and fetch's body carry no type of their own.
BODY_CONTENT_TYPE = "application/x-www-form-urlencoded"
JSON_TYPE = "application/json"
# Every option that adds a piece to the body, in the order curl joins
# them, and the spelling curl names in a read failure.
DATA_OPTIONS = ("data", "data_binary", "data_raw", "data_urlencode", "json")
DATA_SPELLING = {
    "data": "-d",
    "data_binary": "--data-binary",
    "data_urlencode": "--data-urlencode",
    "json": "--json",
}
# -d @FILE drops these bytes from what it reads; --data-binary keeps them.
DATA_STRIPPED = b"\r\n\0"


def resolve_target(o: str | PathSpec, cwd: PathSpec | str | None) -> PathSpec:
    if isinstance(o, PathSpec):
        return o
    if o.startswith("/"):
        path = o
    else:
        base = (
            cwd.virtual if isinstance(cwd, PathSpec) else (cwd or "")
        ).rstrip("/")
        path = f"{base}/{o}" if base else f"/{o}"
    last_slash = path.rfind("/")
    directory = path[: last_slash + 1] if last_slash >= 0 else "/"
    return PathSpec(
        vfs_path=(path).strip("/"),
        virtual=path,
        directory=directory,
        resolved=True,
    )


def header_lines(
    values: Sequence[str],
) -> tuple[list[tuple[str, str]], set[str]]:
    """The headers -H sends, and every name it mentions.

    curl's reading of each line: ``Name: value`` sends the header,
    ``Name:`` with nothing after it sends nothing and still stops curl
    adding its own of that name, ``Name;`` sends it empty, and a line
    with neither separator is dropped. The value loses its leading
    blanks only. A name given twice in any case is one header whose
    values are joined with ``, ``, a deliberate divergence from curl,
    which sends two lines: fetch merges them so, and RFC 9110 reads the
    two forms alike.

    Args:
        values (Sequence[str]): the -H values, in line order.
    """
    sent: dict[str, tuple[str, str]] = {}
    named: set[str] = set()
    for line in values:
        colon = line.find(":")
        if colon > 0:
            name, value = line[:colon], line[colon + 1 :].lstrip()
        elif colon < 0 and line.endswith(";") and len(line) > 1:
            name, value = line[:-1], ""
        else:
            continue
        key = name.lower()
        named.add(key)
        if colon > 0 and not value:
            continue
        if key in sent:
            first, joined = sent[key]
            sent[key] = (first, f"{joined}, {value}")
        else:
            sent[key] = (name, value)
    return list(sent.values()), named


def request_lines(
    url: str,
    method: str,
    headers: Sequence[tuple[str, str]],
    body_len: int | None,
    body_type: str | None,
) -> list[str]:
    """The request curl -v shows, as far as mirage can see it.

    Only what leaves mirage is dumped: the request line, Host, the
    headers in curl's order, and the two a -d body adds. curl's ``*``
    transport lines (resolving, connecting, TLS) have no source here
    and are omitted, as are the headers the HTTP stack appends on its
    own and a -F body's encoding, which the client builds.

    Args:
        url (str): the request URL.
        method (str): the HTTP method sent.
        headers (Sequence[tuple[str, str]]): every header between Host
            and the body's own, in the order curl sends them.
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
    lines = [f"{method} {target} HTTP/1.1", f"Host: {host}"]
    lines.extend(f"{k}: {v}" for k, v in headers)
    if body_len is not None:
        lines.append(f"Content-Length: {body_len}")
    if body_type is not None:
        lines.append(f"Content-Type: {body_type}")
    return lines


def url_encoded(data: bytes) -> str:
    """curl's escaping for --data-urlencode.

    Everything but letters, digits and ``-._~`` becomes ``%XX``, and a
    space then becomes ``+`` (curl 8.14.1).

    Args:
        data (bytes): the content to encode.
    """
    return quote(data, safe="").replace("%20", "+")


async def _read_at(
    option: str, name: str, opts: CommandOpts, silent: bool
) -> bytes:
    """Read the file an ``@NAME`` value names, ``-`` being stdin.

    curl gives up on the whole line when it cannot (exit 26), naming
    the file unless -s, and the option either way.

    Args:
        option (str): the option's spelling, for the refusal.
        name (str): the file as the line named it.
        opts (CommandOpts): the invocation, for stdin and the dispatcher.
        silent (bool): whether -s mutes the file's own line.
    """
    try:
        if name == "-":
            return await materialize(opts.stdin)
        if opts.dispatch is None:
            raise OperationNotSupportedError("no filesystem dispatcher")
        content, _ = await opts.dispatch(
            "read", resolve_target(name, opts.cwd)
        )
        return await materialize(content)
    except WALK_ERRORS as exc:
        detail = "" if silent else f"curl: Failed to open {name}\n"
        raise UsageError(
            f"{detail}curl: option {option}: error encountered when reading "
            f"a file\n{HELP_HINT}",
            exit_code=EXIT_READ,
        ) from exc


async def _data_piece(
    kind: str, value: str, opts: CommandOpts, silent: bool
) -> bytes:
    """One data option's contribution to the body.

    Args:
        kind (str): which data option it is.
        value (str): its value as typed.
        opts (CommandOpts): the invocation, for files and stdin.
        silent (bool): whether -s is on.
    """
    if kind == "data_raw":
        return value.encode()
    if kind == "data_urlencode":
        # `=` is looked for before `@`: `name=content` encodes the
        # content, `name@file` a file's, and a bare value all of it.
        sep = value.find("=")
        if sep < 0:
            sep = value.find("@")
        name = value[:sep] if sep > 0 else ""
        content = value[sep + 1 :] if sep >= 0 else value
        raw = (
            await _read_at(DATA_SPELLING[kind], content, opts, silent)
            if sep >= 0 and value[sep] == "@"
            else content.encode()
        )
        encoded = url_encoded(raw)
        return (f"{name}={encoded}" if name else encoded).encode()
    if not value.startswith("@"):
        return value.encode()
    raw = await _read_at(DATA_SPELLING[kind], value[1:], opts, silent)
    if kind == "data":
        return raw.translate(None, DATA_STRIPPED)
    return raw


async def request_body(
    fl: FlagView, opts: CommandOpts
) -> tuple[bytes | None, bool]:
    """The body the data options build, and whether --json was among them.

    The pieces are joined in line order with ``&`` between them, except
    before a --json piece, and only once the body so far is not empty
    (curl 8.14.1: ``-d '' -d b`` sends ``b``).

    Args:
        fl (FlagView): the line's flags.
        opts (CommandOpts): the invocation, for files and stdin.
    """
    silent = fl.as_bool("silent")
    occurrences = fl.occurrences(*DATA_OPTIONS)
    if not occurrences:
        return None, False
    body = b""
    json = False
    for kind, value in occurrences:
        piece = await _data_piece(kind, str(value), opts, silent)
        if body and kind != "json":
            body += b"&"
        body += piece
        json = json or kind == "json"
    return body, json


def basic_auth(user: str, stdin: bytes) -> tuple[str, bytes]:
    """The Authorization value -u sends, and the prompt it costs.

    A user without a ``:`` has curl ask for the password on stderr and
    read it from stdin, which is all a workspace has: the bytes it read
    minus the last one, which curl takes to be the newline.

    Args:
        user (str): the -u value.
        stdin (bytes): what the line's stdin holds.
    """
    prompt = b""
    if ":" not in user:
        prompt = f"Enter host password for user '{user}':\n".encode()
        user = f"{user}:{stdin[:-1].decode(errors='replace')}"
    token = base64.b64encode(user.encode()).decode()
    return f"Basic {token}", prompt


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
    lines.extend(
        f"{k}: {v}"
        for k, v in sorted(
            ((k.lower(), v) for k, v in resp.headers), key=lambda kv: kv[0]
        )
    )
    return lines


def _dump(lines: list[str], prefix: str = "") -> str:
    return "".join(f"{prefix}{line}{CRLF}" for line in [*lines, ""])


def _doubled(hops: list[HttpResponse]) -> str:
    """The header blocks when -D and -i (or -I) both print to stdout.

    curl writes each header line to the dump as it arrives and then to
    the output, so on one stream every line comes out twice, one after
    the other (curl 8.14.1).

    Args:
        hops (list[HttpResponse]): every response, redirects first.
    """
    return "".join(
        f"{line}{CRLF}{line}{CRLF}"
        for hop in hops
        for line in [*response_lines(hop), ""]
    )


def _write_failure(shown: str, exc: Exception) -> str:
    """Why a write to ``shown`` failed, in curl's exit code 23.

    Deliberate divergence: real curl says "Failed writing received data
    to disk/application" (or "client returned ERROR on write of N
    bytes") and drops the cause. A mirage write can fail for reasons a
    local file cannot (read-only mount, unsupported op), so the exit
    code matches curl while the message keeps the path and the reason.
    The refusals whose wording is load-bearing (read-only mount,
    unsupported op) keep their raw message; an unusable path carries
    only the path as its message, so it needs the GNU strerror. str()
    on an OSError renders "[Errno 13] msg: 'path'", so the errno and a
    python repr would reach stderr; strerror is the message on its own.

    Args:
        shown (str): the path as the line named it.
        exc (Exception): the write's failure.
    """
    detail = getattr(exc, "strerror", None) or str(exc)
    if not isinstance(exc, (PermissionError, OperationNotSupportedError)):
        strerror = fs_strerror(exc)
        if strerror is not None:
            detail = strerror
    return f"curl: ({EXIT_WRITE}) {shown}: {detail}\n"


def _path_str(value: PathSpec | str) -> str:
    return value.virtual if isinstance(value, PathSpec) else value


@command("curl", vfs=None, spec=SPECS["curl"])
async def curl(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["curl"])
    user_agent = fl.as_str("user_agent")
    request = fl.as_str("request")
    has_data = bool(fl.occurrences(*DATA_OPTIONS))
    form = fl.as_str("form")
    output = fl.raw("output")
    # -D names a file, or stdout as a lone `-`, which the parser leaves
    # unresolved (STDOUT_DASH_OPTIONS); `./-` is a file.
    dump_header = fl.raw("dump_header")
    dump_to_stdout = dump_header == "-" or (
        isinstance(dump_header, PathSpec) and dump_header.raw_path == "-"
    )
    dump_file = (
        None
        if dump_to_stdout or not isinstance(dump_header, (PathSpec, str))
        else dump_header
    )
    # -k: the server's certificate is not verified.
    verify = not fl.as_bool("insecure")
    location = fl.as_bool("location")
    verbose = fl.as_bool("verbose")
    include = fl.as_bool("include")
    head = fl.as_bool("head")
    max_time = fl.as_float("max_time")
    sent, named = header_lines(fl.as_list("header"))
    # curl refuses these lines before any transfer (curl 8.7.1, exit 2).
    # A negative --max-time is not a number curl takes; curl names the
    # spelling typed, which the handler cannot see, so the long one.
    if max_time is not None and max_time < 0:
        raise UsageError(
            "curl: option --max-time: expected a positive numerical "
            f"parameter\n{HELP_HINT}",
            exit_code=EXIT_USAGE,
        )
    # -I beside a body option asks two methods of one request: curl warns
    # and refuses. -s mutes the warning and -S does not bring it back; the
    # option error -F adds is never muted.
    if head and (has_data or form is not None):
        warning = HEAD_DATA_WARNING if has_data else HEAD_FORM_WARNING
        refusal = "" if fl.as_bool("silent") else warning
        if not has_data:
            refusal += f"curl: option -F: is badly used here\n{HELP_HINT}\n"
        return None, IOResult(exit_code=EXIT_USAGE, stderr=refusal.encode())
    if not texts:
        raise UsageError(
            f"curl: (2) no URL specified\n{HELP_HINT}", exit_code=EXIT_USAGE
        )
    url = texts[0]
    # -s silences the message, -S puts it back. Neither changes the exit code.
    quiet = fl.as_bool("silent") and not fl.as_bool("show_error")
    # A zero --max-time is curl's "no limit", not a deadline of zero.
    timeout: float | None = DEFAULT_TIMEOUT
    if max_time is not None:
        timeout = None if max_time == 0 else max_time
    template = fl.as_str("write_out") or ""
    # curl 8.14.1: -s suppresses only the opening diagnostic; -S does not
    # restore it. The option error is always printed. The parsed flags no
    # longer retain the spelling, so each option names its usual one.
    if template.startswith("@"):
        raw = await _read_at("-w", template[1:], opts, fl.as_bool("silent"))
        template = raw.decode(errors="replace")
    body, json = await request_body(fl, opts)
    # A custom header of a name curl would add itself takes its place,
    # so curl's own goes only where the line names none. The trace lists
    # them in curl's order; the wire leaves User-Agent and Accept to the
    # client's defaults unless the line set them.
    auth: list[tuple[str, str]] = []
    prompt = b""
    user = fl.as_str("user")
    if user is not None and "authorization" not in named:
        stdin = b"" if ":" in user else await materialize(opts.stdin)
        token, prompt = basic_auth(user, stdin)
        auth.append(("Authorization", token))
    agent = (
        [("User-Agent", user_agent)]
        if user_agent and "user-agent" not in named
        else []
    )
    typed = [
        (name, JSON_TYPE)
        for name in ("Content-Type", "Accept")
        if json and name.lower() not in named
    ]
    headers = [*auth, *agent, *sent, *typed]
    trace_headers = [
        *auth,
        *(
            []
            if "user-agent" in named
            else [("User-Agent", user_agent or DEFAULT_USER_AGENT)]
        ),
        *([] if "accept" in named or json else [("Accept", "*/*")]),
        *sent,
        *typed,
    ]
    started = time.monotonic()

    async def finish(
        stdout: ByteSource | None,
        io: IOResult,
        response: HttpResponse | None = None,
    ) -> tuple[ByteSource | None, IOResult]:
        code = f"{response.status:03d}" if response is not None else "000"
        values = {
            "http_code": code,
            "response_code": code,
            "url_effective": response.url if response is not None else url,
            "num_redirects": str(len(response.history))
            if response is not None
            else "0",
            "size_download": str(len(response.body))
            if response is not None
            else "0",
            "content_type": next(
                (
                    v
                    for k, v in response.headers
                    if k.lower() == "content-type"
                ),
                "",
            )
            if response is not None
            else "",
            "method": response.method
            if response is not None
            else request
            or ("HEAD" if head else "POST" if has_data or form else "GET"),
            "exitcode": str(io.exit_code),
            "time_total": f"{time.monotonic() - started:.6f}",
        }
        out, err = render_write_out(template, values)
        io.stderr = prompt + (await materialize(io.stderr)) + err
        return (await materialize(stdout)) + out, io

    body_len: int | None = None
    body_type: str | None = None
    try:
        if form:
            method = request or "POST"
            key, _, value = form.partition("=")
            resp = await http_form_request(
                url,
                method=method,
                form_data={key: value},
                headers=dict(headers),
                timeout=timeout,
                follow_redirects=location,
                verify=verify,
            )
        else:
            method = request or (
                "HEAD" if head else ("POST" if body is not None else "GET")
            )
            body_len = len(body) if body is not None else None
            # -v shows what is sent, so curl's default for the body goes
            # on the request, not on the trace alone.
            if body is not None and not json and "content-type" not in named:
                body_type = BODY_CONTENT_TYPE
            wire = dict(headers)
            if body_type is not None:
                wire["Content-Type"] = body_type
            resp = await http_request(
                url,
                method=method,
                headers=wire,
                data=body,
                timeout=timeout,
                follow_redirects=location,
                verify=verify,
            )
    except HttpTimeoutError as exc:
        # Nothing was received: the body is read whole, so a deadline
        # that hits mid-transfer still counts as zero bytes here.
        err = (
            b""
            if quiet
            else (
                f"curl: ({EXIT_TIMEOUT}) Operation timed out after "
                f"{exc.elapsed_ms} milliseconds with 0 bytes received\n"
            ).encode()
        )
        return await finish(None, IOResult(exit_code=EXIT_TIMEOUT, stderr=err))
    except HttpConnectError as exc:
        err = (
            b""
            if quiet
            else (
                f"curl: ({EXIT_CONNECT}) Failed to connect to {exc.host} port "
                f"{exc.port}: Could not connect to server\n"
            ).encode()
        )
        return await finish(None, IOResult(exit_code=EXIT_CONNECT, stderr=err))
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
                    request_lines(
                        target,
                        sent_as,
                        trace_headers,
                        body_len if carries else None,
                        body_type if carries else None,
                    ),
                    "> ",
                )
            )
            dumped.append(_dump(response_lines(hop), "< "))
        trace = "".join(dumped).encode()
    # -i, -I and -D all show every hop's header block (curl 8.14.1); the
    # body a redirect carried is never written, only the final one.
    blocks = "".join(_dump(response_lines(hop)) for hop in hops).encode()
    writes: dict[str, ByteSource] = {}
    # -D writes the headers as they arrive, so before -f judges the
    # status and before -o writes the body: a file both name ends up
    # holding the body.
    if dump_file is not None:
        if opts.dispatch is not None:
            try:
                await opts.dispatch(
                    "write", resolve_target(dump_file, opts.cwd), data=blocks
                )
            except WALK_ERRORS as exc:
                err = (
                    b""
                    if quiet
                    else _write_failure(_path_str(dump_file), exc).encode()
                )
                return await finish(
                    None,
                    IOResult(exit_code=EXIT_WRITE, stderr=trace + err),
                    resp,
                )
        writes[_path_str(dump_file)] = blocks
    header_out = blocks if dump_to_stdout else None
    # Only -f makes an error status an error, and then no body is
    # written; the headers -D already dumped stay dumped.
    if fl.as_bool("fail") and resp.is_error:
        err = (
            b""
            if quiet
            else (
                f"curl: ({EXIT_HTTP_ERROR}) The requested URL returned error: "
                f"{resp.status}\n"
            ).encode()
        )
        return await finish(
            header_out,
            IOResult(
                exit_code=EXIT_HTTP_ERROR, stderr=trace + err, writes=writes
            ),
            resp,
        )
    result = resp.body
    if head:
        # -I prints the headers alone, whatever method -X made it send.
        result = blocks
    elif include:
        result = blocks + result
    if (
        isinstance(output, (PathSpec, str))
        and (output.raw_path if isinstance(output, PathSpec) else output)
        != "-"
    ):
        o_str = _path_str(output)
        if opts.dispatch is not None:
            scope = resolve_target(output, opts.cwd)
            try:
                await opts.dispatch("write", scope, data=result)
            # WALK_ERRORS is the shared recoverable set (every filesystem error
            # plus the ValueError store backends raise for "not a directory"),
            # so a missing parent cannot escape the way it did when this caught
            # only three types.
            except WALK_ERRORS as exc:
                err = b"" if quiet else _write_failure(o_str, exc).encode()
                return await finish(
                    header_out,
                    IOResult(
                        exit_code=EXIT_WRITE, stderr=trace + err, writes=writes
                    ),
                    resp,
                )
        writes[o_str] = result
        # Real curl writes the body to the file and prints nothing else
        # on stdout, the headers -D sends there aside.
        return await finish(
            header_out, IOResult(writes=writes, stderr=trace), resp
        )
    if dump_to_stdout and (head or include):
        result = _doubled(hops).encode() + (b"" if head else resp.body)
    elif dump_to_stdout:
        result = blocks + result
    return await finish(result, IOResult(writes=writes, stderr=trace), resp)
