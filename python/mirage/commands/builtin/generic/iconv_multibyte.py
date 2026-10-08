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

import itertools
import logging
from collections.abc import Callable
from dataclasses import dataclass

logger = logging.getLogger(__name__)

ILLEGAL = -1
CUT = -2

# One decoded character as (code point, bytes used); the code point is
# ILLEGAL or CUT when there is none.
Decoded = tuple[int, int]
Table = dict[int, int]
ByteRanges = tuple[tuple[int, int], ...]
Block = tuple[ByteRanges, ...]
StepFn = Callable[[bytes, int, Table], Decoded]

GBK_TRAIL: ByteRanges = ((0x40, 0x7E), (0x80, 0xFE))
SJIS_TRAIL: ByteRanges = ((0x40, 0x7E), (0x80, 0xFC))
EUC_BYTE: ByteRanges = ((0xA1, 0xFE),)
FOUR_DIGIT: ByteRanges = ((0x30, 0x39),)
FOUR_LETTER: ByteRanges = ((0x81, 0xFE),)
PRIVATE_USE = (0xE000, 0xF8FF)
HALFWIDTH_KATAKANA = 0xFEC0
SUPPLEMENTARY_LEAD = (0x90, 0xE3)
LAST_CODE_POINT = 0x10FFFF


def _key(raw: bytes, at: int, width: int) -> int:
    return int.from_bytes(raw[at : at + width], "big")


def _width(key: int) -> int:
    """How many bytes a sequence spans, one to four.

    Args:
        key (int): a sequence read big-endian.
    """
    if key > 0xFFFF:
        return 4 if key > 0xFFFFFF else 3
    return 2 if key > 0xFF else 1


def _pair(raw: bytes, at: int, table: Table, unmapped: int) -> Decoded:
    cp = table.get(_key(raw, at, 2))
    return (cp, 2) if cp is not None else (ILLEGAL, unmapped)


def gbk_step(raw: bytes, at: int, table: Table) -> Decoded:
    """One GBK character, as glibc 2.41's ``gbk.c`` reads it.

    Args:
        raw (bytes): the input.
        at (int): offset of the character.
        table (Table): the two-byte table.
    """
    lead = raw[at]
    if lead < 0x80:
        return lead, 1
    if lead == 0x80:
        return 0x20AC, 1
    if lead == 0xFF:
        return ILLEGAL, 1
    if at + 1 >= len(raw):
        return CUT, 0
    trail = raw[at + 1]
    if trail < 0x40 or trail == 0xFF or (lead == 0xFE and trail > 0xA0):
        return ILLEGAL, 1
    return _pair(raw, at, table, 2)


def euc_cn_step(raw: bytes, at: int, table: Table) -> Decoded:
    """One EUC-CN (GB2312) character, as glibc's ``euc-cn.c`` reads it.

    Args:
        raw (bytes): the input.
        at (int): offset of the character.
        table (Table): the two-byte table.
    """
    lead = raw[at]
    if lead < 0x80:
        return lead, 1
    if (lead <= 0xA0 and lead not in (0x8E, 0x8F)) or lead == 0xFF:
        return ILLEGAL, 1
    if at + 1 >= len(raw):
        return CUT, 0
    if raw[at + 1] < 0xA1:
        return ILLEGAL, 1
    return _pair(raw, at, table, 2)


def euc_kr_step(raw: bytes, at: int, table: Table) -> Decoded:
    """One EUC-KR character, as glibc's ``euc-kr.c`` reads it.

    Bytes up to 0x9F stand for themselves, C1 controls included, and
    a refused pair is skipped whole whatever its second byte is.

    Args:
        raw (bytes): the input.
        at (int): offset of the character.
        table (Table): the two-byte table.
    """
    lead = raw[at]
    if lead <= 0x9F:
        return lead, 1
    if lead == 0xA0:
        return ILLEGAL, 1
    if at + 1 >= len(raw):
        return CUT, 0
    return _pair(raw, at, table, 2)


