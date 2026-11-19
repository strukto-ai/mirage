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

import os
import zlib

import pytest

from mirage.commands.cli.builtin.pdf import PDFINFO, PDFTOTEXT
from mirage.commands.cli.builtin.pdf.run import Refused, page_number
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace


def document(pages: list[list[tuple[int, int, str]]]) -> bytes:
    """A PDF whose pages draw each (x, y, text) in 12-point Helvetica."""
    bodies = [
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        b"",
    ]
    kids = []
    for runs in pages:
        content = b"".join(
            b"BT /F1 12 Tf 1 0 0 1 %d %d Tm (%s) Tj ET\n"
            % (x, y, text.encode())
            for x, y, text in runs
        )
        bodies.append(
            b"<< /Length %d >>\nstream\n%sendstream" % (len(content), content)
        )
        bodies.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 1 0 R >> >> /Contents %d 0 R >>"
            % (len(bodies))
        )
        kids.append(len(bodies))
    bodies[1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (
        b" ".join(b"%d 0 R" % k for k in kids),
        len(kids),
    )
    bodies.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    bodies.append(b"<< /Title (Plan) /Author (Ops) >>")
    out = b"%PDF-1.4\n"
    offsets = []
    for number, body in enumerate(bodies, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(bodies) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root %d 0 R /Info %d 0 R >>\n" % (
        len(bodies) + 1,
        len(bodies) - 1,
        len(bodies),
    )
    return out + b"startxref\n%d\n%%%%EOF\n" % xref


TWO_PAGES = document(
    [
        [(72, 720, "First page"), (72, 706, "second line")],
        [(72, 720, "Left"), (320, 720, "Right")],
    ]
)


@pytest.mark.parametrize(
    "text,value",
    [(None, None), ("3", 3), ("+2", 2), ("-1", -1), ("", 0)],
)
def test_page_numbers_read_a_sign_and_digits(text, value):
    assert page_number(text) == value


@pytest.mark.parametrize(
    "text,value",
    [
        ("2147483648", -2147483648),
        ("4294967299", 3),
        ("99999999999", 1215752191),
        ("9223372036854775808", -1),
        ("-9223372036854775809", 0),
    ],
)
def test_a_page_number_past_an_int_keeps_its_low_bits(text, value):
    assert page_number(text) == value


@pytest.mark.parametrize("text", ["x", "2x", " 2", "1.5"])
def test_a_page_number_that_is_no_number_is_refused(text):
    with pytest.raises(Refused):
        page_number(text)


async def shell(line: str) -> tuple[int, str, str]:
    with Workspace({"/w/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        ws.register_cli("pdftotext", PDFTOTEXT)
        ws.register_cli("pdfinfo", PDFINFO)
        await ws.shell("tee /w/plan.pdf > /dev/null", stdin=TWO_PAGES)
        result = await ws.shell(line)
        return (
            result.exit_code,
            (result.stdout or b"").decode(),
            (result.stderr or b"").decode(),
        )


@pytest.mark.asyncio
async def test_text_goes_to_stdout_a_form_feed_after_each_page():
    assert await shell("pdftotext /w/plan.pdf -") == (
        0,
        "First page\nsecond line\n\n\fLeft\n\nRight\n\n\f",
        "",
    )


@pytest.mark.asyncio
async def test_a_page_range_and_the_text_file_beside_the_pdf():
    assert await shell(
        "pdftotext -f 2 -layout /w/plan.pdf && cat /w/plan.txt"
    ) == (0, "Left   Right\n\f", "")


@pytest.mark.asyncio
async def test_a_range_past_the_end_is_refused():
    assert await shell("pdftotext -f 3 /w/plan.pdf -") == (
        99,
        "",
        "Command Line Error: Wrong page range given: the first page (3) "
        "can not be after the last page (2).\n",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line,status",
    [
        ("pdftotext", 99),
        ("pdftotext -f x /w/plan.pdf -", 99),
        ("pdftotext /w/plan.pdf - extra", 99),
        ("pdftotext -h", 0),
        ("pdfinfo", 99),
    ],
)
async def test_help_goes_to_stderr(line, status):
    code, out, err = await shell(line)
    assert (code, out) == (status, "")
    assert err.startswith("usage: ")


@pytest.mark.asyncio
async def test_pdfinfo_prints_the_field_block():
    code, out, err = await shell("pdfinfo -l 2 /w/plan.pdf")
    assert (code, err) == (0, "")
    assert out.splitlines()[:3] == [
        "Title:           Plan",
        "Author:          Ops",
        "Custom Metadata: no",
    ]
    assert "Page    2 size:  612 x 792 pts (letter)" in out
    assert out.endswith("Optimized:       no\nPDF version:     1.4\n")


FONT = b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
HELLO = b"BT /F1 12 Tf 72 720 Td (hello) Tj ET\n"
BIG = b" " * (40 << 20)
# Mostly one letter: inflates under a hundred times its packed bytes, so
# the reader keeps it.
DENSE = os.urandom(20 << 20).translate(bytes([97] * 254 + [98] * 2))


def stream(packed: bytes, extra: bytes = b"") -> bytes:
    return b"<< /Length %d %s>>\nstream\n%s\nendstream" % (
        len(packed),
        extra,
        packed,
    )


def flate(data: bytes, extra: bytes = b"") -> bytes:
    return stream(zlib.compress(data, 9), b"/Filter /FlateDecode " + extra)


def lzw_run(longest: int) -> bytes:
    """An LZW stream of spaces: each code one longer than the last until
    the table fills, then the longest one `longest` times."""
    codes = [256, 32, *range(258, 4096), *[4095] * longest, 257]
    out, held, bits = bytearray(), 0, 0
    width, following, previous = 9, 258, None
    for code in codes:
        if width < 12 and following + 1 == 1 << width:
            width += 1
        held, bits = held << width | code, bits + width
        while bits >= 8:
            bits -= 8
            out.append(held >> bits & 0xFF)
        held &= (1 << bits) - 1
        if code == 256:
            width, following, previous = 9, 258, None
            continue
        if previous is not None and following < 4096:
            following += 1
        previous = code
    if bits:
        out.append(held << (8 - bits) & 0xFF)
    return bytes(out)


# Each filter pdf_oxide decodes with no limit of its own, over 20 MiB of
# spaces; Brotli's from Node's encoder, which Python's library lacks.
FILTERED = {
    "LZWDecode": stream(lzw_run(6000), b"/Filter /LZWDecode "),
    "RunLengthDecode": stream(
        bytes([129, 32]) * ((20 << 20) // 128) + bytes([128]),
        b"/Filter /RunLengthDecode ",
    ),
    "ASCIIHexDecode then FlateDecode": stream(
        zlib.compress(b" " * (20 << 20), 9).hex().encode() + b">",
        b"/Filter [/ASCIIHexDecode /FlateDecode] ",
    ),
    "BrotliDecode": stream(
        bytes.fromhex(
            "cbffff3ff82540e2b14020f7fe8fffff7ff04b00c4611180eefd5ffeffffe097"
            "0088c30200ddfb1f"
        ),
        b"/Filter /BrotliDecode ",
    ),
}


def one_page(content: bytes, resources: bytes, *more: bytes) -> bytes:
    """A one-page PDF: catalog 1, pages 2, page 3, content 4, then `more`."""
    bodies = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Contents 4 0 R /Resources " + resources + b" >>",
        content,
        *more,
    ]
    out = b"%PDF-1.4\n"
    offsets = []
    for number, body in enumerate(bodies, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(bodies) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\n" % (len(bodies) + 1)
    return out + b"startxref\n%d\n%%%%EOF\n" % xref


FONT_ONLY = b"<< /Font << /F1 5 0 R >> >>"
BOMBS = {
    "content": one_page(flate(HELLO + DENSE), FONT_ONLY, FONT),
    "form": one_page(
        flate(HELLO + b"/X0 Do\n"),
        b"<< /Font << /F1 5 0 R >> /XObject << /X0 6 0 R >> >>",
        FONT,
        flate(
            HELLO + BIG,
            b"/Type /XObject /Subtype /Form /BBox [0 0 612 792] "
            b"/Resources << /Font << /F1 5 0 R >> >> ",
        ),
    ),
    "cmap": one_page(
        flate(HELLO),
        FONT_ONLY,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
        b"/ToUnicode 6 0 R >>",
        flate(BIG),
    ),
    "font file": one_page(
        flate(HELLO),
        FONT_ONLY,
        b"<< /Type /Font /Subtype /TrueType /BaseFont /Foo /FirstChar 32 "
        b"/LastChar 126 /FontDescriptor 6 0 R >>",
        b"<< /Type /FontDescriptor /FontName /Foo /Flags 32 "
        b"/FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 "
        b"/Descent -200 /CapHeight 700 /StemV 80 /FontFile2 7 0 R >>",
        flate(BIG),
    ),
}


async def capped(document: bytes, line: str) -> tuple[int, str, str]:
    with Workspace(
        {"/w/": RAMVFS()}, mode=MountMode.WRITE, max_memory="16MB"
    ) as ws:
        ws.register_cli("pdftotext", PDFTOTEXT)
        ws.register_cli("pdfinfo", PDFINFO)
        await ws.shell("tee /w/d.pdf > /dev/null", stdin=document)
        result = await ws.shell(line)
        return (
            result.exit_code,
            (result.stdout or b"").decode(),
            (result.stderr or b"").decode(),
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("site", sorted(BOMBS))
async def test_a_stream_that_inflates_past_max_memory_is_refused(site):
    assert await capped(BOMBS[site], "pdftotext /w/d.pdf -") == (
        1,
        "",
        "pdftotext: memory exhausted\n",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("filters", sorted(FILTERED))
async def test_a_character_map_past_max_memory_is_refused_by_any_filter(
    filters,
):
    page = one_page(
        flate(HELLO),
        FONT_ONLY,
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica "
        b"/ToUnicode 6 0 R >>",
        FILTERED[filters],
    )
    assert await capped(page, "pdftotext /w/d.pdf -") == (
        1,
        "",
        "pdftotext: memory exhausted\n",
    )


def png_sub(row: bytes) -> bytes:
    """One row through the PNG Sub predictor: each byte less the one before."""
    return bytes([1]) + bytes(
        (b - (row[i - 1] if i else 0)) & 0xFF for i, b in enumerate(row)
    )


@pytest.mark.asyncio
async def test_a_form_behind_a_predictor_counts_each_form_it_names():
    draws = b"/X1 Do\n"
    page = one_page(
        flate(HELLO + b"/X0 Do\n"),
        b"<< /Font << /F1 5 0 R >> /XObject << /X0 6 0 R >> >>",
        FONT,
        flate(
            png_sub(draws),
            b"/DecodeParms << /Predictor 12 /Columns %d >> "
            b"/Type /XObject /Subtype /Form /BBox [0 0 612 792] "
            b"/Resources << /XObject << /X1 7 0 R >> >> " % len(draws),
        ),
        flate(BIG, b"/Type /XObject /Subtype /Form /BBox [0 0 612 792] "),
    )
    assert await capped(page, "pdftotext /w/d.pdf -") == (
        1,
        "",
        "pdftotext: memory exhausted\n",
    )


@pytest.mark.asyncio
async def test_a_form_the_page_never_draws_is_not_held():
    page = one_page(
        flate(HELLO),
        b"<< /Font << /F1 5 0 R >> /XObject << /X0 6 0 R >> >>",
        FONT,
        flate(
            HELLO + BIG,
            b"/Type /XObject /Subtype /Form /BBox [0 0 612 792] ",
        ),
    )
    assert await capped(page, "pdftotext /w/d.pdf -") == (
        0,
        "hello\n\n\f",
        "",
    )


@pytest.mark.asyncio
async def test_content_past_a_hundred_times_its_bytes_is_dropped_unheld():
    page = one_page(flate(HELLO + BIG), FONT_ONLY, FONT)
    assert await capped(page, "pdftotext /w/d.pdf -") == (0, "\f", "")


@pytest.mark.asyncio
async def test_a_compressed_page_under_max_memory_reads_whole():
    page = one_page(flate(HELLO), FONT_ONLY, FONT)
    assert await capped(page, "pdftotext /w/d.pdf -") == (
        0,
        "hello\n\n\f",
        "",
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "line",
    ["pdfinfo -", "pdftotext - /w/out.txt"],
)
async def test_an_input_past_max_memory_is_refused_as_it_is_read(line):
    command = line.split()[0]
    assert await capped(b"", f"head -c 20000000 /dev/zero | {line}") == (
        1,
        "",
        f"{command}: memory exhausted\n",
    )
