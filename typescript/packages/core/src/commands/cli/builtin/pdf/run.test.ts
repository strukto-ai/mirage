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

import { randomBytes } from 'node:crypto'
import { brotliCompressSync, deflateRawSync, deflateSync } from 'node:zlib'
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

const FONT = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
const HELLO = 'BT /F1 12 Tf 72 720 Td (hello) Tj ET\n'
const BIG = ENC.encode(' '.repeat(40 << 20))
// Mostly one letter: inflates under a hundred times its packed bytes, so
// the reader keeps it.
const DENSE = randomBytes(20 << 20).map((b) => (b < 254 ? 97 : 98))

function stream(packed: Uint8Array, extra = ''): Uint8Array {
  return Buffer.concat([
    ENC.encode(`<< /Length ${String(packed.length)} ${extra}>>\nstream\n`),
    packed,
    ENC.encode('\nendstream'),
  ])
}

function flate(data: Uint8Array, extra = ''): Uint8Array {
  return stream(deflateSync(data, { level: 9 }), `/Filter /FlateDecode ${extra}`)
}

/**
 * An LZW stream of spaces: each code one longer than the last until the
 * table fills, then the longest one `longest` times.
 */
function lzwRun(longest: number): Uint8Array {
  const codes = [256, 32]
  for (let code = 258; code < 4096; code++) codes.push(code)
  for (let i = 0; i < longest; i++) codes.push(4095)
  codes.push(257)
  const out: number[] = []
  let held = 0
  let bits = 0
  let width = 9
  let following = 258
  let previous: number | null = null
  for (const code of codes) {
    if (width < 12 && following + 1 === 1 << width) width += 1
    held = (held << width) | code
    bits += width
    while (bits >= 8) {
      bits -= 8
      out.push((held >> bits) & 0xff)
    }
    held &= (1 << bits) - 1
    if (code === 256) {
      width = 9
      following = 258
      previous = null
      continue
    }
    if (previous !== null && following < 4096) following += 1
    previous = code
  }
  if (bits > 0) out.push((held << (8 - bits)) & 0xff)
  return new Uint8Array(out)
}

// Each filter pdf_oxide decodes with no limit of its own, over 20 MiB of spaces.
const SPACES = ENC.encode(' '.repeat(20 << 20))
const FILTERED: Record<string, Uint8Array> = {
  LZWDecode: stream(lzwRun(6000), '/Filter /LZWDecode '),
  RunLengthDecode: stream(
    joined(
      new Uint8Array((20 << 20) / 64).map((_, i) => (i % 2 === 0 ? 129 : 32)),
      new Uint8Array([128]),
    ),
    '/Filter /RunLengthDecode ',
  ),
  'ASCIIHexDecode then FlateDecode': stream(
    ENC.encode(Buffer.from(deflateSync(SPACES, { level: 9 })).toString('hex') + '>'),
    '/Filter [/ASCIIHexDecode /FlateDecode] ',
  ),
  BrotliDecode: stream(brotliCompressSync(SPACES), '/Filter /BrotliDecode '),
}

function joined(...parts: (string | Uint8Array)[]): Uint8Array {
  return Buffer.concat(parts.map((p) => (typeof p === 'string' ? ENC.encode(p) : p)))
}

/** A one-page PDF: catalog 1, pages 2, page 3, content 4, then `more`. */
function onePage(
  content: Uint8Array,
  resources: string,
  ...more: (string | Uint8Array)[]
): Uint8Array {
  return pages([[content, resources]], ...more)
}

/**
 * A PDF of pages, each a [content, resources] pair: catalog 1, pages 2, then
 * each page and its content, then `more`.
 */
