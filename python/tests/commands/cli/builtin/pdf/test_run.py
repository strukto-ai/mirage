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