def sjis_step(raw: bytes, at: int, table: Table) -> Decoded:
    """One Shift_JIS character, as glibc's ``sjis.c`` reads it.

    glibc reads 0x5C as YEN SIGN and 0x7E as OVERLINE, JIS X 0201's
    Roman half, and 0xA1-0xDF as half-width katakana.

    Args:
        raw (bytes): the input.
        at (int): offset of the character.
        table (Table): the two-byte table.
    """
    lead = raw[at]
    if lead == 0x5C:
        return 0xA5, 1
    if lead == 0x7E:
        return 0x203E, 1
    if lead < 0x80:
        return lead, 1
    if 0xA1 <= lead <= 0xDF:
        return lead + HALFWIDTH_KATAKANA, 1
    if lead in (0x80, 0xA0) or lead > 0xEA:
        return ILLEGAL, 1
    if at + 1 >= len(raw):
        return CUT, 0
    if raw[at + 1] < 0x40:
        return ILLEGAL, 1
    return _pair(raw, at, table, 2)


def euc_jp_step(raw: bytes, at: int, table: Table) -> Decoded:
    """One EUC-JP character, as glibc's ``euc-jp.c`` reads it.

    Code set 2 (0x8E) is half-width katakana and code set 3 (0x8F)
    JIS X 0212, whose rows outside 0x22-0x6D glibc refuses before it
    asks for the third byte. glibc skips one byte of any refused
    sequence.

    Args:
        raw (bytes): the input.
        at (int): offset of the character.
        table (Table): the two- and three-byte table.
    """
    lead = raw[at]
    if lead < 0x8E or 0x90 <= lead <= 0x9F:
        return lead, 1
    if lead == 0xFF:
        return ILLEGAL, 1
    if at + 1 >= len(raw):
        return CUT, 0
    second = raw[at + 1]
    if second < 0xA1:
        return ILLEGAL, 1
    if lead == 0x8F:
        if not 0xA2 <= second <= 0xED:
            return ILLEGAL, 1
        if at + 2 >= len(raw):
            return CUT, 0
        cp = table.get(_key(raw, at, 3))
        return (cp, 3) if cp is not None else (ILLEGAL, 1)
    return _pair(raw, at, table, 1)


def _supplementary(raw: bytes, at: int) -> int | None:
    """The code point of a GB18030 four-byte sequence past the BMP.

    Planes 1-16 are a straight count from 0x90308130.

    Args:
        raw (bytes): the input.
        at (int): offset of the sequence.
    """
    b1, b2, b3, b4 = raw[at : at + 4]
    index = (((b1 - 0x90) * 10 + (b2 - 0x30)) * 126 + (b3 - 0x81)) * 10
    cp = 0x10000 + index + (b4 - 0x30)
    return cp if cp <= LAST_CODE_POINT else None


def gb18030_step(raw: bytes, at: int, table: Table) -> Decoded:
    """One GB18030 character, as glibc's ``gb18030.c`` reads it.

    Args:
        raw (bytes): the input.
        at (int): offset of the character.
        table (Table): the two-byte and BMP four-byte table.
    """
    lead = raw[at]
    if lead < 0x80:
        return lead, 1
    if lead in (0x80, 0xFF):
        return ILLEGAL, 1
    if at + 1 >= len(raw):
        return CUT, 0
    second = raw[at + 1]
    if 0x30 <= second <= 0x39:
        if at + 3 >= len(raw):
            return CUT, 0
        if not 0x81 <= raw[at + 2] <= 0xFE:
            return ILLEGAL, 3
        if not 0x30 <= raw[at + 3] <= 0x39:
            return ILLEGAL, 4
        if SUPPLEMENTARY_LEAD[0] <= lead <= SUPPLEMENTARY_LEAD[1]:
            cp = _supplementary(raw, at)
        else:
            cp = table.get(_key(raw, at, 4))
        return (cp, 4) if cp is not None else (ILLEGAL, 4)
    if second < 0x40 or second in (0x7F, 0xFF):
        return ILLEGAL, 2
    return _pair(raw, at, table, 2)


