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
import { PDFINFO, PDFTOTEXT } from './index.ts'
import { Refused, pageNumber } from './run.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder()

/** A PDF whose pages draw each [x, y, text] in 12-point Helvetica. */
function document(pages: [number, number, string][][]): Uint8Array {
  const bodies = ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', '']
  const kids: number[] = []
  for (const runs of pages) {
    const content = runs
      .map(([x, y, text]) => `BT /F1 12 Tf 1 0 0 1 ${String(x)} ${String(y)} Tm (${text}) Tj ET\n`)
      .join('')
    bodies.push(`<< /Length ${String(content.length)} >>\nstream\n${content}endstream`)
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 1 0 R >> >> /Contents ${String(bodies.length)} 0 R >>`,
    )
    kids.push(bodies.length)
  }
  bodies[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${String(k)} 0 R`).join(' ')}] /Count ${String(kids.length)} >>`
  bodies.push('<< /Type /Catalog /Pages 2 0 R >>')
  bodies.push('<< /Title (Plan) /Author (Ops) >>')
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  bodies.forEach((body, i) => {
    offsets.push(out.length)
    out += `${String(i + 1)} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${String(bodies.length + 1)}\n0000000000 65535 f \n`
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${String(bodies.length + 1)} /Root ${String(bodies.length - 1)} 0 R /Info ${String(bodies.length)} 0 R >>\n`
  return ENC.encode(`${out}startxref\n${String(xref)}\n%%EOF\n`)
}

const TWO_PAGES = document([
  [
    [72, 720, 'First page'],
    [72, 706, 'second line'],
  ],
  [
    [72, 720, 'Left'],
    [320, 720, 'Right'],
  ],
])

async function shell(line: string): Promise<[number, string, string]> {
  const ws = new Workspace({ '/w': new RAMVFS() }, { mode: MountMode.WRITE })
  try {
    ws.registerCli('pdftotext', PDFTOTEXT)
    ws.registerCli('pdfinfo', PDFINFO)
    await ws.shell('tee /w/plan.pdf > /dev/null', { stdin: TWO_PAGES })
    const result = await ws.shell(line)
    return [result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]
  } finally {
    await ws.close()
  }
}

describe('page numbers', () => {
  it.each([
    [undefined, undefined],
    ['3', 3],
    ['+2', 2],
    ['-1', -1],
    ['', 0],
  ])('reads %j as %j', (text, value) => {
    expect(pageNumber(text)).toBe(value)
  })

  it.each([
    ['2147483648', -2147483648],
    ['4294967299', 3],
    ['99999999999', 1215752191],
    ['9223372036854775808', -1],
    ['-9223372036854775809', 0],
  ])('keeps the low bits of %j past an int', (text, value) => {
    expect(pageNumber(text)).toBe(value)
  })

  it.each(['x', '2x', ' 2', '1.5'])('refuses %j', (text) => {
    expect(() => pageNumber(text)).toThrow(Refused)
  })
})

describe('pdftotext', () => {
  it('writes to stdout with a form feed after each page', async () => {
    expect(await shell('pdftotext /w/plan.pdf -')).toEqual([
      0,
      'First page\nsecond line\n\n\fLeft\n\nRight\n\n\f',
      '',
    ])
  })

  it('reads a page range into the text file beside the PDF', async () => {
    expect(await shell('pdftotext -f 2 -layout /w/plan.pdf && cat /w/plan.txt')).toEqual([
      0,
      'Left   Right\n\f',
      '',
    ])
  })

  it('refuses a range past the end', async () => {
    expect(await shell('pdftotext -f 3 /w/plan.pdf -')).toEqual([
      99,
      '',
      'Command Line Error: Wrong page range given: the first page (3) can not be after the last page (2).\n',
    ])
  })

  it.each([
    ['pdftotext', 99],
    ['pdftotext -f x /w/plan.pdf -', 99],
    ['pdftotext /w/plan.pdf - extra', 99],
    ['pdftotext -h', 0],
    ['pdfinfo', 99],
  ])('answers %j with help on stderr', async (line, status) => {
    const [code, out, err] = await shell(line)
    expect([code, out]).toEqual([status, ''])
    expect(err.startsWith('usage: ')).toBe(true)
  })
})

describe('pdfinfo', () => {
  it('prints the field block', async () => {
    const [code, out, err] = await shell('pdfinfo -l 2 /w/plan.pdf')
    expect([code, err]).toEqual([0, ''])
    expect(out.split('\n').slice(0, 3)).toEqual([
      'Title:           Plan',
      'Author:          Ops',
      'Custom Metadata: no',
    ])
    expect(out).toContain('Page    2 size:  612 x 792 pts (letter)')
    expect(out.endsWith('Optimized:       no\nPDF version:     1.4\n')).toBe(true)
  })
})
