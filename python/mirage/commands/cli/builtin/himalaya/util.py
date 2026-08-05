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
from email.policy import SMTP

from mirage.commands.cli.builtin.himalaya.builder import (Compose, Source,
                                                          build, read_body,
                                                          split_addresses)
from mirage.commands.cli.builtin.himalaya.smtp import send_raw
from mirage.commands.spec.types import FlagView
from mirage.core.email.config import EmailConfig
from mirage.io.stream import yield_bytes
from mirage.io.types import ByteSource, IOResult


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


async def route(
    config: EmailConfig,
    fl: FlagView,
    stdin: ByteSource | None,
    source: Source | None,
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
    """
    compose = Compose(
        sender=fl.as_str("from") or config.username,
        to=split_addresses(fl.as_list("to")),
        cc=split_addresses(fl.as_list("cc")),
        bcc=split_addresses(fl.as_list("bcc")),
        subject=fl.as_str("subject"),
        body=await read_body(fl, stdin),
        signature=fl.as_str("signature"),
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