@dataclass(frozen=True, slots=True)
class MultibyteSpec:
    """One multi-byte charset: glibc's grammar over a host-seeded table.

    The table is what the host's own decoder (a python codec here, the
    platform ``TextDecoder`` in TypeScript) answers for every sequence
    in ``blocks``, then corrected to glibc 2.41: ``remapped`` sets the
    sequences where a host disagrees with glibc, ``excluded`` drops the
    ranges a host decodes and glibc does not, and a private-use answer
    is dropped unless glibc maps into that area. The corrections cover
    CPython's codecs, ICU's (Node) and WHATWG's (browsers), so every
    host builds the same table. Measured byte for byte on
    debian:stable-slim. A sequence is its bytes read big-endian.

    Args:
        name (str): glibc's name for the charset.
        codec (str): the host decoder that seeds the table.
        step (StepFn): reads one character.
        blocks (tuple[Block, ...]): the sequences the table holds, as
            per-byte ranges.
        remapped (tuple[tuple[int, int], ...]): sequence, glibc's code
            point.
        excluded (tuple[tuple[int, int], ...]): first and last sequence
            of a range glibc leaves unmapped.
        private_use (bool): whether glibc maps sequences into U+E000-F8FF.
        one_way (tuple[tuple[int, int], ...]): code points glibc encodes
            to a sequence that decodes to another one, and that sequence.
        supplementary (bool): whether planes 1-16 are counted out by
            four-byte sequences (GB18030).
    """

    name: str
    codec: str
    step: StepFn
    blocks: tuple[Block, ...]
    remapped: tuple[tuple[int, int], ...] = ()
    excluded: tuple[tuple[int, int], ...] = ()
    private_use: bool = False
    one_way: tuple[tuple[int, int], ...] = ()
    supplementary: bool = False


GBK = MultibyteSpec(
    name="GBK",
    codec="gbk",
    step=gbk_step,
    blocks=(
        (((0x81, 0xFD),), GBK_TRAIL),
        (((0xFE, 0xFE),), ((0x40, 0x7E), (0x80, 0xA0))),
    ),
    excluded=(
        (0xA2E3, 0xA2E3),
        (0xA3A0, 0xA3A0),
        (0xA6D9, 0xA6DF),
        (0xA6EC, 0xA6ED),
        (0xA6F3, 0xA6F3),
        (0xA8BC, 0xA8BC),
        (0xA8BF, 0xA8BF),
        (0xA989, 0xA995),
        (0xFE50, 0xFE50),
        (0xFE54, 0xFE6B),
        (0xFE6D, 0xFE75),
        (0xFE77, 0xFE7E),
        (0xFE80, 0xFE90),
        (0xFE92, 0xFEA0),
    ),
)

EUC_CN = MultibyteSpec(
    name="EUC-CN",
    codec="gb2312",
    step=euc_cn_step,
    blocks=((((0xA1, 0xF7),), EUC_BYTE),),
    remapped=((0xA1A4, 0x30FB), (0xA1AA, 0x2015)),
    excluded=(
        (0xA2A1, 0xA2AA),
        (0xA2E3, 0xA2E3),
        (0xA6D9, 0xA6F5),
        (0xA8BB, 0xA8C0),
    ),
)

GB18030 = MultibyteSpec(
    name="GB18030",
    codec="gb18030",
    step=gb18030_step,
    blocks=(
        (FOUR_LETTER, GBK_TRAIL),
        (((0x81, 0x83),), FOUR_DIGIT, FOUR_LETTER, FOUR_DIGIT),
        (((0x84, 0x84),), ((0x30, 0x30),), FOUR_LETTER, FOUR_DIGIT),
        (((0x84, 0x84),), ((0x31, 0x31),), ((0x81, 0xA4),), FOUR_DIGIT),
    ),
    remapped=(
        (0x8135F437, 0xE7C7),
        (0x82359037, 0xE81E),
        (0x82359038, 0xE826),
        (0x82359039, 0xE82B),
        (0x82359130, 0xE82C),
        (0x82359131, 0xE832),
        (0x82359132, 0xE843),
        (0x82359133, 0xE854),
        (0x82359134, 0xE864),
        (0x84318236, 0xE78D),
        (0x84318237, 0xE78F),
        (0x84318238, 0xE78E),
        (0x84318239, 0xE790),
        (0x84318330, 0xE791),
        (0x84318331, 0xE792),
        (0x84318332, 0xE793),
        (0x84318333, 0xE794),
        (0x84318334, 0xE795),
        (0x84318335, 0xE796),
        (0xA3A0, 0xE5E5),
        (0xA6D9, 0xFE10),
        (0xA6DA, 0xFE12),
        (0xA6DB, 0xFE11),
        (0xA6DC, 0xFE13),
        (0xA6DD, 0xFE14),
        (0xA6DE, 0xFE15),
        (0xA6DF, 0xFE16),
        (0xA6EC, 0xFE17),
        (0xA6ED, 0xFE18),
        (0xA6F3, 0xFE19),
        (0xA8BC, 0x1E3F),
        (0xFE59, 0x9FB4),
        (0xFE61, 0x9FB5),
        (0xFE66, 0x9FB6),
        (0xFE67, 0x9FB7),
        (0xFE6D, 0x9FB8),
        (0xFE7E, 0x9FB9),
        (0xFE90, 0x9FBA),
        (0xFEA0, 0x9FBB),
    ),
    private_use=True,
    supplementary=True,
)

