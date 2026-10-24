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
from mirage.commands.builtin.generic_bind.adapter import GenericCommand
from mirage.commands.builtin.generic_bind.files import (
    command_files,
    resolve_or_empty,
)
from mirage.commands.builtin.utils.links import dispatch_of
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.stream_host import (
    StreamHost,
    hosted_stream,
    own_mount,
)
from mirage.commands.builtin.utils.strtol import (
    EOVERFLOW_REASON,
    INT_MAX,
    signed_decimal,
)
from mirage.commands.config import Context
from mirage.commands.quote import quote_text
from mirage.commands.spec import SPECS
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import byte_view, utf8_locale
from mirage.types import JsonValue, PathSpec


def digits_refusal(text: str, value: int | None) -> str:
    """csplit's refusal of a -n value, which GNU 9.7 takes as a decimal
    from 0 to INT_MAX: out of that range is too large.

    Args:
        text (str): the value as typed.
        value (int | None): what it scanned to, None for no number.
    """
    reason = "" if value is None else f": {EOVERFLOW_REASON}"
    return f"csplit: invalid number: '{quote_text(text)}'{reason}"


async def csplit(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    files = command_files(ctx, paths)
    # getopt reads -n before any operand is looked at.
    fl = FlagView(ctx.flags, spec=SPECS["csplit"])
    digits = fl.as_number(
        "digits", signed_decimal, digits_refusal, low=0, high=INT_MAX
    )
    paths = await resolve_or_empty(files, paths)
    words = [path.raw_path for path in paths] + list(texts)
    prefix = fl.raw("prefix")
    suffix_format = fl.as_str("suffix_format")
    config: dict[str, JsonValue] = {
        "prefix": byte_view(
            prefix.raw_path if isinstance(prefix, PathSpec) else "xx"
        ),
        "digits": 2 if digits is None else digits,
        "keep": fl.as_bool("keep_files"),
        "silent": fl.as_bool("quiet") or fl.as_bool("silent"),
        "suppress": fl.as_bool("suppress_matched"),
        "elide": fl.as_bool("elide_empty_files"),
        "utf8": utf8_locale(ctx.env),
        "operands": [byte_view(word) for word in words],
    }
    if suffix_format is not None:
        config["suffix_format"] = byte_view(suffix_format)
    # The pieces go to the prefix, or `xx` in the working directory, which
    # need not be this mount, so the dispatcher routes each write, and the
    # removal of a failed run's pieces.
    host = StreamHost(
        paths,
        normalized_read(files.read),
        ctx.stdin,
        dispatch_of(ctx),
        ctx.cwd,
        None,
        own_mount,
        command="csplit",
    )
    io = IOResult()
    return hosted_stream("csplit", config, host, io), io


BUILDER = GenericCommand("csplit", csplit, write=True)
