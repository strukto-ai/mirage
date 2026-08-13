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
from mirage.commands.builtin.general.curl import _resolve_target
from mirage.commands.builtin.utils.http import HttpConnectError, _http_get
from mirage.commands.config import CommandOpts
from mirage.commands.errors import UsageError
from mirage.commands.registry import command
from mirage.commands.spec import SPECS
from mirage.commands.spec.types import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.errors import WALK_ERRORS

# Exit codes GNU wget uses for the failures mirage can hit. Unlike curl, wget
# treats any 4xx/5xx as a failure (EXIT_SERVER_ERROR) and needs no flag to do
# so, and it reports a local write failure as a generic EXIT_GENERIC.
EXIT_GENERIC = 1
EXIT_NETWORK = 4
EXIT_SERVER_ERROR = 8

USAGE = ("wget: missing URL\n"
         "Usage: wget [OPTION]... [URL]...\n"
         "\n"
         "Try `wget --help' for more options.")


@command("wget", resource=None, spec=SPECS["wget"])
async def wget(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    opts: CommandOpts,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(opts.flags, spec=SPECS["wget"])
    args_O = fl.raw("args_O")
    q = fl.as_bool("q")
    spider = fl.as_bool("spider")
    dispatch = opts.dispatch
    if not texts:
        raise UsageError(USAGE, exit_code=EXIT_GENERIC)
    url = texts[0]

    # wget follows redirects unconditionally; it has no -L equivalent.
    try:
        resp = _http_get(url)
    except HttpConnectError as exc:
        err = b"" if q else (f"Connecting to {exc.host}:{exc.port}... "
                             f"failed: Connection refused.\n").encode()
        return None, IOResult(exit_code=EXIT_NETWORK, stderr=err)

    # --spider reports its verdict on stderr, not stdout, and inherits the
    # same exit 8 an error status gives a real download.
    if spider:
        if resp.is_error:
            err = b"" if q else (
                b"Remote file does not exist -- broken link!!!\n")
            return None, IOResult(exit_code=EXIT_SERVER_ERROR, stderr=err)
        err = b"" if q else b"Remote file exists.\n"
        return None, IOResult(stderr=err)

    dest_raw: str | PathSpec
    if isinstance(args_O, (str, PathSpec)) and args_O:
        dest_raw = args_O
    elif paths:
        dest_raw = paths[0]
    else:
        dest_raw = url.rsplit("/", 1)[-1]
    dest_str = dest_raw.virtual if isinstance(dest_raw, PathSpec) else dest_raw

    # An error status still creates the destination, empty, the way GNU wget
    # truncates the -O target before it learns the response code.
    data = b"" if resp.is_error else resp.body
    if dispatch is not None:
        scope = _resolve_target(dest_raw, opts.cwd)
        try:
            await dispatch("write", scope, data=data)
        # WALK_ERRORS is the shared recoverable set (every filesystem error
        # plus the ValueError store backends raise for "not a directory"), so
        # a missing parent cannot escape the way it did when this caught only
        # three types.
        except WALK_ERRORS as exc:
            # str() on an OSError renders "[Errno 13] msg: 'path'", so the
            # errno and a python repr would reach stderr; strerror is the
            # message on its own.
            detail = getattr(exc, "strerror", None) or str(exc)
            err = b"" if q else f"{dest_str}: {detail}\n".encode()
            return None, IOResult(exit_code=EXIT_GENERIC, stderr=err)
    if resp.is_error:
        err = b"" if q else (f"ERROR {resp.status}: {resp.reason}.\n").encode()
        return None, IOResult(exit_code=EXIT_SERVER_ERROR,
                              stderr=err,
                              writes={dest_str: data})
    # Real wget puts its progress report on stderr and nothing on stdout.
    err = b"" if q else (
        f"'{dest_str}' saved [{len(data)}/{len(data)}]\n").encode()
    return None, IOResult(stderr=err, writes={dest_str: data})
