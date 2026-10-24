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

import { type util } from 'zod'

import type { CommandFn } from '../../../config.ts'
import { quoteText } from '../../../quote.ts'
import { specOf } from '../../../spec/builtins.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { IOResult } from '../../../../io/types.ts'
import { byteView, utf8Locale } from '../../../../shell/bytes.ts'
import { StreamHost, hostedStream, ownMount } from '../../utils/stream_host.ts'
import { EOVERFLOW_REASON, INT_MAX, signedDecimal } from '../../utils/strtol.ts'
import type { GenericCommand } from '../adapter.ts'
import { commandFiles, resolveOrEmpty } from '../files.ts'

/**
 * csplit's refusal of a -n value, which GNU 9.7 takes as a decimal from 0 to
 * INT_MAX: out of that range is too large. Mirrors Python's
 * `digits_refusal`.
 */
export function digitsRefusal(text: string, value: bigint | null): string {
  const reason = value === null ? '' : `: ${EOVERFLOW_REASON}`
  return `csplit: invalid number: '${quoteText(text)}'${reason}`
}

const csplit: CommandFn = async (_accessor, paths, texts, ctx) => {
  const files = commandFiles(ctx, paths)
  // getopt reads -n before any operand is looked at.
  const fl = new FlagView(ctx.flags, specOf('csplit'))
  const digits = fl.asNumber('digits', signedDecimal, digitsRefusal, { low: 0n, high: INT_MAX })
  const resolved = await resolveOrEmpty(files, paths)
  const suffixFormat = fl.asStr('suffix_format')
  const config: Record<string, util.JSONType> = {
    prefix: byteView(fl.asPath('prefix')?.rawPath ?? 'xx'),
    digits: digits === undefined ? 2 : Number(digits),
    keep: fl.asBool('keep_files'),
    silent: fl.asBool('quiet') || fl.asBool('silent'),
    suppress: fl.asBool('suppress_matched'),
    elide: fl.asBool('elide_empty_files'),
    utf8: utf8Locale(ctx.env),
    operands: [...resolved.map((path) => path.rawPath), ...texts].map((word) => byteView(word)),
  }
  if (typeof suffixFormat === 'string') config.suffix_format = byteView(suffixFormat)
  // The pieces go to the prefix, or `xx` in the working directory, which
  // need not be this mount, so the dispatcher routes each write, and the
  // removal of a failed run's pieces. Mirrors the Python builder.
  const host = new StreamHost(resolved, files.read, ctx, ownMount, true, 'csplit')
  const io = new IOResult()
  return [hostedStream('csplit', config, host, io, ctx.signal), io]
}

export const BUILDER: GenericCommand = {
  name: 'csplit',
  write: true,
  fn: csplit,
}
