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

import asyncio
import logging
import re
import ssl
from dataclasses import dataclass

logger = logging.getLogger(__name__)

# A line that announces a literal: the octet count in braces at its end.
_LITERAL = re.compile(rb"\{(\d+)\}\r?\n\Z")

# The longest response line read in one piece; a message body arrives as a
# literal, read by its count, so only text lines are held to this.
_LINE_LIMIT = 1 << 20

# An answer's lines, named once: the client's own `list` method shadows the
# builtin inside the class body.
_Lines = list[bytes | bytearray]


@dataclass(frozen=True, slots=True)
class IMAPResponse:
    """One command's answer.

    Args:
        result (str): the tagged status, ``OK``, ``NO`` or ``BAD``.
        lines (list[bytes | bytearray]): the untagged lines in order,
            each without its ``* `` and, for a command that answers in
            its own name (``LIST``, ``SEARCH``), without that name; a
            literal's octets as a bytearray of their own between the text
            before and after it; the tagged line's text last.
    """

    result: str
    lines: _Lines


def _quoted(value: str) -> str:
    """Spell a value as an IMAP quoted string.

    Args:
        value (str): the text, which may not hold a line break.

    Raises:
        ValueError: the value holds a CR or LF, which a quoted string
            cannot carry.
    """
    if "\r" in value or "\n" in value:
        raise ValueError("an IMAP quoted string cannot hold a line break")
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


