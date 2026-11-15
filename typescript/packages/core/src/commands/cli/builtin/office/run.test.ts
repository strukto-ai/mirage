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

import { describe, expect, it } from 'vitest'
import { MountMode } from '../../../../types.ts'
import { RAMVFS } from '../../../../vfs/ram/ram.ts'
import { Workspace } from '../../../../workspace/workspace/workspace.ts'
import { OFFICE } from './index.ts'

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
    'get /w/t.xlsx',
    0,
    '/ (workbook) calc.fullPrecision=true calc.fullCalcOnLoad=true\n/Sheet1 (sheet) children=2\n',
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
    expect(writers).toEqual(['batch', 'create', 'remove', 'set'])
  })
})