function pages(each: [Uint8Array, string][], ...more: (string | Uint8Array)[]): Uint8Array {
  const kids = each.map((_, at) => 3 + 2 * at)
  const bodies: (string | Uint8Array)[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${kids.map((k) => `${String(k)} 0 R`).join(' ')}] /Count ${String(kids.length)} >>`,
  ]
  each.forEach(([content, resources], at) => {
    bodies.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${String(4 + 2 * at)} 0 R /Resources ${resources} >>`,
      content,
    )
  })
  bodies.push(...more)
  const head = ENC.encode('%PDF-1.4\n')
  const out: Uint8Array[] = [head]
  let length = head.length
  const offsets: number[] = []
  bodies.forEach((body, i) => {
    offsets.push(length)
    const object = joined(`${String(i + 1)} 0 obj\n`, body, '\nendobj\n')
    out.push(object)
    length += object.length
  })
  const xref = [
    `xref\n0 ${String(bodies.length + 1)}\n0000000000 65535 f \n`,
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`),
    `trailer\n<< /Size ${String(bodies.length + 1)} /Root 1 0 R >>\nstartxref\n${String(length)}\n%%EOF\n`,
  ].join('')
  return joined(...out, xref)
}

const FONT_ONLY = '<< /Font << /F1 5 0 R >> >>'
const BOMBS: Record<string, Uint8Array> = {
  content: onePage(flate(joined(HELLO, DENSE)), FONT_ONLY, FONT),
  form: onePage(
    flate(ENC.encode(HELLO + '/X0 Do\n')),
    '<< /Font << /F1 5 0 R >> /XObject << /X0 6 0 R >> >>',
    FONT,
    flate(
      joined(HELLO, BIG),
      '/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> ',
    ),
  ),
  cmap: onePage(
    flate(ENC.encode(HELLO)),
    FONT_ONLY,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>',
    flate(BIG),
  ),
  'descendant font file': onePage(
    flate(ENC.encode(HELLO)),
    FONT_ONLY,
    '<< /Type /Font /Subtype /Type0 /BaseFont /Foo /Encoding /Identity-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Foo /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 7 0 R >>',
    '<< /Type /FontDescriptor /FontName /Foo /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 8 0 R >>',
    flate(BIG),
  ),
  'descendant glyph map': onePage(
    flate(ENC.encode(HELLO)),
    FONT_ONLY,
    '<< /Type /Font /Subtype /Type0 /BaseFont /Foo /Encoding /Identity-H /DescendantFonts [6 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Foo /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /CIDToGIDMap 7 0 R >>',
    flate(BIG),
  ),
  'content behind a broken zlib header': onePage(
    stream(
      joined(new Uint8Array([0x78, 0x00]), deflateRawSync(joined(HELLO, BIG))),
      '/Filter /FlateDecode ',
    ),
    FONT_ONLY,
    FONT,
  ),
  'font file': onePage(
    flate(ENC.encode(HELLO)),
    FONT_ONLY,
    '<< /Type /Font /Subtype /TrueType /BaseFont /Foo /FirstChar 32 /LastChar 126 /FontDescriptor 6 0 R >>',
    '<< /Type /FontDescriptor /FontName /Foo /Flags 32 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 7 0 R >>',
    flate(BIG),
  ),
}

async function capped(document: Uint8Array, line: string): Promise<[number, string, string]> {
  const ws = new Workspace({ '/w': new RAMVFS() }, { mode: MountMode.WRITE, maxMemory: '16MB' })
  try {
    ws.registerCli('pdftotext', PDFTOTEXT)
    ws.registerCli('pdfinfo', PDFINFO)
    await ws.shell('tee /w/d.pdf > /dev/null', { stdin: document })
    const result = await ws.shell(line)
    return [result.exitCode, DEC.decode(result.stdout), DEC.decode(result.stderr)]
  } finally {
    await ws.close()
  }
}

describe('under max_memory', () => {
  it.each(Object.entries(BOMBS).sort(([a], [b]) => a.localeCompare(b)))(
    'refuses a %s stream that inflates past it',
    async (_, bomb) => {
      expect(await capped(bomb, 'pdftotext /w/d.pdf -')).toEqual([
        1,
        '',
        'pdftotext: memory exhausted\n',
      ])
    },
  )

  it.each(Object.entries(FILTERED).sort(([a], [b]) => a.localeCompare(b)))(
    'refuses a character map past it through %s',
    async (_, filtered) => {
      const page = onePage(
        flate(ENC.encode(HELLO)),
        FONT_ONLY,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /ToUnicode 6 0 R >>',
        filtered,
      )
      expect(await capped(page, 'pdftotext /w/d.pdf -')).toEqual([
        1,
        '',
        'pdftotext: memory exhausted\n',
      ])
    },
  )

  it('counts each form a form behind a predictor names', async () => {
    const draws = ENC.encode('/X1 Do\n')
    const sub = new Uint8Array([1, ...draws.map((b, i) => (b - (draws[i - 1] ?? 0)) & 0xff)])
    const page = onePage(
      flate(ENC.encode(HELLO + '/X0 Do\n')),
      '<< /Font << /F1 5 0 R >> /XObject << /X0 6 0 R >> >>',
      FONT,
      flate(
        sub,
        `/DecodeParms << /Predictor 12 /Columns ${String(draws.length)} >> ` +
          '/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << /XObject << /X1 7 0 R >> >> ',
      ),
      flate(BIG, '/Type /XObject /Subtype /Form /BBox [0 0 612 792] '),
    )
    expect(await capped(page, 'pdftotext /w/d.pdf -')).toEqual([
      1,
      '',
      'pdftotext: memory exhausted\n',
    ])
  })

  it('refuses forms that fit one at a time together', async () => {
    const form = flate(
      joined(HELLO, ' '.repeat(10 << 20)),
      '/Type /XObject /Subtype /Form /BBox [0 0 612 792] ',
    )
    const page = onePage(
      flate(ENC.encode(HELLO + '/X0 Do /X1 Do\n')),
      '<< /Font << /F1 5 0 R >> /XObject << /X0 6 0 R /X1 7 0 R >> >>',
      FONT,
      form,
      form,
    )
    expect(await capped(page, 'pdftotext /w/d.pdf -')).toEqual([
      1,
      '',
      'pdftotext: memory exhausted\n',
    ])
  })

  it('checks forms held on earlier pages again when a page draws them together', async () => {
    const form = flate(
      joined(HELLO, ' '.repeat(9 << 20)),
      '/Type /XObject /Subtype /Form /BBox [0 0 612 792] /Resources << >> ',
    )
    const shared = '<< /Font << /F1 9 0 R >> /XObject << /X0 10 0 R /X1 11 0 R >> >>'
    const document = pages(
      [
        [flate(ENC.encode(HELLO + '/X0 Do\n')), shared],
        [flate(ENC.encode(HELLO + '/X1 Do\n')), shared],
        [flate(ENC.encode(HELLO + '/X0 Do /X1 Do\n')), shared],
      ],
      FONT,
      form,
      form,
    )
    const [code, , err] = await capped(document, 'pdftotext /w/d.pdf -')
    expect([code, err]).toEqual([1, 'pdftotext: memory exhausted\n'])
  })

  it("reads each page's resources for a form without its own", async () => {
    const page = flate(ENC.encode(HELLO + '/X0 Do\n'))
    const document = pages(
      [
        [page, '<< /Font << /F1 7 0 R >> /XObject << /X0 8 0 R >> >>'],
        [page, '<< /Font << /F1 7 0 R >> /XObject << /X0 8 0 R /Nested 9 0 R >> >>'],
      ],
      FONT,
      flate(ENC.encode('/Nested Do\n'), '/Type /XObject /Subtype /Form /BBox [0 0 612 792] '),
      flate(BIG, '/Type /XObject /Subtype /Form /BBox [0 0 612 792] '),
    )
    const [code, , err] = await capped(document, 'pdftotext /w/d.pdf -')
    expect([code, err]).toEqual([1, 'pdftotext: memory exhausted\n'])
  })

  it('walks fonts whose resources name each other once', async () => {
    const type3 =
      '<< /Type /Font /Subtype /Type3 /FontBBox [0 0 1000 1000] /FontMatrix [0.001 0 0 0.001 0 0] ' +
      '/CharProcs << >> /Encoding << /Type /Encoding /Differences [] >> /FirstChar 32 /LastChar 32 ' +
      '/Widths [0] /Resources 10 0 R >>'
    const page = onePage(
      flate(ENC.encode(HELLO)),
      '<< /Font << /F1 5 0 R /T1 6 0 R >> >>',
      FONT,
      type3,
      type3,
      type3,
      type3,
      '<< /Font << /T1 6 0 R /T2 7 0 R /T3 8 0 R /T4 9 0 R >> >>',
    )
    const [code, out] = await capped(page, 'pdftotext /w/d.pdf -')
    expect([code, out.includes('hello')]).toEqual([0, true])
  })

  it('holds no form the page never draws', async () => {
    const page = onePage(
      flate(ENC.encode(HELLO)),
      '<< /Font << /F1 5 0 R >> /XObject << /X0 6 0 R >> >>',
      FONT,
      flate(joined(HELLO, BIG), '/Type /XObject /Subtype /Form /BBox [0 0 612 792] '),
    )
    expect(await capped(page, 'pdftotext /w/d.pdf -')).toEqual([0, 'hello\n\n\f', ''])
  })

  it('drops content past a hundred times its bytes without holding it', async () => {
    const page = onePage(flate(joined(HELLO, BIG)), FONT_ONLY, FONT)
    expect(await capped(page, 'pdftotext /w/d.pdf -')).toEqual([0, '\f', ''])
  })

  it('reads a compressed page that fits whole', async () => {
    const page = onePage(flate(ENC.encode(HELLO)), FONT_ONLY, FONT)
    expect(await capped(page, 'pdftotext /w/d.pdf -')).toEqual([0, 'hello\n\n\f', ''])
  })

  it.each([
    ['pdfinfo -', 'pdfinfo'],
    ['pdftotext - /w/out.txt', 'pdftotext'],
  ])('refuses an input past it as %s reads it', async (line, command) => {
    expect(await capped(new Uint8Array(), `head -c 20000000 /dev/zero | ${line}`)).toEqual([
      1,
      '',
      `${command}: memory exhausted\n`,
    ])
  })
})
