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

import type { util } from 'zod'
import { IOResult } from '../../../../io/types.ts'
import { StreamModule, type OpenStream } from '../../../../rs/stream.ts'
import { byteView } from '../../../../shell/bytes.ts'
import type { PathSpec } from '../../../../types.ts'
import { commandFiles } from '../../../builtin/generic_bind/files.ts'
import { StreamHost, hostedStream } from '../../../builtin/utils/stream_host.ts'
import type { CommandFnResult, Context } from '../../../config.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import { CommandSpec } from '../../../spec/types.ts'
import { nodeHelp } from '../../walk.ts'

/** The exit status of a refused command line. */
export const USAGE = 99

/** A page number as the reader takes one: a sign, then digits. */
export const PAGE = /^[+-]?[0-9]*$/

const ENCODER = new TextEncoder()

/** A page number that is no number. */
export class Refused extends Error {}

/** A page option's value, or undefined when not given; throws Refused for one that is no number. */
export function pageNumber(text: string | undefined): number | undefined {
  if (text === undefined) return undefined
  if (!PAGE.test(text)) throw new Refused(text)
  const digits = text.replace(/^[+-]/, '')
  const value = digits === '' ? 0 : Number.parseInt(digits, 10)
  return text.startsWith('-') ? -value : value
}

/** The help page on standard error, the way the reader answers a request for it and a command line it refuses. */
export function usage(spec: CommandSpec, status: number): CommandFnResult {
  const text = nodeHelp(spec.name, spec)
  return [null, new IOResult({ exitCode: status, stderr: ENCODER.encode(text) })]
}

/** The passwords an encrypted file opens with, as typed. */
export function passwords(flags: FlagView): Record<string, util.JSONType> {
  const owner = flags.asStr('opw')
  const user = flags.asStr('upw')
  return {
    owner_password: owner === undefined ? null : byteView(owner),
    user_password: user === undefined ? null : byteView(user),
  }
}

/** The host a PDF stream reads its document and writes its text through; `-` is standard input. */
export function streamHost(ctx: Context, document: PathSpec): StreamHost {
  const operands = document.rawPath === '-' ? [] : [document]
  const files = commandFiles(ctx, operands)
  return new StreamHost(operands, files.read, ctx)
}

let pdfModule: StreamModule | undefined

/**
 * Open a stream on the PDF Wasm module, loaded on first use: Python's native
 * module has it built in. A run holds its document whole, so each starts on
 * a fresh instance rather than on one an earlier run grew.
 */
export async function openPdfStream(
  kind: string,
  config: Readonly<Record<string, util.JSONType>>,
): Promise<OpenStream> {
  if (pdfModule === undefined) {
    const { default: source } = await import('#mirage-pdf-wasm')
    pdfModule = new StreamModule(source, 0)
  }
  return pdfModule.open(kind, config)
}

/** Write a PDF file's text, as mirage-rs lays it out, to a text file or standard output. */
export function runPdftotext(
  _accessor: unknown,
  paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const spec = ctx.spec ?? new CommandSpec({ name: 'pdftotext' })
  const flags = new FlagView(ctx.flags, spec)
  if (flags.asBool('help')) return Promise.resolve(usage(spec, 0))
  let first: number | undefined
  let last: number | undefined
  try {
    first = pageNumber(flags.asStr('f'))
    last = pageNumber(flags.asStr('args_l'))
  } catch (err) {
    if (err instanceof Refused) return Promise.resolve(usage(spec, USAGE))
    throw err
  }
  const [document, output] = paths
  if (document === undefined || paths.length > 2) return Promise.resolve(usage(spec, USAGE))
  const config: Record<string, util.JSONType> = {
    file: byteView(document.rawPath),
    output: output === undefined ? null : byteView(output.rawPath),
    first: first ?? null,
    last: last ?? null,
    layout: flags.asBool('layout'),
    raw: flags.asBool('raw'),
    nopgbrk: flags.asBool('nopgbrk'),
    nodiag: flags.asBool('nodiag'),
    enc: flags.asStr('enc') ?? null,
    eol: flags.asStr('eol') ?? null,
    quiet: flags.asBool('q'),
    ...passwords(flags),
  }
  const io = new IOResult()
  const host = streamHost(ctx, document)
  return Promise.resolve([
    hostedStream('pdftotext', config, host, io, ctx.signal, openPdfStream),
    io,
  ])
}

/** Print a PDF file's document information, as mirage-rs reads it. */
export function runPdfinfo(
  _accessor: unknown,
  paths: PathSpec[],
  _texts: string[],
  ctx: Context,
): Promise<CommandFnResult> {
  const spec = ctx.spec ?? new CommandSpec({ name: 'pdfinfo' })
  const flags = new FlagView(ctx.flags, spec)
  if (flags.asBool('help')) return Promise.resolve(usage(spec, 0))
  let first: number | undefined
  let last: number | undefined
  try {
    first = pageNumber(flags.asStr('f'))
    last = pageNumber(flags.asStr('args_l'))
  } catch (err) {
    if (err instanceof Refused) return Promise.resolve(usage(spec, USAGE))
    throw err
  }
  const [document] = paths
  if (document === undefined || paths.length !== 1) return Promise.resolve(usage(spec, USAGE))
  const config: Record<string, util.JSONType> = {
    file: byteView(document.rawPath),
    first: first ?? null,
    last: last ?? null,
    zone: ctx.env?.TZ ?? null,
    quiet: flags.asBool('q'),
    ...passwords(flags),
  }
  const io = new IOResult()
  const host = streamHost(ctx, document)
  return Promise.resolve([hostedStream('pdfinfo', config, host, io, ctx.signal, openPdfStream), io])
}
