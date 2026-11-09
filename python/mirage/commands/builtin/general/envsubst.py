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
import re
from collections.abc import AsyncIterator, Callable, Mapping

from mirage.accessor.base import Accessor
from mirage.commands.builtin.utils.stream import resolve_source
from mirage.commands.config import Context, command
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import encode_text
from mirage.types import PathSpec

REFERENCE = re.compile(
    rb"\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})"
)
UNFINISHED = re.compile(rb"\$(?:\{?[A-Za-z0-9_]*)\Z")
# How much of an unfinished reference is held for the next chunk; past
# this a name is no name anyone wrote, and it passes as text.
MAX_HELD = 64 * 1024
MISSING = b"envsubst: missing arguments\n"
TOO_MANY = b"envsubst: too many arguments\n"


def _names(shell_format: bytes) -> list[bytes]:
    """The variables a SHELL-FORMAT names, in order, repeats kept.

    Args:
        shell_format (bytes): the format.
    """
    return [a or b for a, b in REFERENCE.findall(shell_format)]


def _replacer(
    env: Mapping[str, str], allowed: set[bytes] | None
) -> Callable[[re.Match[bytes]], bytes]:
    """What one reference becomes: its value, empty when unset, or itself
    when the format left it out.

    Args:
        env (Mapping[str, str]): the environment.
        allowed (set[bytes] | None): the names a format picked.
    """

    def replace(found: re.Match[bytes]) -> bytes:
        name = found.group(1) or found.group(2)
        if allowed is not None and name not in allowed:
            return found.group(0)
        return encode_text(env.get(name.decode("ascii"), ""))

    return replace


async def _substituted(
    source: AsyncIterator[bytes],
    replace: Callable[[re.Match[bytes]], bytes],
) -> AsyncIterator[bytes]:
    held = b""
    async for chunk in source:
        data = held + chunk
        at = data.rfind(b"$")
        keep = (
            0 <= at
            and len(data) - at <= MAX_HELD
            and UNFINISHED.match(data, at) is not None
        )
        held = data[at:] if keep else b""
        done = data[:at] if keep else data
        if done:
            yield REFERENCE.sub(replace, done)
    if held:
        yield REFERENCE.sub(replace, held)


@command("envsubst", vfs=None, spec=SPECS["envsubst"])
async def envsubst(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Replace ``$NAME`` and ``${NAME}`` on standard input; a SHELL-FORMAT
    operand limits which names, and ``-v`` lists a format's names. Pinned
    against gettext-runtime 0.23.1.
    """
    if len(texts) > 1:
        return None, IOResult(exit_code=1, stderr=TOO_MANY)
    fl = FlagView(ctx.flags, spec=SPECS["envsubst"])
    picked = encode_text(texts[0]) if texts else None
    if fl.as_bool("variables"):
        if picked is None:
            return None, IOResult(exit_code=1, stderr=MISSING)
        lines = b"".join(name + b"\n" for name in _names(picked))
        return lines or None, IOResult()
    allowed = None if picked is None else set(_names(picked))
    replace = _replacer(ctx.env or {}, allowed)
    return _substituted(resolve_source(ctx.stdin), replace), IOResult()
