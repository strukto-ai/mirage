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

import bisect
import hashlib
import itertools
import pathlib
import urllib.request
from typing import NamedTuple

ROOT = pathlib.Path(__file__).resolve().parent.parent
RS_OUT = ROOT / "rust/mirage-rs/src/generated/iconv_data.rs"

# Each charset's table comes from its standard's published mapping: the
# Unicode Consortium's East Asian tables (GB2312.TXT is withdrawn, so its
# last published copy is read from the Internet Archive), Microsoft's
# CP936 as Unicode publishes it, and the WHATWG Encoding Standard's
# indexes (licenses/third_party/unicode-mappings.txt and
# whatwg-encoding.txt). The image's iconv is only the test oracle: the
# digests in rust/mirage-rs/src/iconv/tests.rs were checked against it.
UNICODE = "https://www.unicode.org/Public/MAPPINGS"
WHATWG = (
    "https://encoding.spec.whatwg.org/commit-snapshots/"
    "a985b62a9b45c17da3e17a9f0a0b4e30c34c4a8a"
)
SOURCES = {
    "JIS0208.TXT": (
        f"{UNICODE}/OBSOLETE/EASTASIA/JIS/JIS0208.TXT",
        "1c571870457f19c97720631fa83ee491549a96ba1436da1296786a67d8632e87",
    ),
    "JIS0212.TXT": (
        f"{UNICODE}/OBSOLETE/EASTASIA/JIS/JIS0212.TXT",
        "477820bb3055bbcc90880d788cd95607d221dc94457bae249231adecf13c12e6",
    ),
    "JIS0201.TXT": (
        f"{UNICODE}/OBSOLETE/EASTASIA/JIS/JIS0201.TXT",
        "3f26a4c8c083cb6303dcdfcac2b73e8119c1cc1a7da1736fc7435f6efbd037de",
    ),
    "CP936.TXT": (
        f"{UNICODE}/VENDORS/MICSFT/WINDOWS/CP936.TXT",
        "b86f601c575e9ab457380b6f7abef03c75499cc6075bdc8b4b27f3f2de74bf6a",
    ),
    "GB2312.TXT": (
        "https://web.archive.org/web/20040618175143id_/"
        "http://www.unicode.org:80/Public/MAPPINGS/OBSOLETE/EASTASIA/GB/GB2312.TXT",
        "52335c54396c41d3e04856cb6018bd600469f210556233aa9895b1f396b257ed",
    ),
    "index-gb18030.txt": (
        f"{WHATWG}/index-gb18030.txt",
        "746b3c55f1a8ec4b90b451f384437a17fd37cd51cd668456a28071a758d10784",
    ),
    "index-gb18030-ranges.txt": (
        f"{WHATWG}/index-gb18030-ranges.txt",
        "874c6b6f6f74cf7d427ad228d5b41ddd9354fffd92a2259bf429f86e6baa7a1e",
    ),
    "index-euc-kr.txt": (
        f"{WHATWG}/index-euc-kr.txt",
        "89af20dd867c84cefb710b1790229786cfef2bf11916361a210d81b90381e267",
    ),
    "index-jis0208.txt": (
        f"{WHATWG}/index-jis0208.txt",
        "341dcde7e8b984e9c7bbf5ed75c8da7c6087d47083a1a2b3ed558bfd5bef9468",
    ),
    "index-jis0212.txt": (
        f"{WHATWG}/index-jis0212.txt",
        "6ac698a473822b282ff4f4d4f17873b970612ef9bd232e03941854c09b67c7ee",
    ),
}

# The 18 characters GB 18030-2022 moved from the private-use code points
# GB 18030-2005 gave their two-byte sequences to those sequences (as
# WHATWG's index has them), handing each private-use code point to the
# four-byte sequence the character had (Lunde, "CJKV Information
# Processing"; Unicode L2/23-003): two-byte sequence, its 2005 code point.
GB18030_2022_SWAPS = (
    (0xA6D9, 0xE78D),
    (0xA6DA, 0xE78E),
    (0xA6DB, 0xE78F),
    (0xA6DC, 0xE790),
    (0xA6DD, 0xE791),
    (0xA6DE, 0xE792),
    (0xA6DF, 0xE793),
    (0xA6EC, 0xE794),
    (0xA6ED, 0xE795),
    (0xA6F3, 0xE796),
    (0xFE59, 0xE81E),
    (0xFE61, 0xE826),
    (0xFE66, 0xE82B),
    (0xFE67, 0xE82C),
    (0xFE6D, 0xE832),
    (0xFE7E, 0xE843),
    (0xFE90, 0xE854),
    (0xFEA0, 0xE864),
)

