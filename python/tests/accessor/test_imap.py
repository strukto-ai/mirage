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
from collections.abc import AsyncIterator, Awaitable, Callable

import pytest
import pytest_asyncio

from mirage.accessor.imap import IMAPClient

MESSAGE = b"Subject: hi\r\n\r\nbody\r\n"

Script = Callable[[str, str, asyncio.StreamReader], list[bytes]]


async def _serve(
    script: Script,
    received: list[str],
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
) -> None:
    writer.write(b"* OK IMAP4rev1 ready\r\n")
    while line := await reader.readline():
        text = line.decode().rstrip("\r\n")
        received.append(text)
        tag, _, rest = text.partition(" ")
        for out in script(tag, rest, reader):
            writer.write(out)
        await writer.drain()
        if rest.upper() == "LOGOUT":
            break
    writer.close()


def _answers(tag: str, rest: str, reader: asyncio.StreamReader) -> list[bytes]:
    verb = rest.split(" ")[0].upper()
    done = f"{tag} OK {verb} completed\r\n".encode()
    if verb == "LIST":
        return [
            b'* LIST (\\HasNoChildren) "/" "INBOX"\r\n',
            b'* LIST (\\HasNoChildren) "/" "Sent Items"\r\n',
            done,
        ]
    if verb == "SEARCH" and rest.endswith("NONE"):
        return [b"* SEARCH\r\n", done]
    if verb == "SEARCH" and rest.endswith("UPDATED"):
        return [
            b"* 23 EXISTS\r\n",
            b"* 1 RECENT\r\n",
            b"* SEARCH 1 2\r\n",
            done,
        ]
    if verb == "SEARCH":
        return [b"* SEARCH 1 2\r\n", done]
    if verb == "UID":
        literal = b"{%d}\r\n" % len(MESSAGE)
        return [
            b"* 1 FETCH (UID 7 FLAGS (\\Seen) BODY[] " + literal,
            MESSAGE,
            b")\r\n",
            f"{tag} OK FETCH completed\r\n".encode(),
        ]
    if verb == "LOGOUT":
        return [b"* BYE\r\n", done]
    return [done]


@pytest_asyncio.fixture
async def imap_server() -> AsyncIterator[
    Callable[[Script], Awaitable[tuple[IMAPClient, list[str]]]]
]:
    servers: list[asyncio.Server] = []
    clients: list[IMAPClient] = []

    async def start(script: Script) -> tuple[IMAPClient, list[str]]:
        received: list[str] = []
        server = await asyncio.start_server(
            lambda r, w: _serve(script, received, r, w), "127.0.0.1", 0
        )
        servers.append(server)
        port = server.sockets[0].getsockname()[1]
        clients.append(await IMAPClient.connect("127.0.0.1", port, False))
        return clients[-1], received

    yield start
    for client in clients:
        await client.close()
    for server in servers:
        server.close()
        await server.wait_closed()


@pytest.mark.asyncio
async def test_login_quotes_its_arguments(imap_server):
    client, received = await imap_server(_answers)
    response = await client.login('a"b', "p\\q")
    assert response.result == "OK"
    assert received[0].split(" ", 1)[1] == 'LOGIN "a\\"b" "p\\\\q"'


@pytest.mark.asyncio
async def test_a_command_named_answer_drops_its_name(imap_server):
    client, _ = await imap_server(_answers)
    listing = await client.list('""', "*")
    assert listing.lines == [
        b'(\\HasNoChildren) "/" "INBOX"',
        b'(\\HasNoChildren) "/" "Sent Items"',
        b"LIST completed",
    ]
    assert (await client.search("ALL")).lines[0] == b"1 2"
    assert (await client.search("NONE")).lines[0] == b""


@pytest.mark.asyncio
async def test_a_literal_stands_between_the_text_around_it(imap_server):
    client, _ = await imap_server(_answers)
    response = await client.uid("fetch", "7", "(UID FLAGS BODY.PEEK[])")
    assert response.lines == [
        b"1 FETCH (UID 7 FLAGS (\\Seen) BODY[] {%d}" % len(MESSAGE),
        bytearray(MESSAGE),
        b")",
        b"FETCH completed",
    ]
    assert isinstance(response.lines[1], bytearray)


