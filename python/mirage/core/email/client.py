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
from typing import Any

from mirage.accessor.email import EmailAccessor
from mirage.accessor.imap import IMAPClient, IMAPResponse
from mirage.core.email._parse import parse_rfc822, parse_with_payloads

INTERNAL_DATE_KEY = "internal_date"
INTERNAL_DATE_RE = re.compile(r'INTERNALDATE "([^"]*)"')
# Metadata is asked for ahead of the body: a server may answer the items
# in the order they were requested, and anything after BODY[] lands on
# the line *behind* the literal, where the parsers below never look.
FETCH_ITEMS = "(UID FLAGS INTERNALDATE BODY.PEEK[])"


def quote_string(value: str) -> str:
    """Spell a value as an RFC 3501 quoted string.

    The two quoted-specials, ``"`` and ``\\``, are escaped with a
    backslash and nothing else is touched. A mailbox is always sent
    quoted, since the client joins arguments with spaces as given and a
    name holding one (``Sent Items``, ``[Gmail]/Sent Mail``) would
    arrive as two words. A CR or LF has no spelling inside a quoted
    string, so a value holding one is refused here rather than sent,
    where it would end the command line early.

    Args:
        value (str): the text as the caller means it.

    Returns:
        str: the value wrapped in quotes with its specials escaped.

    Raises:
        ValueError: the value holds a line break.
    """
    if "\r" in value or "\n" in value:
        raise ValueError("an IMAP quoted string cannot hold a line break")
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def read_quoted(text: str) -> tuple[str, str]:
    """Read one RFC 3501 quoted string off the front of ``text``.

    Args:
        text (str): a fragment whose first character is the opening
            quote.

    Returns:
        tuple[str, str]: the unescaped contents, and whatever follows
            the closing quote with leading spaces dropped.
    """
    chars: list[str] = []
    index = 1
    while index < len(text):
        char = text[index]
        if char == "\\" and index + 1 < len(text):
            chars.append(text[index + 1])
            index += 2
            continue
        if char == '"':
            return "".join(chars), text[index + 1 :].lstrip()
        chars.append(char)
        index += 1
    return "".join(chars), ""


def parse_folder_line(
    line: bytes | bytearray,
) -> tuple[str, tuple[str, ...]] | None:
    """Read one LIST response line as a name and its attributes.

    The grammar is ``(attrs) delimiter mailbox``, and the mailbox is an
    astring: a quoted string on most servers but a bare atom whenever
    the name needs no quoting, which is legal and which some servers
    emit. Splitting on quotes reads the delimiter as the name for the
    atom form, so the three tokens are walked in order instead.

    Args:
        line (bytes | bytearray): one line of the LIST response.

    Returns:
        tuple[str, tuple[str, ...]] | None: the mailbox name and its
            attributes, or None for a line that is not a mailbox (the
            trailing "LIST completed" among them).
    """
    text = bytes(line).decode(errors="replace").strip()
    # An untagged LIST line always opens with its attribute list, which
    # is what tells it apart from the completion line.
    if not text.startswith("("):
        return None
    end = text.find(")")
    if end == -1:
        return None
    attributes = tuple(text[1:end].split())
    rest = text[end + 1 :].lstrip()
    if rest.startswith('"'):
        _, rest = read_quoted(rest)
    elif rest[:3].upper() == "NIL":
        rest = rest[3:].lstrip()
    if not rest:
        return None
    name = read_quoted(rest)[0] if rest.startswith('"') else rest.split()[0]
    return (name, attributes) if name else None


async def list_folder_entries(
    accessor: EmailAccessor,
) -> list[tuple[str, tuple[str, ...]]]:
    imap = await accessor.get_imap()
    response = await imap.list('""', "*")
    entries: list[tuple[str, tuple[str, ...]]] = []
    for line in response.lines:
        parsed = parse_folder_line(line)
        if parsed is not None:
            entries.append(parsed)
    return entries


async def select_folder(imap: IMAPClient, folder: str) -> None:
    """Select a mailbox, failing loudly when it does not exist.

    An unchecked SELECT leaves the session in AUTH state, and the next
    command then fails with a raw protocol complaint ("command SEARCH
    illegal in state AUTH") that names neither the mailbox nor the
    problem.

    Args:
        imap (IMAPClient): the connected client.
        folder (str): the mailbox to select.

    Raises:
        FileNotFoundError: the server refused the mailbox.
    """
    response = await imap.select(quote_string(folder))
    if response.result != "OK":
        raise FileNotFoundError(f"no such mailbox {folder!r}")


async def list_folders(accessor: EmailAccessor) -> list[str]:
    return [name for name, _ in await list_folder_entries(accessor)]


async def list_message_uids(
    accessor: EmailAccessor,
    folder: str,
    search_criteria: str = "ALL",
    max_results: int | None = None,
) -> list[str]:
    imap = await accessor.get_imap()
    await select_folder(imap, folder)
    response = await imap.search(search_criteria, charset=None)
    if response.result != "OK":
        # A refused SEARCH must not read as "matched nothing": that hides
        # criteria the server cannot answer behind an empty result.
        raise ValueError(f"IMAP rejected the search: {search_criteria}")
    if not response.lines:
        return []
    seq_nums = bytes(response.lines[0]).decode().split()
    if not seq_nums:
        return []
    if max_results is not None:
        seq_nums = seq_nums[-max_results:]
    uids: list[str] = []
    batch_size = 50
    for i in range(0, len(seq_nums), batch_size):
        batch = seq_nums[i : i + batch_size]
        seq_set = ",".join(batch)
        uid_response = await imap.fetch(seq_set, "(UID)")
        for line in _text_lines(uid_response):
            if "UID" in line:
                try:
                    uid_idx = line.index("UID") + 4
                    rest = line[uid_idx:].strip()
                    uid_val = rest.split(")")[0].split()[0]
                    uids.append(uid_val)
                except (ValueError, IndexError):
                    # tolerant IMAP parse: skip lines that do not match
                    pass
    return uids