EUC_KR = MultibyteSpec(
    name="EUC-KR",
    codec="euc_kr",
    step=euc_kr_step,
    blocks=((EUC_BYTE, EUC_BYTE),),
    remapped=(
        (0xA2E6, 0x20AC),
        (0xA2E7, 0xAE),
        (0xA2E8, 0x327E),
        (0xA4D4, 0x3164),
    ),
    one_way=((0x20A9, 0xA3DC),),
)

SJIS = MultibyteSpec(
    name="SJIS",
    codec="shift_jis",
    step=sjis_step,
    blocks=(
        (((0x81, 0x9F),), SJIS_TRAIL),
        (((0xE0, 0xEA),), SJIS_TRAIL),
    ),
    remapped=(
        (0x8160, 0x301C),
        (0x8161, 0x2016),
        (0x817C, 0x2212),
        (0x8191, 0xA2),
        (0x8192, 0xA3),
        (0x81CA, 0xAC),
    ),
    excluded=(
        (0x8740, 0x875D),
        (0x875F, 0x8775),
        (0x877E, 0x877E),
        (0x8780, 0x879C),
    ),
    one_way=(
        (0x5C, 0x5C),
        (0x7E, 0x7E),
        (0xFFE0, 0x8191),
        (0xFFE1, 0x8192),
        (0xFFE2, 0x81CA),
    ),
)

EUC_JP = MultibyteSpec(
    name="EUC-JP",
    codec="euc_jp",
    step=euc_jp_step,
    blocks=(
        (EUC_BYTE, EUC_BYTE),
        (((0x8E, 0x8E),), ((0xA1, 0xDF),)),
        (((0x8F, 0x8F),), ((0xA2, 0xED),), EUC_BYTE),
    ),
    remapped=(
        (0x8FA2B7, 0xFF5E),
        (0xA1C1, 0x301C),
        (0xA1C2, 0x2016),
        (0xA1DD, 0x2212),
        (0xA1F1, 0xA2),
        (0xA1F2, 0xA3),
        (0xA2CC, 0xAC),
    ),
    excluded=(
        (0xADA1, 0xADBE),
        (0xADC0, 0xADD6),
        (0xADDF, 0xADFC),
        (0xF9A1, 0xF9FE),
        (0xFAA1, 0xFAFE),
        (0xFBA1, 0xFBFE),
        (0xFCA1, 0xFCEE),
        (0xFCF1, 0xFCFE),
    ),
    one_way=((0xA5, 0x5C), (0x203E, 0x7E)),
)

MULTIBYTE_CHARSETS: dict[str, MultibyteSpec] = {
    "GBK": GBK,
    "GB13000": GBK,
    "CP936": GBK,
    "MS936": GBK,
    "WINDOWS-936": GBK,
    "EUC-CN": EUC_CN,
    "EUCCN": EUC_CN,
    "GB2312": EUC_CN,
    "CSGB2312": EUC_CN,
    "CN-GB": EUC_CN,
    "GB18030": GB18030,
    "EUC-KR": EUC_KR,
    "EUCKR": EUC_KR,
    "CSEUCKR": EUC_KR,
    "OSF0004000A": EUC_KR,
    "SJIS": SJIS,
    "SHIFT-JIS": SJIS,
    "SHIFT_JIS": SJIS,
    "MS_KANJI": SJIS,
    "CSSHIFTJIS": SJIS,
    "EUC-JP": EUC_JP,
    "EUCJP": EUC_JP,
    "UJIS": EUC_JP,
    "CSEUCPKDFMTJAPANESE": EUC_JP,
    "OSF00030010": EUC_JP,
}


def _sequences(blocks: tuple[Block, ...]) -> list[bytes]:
    """Every sequence the blocks span, in block then byte order.

    Args:
        blocks (tuple[Block, ...]): per-byte ranges.
    """
    out: list[bytes] = []
    for block in blocks:
        axes = [
            [x for low, high in ranges for x in range(low, high + 1)]
            for ranges in block
        ]
        out.extend(bytes(combo) for combo in itertools.product(*axes))
    return out


