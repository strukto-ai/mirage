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

from mirage.accessor.base import Accessor
from mirage.commands.builtin.errors import HttpConnectError, HttpTimeoutError
from mirage.commands.builtin.general.curl import said
from mirage.commands.builtin.utils.constants import HTTP_TIMEOUT_SECONDS
from mirage.commands.builtin.utils.http import http_get
from mirage.commands.builtin.utils.links import dispatch_of
from mirage.commands.builtin.utils.paths import resolve_target
from mirage.commands.config import Context, command
from mirage.commands.errors import UsageError
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.errors.constants import WALK_ERRORS
from mirage.errors.fs import fs_strerror
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec

# Exit codes GNU wget uses for the failures mirage can hit. Unlike curl, wget
# treats any 4xx/5xx as a failure (EXIT_SERVER_ERROR) and needs no flag to do
# so, and it reports a local write failure as a generic EXIT_GENERIC.
EXIT_GENERIC = 1
EXIT_NETWORK = 4
EXIT_SERVER_ERROR = 8

USAGE = (
    "wget: missing URL\n"
    "Usage: wget [OPTION]... [URL]...\n"
    "\n"
    "Try `wget --help' for more options."
)


@command("wget", vfs=None, spec=SPECS["wget"])
async def wget(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, spec=SPECS["wget"])
    args_O = fl.raw("args_O")
    q = fl.as_bool("q")
    spider = fl.as_bool("spider")
    dispatch = dispatch_of(ctx)
    if not texts:
        raise UsageError(USAGE, exit_code=EXIT_GENERIC)
    url = texts[0]
    if args_O == "" or (isinstance(args_O, PathSpec) and not args_O.raw_path):
        # wget opens -O before it connects, and perror("") is the bare
        # strerror, -q or not (GNU Wget 1.25.0).
        return None, IOResult(
            exit_code=EXIT_GENERIC, stderr=b"No such file or directory\n"
        )
    timeout = fl.as_float("timeout")
    if timeout is not None and timeout < 0:
        raise UsageError(
            f"wget: --timeout: Negative time period '{timeout:g}'", exit_code=2
        )

    # wget follows redirects unconditionally; it has no -L equivalent.
    try:
        resp = await http_get(
            url,
            timeout=(
                HTTP_TIMEOUT_SECONDS if timeout is None else (timeout or None)
            ),
        )
    except HttpConnectError as exc:
        reason = (
            "Connection timed out"
            if isinstance(exc, HttpTimeoutError)
            else "Connection refused"
        )
        line = f"Connecting to {exc.host}:{exc.port}... failed: {reason}.\n"
        return None, IOResult(exit_code=EXIT_NETWORK, stderr=said(q, line))

    # --spider reports its verdict on stderr, not stdout, and inherits the
    # same exit 8 an error status gives a real download.
    if spider:
        if resp.is_error:
            err = said(q, "Remote file does not exist -- broken link!!!\n")
            return None, IOResult(exit_code=EXIT_SERVER_ERROR, stderr=err)
        return None, IOResult(stderr=said(q, "Remote file exists.\n"))

    explicit_output = isinstance(args_O, (str, PathSpec)) and bool(args_O)
    stdout = args_O == "-" or (
        isinstance(args_O, PathSpec) and args_O.raw_path == "-"
    )
    if stdout or (resp.is_error and not explicit_output):
        err = (
            said(q, f"ERROR {resp.status}: {resp.reason}.\n")
            if resp.is_error
            else b""
        )
        return (None if resp.is_error else resp.body), IOResult(
            exit_code=EXIT_SERVER_ERROR if resp.is_error else 0, stderr=err
        )

    dest_raw: str | PathSpec
    if isinstance(args_O, (str, PathSpec)) and args_O:
        dest_raw = args_O
    elif paths:
        dest_raw = paths[0]
    else:
        dest_raw = url.rsplit("/", 1)[-1] or "index.html"
    dest_str = dest_raw.virtual if isinstance(dest_raw, PathSpec) else dest_raw

    # An error status still creates the destination, empty, the way GNU wget
    # truncates the -O target before it learns the response code.
    data = b"" if resp.is_error else resp.body
    if dispatch is not None:
        scope = resolve_target(dest_raw, ctx.cwd)
        try:
            await dispatch("write", scope, data=data)
        # WALK_ERRORS is the shared recoverable set (every filesystem error
        # plus the ValueError store backends raise for "not a directory"), so
        # a missing parent cannot escape the way it did when this caught only
        # three types.
        except WALK_ERRORS as exc:
            # GNU wget opens the -O file before it fetches and answers a
            # refused open as `NAME: strerror`, exit 1, which -q does not
            # silence (wget 1.25.0). str() on an OSError renders
            # "[Errno 13] msg: 'path'", so the strerror phrase stands alone.
            detail = fs_strerror(exc) or str(exc)
            line = f"{dest_str}: {detail}\n"
            return None, IOResult(exit_code=EXIT_GENERIC, stderr=line.encode())
    if resp.is_error:
        err = said(q, f"ERROR {resp.status}: {resp.reason}.\n")
        return None, IOResult(exit_code=EXIT_SERVER_ERROR, stderr=err)
    # Real wget puts its progress report on stderr and nothing on stdout.
    saved = f"'{dest_str}' saved [{len(data)}/{len(data)}]\n"
    return None, IOResult(stderr=said(q, saved))