PRIVATE_USE = (0xE000, 0xF8FF)
GBK_TRAIL = ((0x40, 0x7E), (0x80, 0xFE))
SJIS_TRAIL = ((0x40, 0x7E), (0x80, 0xFC))
EUC_BYTE = ((0xA1, 0xFE),)
DIGIT = ((0x30, 0x39),)
LETTER = ((0x81, 0xFE),)


class Spec(NamedTuple):
    """One charset: the WHATWG decoder encoding_rs seeds its table with,
    the sequences the table holds as per-byte ranges (the blocks
    rust/mirage-rs/src/iconv/table.rs walks), and whether its standard
    maps into the private-use area."""

    name: str
    label: str
    blocks: tuple[tuple[tuple[tuple[int, int], ...], ...], ...]
    private_use: bool = False


SPECS = (
    Spec(
        "GBK",
        "gbk",
        (
            (((0x81, 0xFD),), GBK_TRAIL),
            (((0xFE, 0xFE),), ((0x40, 0x7E), (0x80, 0xA0))),
        ),
    ),
    Spec("EUC-CN", "gb2312", ((((0xA1, 0xF7),), EUC_BYTE),)),
    Spec(
        "GB18030",
        "gb18030",
        (
            (LETTER, GBK_TRAIL),
            (((0x81, 0x83),), DIGIT, LETTER, DIGIT),
            (((0x84, 0x84),), ((0x30, 0x30),), LETTER, DIGIT),
            (((0x84, 0x84),), ((0x31, 0x31),), ((0x81, 0xA4),), DIGIT),
        ),
        private_use=True,
    ),
    Spec("EUC-KR", "euc-kr", ((EUC_BYTE, EUC_BYTE),)),
    Spec(
        "SJIS",
        "shift_jis",
        ((((0x81, 0x9F),), SJIS_TRAIL), (((0xE0, 0xEA),), SJIS_TRAIL)),
    ),
    Spec(
        "EUC-JP",
        "euc-jp",
        (
            (EUC_BYTE, EUC_BYTE),
            (((0x8E, 0x8E),), ((0xA1, 0xDF),)),
            (((0x8F, 0x8F),), ((0xA2, 0xED),), EUC_BYTE),
        ),
    ),
)

NOTE = (
    "GENERATED by scripts/gen_iconv_multibyte.py from the standards'\n"
    "published mapping tables (see the script for each source): where each\n"
    "differs from the WHATWG decoder encoding_rs seeds it with. Do not edit\n"
    "by hand; rerun the script."
)

Table = dict[int, int]


def fetch(name: str) -> str:
    url, want = SOURCES[name]
    request = urllib.request.Request(url, headers={"User-Agent": "mirage"})
    with urllib.request.urlopen(request) as response:
        data: bytes = response.read()
    digest = hashlib.sha256(data).hexdigest()
    if digest != want:
        raise SystemExit(f"{name}: sha256 {digest}, want {want}")
    return data.decode("utf-8")


def columns(name: str, source: int, target: int) -> Table:
    """A Unicode mapping file read as one column to another."""
    out: Table = {}
    for line in fetch(name).split("\n"):
        fields = line.split("#")[0].split()
        if len(fields) > max(source, target):
            out[int(fields[source], 16)] = int(fields[target], 16)
    return out


def index(name: str) -> Table:
    """A WHATWG index: pointer to code point."""
    out: Table = {}
    for line in fetch(f"index-{name}.txt").split("\n"):
        fields = line.split("#")[0].split()
        if len(fields) >= 2:
            out[int(fields[0])] = int(fields[1], 16)
    return out


def gb_two_byte(pointer: int) -> int:
    lead, rest = divmod(pointer, 190)
    return ((lead + 0x81) << 8) | (rest + (0x40 if rest < 0x3F else 0x41))


def gb_four_byte(pointer: int) -> int:
    pointer, b4 = divmod(pointer, 10)
    pointer, b3 = divmod(pointer, 126)
    b1, b2 = divmod(pointer, 10)
    return (
        ((b1 + 0x81) << 24)
        | ((b2 + 0x30) << 16)
        | ((b3 + 0x81) << 8)
        | (b4 + 0x30)
    )


def gb_range(ranges: list[tuple[int, int]], pointer: int) -> int | None:
    """The WHATWG index gb18030 ranges code point."""
    if 39419 < pointer < 189000 or pointer > 1237575:
        return None
    if pointer == 7457:
        return 0xE7C7
    if pointer >= 189000:
        return 0x10000 + pointer - 189000
    offset, point = max((o, p) for o, p in ranges if o <= pointer)
    return point + pointer - offset