@pytest.mark.asyncio
async def test_non_ascii_keys_are_searched_as_utf8(imap_server):
    client, received = await imap_server(_answers)
    await client.search('FROM "José"')
    assert received[-1].split(" ", 1)[1] == 'SEARCH CHARSET UTF-8 FROM "José"'


async def _append_server(
    refuse: bool, got: dict[str, bytes]
) -> tuple[asyncio.Server, int]:
    async def serve(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        writer.write(b"* OK IMAP4rev1 ready\r\n")
        line = await reader.readline()
        got["line"] = line.rstrip(b"\r\n")
        tag = line.split(b" ")[0]
        if refuse:
            writer.write(tag + b" NO [TRYCREATE] no such mailbox\r\n")
            await writer.drain()
            await reader.read()
            writer.close()
            return
        writer.write(b"+ ready for literal data\r\n")
        await writer.drain()
        count = int(got["line"].rsplit(b"{", 1)[1][:-1])
        got["literal"] = await reader.readexactly(count)
        got["end"] = await reader.readline()
        writer.write(tag + b" OK APPEND completed\r\n")
        await writer.drain()
        await reader.read()
        writer.close()

    server = await asyncio.start_server(serve, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1]


@pytest.mark.asyncio
async def test_append_sends_its_literal_after_the_continuation():
    got: dict[str, bytes] = {}
    server, port = await _append_server(False, got)
    try:
        client = await IMAPClient.connect("127.0.0.1", port, False)
        response = await client.append(MESSAGE, '"Sent"', "\\Seen")
        assert response.result == "OK"
        assert got["line"].endswith(
            b'APPEND "Sent" (\\Seen) {%d}' % len(MESSAGE)
        )
        assert (got["literal"], got["end"]) == (MESSAGE, b"\r\n")
        await client.close()
    finally:
        server.close()
        await server.wait_closed()


@pytest.mark.asyncio
async def test_a_refused_append_answers_before_the_literal():
    got: dict[str, bytes] = {}
    server, port = await _append_server(True, got)
    try:
        client = await IMAPClient.connect("127.0.0.1", port, False)
        response = await client.append(MESSAGE, '"Gone"')
        assert response.result == "NO"
        assert response.lines == [b"[TRYCREATE] no such mailbox"]
        assert "literal" not in got
        await client.close()
    finally:
        server.close()
        await server.wait_closed()


@pytest.mark.asyncio
async def test_a_closed_connection_is_not_alive(imap_server):
    client, _ = await imap_server(_answers)
    assert client.alive
    assert (await client.logout()).result == "OK"
    assert not client.alive
    with pytest.raises(ConnectionError):
        await client.select('"INBOX"')


@pytest.mark.asyncio
async def test_an_update_the_server_volunteers_stays_out_of_the_answer(
    imap_server,
):
    client, _ = await imap_server(_answers)
    response = await client.search("UPDATED")
    assert response.lines == [b"1 2", b"SEARCH completed"]


async def _quiet_server(
    after_login: bytes,
) -> tuple[asyncio.Server, int]:
    async def serve(
        reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        writer.write(b"* OK IMAP4rev1 ready\r\n")
        line = await reader.readline()
        tag = line.split(b" ")[0]
        writer.write(tag + b" OK LOGIN completed\r\n" + after_login)
        await writer.drain()
        if after_login:
            writer.close()
            return
        await reader.read()
        writer.close()

    server = await asyncio.start_server(serve, "127.0.0.1", 0)
    return server, server.sockets[0].getsockname()[1]


@pytest.mark.asyncio
async def test_a_server_that_says_bye_while_idle_is_not_alive():
    server, port = await _quiet_server(b"* BYE idle too long\r\n")
    try:
        client = await IMAPClient.connect("127.0.0.1", port, False)
        assert (await client.login("u", "p")).result == "OK"
        await asyncio.sleep(0.1)
        assert not client.alive
        await client.close()
    finally:
        server.close()
        await server.wait_closed()


@pytest.mark.asyncio
async def test_an_abandoned_command_closes_the_connection():
    server, port = await _quiet_server(b"")
    try:
        client = await IMAPClient.connect("127.0.0.1", port, False)
        assert (await client.login("u", "p")).result == "OK"
        with pytest.raises(TimeoutError):
            await asyncio.wait_for(client.select('"INBOX"'), 0.2)
        assert not client.alive
        await client.close()
    finally:
        server.close()
        await server.wait_closed()
