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

from dataclasses import replace

from mirage.shell.parse.heredoc.constants import (BACKSLASH, BACKTICK, DOLLAR,
                                                  DOUBLE_QUOTE)
from mirage.shell.parse.heredoc.line import (construct_closer, construct_end,
                                             quote_end)
from mirage.shell.parse.heredoc.types import Heredoc, HeredocSource


def quoted_body(doc: Heredoc) -> tuple[bytes, list[int]]:
    """Encode a body as one expansion word, preserving substitution syntax.

    Args:
        doc (Heredoc): source reader's body and quoting decision.
    """
    out = bytearray(b'"')
    offsets = [doc.body_start]
    index = 0
    while index < len(doc.body):
        byte = doc.body[index]
        end = None
        if not doc.quoted:
            closer = construct_closer(doc.body, index,
                                      False) if byte == DOLLAR else None
            if closer is not None:
                end = construct_end(doc.body, index, closer)
            elif byte == BACKTICK:
                end = quote_end(doc.body, index)
            elif byte == BACKSLASH and doc.body[index + 1:index +
                                                2] in (b"$", b"`", b"\\"):
                end = index + 2
        if end is not None:
            out.extend(doc.body[index:end])
            offsets.extend(doc.offsets[index:end])
            index = end
            continue
        if byte in (DOUBLE_QUOTE,
                    BACKSLASH) or doc.quoted and byte in (DOLLAR, BACKTICK):
            out.append(BACKSLASH)
            offsets.append(doc.offsets[index])
        out.append(byte)
        offsets.append(doc.offsets[index])
        index += 1
    out.append(DOUBLE_QUOTE)
    offsets.append(doc.end)
    return bytes(out), offsets


def lower_heredocs(data: bytes, documents: list[Heredoc]) -> HeredocSource:
    """Give the grammar inline input words; keep heredoc identity separately.

    Args:
        data (bytes): original shell source.
        documents (list[Heredoc]): fully read heredocs.
    """
    edits: list[tuple[int, int, bytes, list[int], Heredoc | None]] = []
    for doc in documents:
        word, positions = quoted_body(doc)
        edits.append((doc.operator_start, doc.word_end, b"<" + word,
                      [doc.operator_start] + positions, doc))
        if doc.end > doc.body_start:
            edits.append((doc.body_start, doc.end, b"", [], None))
    out = bytearray()
    offsets: list[int] = []
    attached: list[tuple[int, Heredoc]] = []
    cursor = 0
    for start, end, replacement, positions, attached_doc in sorted(
            edits, key=lambda edit: edit[0]):
        out.extend(data[cursor:start])
        offsets.extend(range(cursor, start))
        if attached_doc is not None:
            attached.append((len(out), attached_doc))
        out.extend(replacement)
        offsets.extend(positions)
        cursor = end
    out.extend(data[cursor:])
    offsets.extend(range(cursor, len(data)))
    offsets.append(len(data))
    return HeredocSource(data, bytes(out), tuple(offsets), tuple(attached))


def rebase_source(source: HeredocSource, repaired: bytes) -> HeredocSource:
    """Carry source locations through the parser's insertion-only repairs.

    Args:
        source (HeredocSource): lowered source record.
        repaired (bytes): final tree source after grammar repairs.
    """
    if repaired == source.source:
        return source
    offsets: list[int] = []
    starts: dict[int, int] = {}
    cursor = 0
    for index, byte in enumerate(repaired):
        offsets.append(source.offsets[cursor])
        if cursor < len(source.source) and byte == source.source[cursor]:
            starts[cursor] = index
            cursor += 1
    if cursor != len(source.source):
        raise ValueError("shell repair must preserve the lowered source")
    offsets.append(source.offsets[-1])
    return replace(source,
                   source=repaired,
                   offsets=tuple(offsets),
                   documents=tuple((starts[start], doc)
                                   for start, doc in source.documents))
