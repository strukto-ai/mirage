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

import { runCodec } from './codec.ts'
import { type JqError, type JqHalt, type JqOptions, type JqRun } from './types.ts'
import { fsStrerror, isEisdir } from '../../errors/fs.ts'
import { YieldBudget } from '../../io/yield_budget.ts'
import { StreamRefusal } from '../../rs/errors.ts'
import type { JsonValue } from '../../types.ts'
import { concat } from '../../utils/bytes.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { ignoreBOM: true })

function config(
  opts: JqOptions,
  separator: boolean,
  checkOnly: boolean,
): Readonly<Record<string, JsonValue>> {
  return {
    raw_output: opts.rawOutput,
    join_output: opts.joinOutput,
    nul_output: opts.nulOutput,
    compact: opts.compact,
    ascii_output: opts.asciiOutput,
    sort_keys: opts.sortKeys,
    tab: opts.tab,
    indent: opts.indent,
    seq: opts.seq,
    separator,
    check_only: checkOnly,
  }
}

/** Lay out a compact evaluator dump without converting numeric literals. */
export async function dumpText(text: string, opts: JqOptions): Promise<string> {
  const plain = { ...opts, rawOutput: false, seq: false }
  const parts: Uint8Array[] = []
  for await (const part of runCodec('jq_format', config(plain, false, false), ENC.encode(text)))
    parts.push(part)
  return DEC.decode(concat(parts))
}

/** Render one evaluator dump with its separator in bounded Rust steps. */
export async function formatOne(
  text: string,
  opts: JqOptions,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  for await (const part of runCodec(
    'jq_format',
    config(opts, true, false),
    ENC.encode(text),
    signal,
  ))
    parts.push(part)
  return concat(parts)
}

/** Apply the shared formatter's raw-NUL refusal before printing a run. */
export async function printable(
  run: JqRun<string>,
  opts: JqOptions,
  signal?: AbortSignal,
): Promise<JqRun<string>> {
  if (!opts.nulOutput || opts.asciiOutput) return run
  const budget = new YieldBudget(signal)
  for (const [at, text] of run.outputs.entries()) {
    const pending = budget.run()
    if (pending !== undefined) await pending
    try {
      for await (const _ of runCodec(
        'jq_format',
        config(opts, false, true),
        ENC.encode(text),
        signal,
      )) {
        void _
      }
    } catch (error) {
      if (!(error instanceof StreamRefusal)) throw error
      return {
        outputs: run.outputs.slice(0, at),
        stop: { kind: 'error', text: error.message, string: true },
      }
    }
  }
  return run
}

/**
 * jq's report of an error no `try` caught, which it writes to stderr. A
 * string message is printed the way C prints a string, so it ends at a
 * NUL.
 */
export function errorReport(position: string, error: JqError): string {
  if (error.string) {
    const text = error.text.split('\0', 1)[0] ?? ''
    return `jq: error (at ${position}): ${text}\n`
  }
  return `jq: error (at ${position}) (not a string): ${error.text}\n`
}

/**
 * Why jq could not load a whole file (jv_load_file): an -f program, a
 * --rawfile or a --slurpfile, named as typed. It opens the file itself, so a
 * directory gets words of its own instead of a failed read.
 */
export function loadFailure(name: string, err: unknown): string {
  if (isEisdir(err)) return `Could not open ${name}: It's a directory`
  return `Could not open ${name}: ${fsStrerror(err) ?? ''}`
}

/**
 * What jq writes to stderr for a halt: a string as it is, anything else
 * dumped on a line of its own, and nothing for `halt` or a null.
 */
export function haltReport(halt: JqHalt): string {
  if (halt.message === null) return ''
  return halt.string ? halt.message : `${halt.message}\n`
}
