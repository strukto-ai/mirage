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

import json
import posixpath
from email.policy import SMTP

from mirage.commands.cli.builtin.himalaya.builder import (Attachment, Compose,
                                                          Source, build,
                                                          read_body,
                                                          split_addresses)
from mirage.commands.cli.builtin.himalaya.smtp import send_raw
from mirage.commands.cli.types import CLIVerbOpts
from mirage.commands.spec.types import FlagView
from mirage.core.email.config import EmailConfig
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult
from mirage.types import PathSpec
from mirage.utils.filetype import mime_type_for


def first_text(texts: tuple[str, ...], label: str) -> str:
    """The command's first operand, or a usage error.

    Args:
        texts (tuple[str, ...]): positional operands as typed.
        label (str): what the operand is, for the message.

    Raises:
        ValueError: no operand was given.
    """
    if not texts:
        raise ValueError(f"{label} is required")
    return texts[0]


async def load_attachments(ops: CLIVerbOpts | None,
                           paths: list[PathSpec]) -> tuple[Attachment, ...]:
    """Read --attach files through the workspace dispatcher.

    An account CLI has no mount of its own; an attachment is an
    unrelated workspace file, so it is read through the op dispatcher
    the executor hands every CLI, the same door git reads repositories
    through.

    Args:
        ops (CLIVerbOpts | None): the workspace doors, None outside one.
        paths (list[PathSpec]): --attach values, cwd-resolved.

    Raises:
        ValueError: there is no workspace to read from, or a path does
            not exist.
    """
    if not paths:
        return ()
    if ops is None or ops.dispatch is None:
        raise ValueError("--attach needs a workspace to read files from")
    attachments: list[Attachment] = []
    for spec in paths:
        try:
            data, _ = await ops.dispatch("read", spec)
        except FileNotFoundError:
            raise ValueError(f"read attachment {spec.virtual}: "
                             "No such file or directory") from None
        filename = posixpath.basename(spec.virtual.rstrip("/")) or "attachment"
        attachments.append(
            Attachment(filename=filename,
                       content_type=mime_type_for(filename),
                       data=data if isinstance(data, bytes) else bytes(data)))
    return tuple(attachments)


async def route(
    config: EmailConfig,
    fl: FlagView,
    stdin: ByteSource | None,
    source: Source | None,
    ops: CLIVerbOpts | None,
) -> tuple[ByteSource | None, IOResult]:
    """Assemble a message, then send it or write its MIME to stdout.

    Shared by compose, reply and forward: the three differ only in the
    source message they derive headers from. Without --send the raw
    RFC 5322 bytes go to stdout, so a composer chain can pick them up.

    Args:
        config (EmailConfig): the account.
        fl (FlagView): the leaf's parsed flags.
        stdin (ByteSource | None): piped body, used when --body is absent.
        source (Source | None): the replied-to or forwarded message.
        ops (CLIVerbOpts | None): the workspace doors, read only when
            --attach names files to load.
    """
    compose = Compose(
        sender=fl.as_str("from") or config.username,
        to=split_addresses(fl.as_list("to")),
        cc=split_addresses(fl.as_list("cc")),
        bcc=split_addresses(fl.as_list("bcc")),
        subject=fl.as_str("subject"),
        body=await read_body(fl, stdin),
        signature=fl.as_str("signature"),
        attachments=await load_attachments(ops, fl.as_paths("attach")),
    )
    message = build(compose, source)
    # SMTP is a CRLF protocol and these bytes go straight onto the wire
    # (or into `message send`), so serialize with the SMTP policy rather
    # than the LF-only default.
    raw = message.as_bytes(policy=SMTP)
    if not fl.as_bool("send"):
        return yield_bytes(raw), IOResult()
    await send_raw(config, raw)
    result = {
        "status": "sent",
        "to": message["To"],
        "subject": message["Subject"],
    }
    out = json.dumps(result, ensure_ascii=False,
                     separators=(",", ":")).encode()
    return yield_bytes(out), IOResult()
