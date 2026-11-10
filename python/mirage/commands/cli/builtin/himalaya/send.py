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

from mirage.accessor.email import EmailAccessor
from mirage.commands.cli.builtin.himalaya.deliver import append_message
from mirage.commands.cli.builtin.himalaya.flag import IMAP_FLAGS
from mirage.commands.cli.builtin.himalaya.printer import (
    ChainedError,
    rendered,
)
from mirage.commands.cli.builtin.himalaya.smtp import send_raw
from mirage.commands.cli.builtin.himalaya.util import finish_message
from mirage.commands.config import Context
from mirage.commands.spec.flag_view import FlagView
from mirage.io.types import ByteSource, IOResult, materialize
from mirage.types import PathSpec
from mirage.workspace.files import Files

EMPTY_MESSAGE = "Message is empty"


def _crlf(text: bytes) -> bytes:
    return text.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")


async def _read_message(
    vfs: Files | None,
    texts: list[str],
    stdin: ByteSource | None,
    cwd: PathSpec,
) -> bytes:
    if texts:
        inline = " ".join(texts).replace("\\r", "").replace("\\n", "\r\n")
        if vfs is not None:
            path = PathSpec.from_str_path(inline, cwd=cwd)
            if await vfs.exists(path):
                return _crlf(bytes(await vfs.read(path)))
        return _crlf(inline.encode())
    return await materialize(stdin) if stdin else b""


def _is_blank(raw: bytes) -> bool:
    return not raw.strip()


async def send(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, ctx.spec)
    raw = await _read_message(ctx.vfs, texts, ctx.stdin, ctx.cwd)
    if _is_blank(raw):
        raise ValueError(EMPTY_MESSAGE)
    return await finish_message(accessor, fl, raw, True)


async def add(
    accessor: EmailAccessor,
    paths: list[PathSpec],
    texts: list[str],
    ctx: Context,
) -> tuple[ByteSource | None, IOResult]:
    fl = FlagView(ctx.flags, ctx.spec)
    raw = await _read_message(ctx.vfs, texts, ctx.stdin, ctx.cwd)
    if _is_blank(raw):
        raise ValueError(EMPTY_MESSAGE)
    flags = " ".join(IMAP_FLAGS[name] for name in fl.as_list("flag"))
    sent = fl.as_bool("send")
    if sent:
        await send_raw(accessor.config, raw)
    mailbox = fl.as_str("mailbox") or ""
    try:
        uid = await append_message(accessor, raw, mailbox, flags)
    except Exception as exc:
        if not sent:
            raise
        raise ChainedError(
            f"Message sent, but saving a copy to {mailbox} failed",
            (str(exc),),
        ) from exc
    suffix = " and sent" if sent else ""
    text = (
        f"Message {uid} successfully added{suffix}"
        if uid is not None
        else f"Message successfully added{suffix}, id unavailable"
    )
    out = rendered(fl, {"id": uid, "sent": sent}, text)
    return out, IOResult()