def _host_decode(codec: str, seq: bytes) -> int | None:
    """The one code point the host decoder reads ``seq`` as, or None.

    Args:
        codec (str): a python codec name.
        seq (bytes): one whole sequence.
    """
    text = seq.decode(codec)
    return ord(text) if len(text) == 1 else None


_TABLES: dict[str, Table] = {}
_REVERSES: dict[str, dict[int, bytes]] = {}


def multibyte_table(spec: MultibyteSpec) -> Table:
    """The sequence-to-code-point table of a charset, built once.

    Args:
        spec (MultibyteSpec): the charset.
    """
    known = _TABLES.get(spec.name)
    if known is not None:
        return known
    table: Table = {}
    refused = 0
    first_error: UnicodeDecodeError | None = None
    for seq in _sequences(spec.blocks):
        key = int.from_bytes(seq, "big")
        if any(low <= key <= high for low, high in spec.excluded):
            continue
        try:
            cp = _host_decode(spec.codec, seq)
        except UnicodeDecodeError as exc:
            refused += 1
            if first_error is None:
                first_error = exc
            continue
        if cp is None:
            continue
        if not spec.private_use and PRIVATE_USE[0] <= cp <= PRIVATE_USE[1]:
            continue
        table[key] = cp
    if first_error is not None:
        logger.debug(
            "iconv: %s table skipped %d undecodable sequences; first: %s",
            spec.codec,
            refused,
            first_error,
        )
    for key, cp in spec.remapped:
        table[key] = cp
    _TABLES[spec.name] = table
    return table


def multibyte_reverse(spec: MultibyteSpec) -> dict[int, bytes]:
    """The code-point-to-sequence table glibc encodes with.

    It is the decode table turned around, single bytes included, plus
    glibc's one-way entries. No supported charset decodes two sequences
    to one code point, so the order the entries are added in decides
    nothing.

    Args:
        spec (MultibyteSpec): the charset.
    """
    known = _REVERSES.get(spec.name)
    if known is not None:
        return known
    table = multibyte_table(spec)
    reverse: dict[int, bytes] = {}
    for seq in (bytes([byte]) for byte in range(0x100)):
        cp, width = spec.step(seq, 0, table)
        if cp >= 0 and width == 1:
            reverse.setdefault(cp, seq)
    for key, cp in table.items():
        reverse.setdefault(cp, key.to_bytes(_width(key), "big"))
    for cp, key in spec.one_way:
        reverse[cp] = key.to_bytes(_width(key), "big")
    _REVERSES[spec.name] = reverse
    return reverse


def _supplementary_sequence(cp: int) -> bytes:
    """The GB18030 four-byte sequence of a code point past the BMP.

    Args:
        cp (int): a code point from U+10000.
    """
    index = cp - 0x10000
    index, b4 = divmod(index, 10)
    index, b3 = divmod(index, 126)
    b1, b2 = divmod(index, 10)
    return bytes([0x90 + b1, 0x30 + b2, 0x81 + b3, 0x30 + b4])


class MultibyteEncoder:
    """The target side of a multi-byte charset, shared by every input.

    Mirrors the TypeScript ``MultibyteEncoder``.
    """

    def __init__(self, spec: MultibyteSpec) -> None:
        self.spec = spec
        self.reverse = multibyte_reverse(spec)

    def encode_char(self, cp: int) -> bytes | None:
        seq = self.reverse.get(cp)
        if seq is None and self.spec.supplementary and cp >= 0x10000:
            return _supplementary_sequence(cp)
        return seq

    def encode_text(self, text: str) -> bytes | None:
        out = bytearray()
        for char in text:
            seq = self.encode_char(ord(char))
            if seq is None:
                return None
            out += seq
        return bytes(out)


__all__ = [
    "CUT",
    "EUC_CN",
    "EUC_JP",
    "EUC_KR",
    "GB18030",
    "GBK",
    "ILLEGAL",
    "MULTIBYTE_CHARSETS",
    "SJIS",
    "MultibyteEncoder",
    "MultibyteSpec",
    "euc_cn_step",
    "euc_jp_step",
    "euc_kr_step",
    "gb18030_step",
    "gbk_step",
    "multibyte_reverse",
    "multibyte_table",
    "sjis_step",
]
