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
from dataclasses import dataclass
from typing import Literal, TypedDict

from mirage.rs.stream import open_stream


class Address(TypedDict):
    name: str | None
    address: str | None


@dataclass(frozen=True, slots=True)
class Attachment:
    id: str
    filename: str | None
    mime: str | None
    size: int
    inline: bool
    payload: bytes


def render_mime(
    raw: bytes,
    view: Literal["json", "read", "template", "attachments", "addresses"],
    *,
    payloads: bool = False,
) -> bytes:
    """Run a message projection in the shared parser.

    Args:
        raw (bytes): the RFC 5322 message or one address header value.
        view (str): the requested projection.
        payloads (bool): whether the attachment projection includes payloads.
    """
    stream = open_stream("mime", {"view": view, "payloads": payloads})
    try:
        stream.feed(raw)
        return stream.finish()
    finally:
        stream.close()


def parse_addresses(value: str) -> list[Address]:
    """Decode an address header value.

    Args:
        value (str): an address header value.
    """
    return json.loads(render_mime(f"{value}\n".encode(), "addresses"))


def parse_attachments(raw: bytes, *, payloads: bool) -> list[Attachment]:
    """Decode attachment metadata and, for writes, the payloads.

    Args:
        raw (bytes): the RFC 5322 message.
        payloads (bool): whether to return contents.
    """
    output = render_mime(raw, "attachments", payloads=payloads)
    end = len(output) - 4
    metadata = end - int.from_bytes(output[end:], "little")
    rows = []
    start = 0
    for row in json.loads(output[metadata:end]):
        finish = start + row["size"]
        rows.append(
            Attachment(
                **row, payload=output[start:finish] if payloads else b""
            )
        )
        start = finish
    return rows
