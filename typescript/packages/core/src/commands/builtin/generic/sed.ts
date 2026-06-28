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

import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { executeProgram, parseOneCommand, parseProgram, type SedCommand } from '../sed_helper.ts'
import { readStdinAsync } from '../utils/stream.ts'

const ENC = new TextEncoder()
const DEC = new TextDecoder('utf-8', { fatal: false })

export async function sedGeneric(
  paths: PathSpec[],
  texts: string[],
  opts: CommandOpts,
  stream: (p: PathSpec) => AsyncIterable<Uint8Array>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
): Promise<CommandFnResult> {
  // The script comes from -e expressions and -f script files (joined with
  // newlines, -e then -f as grep does) when any were given, otherwise from the
  // first positional operand.
  const eVals = opts.flags.e
  const eList = Array.isArray(eVals) ? eVals : typeof eVals === 'string' ? [eVals] : []
  const fVals = opts.flags.f
  const fList = Array.isArray(fVals) ? fVals : typeof fVals === 'string' ? [fVals] : []
  const scriptParts = [...eList]
  for (const filePath of fList) {
    const spec = PathSpec.fromStrPath(filePath, paths[0]?.prefix ?? opts.mountPrefix ?? '')
    let text = DEC.decode(await materialize(stream(spec)))
    if (text.endsWith('\n')) text = text.slice(0, -1)
    scriptParts.push(text)
  }
  const flagScript = eList.length > 0 || fList.length > 0
  if (!flagScript && texts[0] !== undefined) scriptParts.push(texts[0])
  const script = scriptParts.length > 0 ? scriptParts.join('\n') : undefined
  if (script === undefined) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('sed: missing script\n') })]
  }
  const suppress = opts.flags.n === true
  const inPlace = opts.flags.i === true
  // -E / -r select Extended Regular Expressions; without them sed is BRE.
  const extended = opts.flags.E === true || opts.flags.r === true
  let commands: SedCommand[]
  try {
    if (script.includes(';') || script.includes('{') || script.includes('\n')) {
      commands = parseProgram(script)
    } else {
      commands = [parseOneCommand(script)[0]]
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${msg}\n`) })]
  }
  const first = commands[0]
  const isSimpleSub =
    commands.length === 1 &&
    first?.cmd === 's' &&
    (first.addrStart === null || first.addrStart === undefined) &&
    !suppress

  if (paths.length > 0) {
    if (isSimpleSub) {
      // Run the substitution through the per-line engine rather than a single
      // whole-buffer `text.replace`: `^`/`$` must anchor per line and a
      // non-global `s///` substitutes the first match on *each* line, matching
      // GNU sed. A buffer-wide replace anchors at the buffer ends and only
      // touches the first match overall. See issue #326.
      if (inPlace) {
        const writes: Record<string, Uint8Array> = {}
        for (const p of paths) {
          const data = await materialize(stream(p))
          const text = DEC.decode(data)
          const newText = executeProgram(text, commands, false, extended)
          const newData = ENC.encode(newText)
          await write(p, newData)
          writes[p.stripPrefix] = newData
        }
        return [null, new IOResult({ writes, cache: paths.map((p) => p.stripPrefix) })]
      }
      const outputs: string[] = []
      for (const p of paths) {
        const data = await materialize(stream(p))
        const text = DEC.decode(data)
        outputs.push(executeProgram(text, commands, false, extended))
      }
      const out: ByteSource = ENC.encode(outputs.join(''))
      return [out, new IOResult({ cache: paths.map((p) => p.stripPrefix) })]
    }

    const modifying = inPlace && commands.some((c) => c.cmd === 's' || c.cmd === 'd')
    const allOutputs: string[] = []
    const writes: Record<string, Uint8Array> = {}
    for (const p of paths) {
      const data = await materialize(stream(p))
      const text = DEC.decode(data)
      const result = executeProgram(text, commands, suppress, extended)
      if (modifying) {
        const newData = ENC.encode(result)
        await write(p, newData)
        writes[p.stripPrefix] = newData
      } else {
        allOutputs.push(result)
      }
    }
    if (modifying) {
      return [null, new IOResult({ writes, cache: paths.map((p) => p.stripPrefix) })]
    }
    const out: ByteSource = ENC.encode(allOutputs.join('\n'))
    return [out, new IOResult()]
  }

  const raw = await readStdinAsync(opts.stdin)
  if (raw === null) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode('sed: missing operand\n') })]
  }
  const text = DEC.decode(raw)
  const result = executeProgram(text, commands, suppress, extended)
  return [ENC.encode(result), new IOResult()]
}