def standards() -> dict[str, Table]:
    """Each charset's sequence-to-code-point table, from its standard."""
    out: dict[str, Table] = {}
    # GBK is Microsoft's code page 936, as CP936.TXT has it.
    out["GBK"] = {
        k: v for k, v in columns("CP936.TXT", 0, 1).items() if k > 0xFF
    }
    # EUC-CN is GB 2312-80 with both bytes' high bit set.
    out["EUC-CN"] = {
        k | 0x8080: v for k, v in columns("GB2312.TXT", 0, 1).items()
    }
    # GB18030 is GB 18030-2022: WHATWG's two-byte index matches it but at
    # 0xA3A0, which the standard maps to U+E5E5; four-byte sequences in
    # the BMP from the ranges index, then the 2022 swaps.
    two = {gb_two_byte(p): v for p, v in index("gb18030").items()}
    two[0xA3A0] = 0xE5E5
    ranges = sorted(index("gb18030-ranges").items())
    gb18030 = dict(two)
    four_of: Table = {}
    for pointer in range(39420):
        point = gb_range(ranges, pointer)
        if point is not None:
            gb18030[gb_four_byte(pointer)] = point
            four_of[point] = gb_four_byte(pointer)
    for seq, old in GB18030_2022_SWAPS:
        gb18030[four_of[two[seq]]] = old
    out["GB18030"] = gb18030
    # EUC-KR is KS X 1001: WHATWG's index over EUC's 94 x 94 square, plus
    # the postal mark KS X 1001:2002 added at 0xA2E8.
    euc_kr: Table = {}
    for pointer, point in index("euc-kr").items():
        lead, trail = divmod(pointer, 190)
        key = ((lead + 0x81) << 8) | (trail + 0x41)
        if 0xA1 <= key >> 8 <= 0xFE and 0xA1 <= key & 0xFF <= 0xFE:
            euc_kr[key] = point
    euc_kr[0xA2E8] = 0x327E
    out["EUC-KR"] = euc_kr
    # Shift_JIS's double bytes are JIS X 0208. Its single bytes are JIS X
    # 0201, whose 0x5C is the yen sign, so the double-byte reverse solidus
    # at 1-32 is the fullwidth one; EUC-JP, whose single bytes are ASCII,
    # makes the same choice, and takes JIS X 0212's tilde as fullwidth too.
    sjis = columns("JIS0208.TXT", 0, 2)
    sjis[0x815F] = 0xFF3C
    out["SJIS"] = sjis
    euc_jp = {k | 0x8080: v for k, v in columns("JIS0208.TXT", 1, 2).items()}
    euc_jp[0xA1C0] = 0xFF3C
    euc_jp |= {
        k | 0x8F8080: v for k, v in columns("JIS0212.TXT", 0, 1).items()
    }
    euc_jp[0x8FA2B7] = 0xFF5E
    euc_jp |= {
        0x8E00 | k: v
        for k, v in columns("JIS0201.TXT", 0, 1).items()
        if 0xA1 <= k <= 0xDF
    }
    out["EUC-JP"] = euc_jp
    return out


def one_way() -> dict[str, tuple[tuple[int, int], ...]]:
    """Code points encoded to a sequence that decodes to another one."""
    roman = columns("JIS0201.TXT", 0, 1)
    yen, overline = roman[0x5C], roman[0x7E]
    return {
        # JIS X 0201 Roman and ASCII differ only at 0x5C and 0x7E. Where
        # those bytes read as Roman, ASCII's two characters still encode
        # to them, and where they read as ASCII, Roman's do.
        "SJIS": (
            (0x5C, 0x5C),
            (0x7E, 0x7E),
            # Measured: the image's iconv also encodes the fullwidth cent,
            # pound and not signs to the cells of the plain ones.
            (0xFFE0, 0x8191),
            (0xFFE1, 0x8192),
            (0xFFE2, 0x81CA),
        ),
        "EUC-JP": ((yen, 0x5C), (overline, 0x7E)),
        # Measured: the image's iconv encodes the won sign to the cell of
        # the fullwidth one.
        "EUC-KR": ((0x20A9, 0xA3DC),),
    }


