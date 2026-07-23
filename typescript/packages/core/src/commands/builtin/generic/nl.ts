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

import { AsyncLineIterator } from '../../../io/async_line_iterator.ts'
import { IOResult } from '../../../io/types.ts'
import type { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { resolveSource } from '../utils/stream.ts'
import { operandsIo, readOperands, singleChunk } from '../utils/operands.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

function shouldNumber(line: string, numbering: string, pattern: RegExp | null): boolean {
  if (numbering === 'n') return false
  if (numbering === 'a') return true
  if (numbering === 'p' && pattern !== null) return pattern.test(line)
  return line.trim() !== ''
}

function formatNumber(value: number, width: number, format: string): string {
  const raw = String(value)
  if (format === 'ln') return raw.padEnd(width, ' ')
  if (format === 'rz') return raw.padStart(width, '0')
  return raw.padStart(width, ' ')
}

// GNU pads a one-character -d with ':' as its second character, and an empty
// -d disables delimiter matching entirely.
function sectionDelimiters(delimiter: string): Record<string, string> {
  if (delimiter === '') return {}
  const pair = delimiter.length > 1 ? delimiter : `${delimiter}:`
  return { [pair.repeat(3)]: 'header', [pair.repeat(2)]: 'body', [pair]: 'footer' }
}

interface NlConfig {
  numbering: Record<string, string>
  patterns: Record<string, RegExp | null>
  start: number
  increment: number
  width: number
  separator: string
  numberFormat: string
  delimiters: Record<string, string>
  joinBlankLines: number
  noRenumber: boolean
}

interface NlState {
  number: number
  section: string
  blankRun: number
}

function renderLine(line: string, config: NlConfig, state: NlState): Uint8Array {
  const section = config.delimiters[line]
  if (section !== undefined) {
    state.section = section
    state.blankRun = 0
    if (!config.noRenumber) state.number = config.start
    // GNU writes an empty line in place of the delimiter itself.
    return ENC.encode('\n')
  }
  const numbering = config.numbering[state.section] ?? 'n'
  const pattern = config.patterns[state.section] ?? null
  let numberLine = shouldNumber(line, numbering, pattern)
  if (numbering === 'a' && line === '') {
    state.blankRun += 1
    numberLine = state.blankRun >= config.joinBlankLines
    if (numberLine) state.blankRun = 0
  } else {
    state.blankRun = 0
  }
  if (numberLine) {
    const prefix = formatNumber(state.number, config.width, config.numberFormat)
    state.number += config.increment
    return ENC.encode(`${prefix}${config.separator}${line}\n`)
  }
  return ENC.encode(`${' '.repeat(config.width)}${config.separator}${line}\n`)
}

async function* nlStream(
  source: AsyncIterable<Uint8Array>,
  config: NlConfig,
  state: NlState,
): AsyncIterable<Uint8Array> {
  const iter = new AsyncLineIterator(source)
  for await (const raw of iter) {
    const line = DEC.decode(raw)
    yield renderLine(line, config, state)
  }
}

async function* nlMulti(
  buffers: readonly Uint8Array[],
  config: NlConfig,
): AsyncIterable<Uint8Array> {
  const state: NlState = { number: config.start, section: 'body', blankRun: 0 }
  for (const data of buffers) {
    for await (const rendered of nlStream(singleChunk(data), config, state)) yield rendered
  }
}

function parseNumbering(raw: string): [string, RegExp | null] {
  if (raw.startsWith('p')) return ['p', new RegExp(raw.slice(1))]
  return [raw, null]
}

function parseOptions(flags: Record<string, string | boolean | string[]>): NlConfig {
  const bodyValue = flags.b ?? flags.body_numbering
  const footerValue = flags.f ?? flags.footer_numbering
  const headerValue = flags.h ?? flags.header_numbering
  const [bodyNumbering, bodyPattern] = parseNumbering(
    typeof bodyValue === 'string' ? bodyValue : 't',
  )
  const [footerNumbering, footerPattern] = parseNumbering(
    typeof footerValue === 'string' ? footerValue : 'n',
  )
  const [headerNumbering, headerPattern] = parseNumbering(
    typeof headerValue === 'string' ? headerValue : 'n',
  )
  const startValue = flags.v ?? flags.starting_line_number
  const incrementValue = flags.i ?? flags.line_increment
  const widthValue = flags.w ?? flags.number_width
  const separatorValue = flags.s ?? flags.number_separator
  const formatValue = flags.n ?? flags.number_format
  const delimiterValue = flags.d ?? flags.section_delimiter
  const blankValue = flags.l ?? flags.join_blank_lines
  return {
    numbering: { body: bodyNumbering, footer: footerNumbering, header: headerNumbering },
    patterns: { body: bodyPattern, footer: footerPattern, header: headerPattern },
    start: typeof startValue === 'string' ? Number.parseInt(startValue, 10) : 1,
    increment: typeof incrementValue === 'string' ? Number.parseInt(incrementValue, 10) : 1,
    width: typeof widthValue === 'string' ? Number.parseInt(widthValue, 10) : 6,
    separator: typeof separatorValue === 'string' ? separatorValue : '\t',
    numberFormat: typeof formatValue === 'string' ? formatValue : 'rn',
    delimiters: sectionDelimiters(typeof delimiterValue === 'string' ? delimiterValue : '\\:'),
    joinBlankLines: typeof blankValue === 'string' ? Number.parseInt(blankValue, 10) : 1,
    noRenumber: flags.p === true || flags.no_renumber === true,
  }
}

export async function nlGeneric(
  paths: PathSpec[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
): Promise<CommandFnResult> {
  const config = parseOptions(opts.flags)
  if (paths.length > 0) {
    // Operands read eagerly so a missing one is reported up front and the
    // remaining operands still number (GNU); the IOResult is sealed before
    // the output stream is handed back.
    const [ok, err] = await readOperands(paths, stream, 'nl')
    const io = operandsIo(err)
    if (ok.length === 0 && err !== '') return [null, io]
    return [
      nlMulti(
        ok.map((o) => o.data),
        config,
      ),
      io,
    ]
  }
  try {
    const source = resolveSource(opts.stdin, 'nl: missing operand')
    return [
      nlStream(source, config, { number: config.start, section: 'body', blankRun: 0 }),
      new IOResult(),
    ]
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
  }
}
