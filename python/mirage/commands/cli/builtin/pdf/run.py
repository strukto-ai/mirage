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

from mirage.accessor.base import Accessor
from mirage.commands.builtin.generic_bind.files import command_files
from mirage.commands.builtin.utils.links import dispatch_of
from mirage.commands.builtin.utils.operands import normalized_read
from mirage.commands.builtin.utils.stream_host import (
    StreamHost,
    hosted_stream,
)
from mirage.commands.cli.walk import node_help
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.commands.spec.types import CommandSpec
from mirage.io.types import ByteSource, IOResult
from mirage.shell.bytes import byte_view
from mirage.types import JsonValue, PathSpec

# The exit status of a refused command line.
USAGE = 99

# A page number as the reader takes one: a sign, then digits.
PAGE = re.compile(r"[+-]?[0-9]*")


class Refused(Exception):
    """A page number that is no number."""


def page_number(text: str | None) -> int | None:
    """A page option's value, or None when not given.

    Args:
        text (str | None): the value as typed.

    Raises:
        Refused: the value is no number.
    """
    if text is None:
        return None
    if PAGE.fullmatch(text) is None:
        raise Refused(text)
    digits = text.lstrip("+-")
    value = int(digits) if digits else 0
    return -value if text.startswith("-") else value


def usage(spec: CommandSpec, status: int) -> tuple[None, IOResult]:
    """The help page on standard error, the way the reader answers a
    request for it and a command line it refuses.

    Args:
        spec (CommandSpec): the command's grammar.
        status (int): the exit status.
    """
    text = node_help(spec.name, spec)
    return None, IOResult(exit_code=status, stderr=text.encode())


def passwords(flags: FlagView) -> dict[str, JsonValue]:
    """The passwords an encrypted file opens with, as typed.

    Args:
        flags (FlagView): the command's options.
    """
    owner = flags.as_str("opw")
    user = flags.as_str("upw")
    return {
        "owner_password": None if owner is None else byte_view(owner),
        "user_password": None if user is None else byte_view(user),
    }


def stream_host(ctx: Context, document: PathSpec) -> StreamHost:
    """The host a PDF stream reads its document and writes its text
    through; `-` is standard input.

    Args:
        ctx (Context): the command's context.
        document (PathSpec): the PDF operand.
    """
    operands = [] if document.raw_path == "-" else [document]
    files = command_files(ctx, operands)
    return StreamHost(
        operands,
        normalized_read(files.read),
        ctx.stdin,
        dispatch_of(ctx),
        ctx.cwd,
    )


async def run_pdftotext(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Write a PDF file's text, as mirage-rs lays it out, to a text file or
    standard output.

    Args:
        accessor (Accessor): unused; pdftotext holds no account.
        paths (list[PathSpec]): the PDF file, then the text file.
        texts (list[str]): unused.
        ctx (Context): the command's context.
    """
    spec = ctx.spec or CommandSpec(name="pdftotext")
    flags = FlagView(ctx.flags, spec=spec)
    if flags.as_bool("help"):
        return usage(spec, 0)
    try:
        first = page_number(flags.as_str("f"))
        last = page_number(flags.as_str("args_l"))
    except Refused:
        return usage(spec, USAGE)
    if not 1 <= len(paths) <= 2:
        return usage(spec, USAGE)
    document = paths[0]
    config: dict[str, JsonValue] = {
        "file": byte_view(document.raw_path),
        "output": byte_view(paths[1].raw_path) if len(paths) > 1 else None,
        "first": first,
        "last": last,
        "layout": flags.as_bool("layout"),
        "raw": flags.as_bool("raw"),
        "nopgbrk": flags.as_bool("nopgbrk"),
        "nodiag": flags.as_bool("nodiag"),
        "enc": flags.as_str("enc"),
        "eol": flags.as_str("eol"),
        "quiet": flags.as_bool("q"),
        **passwords(flags),
    }
    io = IOResult()
    host = stream_host(ctx, document)
    return hosted_stream("pdftotext", config, host, io), io


async def run_pdfinfo(
    accessor: Accessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    """Print a PDF file's document information, as mirage-rs reads it.

    Args:
        accessor (Accessor): unused; pdfinfo holds no account.
        paths (list[PathSpec]): the PDF file.
        texts (list[str]): unused.
        ctx (Context): the command's context.
    """
    spec = ctx.spec or CommandSpec(name="pdfinfo")
    flags = FlagView(ctx.flags, spec=spec)
    if flags.as_bool("help"):
        return usage(spec, 0)
    try:
        first = page_number(flags.as_str("f"))
        last = page_number(flags.as_str("args_l"))
    except Refused:
        return usage(spec, USAGE)
    if len(paths) != 1:
        return usage(spec, USAGE)
    document = paths[0]
    config: dict[str, JsonValue] = {
        "file": byte_view(document.raw_path),
        "first": first,
        "last": last,
        "zone": (ctx.env or {}).get("TZ"),
        "quiet": flags.as_bool("q"),
        **passwords(flags),
    }
    io = IOResult()
    host = stream_host(ctx, document)
    return hosted_stream("pdfinfo", config, host, io), io