async def fetch_raw_message(
    accessor: EmailAccessor,
    folder: str,
    uid: str,
) -> bytes:
    imap = await accessor.get_imap()
    await select_folder(imap, folder)
    response = await imap.uid("fetch", uid, "(BODY.PEEK[])")
    return _extract_body(response)


async def fetch_message(
    accessor: EmailAccessor,
    folder: str,
    uid: str,
) -> dict[str, Any]:
    imap = await accessor.get_imap()
    await select_folder(imap, folder)
    # BODY.PEEK[] instead of RFC822: reading a rendered file must not flip
    # \Seen on the mailbox, matching the imapflow client in the TS backend.
    response = await imap.uid("fetch", uid, FETCH_ITEMS)
    raw_bytes = _extract_body(response)
    flags = _extract_flags(response)
    msg_dict = parse_rfc822(raw_bytes)
    msg_dict["uid"] = uid
    msg_dict["flags"] = flags
    msg_dict[INTERNAL_DATE_KEY] = _extract_internal_date(response)
    return msg_dict


async def fetch_headers(
    accessor: EmailAccessor,
    folder: str,
    uids: list[str],
) -> list[dict[str, Any]]:
    if not uids:
        return []
    imap = await accessor.get_imap()
    await select_folder(imap, folder)
    results: list[dict[str, Any]] = []
    batch_size = 25
    for i in range(0, len(uids), batch_size):
        batch = uids[i : i + batch_size]
        uid_set = ",".join(batch)
        # Full BODY.PEEK[] rather than BODY[HEADER]: attachment names live
        # in the MIME structure, and listings must surface attachment dirs
        # without flipping \Seen (the gmail backend fetches full messages
        # on readdir the same way).
        response = await imap.uid("fetch", uid_set, FETCH_ITEMS)
        results.extend(_parse_multi_fetch(response, batch))
    return results


async def fetch_attachment(
    accessor: EmailAccessor,
    folder: str,
    uid: str,
    filename: str,
) -> bytes | None:
    imap = await accessor.get_imap()
    await select_folder(imap, folder)
    response = await imap.uid("fetch", uid, "(BODY.PEEK[])")
    raw_bytes = _extract_body(response)
    attachments = parse_with_payloads(raw_bytes)
    for att in attachments:
        if att["filename"] == filename:
            return att["payload"]
    return None


def _text_lines(response: IMAPResponse) -> list[str]:
    """An answer's text lines, decoded, its literals left out: a message
    whose own text names FLAGS or INTERNALDATE must not be read as the
    mailbox's.

    Args:
        response (IMAPResponse): the answer.
    """
    return [
        item.decode(errors="replace")
        for item in response.lines
        if not isinstance(item, bytearray)
    ]


def _extract_body(response: IMAPResponse) -> bytes:
    """The message a FETCH answer carries: its literal.

    Args:
        response (IMAPResponse): the answer to a BODY.PEEK[] fetch.
    """
    for item in response.lines:
        if isinstance(item, bytearray):
            return bytes(item)
    return b""


def _extract_flags(response: IMAPResponse) -> list[str]:
    """The flags a FETCH answer reports.

    Args:
        response (IMAPResponse): the answer.
    """
    for line in _text_lines(response):
        if "FLAGS" in line:
            return _extract_flags_from_line(line)
    return []


def _parse_multi_fetch(
    response: IMAPResponse, uids: list[str]
) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    current_uid = None
    current_flags: list[str] = []
    current_internal = ""

    for item in response.lines:
        if isinstance(item, bytearray):
            # Full parse (not headers_only): listings need the MIME
            # structure to surface attachment dirs.
            msg_dict = parse_rfc822(bytes(item))
            msg_dict["uid"] = current_uid or (
                uids[len(results)] if len(results) < len(uids) else ""
            )
            msg_dict["flags"] = current_flags
            msg_dict[INTERNAL_DATE_KEY] = current_internal
            results.append(msg_dict)
            current_uid = None
            current_flags = []
            current_internal = ""
            continue
        line = item.decode(errors="replace")
        if "FETCH" in line and "UID" in line:
            try:
                uid_idx = line.index("UID") + 4
                uid_end = (
                    line.index(" ", uid_idx)
                    if " " in line[uid_idx:]
                    else len(line)
                )
                current_uid = line[uid_idx:uid_end].strip(")")
            except (ValueError, IndexError):
                # tolerant IMAP parse: skip lines that do not match the shape
                pass
            if "FLAGS" in line:
                current_flags = _extract_flags_from_line(line)
            current_internal = _internal_date_from_line(line)

    return results


def _internal_date_from_line(line: str) -> str:
    match = INTERNAL_DATE_RE.search(line)
    return match.group(1) if match else ""


def _extract_internal_date(response: IMAPResponse) -> str:
    """The INTERNALDATE a FETCH answer reports.

    Args:
        response (IMAPResponse): the answer.
    """
    for line in _text_lines(response):
        found = _internal_date_from_line(line)
        if found:
            return found
    return ""


def _extract_flags_from_line(line: str) -> list[str]:
    try:
        start = line.index("(", line.index("FLAGS")) + 1
        end = line.index(")", start)
        return line[start:end].split()
    except ValueError:
        return []
