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

import io
import zipfile

import pytest

from mirage.commands.cli.builtin.office import OFFICE
from mirage.types import MountMode
from mirage.vfs.ram import RAMVFS
from mirage.workspace import Workspace

# Each line and what OfficeCLI 1.0.161 answers it with: exit code,
# stdout, stderr. A formula carries no computed value, mirage's
# divergence: it shows as not evaluated.
BATCH_OK = (
    '[{"command":"set","path":"/Sheet1/E1","props":{"value":"7"}},'
    '{"command":"get","path":"/Sheet1/E1"}]'
)
BATCH_FAILS = (
    '[{"command":"set","path":"/Sheet1/F1","props":{"value":"1"}},'
    '{"command":"set","path":"/Nope/A1","props":{"value":"1"}}]'
)
SHEET_NOT_FOUND = (
    'Sheet not found: "Nope". Available sheets: [Sheet1]. Use DOM path '
    '"/Sheet1/A1" or Excel notation "Sheet1!A1".'
)
NO_MATCHES = "No matches. Run 'office help xlsx query' for selector syntax.\n"
CASES = [
    ("create /w/t.xlsx", 0, "Created: /w/t.xlsx\n", ""),
    (
        "create /w/t.xlsx",
        1,
        "",
        "Error: File already exists: /w/t.xlsx. Use --force to overwrite.\n",
    ),
    (
        "set /w/t.xlsx /Sheet1/A1 --prop value=42 --prop type=string",
        0,
        "Updated /Sheet1/A1: value=42, type=string (applied: type=String)\n",
        "",
    ),
    (
        "get /w/t.xlsx /Sheet1/A1",
        0,
        '/Sheet1/A1 (cell) "42" type=String\n',
        "",
    ),
    (
        "set /w/t.xlsx /Sheet1/B1 --prop value=3.5",
        0,
        "Updated /Sheet1/B1: value=3.5\n",
        "",
    ),
    (
        "set /w/t.xlsx Sheet1!C1 --prop value=true",
        0,
        "Updated Sheet1!C1: value=true\n",
        "",
    ),
    (
        "set /w/t.xlsx /Sheet1/A3 --prop value=2024-03-15",
        0,
        "Updated /Sheet1/A3: value=2024-03-15\n",
        "",
    ),
    (
        "get /w/t.xlsx /Sheet1/A3",
        0,
        '/Sheet1/A3 (cell) "2024-03-15" type=Number numFmtId=164 '
        "numberformat=yyyy-mm-dd\n",
        "",
    ),
    (
        "set /w/t.xlsx /Sheet1/D1 --prop formula=B1*2",
        0,
        "Updated /Sheet1/D1: formula=B1*2\n",
        "",
    ),
    ("get /w/t.xlsx /Sheet1/Z9", 0, '/Sheet1/Z9 (cell) "(empty)"\n', ""),
    (
        "get /w/t.xlsx /Sheet1",
        0,
        "/Sheet1 (sheet)\n/Sheet1/row[1] (row)\n"
        '/Sheet1/A1 (cell) "42" type=String\n'
        '/Sheet1/B1 (cell) "3.5" type=Number\n'
        '/Sheet1/C1 (cell) "true" type=String\n'
        '/Sheet1/D1 (cell) "#OCLI_NOTEVAL!" type=Number formula=B1*2 '
        "evaluated=false\n"
        "/Sheet1/row[3] (row)\n"
        '/Sheet1/A3 (cell) "2024-03-15" type=Number numFmtId=164 '
        "numberformat=yyyy-mm-dd\n",
        "",
    ),
    ("get /w/t.xlsx /Sheet1 --depth 0", 0, "/Sheet1 (sheet) children=2\n", ""),
    (
        "get /w/t.xlsx | sed -E 's/ (created|modified)=[^ ]+//g'",
        0,
        "/ (workbook) "
        "author=OfficeCLI lastModifiedBy=OfficeCLI "
        "calc.fullPrecision=true calc.fullCalcOnLoad=true "
        "theme.name=Office Theme theme.colorScheme=Office "
        "theme.color.dk1=#000000 theme.color.lt1=#FFFFFF "
        "theme.color.dk2=#44546A theme.color.lt2=#E7E6E6 "
        "theme.color.accent1=#4472C4 theme.color.accent2=#ED7D31 "
        "theme.color.accent3=#A5A5A5 theme.color.accent4=#FFC000 "
        "theme.color.accent5=#5B9BD5 theme.color.accent6=#70AD47 "
        "theme.color.hlink=#0563C1 theme.color.folHlink=#954F72 "
        "theme.fontScheme=Office theme.font.major.latin=Calibri Light "
        "theme.font.major.eastAsia= theme.font.minor.latin=Calibri "
        "theme.font.minor.eastAsia= theme.formatScheme=Office "
        "extended.application=OfficeCLI/1.0.161"
        "\n/Sheet1 (sheet) children=2\n",
        "",
    ),
    (
        "get /w/t.xlsx /Sheet1/A1:B1",
        0,
        "/Sheet1/A1:B1 (range)\n"
        '/Sheet1/A1 (cell) "42" type=String\n'
        '/Sheet1/B1 (cell) "3.5" type=Number\n',
        "",
    ),
    (
        "query /w/t.xlsx 'cell:contains(4)'",
        0,
        '/Sheet1/A1 (cell) "42" type=String value=42\n'
        '/Sheet1/A3 (cell) "2024-03-15" type=Number numFmtId=164 '
        "numberformat=yyyy-mm-dd value=45366\n",
        "",
    ),
    (
        "query /w/t.xlsx 'cell[value>10]'",
        0,
        '/Sheet1/A1 (cell) "42" type=String value=42\n'
        '/Sheet1/A3 (cell) "2024-03-15" type=Number numFmtId=164 '
        "numberformat=yyyy-mm-dd value=45366\n",
        "Warning: non-numeric 'true' for 'value' at /Sheet1/C1\n",
    ),
    ("query /w/t.xlsx zzz", 0, "", NO_MATCHES),
    (
        "query /w/t.xlsx 'cell[valu=1]'",
        0,
        "",
        "Warning: unknown key 'valu'. Available: evaluated, formula, "
        "numberformat, numFmtId, text, type, value (did you mean 'value'?)\n"
        + NO_MATCHES,
    ),
    (
        "query /w/t.xlsx 'cell[type=Number'",
        1,
        "",
        'Error: Malformed selector: unclosed bracket in "cell[type=Number"\n',
    ),
    (
        "query /w/t.xlsx row",
        0,
        "/Sheet1/row[1] (row) children=4\n/Sheet1/row[3] (row) children=1\n",
        "",
    ),
    (
        f"batch /w/t.xlsx --commands '{BATCH_OK}'",
        0,
        "[1] Updated /Sheet1/E1: value=7\n"
        '[2] /Sheet1/E1 (cell) "7" type=Number\n\n'
        "\nBatch complete: 2 succeeded, 0 failed, 2 total\n",
        "",
    ),
    (
        f"batch /w/t.xlsx --commands '{BATCH_FAILS}'",
        1,
        "[1] Updated /Sheet1/F1: value=1\n"
        f"[2] ERROR: {SHEET_NOT_FOUND}\n"
        "\nBatch complete: 1 succeeded, 1 failed, 2 total "
        "(atomic: no changes were applied)\n",
        "",
    ),
    ("get /w/t.xlsx /Sheet1/F1", 0, '/Sheet1/F1 (cell) "(empty)"\n', ""),
    (
        "batch /w/t.xlsx --commands '{}'",
        1,
        "",
        "Error: Batch input must be a JSON array. Got: object. Wrap a single "
        'item like [{"command":"get","path":"/"}].\n',
    ),
    (
        "set /w/t.xlsx /Sheet1 --prop hidden=true",
        1,
        "",
        "Error: Cannot hide sheet 'Sheet1': a workbook must keep at least one "
        "visible sheet, or Excel refuses to open the file. Unhide another "
        "sheet first.\n",
    ),
    (
        "set /w/t.xlsx /Sheet1/A1 --prop bogus=1",
        2,
        "Error: No properties applied to /Sheet1/A1\n",
        "UNSUPPORTED props: bogus (valid cell props: value, formula, type). "
        "Run 'office help <format> <element>' to see valid props, or "
        "raw-set for raw XML.\n",
    ),
    (
        "set /w/t.xlsx /Sheet1/A1",
        1,
        "",
        "Error: No properties to set at /Sheet1/A1. Pass at least one "
        "--prop key=value.\n",
    ),
    (
        "set /w/none.xlsx /Sheet1/A1 --prop value=1",
        1,
        "",
        "Error: File not found: /w/none.xlsx\n",
    ),
    (
        "set /w/t.xlsx /Nope/A1 --prop value=1",
        1,
        "",
        f"Error: {SHEET_NOT_FOUND}\n",
    ),
    (
        "remove /w/t.xlsx /Sheet1/comment[1]",
        1,
        "",
        "Error: No comments found in sheet\n",
    ),
    (
        "set /w/t.xlsx /Sheet1/E1 --prop value=8 --json",
        0,
        '{\n  "success": true,\n  "data": "Updated /Sheet1/E1: value=8",\n'
        '  "message": "Updated /Sheet1/E1: value=8"\n}\n',
        "",
    ),
    (
        "get /w/t.xlsx /Sheet1/E1 --json",
        0,
        '{\n  "success": true,\n  "data": {\n    "matches": 1,\n'
        '    "results": [\n      {\n        "path": "/Sheet1/E1",\n'
        '        "type": "cell",\n        "text": "8",\n'
        '        "preview": "E1",\n        "childCount": 0,\n'
        '        "format": {\n          "type": "Number"\n        },\n'
        '        "children": []\n      }\n    ]\n  }\n}\n',
        "",
    ),
]


