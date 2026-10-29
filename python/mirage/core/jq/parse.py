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

from mirage.core.jq.codec import close_codec, run_codec
from mirage.core.jq.types import NO_VALUE, JqParseError, NoValue
from mirage.io.cooperative import CHUNK_SIZE
from mirage.io.yield_budget import YieldBudget
from mirage.rs.stream import OpenStream, open_stream


async def decode_utf8(data: bytes) -> str:
    """Decode raw bytes using jq's malformed sequence rules.

    Args:
        data (bytes): raw input bytes.
    """
    return b"".join(
        [part async for part in run_codec("jq_decode", {}, data)]
    ).decode()


def utf8_missing(piece: bytes | bytearray) -> int:
    """Bytes needed to finish a jq reader piece's final UTF-8 character.

    Args:
        piece (bytes | bytearray): the nonempty reader piece.
    """
    at = len(piece) - 1
    if at <= 0:
        return 0
    seen = 1
    while 0x80 <= piece[at] < 0xC0:
        if at == 0:
            break
        at -= 1
        seen += 1
    first = piece[at]
    length = (
        1
        if first < 0x80
        else 2
        if 0xC2 <= first < 0xE0
        else 3
        if 0xE0 <= first < 0xF0
        else 4
        if 0xF0 <= first <= 0xF4
        else 0
    )
    return max(0, length - seen)


def string_text(value: str) -> str:
    """Quote a host string for the evaluator.

    Args:
        value (str): the string.
    """
    return json.dumps(value, ensure_ascii=False)


class JqParser:
    """A literal-preserving text scanner over the shared Rust grammar.

    Args:
        seq (bool): read RFC 7464 text sequences.
        streaming (bool): produce path and leaf event text.
    """

    def __init__(self, seq: bool = False, streaming: bool = False) -> None:
        self._stream: OpenStream | None = open_stream(
            "jq_scan", {"seq": seq, "streaming": streaming}
        )
        self._budget = YieldBudget()
        self._input = b""
        self._at = 0
        self._final = False
        self._finished = False
        self._wire = bytearray()
        self._parts: list[bytes] = []

    def feed(self, data: bytes, partial: bool) -> None:
        """Offer one reader piece; EOF belongs to the whole input stream.

        Args:
            data (bytes): the original reader piece.
            partial (bool): whether more input follows.
        """
        self._input = data
        self._at = 0
        self._final = not partial

    async def close(self) -> None:
        """Release the scanner after EOF, refusal, or early consumption."""
        stream, self._stream = self._stream, None
        if stream is not None:
            await close_codec(stream)

    async def next(self) -> str | JqParseError | NoValue:
        """Return the next text, parse failure, or NO_VALUE when input is needed."""
        stream = self._stream
        if stream is None:
            return NO_VALUE
        while True:
            wire = self._wire
            if len(wire) >= 5:
                size = int.from_bytes(wire[1:5], "little")
                if len(wire) >= size + 5:
                    tag = wire[0]
                    payload = bytes(wire[5 : size + 5])
                    del wire[: size + 5]
                    if tag == 1:
                        self._parts.append(payload)
                    elif tag == 2:
                        text = b"".join(self._parts).decode()
                        self._parts.clear()
                        return text
                    elif tag == 3:
                        return JqParseError(payload.decode())
                    else:
                        raise ValueError("unknown jq scanner frame")
                    continue
            await self._budget.run()
            if stream.busy():
                wire += stream.drain()
            elif self._at < len(self._input):
                stop = self._at + CHUNK_SIZE
                wire += stream.feed(self._input[self._at : stop])
                self._at = min(stop, len(self._input))
            elif self._final and not self._finished:
                self._finished = True
                wire += stream.finish()
            else:
                return NO_VALUE
