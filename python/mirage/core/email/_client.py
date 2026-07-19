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

from email import policy
from email.parser import BytesParser
from typing import Any

from mirage.accessor.email import EmailAccessor
from mirage.core.email._parse import parse_rfc822


async def list_folders(accessor: EmailAccessor) -> list[str]:
    imap = await accessor.get_imap()
    response = await imap.list('""', "*")
    folders: list[str] = []
    for line in response.lines:
        if isinstance(line, (bytes, bytearray)):
            line = bytes(line).decode(errors="replace")
        if '"' in line:
            parts = line.rsplit('"', 2)
            if len(parts) >= 2:
                folders.append(parts[-2])
    return folders


async def list_message_uids(
    accessor: EmailAccessor,
    folder: str,
    search_criteria: str = "ALL",
    max_results: int | None = None,
) -> list[str]:
    imap = await accessor.get_imap()
    await imap.select(folder)
    response = await imap.search(search_criteria, charset=None)
    if response.result != "OK" or not response.lines:
        return []
    raw = response.lines[0]
    if isinstance(raw, (bytes, bytearray)):
        raw = bytes(raw).decode()
    seq_nums = raw.split() if raw.strip() else []
    if not seq_nums:
        return []
    if max_results is not None:
        seq_nums = seq_nums[-max_results:]
    uids: list[str] = []
    batch_size = 50
    for i in range(0, len(seq_nums), batch_size):
        batch = seq_nums[i:i + batch_size]
        seq_set = ",".join(batch)
        uid_response = await imap.fetch(seq_set, "(UID)")
        for item in uid_response.lines:
            if isinstance(item, (bytes, bytearray)):
                line = bytes(item).decode(errors="replace")
            else:
                line = str(item)
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


async def fetch_message(
    accessor: EmailAccessor,
    folder: str,
    uid: str,
) -> dict[str, Any]:
    imap = await accessor.get_imap()
    await imap.select(folder)
    # BODY.PEEK[] instead of RFC822: reading a rendered file must not flip
    # \Seen on the mailbox, matching the imapflow client in the TS backend.
    response = await imap.uid("fetch", uid, "(BODY.PEEK[] FLAGS)")
    raw_bytes = _extract_body(response)
    flags = _extract_flags(response)
    msg_dict = parse_rfc822(raw_bytes)
    msg_dict["uid"] = uid
    msg_dict["flags"] = flags
    return msg_dict


async def fetch_headers(
    accessor: EmailAccessor,
    folder: str,
    uids: list[str],
) -> list[dict[str, Any]]:
    if not uids:
        return []
    imap = await accessor.get_imap()
    await imap.select(folder)
    results: list[dict[str, Any]] = []
    batch_size = 25
    for i in range(0, len(uids), batch_size):
        batch = uids[i:i + batch_size]
        uid_set = ",".join(batch)
        # Full BODY.PEEK[] rather than BODY[HEADER]: attachment names live
        # in the MIME structure, and listings must surface attachment dirs
        # without flipping \Seen (the gmail backend fetches full messages
        # on readdir the same way).
        response = await imap.uid("fetch", uid_set, "(BODY.PEEK[] FLAGS UID)")
        results.extend(_parse_multi_fetch(response, batch))
    return results


async def fetch_attachment(
    accessor: EmailAccessor,
    folder: str,
    uid: str,
    filename: str,
) -> bytes | None:
    imap = await accessor.get_imap()
    await imap.select(folder)
    response = await imap.uid("fetch", uid, "(BODY.PEEK[])")
    raw_bytes = _extract_body(response)
    attachments = _parse_with_payloads(raw_bytes)
    for att in attachments:
        if att["filename"] == filename:
            return att["payload"]
    return None


def _parse_with_payloads(raw: bytes) -> list[dict[str, Any]]:
    msg = BytesParser(policy=policy.default).parsebytes(raw)
    attachments: list[dict[str, Any]] = []
    if msg.is_multipart():
        for part in msg.walk():
            disposition = str(part.get("Content-Disposition", ""))
            if "attachment" in disposition:
                payload = part.get_payload(decode=True) or b""
                attachments.append({
                    "filename": part.get_filename() or "unnamed",
                    "payload": payload,
                })
    return attachments


def _extract_body(response) -> bytes:
    for item in response.lines:
        if isinstance(item, (bytearray, )) and len(item) > 20:
            return bytes(item)
        if isinstance(item, bytes) and len(item) > 100:
            return item
    return b""


def _extract_flags(response) -> list[str]:
    for item in response.lines:
        if isinstance(item, (bytes, bytearray)):
            line = bytes(item).decode(errors="replace")
        else:
            line = str(item)
        if "FLAGS" in line:
            try:
                start = line.index("(", line.index("FLAGS")) + 1
                end = line.index(")", start)
                return line[start:end].split()
            except ValueError:
                # tolerant IMAP parse: skip lines that do not match the shape
                pass
    return []


def _parse_multi_fetch(response, uids: list[str]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    current_uid = None
    current_flags: list[str] = []

    for item in response.lines:
        if isinstance(item, (bytes, bytearray)):
            line = bytes(item).decode(errors="replace")
        else:
            line = str(item)

        if "FETCH" in line and "UID" in line:
            try:
                uid_idx = line.index("UID") + 4
                uid_end = line.index(
                    " ", uid_idx) if " " in line[uid_idx:] else len(line)
                current_uid = line[uid_idx:uid_end].strip(")")
            except (ValueError, IndexError):
                # tolerant IMAP parse: skip lines that do not match the shape
                pass
            if "FLAGS" in line:
                current_flags = _extract_flags_from_line(line)
            continue

        if isinstance(item, (bytearray, )) and len(item) > 20:
            raw = bytes(item)
            # Full parse (not headers_only): listings need the MIME
            # structure to surface attachment dirs.
            msg_dict = parse_rfc822(raw)
            msg_dict["uid"] = current_uid or (uids[len(results)] if
                                              len(results) < len(uids) else "")
            msg_dict["flags"] = current_flags
            results.append(msg_dict)
            current_uid = None
            current_flags = []

    return results


def _extract_flags_from_line(line: str) -> list[str]:
    try:
        start = line.index("(", line.index("FLAGS")) + 1
        end = line.index(")", start)
        return line[start:end].split()
    except ValueError:
        return []