def whatwg_decoders() -> dict[str, Table]:
    """What a browser's TextDecoder answers, per WHATWG's decoders."""
    gb = {gb_two_byte(p): v for p, v in index("gb18030").items()}
    ranges = sorted(index("gb18030-ranges").items())
    for pointer in range(39420):
        point = gb_range(ranges, pointer)
        if point is not None:
            gb[gb_four_byte(pointer)] = point
    euc_kr = {}
    for pointer, point in index("euc-kr").items():
        lead, trail = divmod(pointer, 190)
        euc_kr[((lead + 0x81) << 8) | (trail + 0x41)] = point
    jis0208 = index("jis0208")
    sjis: Table = {}
    for pointer in range(11280):
        lead, trail = divmod(pointer, 188)
        key = ((lead + (0x81 if lead < 0x1F else 0xC1)) << 8) | (
            trail + (0x40 if trail < 0x3F else 0x41)
        )
        if 8836 <= pointer <= 10715:
            sjis[key] = 0xE000 + pointer - 8836
        elif pointer in jis0208:
            sjis[key] = jis0208[pointer]
    euc_jp: Table = {0x8E00 | b: 0xFF61 + b - 0xA1 for b in range(0xA1, 0xE0)}
    for pointer, point in jis0208.items():
        lead, trail = divmod(pointer, 94)
        if lead < 94:
            euc_jp[((lead + 0xA1) << 8) | (trail + 0xA1)] = point
    for pointer, point in index("jis0212").items():
        lead, trail = divmod(pointer, 94)
        euc_jp[0x8F0000 | ((lead + 0xA1) << 8) | (trail + 0xA1)] = point
    return {
        "gbk": gb,
        "gb2312": gb,
        "gb18030": gb,
        "euc-kr": euc_kr,
        "shift_jis": sjis,
        "euc-jp": euc_jp,
    }


def corrections(
    spec: Spec, standard: Table, whatwg: Table
) -> tuple[tuple[tuple[int, int], ...], tuple[tuple[int, int], ...]]:
    """The remapped sequences and excluded ranges that make the table
    encoding_rs's WHATWG decoder seeds the standard's.

    The seed drops a private-use answer unless the charset maps into that
    area, and the excluded ranges drop every answer; the remapped
    sequences are written over whatever is left.
    """
    keys = block_keys(spec)
    missing = set(standard) - set(keys)
    if missing:
        raise SystemExit(
            f"{spec.name}: {len(missing)} standard sequences outside the blocks"
        )

    def seeded(key: int) -> int | None:
        point = whatwg.get(key)
        if point is None:
            return None
        if not spec.private_use and PRIVATE_USE[0] <= point <= PRIVATE_USE[1]:
            return None
        return point

    dropped = [
        k
        for k in keys
        if k not in standard and seeded(k) is not None
    ]
    # One range per run of dropped sequences with no standard one between.
    defined = sorted(standard)
    excluded: list[tuple[int, int]] = []
    for key in dropped:
        last = excluded[-1][1] if excluded else None
        if last is not None and bisect.bisect_right(
            defined, last
        ) == bisect.bisect_left(defined, key):
            excluded[-1] = (excluded[-1][0], key)
        else:
            excluded.append((key, key))
    remapped = tuple(
        (key, point)
        for key, point in sorted(standard.items())
        if seeded(key) != point
    )
    return remapped, tuple(excluded)


def block_keys(spec: Spec) -> list[int]:
    """Every sequence the spec's blocks span, read big-endian."""
    keys: list[int] = []
    for block in spec.blocks:
        axes = [
            [x for low, high in ranges for x in range(low, high + 1)]
            for ranges in block
        ]
        keys += [
            int.from_bytes(bytes(combo), "big")
            for combo in itertools.product(*axes)
        ]
    return sorted(keys)


def render(data: dict[str, dict[str, tuple[tuple[int, int], ...]]]) -> str:
    # One pair per line, as rustfmt lays the table out.
    body = []
    for spec in SPECS:
        fields = []
        for field, per in data.items():
            pairs = "".join(
                f"        (0x{a:X}, 0x{b:X}),\n" for a, b in per[spec.name]
            )
            fields.append(
                f"    {field}: &[\n{pairs}    ],\n" if pairs else f"    {field}: &[],\n"
            )
        const = spec.name.replace("-", "_")
        body.append(
            f"pub(crate) const {const}: Corrections = Corrections {{\n"
            + "".join(fields)
            + "};\n"
        )
    return (
        "\n".join(f"// {line}" for line in NOTE.split("\n"))
        + "\n\nuse crate::iconv::table::Corrections;\n\n"
        + "\n".join(body)
    )


def main() -> None:
    tables = standards()
    browsers = whatwg_decoders()
    remapped: dict[str, tuple[tuple[int, int], ...]] = {}
    excluded: dict[str, tuple[tuple[int, int], ...]] = {}
    for spec in SPECS:
        standard = tables[spec.name]
        uses_private = any(
            PRIVATE_USE[0] <= p <= PRIVATE_USE[1] for p in standard.values()
        )
        if uses_private != spec.private_use:
            raise SystemExit(
                f"{spec.name}: private_use should be {uses_private}"
            )
        remapped[spec.name], excluded[spec.name] = corrections(
            spec, standard, browsers[spec.label]
        )
    ways = one_way()
    RS_OUT.write_text(
        render(
            {
                "remapped": remapped,
                "excluded": excluded,
                "one_way": {s.name: ways.get(s.name, ()) for s in SPECS},
            }
        )
    )


if __name__ == "__main__":
    main()
