// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.
// ========= Copyright 2026 @ Strukto.AI All Rights Reserved. =========

import { crc32, deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { MountMode } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { OFFICE } from './index.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

// Each line and what OfficeCLI 1.0.161 answers it with: exit code, stdout,
// stderr. A formula carries no computed value, mirage's divergence: it
// shows as not evaluated.
const CASES: [string, number, string, string][] = [
  ['create /w/t.xlsx', 0, 'Created: /w/t.xlsx\n', ''],
  ['create /w/t.xlsx', 1, '', 'Error: File already exists: /w/t.xlsx. Use --force to overwrite.\n'],
  [
    'set /w/t.xlsx /Sheet1/A1 --prop value=42 --prop type=string',
    0,
    'Updated /Sheet1/A1: value=42, type=string (applied: type=String)\n',
    '',
  ],
  ['get /w/t.xlsx /Sheet1/A1', 0, '/Sheet1/A1 (cell) "42" type=String\n', ''],
  ['set /w/t.xlsx /Sheet1/B1 --prop value=3.5', 0, 'Updated /Sheet1/B1: value=3.5\n', ''],
  ['set /w/t.xlsx Sheet1!C1 --prop value=true', 0, 'Updated Sheet1!C1: value=true\n', ''],
  [
    'set /w/t.xlsx /Sheet1/A3 --prop value=2024-03-15',
    0,
    'Updated /Sheet1/A3: value=2024-03-15\n',
    '',
  ],
  [
    'get /w/t.xlsx /Sheet1/A3',
    0,
    '/Sheet1/A3 (cell) "2024-03-15" type=Number numFmtId=164 numberformat=yyyy-mm-dd\n',
    '',
  ],
  ['set /w/t.xlsx /Sheet1/D1 --prop formula=B1*2', 0, 'Updated /Sheet1/D1: formula=B1*2\n', ''],
  ['get /w/t.xlsx /Sheet1/Z9', 0, '/Sheet1/Z9 (cell) "(empty)"\n', ''],
  [
    'get /w/t.xlsx /Sheet1',
    0,
    '/Sheet1 (sheet)\n/Sheet1/row[1] (row)\n/Sheet1/A1 (cell) "42" type=String\n/Sheet1/B1 (cell) "3.5" type=Number\n/Sheet1/C1 (cell) "true" type=String\n/Sheet1/D1 (cell) "#OCLI_NOTEVAL!" type=Number formula=B1*2 evaluated=false\n/Sheet1/row[3] (row)\n/Sheet1/A3 (cell) "2024-03-15" type=Number numFmtId=164 numberformat=yyyy-mm-dd\n',
    '',
  ],
  ['get /w/t.xlsx /Sheet1 --depth 0', 0, '/Sheet1 (sheet) children=2\n', ''],
  [
    "get /w/t.xlsx | sed -E 's/ (created|modified)=[^ ]+//g'",
    0,
    '/ (workbook) author=OfficeCLI lastModifiedBy=OfficeCLI calc.fullPrecision=true calc.fullCalcOnLoad=true theme.name=Office Theme theme.colorScheme=Office theme.color.dk1=#000000 theme.color.lt1=#FFFFFF theme.color.dk2=#44546A theme.color.lt2=#E7E6E6 theme.color.accent1=#4472C4 theme.color.accent2=#ED7D31 theme.color.accent3=#A5A5A5 theme.color.accent4=#FFC000 theme.color.accent5=#5B9BD5 theme.color.accent6=#70AD47 theme.color.hlink=#0563C1 theme.color.folHlink=#954F72 theme.fontScheme=Office theme.font.major.latin=Calibri Light theme.font.major.eastAsia= theme.font.minor.latin=Calibri theme.font.minor.eastAsia= theme.formatScheme=Office extended.application=OfficeCLI/1.0.161\n/Sheet1 (sheet) children=2\n',
    '',
  ],
  [
    'get /w/t.xlsx /Sheet1/A1:B1',
    0,
    '/Sheet1/A1:B1 (range)\n/Sheet1/A1 (cell) "42" type=String\n/Sheet1/B1 (cell) "3.5" type=Number\n',
    '',
  ],
  [
    "query /w/t.xlsx 'cell:contains(4)'",
    0,
    '/Sheet1/A1 (cell) "42" type=String value=42\n/Sheet1/A3 (cell) "2024-03-15" type=Number numFmtId=164 numberformat=yyyy-mm-dd value=45366\n',
    '',
  ],
  [
    "query /w/t.xlsx 'cell[value>10]'",
    0,
    '/Sheet1/A1 (cell) "42" type=String value=42\n/Sheet1/A3 (cell) "2024-03-15" type=Number numFmtId=164 numberformat=yyyy-mm-dd value=45366\n',
    "Warning: non-numeric 'true' for 'value' at /Sheet1/C1\n",
  ],
  ['query /w/t.xlsx zzz', 0, '', "No matches. Run 'office help xlsx query' for selector syntax.\n"],
  [
    "query /w/t.xlsx 'cell[valu=1]'",
    0,
    '',
    "Warning: unknown key 'valu'. Available: evaluated, formula, numberformat, numFmtId, text, type, value (did you mean 'value'?)\nNo matches. Run 'office help xlsx query' for selector syntax.\n",
  ],
  [
    "query /w/t.xlsx 'cell[type=Number'",
    1,
    '',
    'Error: Malformed selector: unclosed bracket in "cell[type=Number"\n',
  ],
  [
    'query /w/t.xlsx row',
    0,
    '/Sheet1/row[1] (row) children=4\n/Sheet1/row[3] (row) children=1\n',
    '',
  ],
  [
    'batch /w/t.xlsx --commands \'[{"command":"set","path":"/Sheet1/E1","props":{"value":"7"}},{"command":"get","path":"/Sheet1/E1"}]\'',
    0,
    '[1] Updated /Sheet1/E1: value=7\n[2] /Sheet1/E1 (cell) "7" type=Number\n\n\nBatch complete: 2 succeeded, 0 failed, 2 total\n',
    '',
  ],
  [
    'batch /w/t.xlsx --commands \'[{"command":"set","path":"/Sheet1/F1","props":{"value":"1"}},{"command":"set","path":"/Nope/A1","props":{"value":"1"}}]\'',
    1,
    '[1] Updated /Sheet1/F1: value=1\n[2] ERROR: Sheet not found: "Nope". Available sheets: [Sheet1]. Use DOM path "/Sheet1/A1" or Excel notation "Sheet1!A1".\n\nBatch complete: 1 succeeded, 1 failed, 2 total (atomic: no changes were applied)\n',
    '',
  ],
  ['get /w/t.xlsx /Sheet1/F1', 0, '/Sheet1/F1 (cell) "(empty)"\n', ''],
  [
    "batch /w/t.xlsx --commands '{}'",
    1,
    '',
    'Error: Batch input must be a JSON array. Got: object. Wrap a single item like [{"command":"get","path":"/"}].\n',
  ],
  [
    'set /w/t.xlsx /Sheet1 --prop hidden=true',
    1,
    '',
    "Error: Cannot hide sheet 'Sheet1': a workbook must keep at least one visible sheet, or Excel refuses to open the file. Unhide another sheet first.\n",
  ],
  [
    'set /w/t.xlsx /Sheet1/A1 --prop bogus=1',
    2,
    'Error: No properties applied to /Sheet1/A1\n',
    "UNSUPPORTED props: bogus (valid cell props: value, formula, type). Run 'office help <format> <element>' to see valid props, or raw-set for raw XML.\n",
  ],
  [
    'set /w/t.xlsx /Sheet1/A1',
    1,
    '',
    'Error: No properties to set at /Sheet1/A1. Pass at least one --prop key=value.\n',
  ],
  ['set /w/none.xlsx /Sheet1/A1 --prop value=1', 1, '', 'Error: File not found: /w/none.xlsx\n'],
  [
    'set /w/t.xlsx /Nope/A1 --prop value=1',
    1,
    '',
    'Error: Sheet not found: "Nope". Available sheets: [Sheet1]. Use DOM path "/Sheet1/A1" or Excel notation "Sheet1!A1".\n',
  ],
  ['remove /w/t.xlsx /Sheet1/comment[1]', 1, '', 'Error: No comments found in sheet\n'],
  [
    'set /w/t.xlsx /Sheet1/E1 --prop value=8 --json',
    0,
    '{\n  "success": true,\n  "data": "Updated /Sheet1/E1: value=8",\n  "message": "Updated /Sheet1/E1: value=8"\n}\n',
    '',
  ],
  [
    'get /w/t.xlsx /Sheet1/E1 --json',
    0,
    '{\n  "success": true,\n  "data": {\n    "matches": 1,\n    "results": [\n      {\n        "path": "/Sheet1/E1",\n        "type": "cell",\n        "text": "8",\n        "preview": "E1",\n        "childCount": 0,\n        "format": {\n          "type": "Number"\n        },\n        "children": []\n      }\n    ]\n  }\n}\n',
    '',
  ],
]

function workspace(): Workspace {
  const ws = new Workspace({ '/w': new RAMVFS() }, { mode: MountMode.WRITE })
  ws.registerCli('office', OFFICE)
  return ws
}

describe('office', () => {
  it('answers each line as OfficeCLI does', async () => {
    const ws = workspace()
    try {
      for (const [line, code, out, err] of CASES) {
        const result = await ws.shell(`office ${line}`)
        expect(
          [result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)],
          line,
        ).toEqual([code, out, err])
      }
    } finally {
      await ws.close()
    }
  })

  it('replaces the workbook under create --force', async () => {
    const ws = workspace()
    try {
      await ws.shell('office create /w/t.xlsx')
      await ws.shell('office set /w/t.xlsx /Sheet1/A1 --prop value=1')
      expect((await ws.shell('office create /w/t.xlsx --force')).exitCode).toBe(0)
      const cell = await ws.shell('office get /w/t.xlsx /Sheet1/A1')
      expect(DEC.decode(cell.stdout)).toBe('/Sheet1/A1 (cell) "(empty)"\n')
    } finally {
      await ws.close()
    }
  })

  it('reads batch items from an input file and from stdin', async () => {
    const ws = workspace()
    try {
      await ws.shell('office create /w/t.xlsx')
      const item = '[{"command":"set","path":"/Sheet1/A1","props":{"value":"5"}}]'
      await ws.shell(`echo '${item}' > /w/in.json`)
      const fromFile = await ws.shell('office batch /w/t.xlsx --input /w/in.json')
      expect(fromFile.exitCode).toBe(0)
      expect(DEC.decode(fromFile.stdout).startsWith('[1] Updated /Sheet1/A1: value=5\n')).toBe(true)
      const piped = await ws.shell(
        `echo '[{"command":"get","path":"/Sheet1/A1"}]' | office batch /w/t.xlsx`,
      )
      expect(DEC.decode(piped.stdout).startsWith('[1] /Sheet1/A1 (cell) "5" type=Number\n')).toBe(
        true,
      )
      const missing = await ws.shell('office batch /w/t.xlsx --input /w/missing.json')
      expect([missing.exitCode, DEC.decode(missing.stderr)]).toEqual([
        1,
        'Error: Input file not found: /w/missing.json\n',
      ])
    } finally {
      await ws.close()
    }
  })

  it('reads only under get and query', () => {
    const writers = Object.entries(OFFICE.handlers)
      .filter(([, handler]) => handler.write)
      .map(([path]) => path)
      .sort()
    expect(writers).toEqual(['add', 'batch', 'create', 'move', 'remove', 'set', 'swap'])
  })
})