@pytest.mark.asyncio
async def test_lines_answer_as_officecli_does():
    with Workspace({"/w/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        ws.register_cli("office", OFFICE)
        for line, code, out, err in CASES:
            result = await ws.shell(f"office {line}")
            got = (
                result.exit_code,
                (result.stdout or b"").decode(),
                (result.stderr or b"").decode(),
            )
            assert got == (code, out, err), line


@pytest.mark.asyncio
async def test_create_force_replaces_the_workbook():
    with Workspace({"/w/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        ws.register_cli("office", OFFICE)
        await ws.shell("office create /w/t.xlsx")
        await ws.shell("office set /w/t.xlsx /Sheet1/A1 --prop value=1")
        result = await ws.shell("office create /w/t.xlsx --force")
        assert result.exit_code == 0
        cell = await ws.shell("office get /w/t.xlsx /Sheet1/A1")
        assert cell.stdout == b'/Sheet1/A1 (cell) "(empty)"\n'


@pytest.mark.asyncio
async def test_batch_reads_input_files_and_stdin():
    with Workspace({"/w/": RAMVFS()}, mode=MountMode.WRITE) as ws:
        ws.register_cli("office", OFFICE)
        await ws.shell("office create /w/t.xlsx")
        item = '[{"command":"set","path":"/Sheet1/A1","props":{"value":"5"}}]'
        await ws.shell(f"echo '{item}' > /w/in.json")
        from_file = await ws.shell("office batch /w/t.xlsx --input /w/in.json")
        assert from_file.exit_code == 0
        assert from_file.stdout.startswith(
            b"[1] Updated /Sheet1/A1: value=5\n"
        )
        piped = await ws.shell(
            'echo \'[{"command":"get","path":"/Sheet1/A1"}]\' '
            "| office batch /w/t.xlsx"
        )
        assert piped.stdout.startswith(
            b'[1] /Sheet1/A1 (cell) "5" type=Number\n'
        )
        missing = await ws.shell(
            "office batch /w/t.xlsx --input /w/missing.json"
        )
        assert (missing.exit_code, missing.stderr) == (
            1,
            b"Error: Input file not found: /w/missing.json\n",
        )


def test_only_get_and_query_read():
    assert {
        path for path, handler in OFFICE.handlers.items() if handler.write
    } == {"create", "set", "add", "remove", "move", "swap", "batch"}


TYPES = (
    b'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.'
    b'openxmlformats.org/package/2006/content-types"><Default Extension="rels" '
    b'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    b'<Default Extension="xml" ContentType="application/xml"/><Override '
    b'PartName="/word/document.xml" ContentType="application/vnd.'
    b'openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    b"</Types>"
)
ROOT_RELS = (
    b'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://'
    b'schemas.openxmlformats.org/package/2006/relationships"><Relationship '
    b'Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
    b'relationships/officeDocument" Target="word/document.xml"/>'
    b"</Relationships>"
)


def word(body: bytes, extra: dict[str, bytes] | None = None) -> bytes:
    """A Word document whose body is `body`, with `extra` parts that no
    relationship names."""
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", TYPES)
        z.writestr("_rels/.rels", ROOT_RELS)
        z.writestr(
            "word/document.xml",
            b'<w:document xmlns:w="http://schemas.openxmlformats.org/'
            b'wordprocessingml/2006/main"><w:body>'
            + body
            + b"</w:body></w:document>",
        )
        for name, data in (extra or {}).items():
            z.writestr(name, data)
    return out.getvalue()


async def office_under_cap(
    document: bytes, *lines: str
) -> list[tuple[int, bytes, bytes]]:
    with Workspace(
        {"/w/": RAMVFS()}, mode=MountMode.WRITE, max_memory="16MB"
    ) as ws:
        ws.register_cli("office", OFFICE)
        await ws.shell("tee /w/d.docx > /dev/null", stdin=document)
        results = []
        for line in lines:
            r = await ws.shell(line)
            results.append((r.exit_code, r.stdout or b"", r.stderr or b""))
        return results


@pytest.mark.asyncio
async def test_a_document_that_parses_past_max_memory_is_refused():
    [got] = await office_under_cap(
        word(b"<w:p/>" * 100_000), "office get /w/d.docx"
    )
    assert got == (1, b"", b"office get: memory exhausted\n")


@pytest.mark.asyncio
async def test_a_document_that_fits_max_memory_reads():
    [got] = await office_under_cap(
        word(b"<w:p/>" * 1_000), "office get /w/d.docx /body/p[1000]"
    )
    assert got[0] == 0, got


@pytest.mark.asyncio
async def test_a_part_nothing_links_to_is_never_inflated_and_kept():
    junk = b"<a>" + b" " * (40 << 20) + b"</a>"
    document = word(
        b"<w:p><w:r><w:t>hi</w:t></w:r></w:p>", {"word/junk.xml": junk}
    )
    got, changed, saved, raw = await office_under_cap(
        document,
        "office get /w/d.docx /body/p[1]",
        "office set /w/d.docx /body/p[1] --prop text=bye",
        "office get /w/d.docx /body/p[1]",
        "cat /w/d.docx",
    )
    assert (got[0], changed[0]) == (0, 0), (got, changed)
    assert b'"bye"' in saved[1], saved
    with zipfile.ZipFile(io.BytesIO(raw[1])) as z:
        assert z.read("word/junk.xml") == junk