class IMAPClient:
    """An IMAP4rev1 client over asyncio streams: one command at a time,
    synchronising literals, and the commands the email backend sends.

    Written for mirage rather than taken from a library: the asyncio IMAP
    client on PyPI is GPL-3.0, which an Apache-2.0 package cannot ship,
    while node's imapflow is MIT. The answer keeps the shape the email
    parsers read (``IMAPResponse``).

    Args:
        reader (asyncio.StreamReader): the connection's read side.
        writer (asyncio.StreamWriter): its write side.
    """

    def __init__(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        self._reader = reader
        self._writer = writer
        self._tag = 0
        self._lock = asyncio.Lock()

    @classmethod
    async def connect(
        cls, host: str, port: int, use_ssl: bool
    ) -> "IMAPClient":
        """Open a connection and read the server's greeting.

        Args:
            host (str): the server.
            port (int): its port.
            use_ssl (bool): speak TLS from the start (IMAPS).

        Raises:
            ConnectionError: the server greeted with anything but OK.
        """
        reader, writer = await asyncio.open_connection(
            host,
            port,
            ssl=ssl.create_default_context() if use_ssl else None,
            limit=_LINE_LIMIT,
        )
        client = cls(reader, writer)
        greeting = await client._readline()
        if not greeting.startswith(b"* OK"):
            writer.close()
            raise ConnectionError(
                f"IMAP server {host} refused the connection: "
                f"{greeting.decode(errors='replace').strip()}"
            )
        return client

    @property
    def alive(self) -> bool:
        """Whether the connection can still carry a command: the server
        has not closed or reset it and the client has not closed it."""
        return (
            self._reader.exception() is None
            and not self._reader.at_eof()
            and not self._writer.is_closing()
        )

    async def login(self, user: str, password: str) -> IMAPResponse:
        """Authenticate with LOGIN.

        Args:
            user (str): the account name.
            password (str): its password.
        """
        return await self._command("LOGIN", _quoted(user), _quoted(password))

    async def list(self, reference: str, pattern: str) -> IMAPResponse:
        """LIST mailboxes.

        Args:
            reference (str): the reference name, already spelled.
            pattern (str): the mailbox pattern, already spelled.
        """
        return await self._command("LIST", reference, pattern)

    async def select(self, mailbox: str) -> IMAPResponse:
        """SELECT a mailbox.

        Args:
            mailbox (str): the mailbox, already spelled (quoted).
        """
        return await self._command("SELECT", mailbox)

    async def search(
        self, criteria: str, charset: str | None = None
    ) -> IMAPResponse:
        """SEARCH the selected mailbox.

        Keys holding a non-ASCII character are sent as UTF-8 under
        ``CHARSET UTF-8`` unless another charset is named, since a
        server reads an unmarked key as US-ASCII.

        Args:
            criteria (str): the search keys, already spelled.
            charset (str | None): the CHARSET the keys are in; None
                names one only for non-ASCII keys.
        """
        if charset is None and not criteria.isascii():
            charset = "UTF-8"
        if charset is None:
            return await self._command("SEARCH", criteria)
        return await self._command("SEARCH", "CHARSET", charset, criteria)

    async def fetch(self, sequence: str, items: str) -> IMAPResponse:
        """FETCH by message sequence number.

        Args:
            sequence (str): the sequence set.
            items (str): the data items, parenthesized.
        """
        return await self._command("FETCH", sequence, items)

    async def uid(self, command: str, *args: str) -> IMAPResponse:
        """Run a command by UID (``UID FETCH``, ``UID STORE``, ...).

        Args:
            command (str): the command the UIDs address.
            *args (str): its arguments, already spelled.
        """
        return await self._command("UID", command.upper(), *args)

    async def append(
        self, message: bytes, mailbox: str, flags: str | None = None
    ) -> IMAPResponse:
        """APPEND a message to a mailbox.

        Args:
            message (bytes): the RFC 5322 message.
            mailbox (str): the mailbox, already spelled (quoted).
            flags (str | None): the flags to set, space-separated; None
                sets none.
        """
        args = [mailbox] if flags is None else [mailbox, f"({flags})"]
        return await self._command("APPEND", *args, literal=message)

    async def logout(self) -> IMAPResponse:
        """LOGOUT and close the connection."""
        try:
            return await self._command("LOGOUT")
        finally:
            await self.close()

    async def close(self) -> None:
        """Close the connection without a LOGOUT."""
        self._writer.close()
        try:
            await self._writer.wait_closed()
        except OSError as exc:
            logger.debug("IMAP connection closed uncleanly: %r", exc)

    async def _command(
        self, verb: str, *args: str, literal: bytes | None = None
    ) -> IMAPResponse:
        """Send one command and read its answer.

        A literal goes last, after the server's continuation, as a
        synchronising literal does.

        Args:
            verb (str): the command.
            *args (str): its arguments, already spelled.
            literal (bytes | None): octets sent as a final literal.
        """
        async with self._lock:
            self._tag += 1
            tag = f"M{self._tag:04d}"
            name = args[0] if verb == "UID" and args else verb
            line = " ".join((tag, verb, *args)).encode()
            lines: _Lines = []
            if literal is not None:
                self._writer.write(line + b" {%d}\r\n" % len(literal))
                await self._writer.drain()
                refused = await self._await_continuation(tag, name, lines)
                if refused is not None:
                    return refused
                self._writer.write(literal + b"\r\n")
            else:
                self._writer.write(line + b"\r\n")
            await self._writer.drain()
            return await self._read_answer(tag, name, lines)

    async def _await_continuation(
        self, tag: str, name: str, lines: _Lines
    ) -> IMAPResponse | None:
        """Read until the server asks for the literal, or refuses the
        command before it.

        Args:
            tag (str): the command's tag.
            name (str): the name its untagged answers carry.
            lines (list[bytes | bytearray]): the answer so far.

        Returns:
            IMAPResponse | None: the refusal, or None once the server is
            ready for the literal.
        """
        while True:
            raw = await self._readline()
            if raw.startswith(b"+"):
                return None
            done = await self._take(raw, tag, name, lines)
            if done is not None:
                return done

    async def _read_answer(
        self, tag: str, name: str, lines: _Lines
    ) -> IMAPResponse:
        """Read lines until the command's tagged status.

        Args:
            tag (str): the command's tag.
            name (str): the name its untagged answers carry.
            lines (list[bytes | bytearray]): the answer so far.
        """
        while True:
            done = await self._take(await self._readline(), tag, name, lines)
            if done is not None:
                return done

    async def _take(
        self,
        raw: bytes,
        tag: str,
        name: str,
        lines: _Lines,
    ) -> IMAPResponse | None:
        """File one response line, and its literals, into the answer.

        Args:
            raw (bytes): the line as read.
            tag (str): the command's tag.
            name (str): the name its untagged answers carry.
            lines (list[bytes | bytearray]): the answer so far.

        Returns:
            IMAPResponse | None: the answer once ``raw`` is the tagged
            status, else None.
        """
        prefix = tag.encode() + b" "
        if raw.startswith(prefix):
            status, _, text = (
                raw[len(prefix) :].rstrip(b"\r\n").partition(b" ")
            )
            lines.append(text)
            return IMAPResponse(status.decode().upper(), lines)
        if not raw.startswith(b"* "):
            return None
        text = raw[2:]
        word, space, _ = text.rstrip(b"\r\n").partition(b" ")
        if word.upper() == name.encode().upper():
            text = text[len(word) + len(space) :]
        while (found := _LITERAL.search(text)) is not None:
            lines.append(text[: found.start()] + b"{" + found[1] + b"}")
            lines.append(
                bytearray(await self._reader.readexactly(int(found[1])))
            )
            text = await self._readline()
        lines.append(text.rstrip(b"\r\n"))
        return None

    async def _readline(self) -> bytes:
        """One response line, CRLF included.

        Raises:
            ConnectionError: the server closed the connection.
        """
        raw = await self._reader.readline()
        if not raw:
            raise ConnectionError("the IMAP server closed the connection")
        return raw