const TYPES =
  '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ' +
  'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'
const ROOT_RELS =
  '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ' +
  'Target="word/document.xml"/></Relationships>'

/** A zip of `parts`, each deflated. */
function zip(parts: [string, Uint8Array][]): Uint8Array {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let at = 0
  for (const [name, data] of parts) {
    const packed = deflateRawSync(data)
    const fields = (sig: number, size: number): Buffer => {
      const head = Buffer.alloc(size)
      head.writeUInt32LE(sig, 0)
      return head
    }
    const local = fields(0x04034b50, 30)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc32(data), 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(Buffer.byteLength(name), 26)
    const central = fields(0x02014b50, 46)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc32(data), 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(Buffer.byteLength(name), 28)
    central.writeUInt32LE(at, 42)
    const entry = Buffer.concat([local, Buffer.from(name), packed])
    locals.push(entry)
    centrals.push(Buffer.concat([central, Buffer.from(name)]))
    at += entry.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(parts.length, 8)
  end.writeUInt16LE(parts.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(at, 16)
  return new Uint8Array(Buffer.concat([...locals, directory, end]))
}

/** A Word document whose body is `body`, with `extra` parts no relationship names. */
function word(body: string, extra: [string, Uint8Array][] = []): Uint8Array {
  return zip([
    ['[Content_Types].xml', ENC.encode(TYPES)],
    ['_rels/.rels', ENC.encode(ROOT_RELS)],
    [
      'word/document.xml',
      ENC.encode(
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
      ),
    ],
    ...extra,
  ])
}

type Ran = [number, Uint8Array, string]

async function officeUnderCap(document: Uint8Array, ...lines: string[]): Promise<Ran[]> {
  const ws = new Workspace({ '/w': new RAMVFS() }, { mode: MountMode.WRITE, maxMemory: '16MB' })
  try {
    ws.registerCli('office', OFFICE)
    await ws.shell('tee /w/d.docx > /dev/null', { stdin: document })
    const results: [number, Uint8Array, string][] = []
    for (const line of lines) {
      const r = await ws.shell(line)
      results.push([r.exitCode, r.stdout, DEC.decode(r.stderr)])
    }
    return results
  } finally {
    await ws.close()
  }
}

describe('office under max_memory', () => {
  it('refuses a document that parses past max_memory', async () => {
    const got = await officeUnderCap(word('<w:p/>'.repeat(100_000)), 'office get /w/d.docx')
    expect(got).toEqual([[1, new Uint8Array(), 'office get: memory exhausted\n']])
  })

  it('refuses parts that fit one at a time together', async () => {
    const pad = ' '.repeat(10 << 20)
    const rels =
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'
    const styles = `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${pad}</w:styles>`
    const got = await officeUnderCap(
      word('<w:p/>' + pad, [
        ['word/_rels/document.xml.rels', ENC.encode(rels)],
        ['word/styles.xml', ENC.encode(styles)],
      ]),
      'office get /w/d.docx',
    )
    expect(got).toEqual([[1, new Uint8Array(), 'office get: memory exhausted\n']])
  })

  it('reads a document that fits', async () => {
    const got = await officeUnderCap(
      word('<w:p/>'.repeat(1_000)),
      'office get /w/d.docx /body/p[1000]',
    )
    expect(got[0]?.[0]).toBe(0)
  })

  it('never inflates a part nothing links to, and keeps it', async () => {
    const junk = ENC.encode('<a>' + ' '.repeat(40 << 20) + '</a>')
    const [got, changed, saved, raw] = (await officeUnderCap(
      word('<w:p><w:r><w:t>hi</w:t></w:r></w:p>', [['word/junk.xml', junk]]),
      'office get /w/d.docx /body/p[1]',
      'office set /w/d.docx /body/p[1] --prop text=bye',
      'office get /w/d.docx /body/p[1]',
      'cat /w/d.docx',
    )) as [Ran, Ran, Ran, Ran]
    expect([got[0], changed[0], saved[0]]).toEqual([0, 0, 0])
    expect(DEC.decode(saved[1])).toContain('"bye"')
    const savedZip = Buffer.from(raw[1])
    const central = savedZip.lastIndexOf('word/junk.xml') - 46
    expect(savedZip.readUInt32LE(central)).toBe(0x02014b50)
    expect(savedZip.readUInt32LE(central + 16)).toBe(crc32(junk))
  })
})
