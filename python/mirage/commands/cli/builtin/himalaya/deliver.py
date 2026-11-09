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
from mirage.commands.cli.builtin.himalaya.printer import ChainedError
from mirage.commands.cli.builtin.himalaya.smtp import send_raw
from mirage.core.email.client import list_folder_entries, quote_string

logger = logging.getLogger(__name__)

SENT_ATTRIBUTE = "\\sent"
DEFAULT_SENT_FOLDER = "Sent"
SEEN_FLAG = "\\Seen"


async def resolve_sent_folder(
    accessor: EmailAccessor, configured: str | None
) -> str:
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
    return await tagged_folder(accessor, SENT_ATTRIBUTE, DEFAULT_SENT_FOLDER)


async def tagged_folder(
    accessor: EmailAccessor, attribute: str, default: str
) -> str:
    """The mailbox the server tags with an RFC 6154 attribute.

    Args:
        accessor (EmailAccessor): the logged-in account.
        attribute (str): the attribute, lowercase, such as ``\\trash``.
        default (str): the name to use when no mailbox carries it.
    """
    for name, attributes in await list_folder_entries(accessor):
        if any(attr.lower() == attribute for attr in attributes):
            return name
    return default


async def append_message(
    accessor: EmailAccessor,
    raw: bytes,
    folder: str,
    flags: str,
) -> str | None:
    """APPEND a message and report the UID the server assigned.

    Args:
        accessor (EmailAccessor): the install's account, whose IMAP
            connection the APPEND rides and stays open after it.
        raw (bytes): the RFC 5322 bytes.
        folder (str): the mailbox.
        flags (str): the flags to set, space separated.

    Returns:
        str | None: the new message's UID, None when the server does not
            report one.

    Raises:
        ValueError: the server refused the APPEND.
    """
    imap = await accessor.get_imap()
    response = await imap.append(
        raw, mailbox=quote_string(folder), flags=flags or None
    )
    if response.result != "OK":
        detail = " ".join(
            line.decode(errors="replace") for line in response.lines
        )
        raise ValueError(f"{folder}: {detail or response.result}")
    for line in response.lines:
        text = line.decode(errors="replace")
        marker = text.find("[APPENDUID ")
        if marker >= 0:
            return text[marker + 1 :].split("]", 1)[0].split()[2]
    return None


async def save_sent_copy(
    accessor: EmailAccessor, raw: bytes, folder: str | None = None
) -> str:
    """APPEND a message to a mailbox, seen, the way upstream saves one.

    Args:
        accessor (EmailAccessor): the install's account.
        raw (bytes): the same RFC 5322 bytes SMTP carried.
        folder (str | None): the mailbox --save named. None resolves the
            account's sent mailbox instead.

    Returns:
        str: the mailbox the copy landed in.
    """
    folder = folder or await resolve_sent_folder(
        accessor, accessor.config.sent_folder
    )
    await append_message(accessor, raw, folder, SEEN_FLAG)
    return folder


async def deliver(
    accessor: EmailAccessor,
    raw: bytes,
    save: str | None = None,
    no_save: bool = False,
) -> tuple[Message, bool]:
    """Send a message over SMTP, then file the sender's own copy.

    Two conversations with two servers: SMTP hands the message to the
    recipient's side and keeps no record, so the copy in the sender's
    Sent mailbox is a separate IMAP APPEND. ``--save <MAILBOX>`` names
    it, the account's ``save_copy`` asks for one without the flag, and
    ``--no-save`` skips it. The send goes first, so a failed send leaves
    no copy behind; a copy that then fails is reported as a failure of
    the command, the way upstream reports it, saying the message left.

    Args:
        accessor (EmailAccessor): the install's account.
        raw (bytes): the complete RFC 5322 message.
        save (str | None): the mailbox --save named, if any.
        no_save (bool): skip the copy the account configures.

    Returns:
        tuple[Message, bool]: the parsed message, and whether a copy was
            saved.

    Raises:
        ChainedError: the copy failed after the message was sent.
    """
    message = await send_raw(accessor.config, raw)
    if no_save or (save is None and not accessor.config.save_copy):
        return message, False
    folder = save or accessor.config.sent_folder or DEFAULT_SENT_FOLDER
    try:
        folder = save or await resolve_sent_folder(
            accessor, accessor.config.sent_folder
        )
        await append_message(accessor, raw, folder, SEEN_FLAG)
    except Exception as exc:
        logger.warning("sent copy not saved: %s", exc)
        raise ChainedError(
            f"Message sent, but saving a copy to {folder} failed",
            (str(exc),),
        ) from exc
    return message, True
