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

import logging
from email.message import Message

from mirage.accessor.email import EmailAccessor
from mirage.commands.cli.builtin.himalaya.smtp import send_raw
from mirage.core.email._client import list_folder_entries, quote_mailbox
from mirage.core.email.config import EmailConfig

logger = logging.getLogger(__name__)

SENT_ATTRIBUTE = "\\sent"
DEFAULT_SENT_FOLDER = "Sent"
SEEN_FLAG = "\\Seen"


async def resolve_sent_folder(accessor: EmailAccessor,
                              configured: str | None) -> str:
    """Name the mailbox a sent copy belongs in.

    IMAP never standardized that name: it is ``Sent`` on most servers,
    ``Sent Items`` on Exchange and ``[Gmail]/Sent Mail`` on Gmail. A
    server that implements RFC 6154 tags the right one \\Sent in its
    LIST reply, so asking beats guessing; upstream himalaya has no
    probe and falls back on its folder.alias.sent, which is what the
    configured name is here.

    Args:
        accessor (EmailAccessor): the logged-in account.
        configured (str | None): sent_folder, when the deployment
            pinned one. It wins, so a server whose tag is wrong stays
            correctable.

    Returns:
        str: the mailbox name to append into.
    """
    if configured:
        return configured
    for name, attributes in await list_folder_entries(accessor):
        if any(attr.lower() == SENT_ATTRIBUTE for attr in attributes):
            return name
    return DEFAULT_SENT_FOLDER


async def save_sent_copy(config: EmailConfig,
                         raw: bytes,
                         folder: str | None = None) -> str:
    """APPEND a message to a mailbox, seen, the way upstream saves one.

    Args:
        config (EmailConfig): the account.
        raw (bytes): the same RFC 5322 bytes SMTP carried.
        folder (str | None): the mailbox --save named. None resolves the
            account's sent mailbox instead.

    Returns:
        str: the mailbox the copy landed in.

    Raises:
        ValueError: the server refused the APPEND.
    """
    accessor = EmailAccessor(config)
    try:
        folder = folder or await resolve_sent_folder(accessor,
                                                     config.sent_folder)
        imap = await accessor.get_imap()
        response = await imap.append(raw,
                                     mailbox=quote_mailbox(folder),
                                     flags=SEEN_FLAG)
        if response.result != "OK":
            detail = " ".join(
                line.decode(
                    errors="replace") if isinstance(line, (
                        bytes, bytearray)) else str(line)
                for line in (response.lines or []))
            raise ValueError(f"{folder}: {detail or response.result}")
    finally:
        await accessor.close()
    return folder


async def deliver(config: EmailConfig,
                  raw: bytes,
                  save: str | None = None) -> tuple[Message, str]:
    """Send a message over SMTP, then file the sender's own copy.

    Two conversations with two servers: SMTP hands the message to the
    recipient's side and keeps no record, so the copy in the sender's
    Sent mailbox is a separate IMAP APPEND that every mail client makes
    on its own. Upstream v2 spells that APPEND as ``--save <MAILBOX>``
    and does nothing without it; mirage keeps the account-level
    ``save_copy`` on top, defaulted on, so an agent that never learned
    the flag still leaves the record a human sender would.

    The other deliberate divergence is the failure arm. Upstream
    propagates, which fails the command after the mail has already left;
    here the APPEND failure is reported on stderr and the verb still
    succeeds, because a non-zero exit invites a retry that sends the
    message twice. Nothing is swallowed: the reason is logged and
    printed. A ``--save`` that sends nothing does not go through here at
    all, precisely because nothing happened yet and failing is safe.

    Args:
        config (EmailConfig): the account.
        raw (bytes): the complete RFC 5322 message.
        save (str | None): the mailbox --save named, if any.

    Returns:
        tuple[Message, str]: the parsed message, and a warning line for
            stderr which is empty when there is nothing to report.
    """
    message = await send_raw(config, raw)
    if save is None and not config.save_copy:
        return message, ""
    try:
        await save_sent_copy(config, raw, save)
    except Exception as exc:
        # Every failure mode is caught on purpose: the message is
        # already delivered by this point, so no fault of the copy may
        # turn into a failed send.
        logger.warning("sent copy not saved: %s", exc)
        return message, f"himalaya: sent copy not saved: {exc}\n"
    return message, ""
