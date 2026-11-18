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

import posixpath

from mirage.accessor.email import EmailAccessor
from mirage.commands.cli.builtin.himalaya.builder import (
    Attachment,
    Compose,
    Source,
    build,
    read_body,
)
from mirage.commands.cli.builtin.himalaya.deliver import (
    deliver,
    save_sent_copy,
)
from mirage.commands.cli.builtin.himalaya.printer import notice
from mirage.commands.cli.operand import read_operand
from mirage.commands.spec.flag_view import FlagView
from mirage.core.email.client import fetch_raw_message
from mirage.core.email.mime import render_mime
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.filetype import mime_type_for
from mirage.utils.ids import IdSource
from mirage.workspace.files import Files

NO_ENTRY = 2
NOT_A_DIRECTORY = 20
NO_BODY = "FETCH returned no body for the requested message"


async def fetch_source(
    accessor: EmailAccessor, mailbox: str, uid: str
) -> bytes:
    """A message's raw bytes, refused when the id matches nothing.

    Args:
        accessor (EmailAccessor): the install's account.
        mailbox (str): the mailbox.
        uid (str): the message id.
    """
    raw = await fetch_raw_message(accessor, mailbox, uid)
    if not raw:
        raise ValueError(NO_BODY)
    return raw


async def _read_file(
    vfs: Files | None, path: PathSpec, flag: str, label: str
) -> bytes:
    try:
        data = await read_operand(vfs, path, flag, label)
    except ValueError as exc:
        code = NOT_A_DIRECTORY if "Not a directory" in str(exc) else NO_ENTRY
        raise ValueError(f"{exc} (os error {code})") from exc
    return data if isinstance(data, bytes) else bytes(data)


async def load_attachments(
    vfs: Files | None, paths: list[PathSpec]
) -> tuple[Attachment, ...]:
    """Read --attach files through the workspace dispatcher.

    An account CLI has no mount of its own; an attachment is an
    unrelated workspace file, so it is read through the op dispatcher
    the executor hands every CLI, the same entry point git reads repositories
    through.

    Args:
        vfs (Files | None): the session's files, None outside a workspace.
        paths (list[PathSpec]): --attach values, cwd-resolved.

    Raises:
        ValueError: there is no workspace to read from, or a path does
            not exist.
    """
    if not paths:
        return ()
    attachments: list[Attachment] = []
    for spec in paths:
        data = await _read_file(vfs, spec, "--attach", "read attachment")
        filename = posixpath.basename(spec.virtual.rstrip("/")) or "attachment"
        attachments.append(
            Attachment(
                filename=filename,
                content_type=mime_type_for(filename),
                data=data,
            )
        )
    return tuple(attachments)


async def _read_named(
    vfs: Files | None, path: PathSpec | None, flag: str, label: str
) -> str | None:
    if path is None:
        return None
    return (await _read_file(vfs, path, flag, label)).decode(errors="replace")


async def finish_message(
    accessor: EmailAccessor,
    fl: FlagView,
    raw: bytes,
    send: bool,
) -> tuple[ByteSource | None, IOResult]:
    """Route composed bytes: to stdout, a mailbox, SMTP, or both.

    Args:
        accessor (EmailAccessor): the install's account.
        fl (FlagView): the leaf's parsed flags.
        raw (bytes): the composed RFC 5322 bytes.
        send (bool): whether the message goes out.
    """
    save = fl.as_str("save")
    no_save = fl.as_bool("no_save")
    if not send and save is None:
        if fl.as_bool("json"):
            return render_mime(raw, "template"), IOResult()
        return raw, IOResult()
    if not send:
        await save_sent_copy(accessor, raw, save)
        return notice(fl, "Message successfully saved"), IOResult()
    _, saved = await deliver(accessor, raw, save, no_save)
    text = (
        "Message successfully saved and sent"
        if saved
        else "Message successfully sent"
    )
    return notice(fl, text), IOResult()


async def route(
    accessor: EmailAccessor,
    fl: FlagView,
    stdin: ByteSource | None,
    source: Source | None,
    vfs: Files | None,
    ids: IdSource | None = None,
) -> tuple[ByteSource | None, IOResult]:
    """Assemble a message, then send it or write its MIME to stdout.

    Shared by compose, reply and forward: the three differ only in the
    source message they derive headers from.

    Args:
        accessor (EmailAccessor): the install's account.
        fl (FlagView): the leaf's parsed flags.
        stdin (ByteSource | None): piped body, used when neither --body
            nor --body-file names one.
        source (Source | None): the replied-to or forwarded message.
        vfs (Files | None): the session's files, read only when --attach
            names files to load.
        ids (IdSource | None): where the message id and boundary draw from.
    """
    send = fl.as_bool("send")
    template = fl.as_bool("json") and not send and fl.as_str("save") is None
    body_file = await _read_named(
        vfs, fl.as_path("body_file"), "--body-file", "read body file"
    )
    signature = fl.as_str("signature")
    if not template and signature is None:
        signature = await _read_named(
            vfs,
            fl.as_path("signature_file"),
            "--signature-file",
            "read signature file",
        )
    compose = Compose(
        sender=fl.as_str("from", accessor.config.username),
        to=tuple(fl.as_list("to")),
        cc=tuple(fl.as_list("cc")),
        bcc=tuple(fl.as_list("bcc")),
        subject=fl.as_str("subject"),
        body=await read_body(fl, stdin, body_file),
        signature=None if template else signature,
        attachments=await load_attachments(vfs, fl.as_paths("attach")),
    )
    return await finish_message(
        accessor, fl, build(compose, source, ids), send
    )
