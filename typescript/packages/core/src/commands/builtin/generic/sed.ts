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

import { stdinStream } from '../utils/stream.ts'
import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { mountKey, mountPrefixOf } from '../../../utils/key_prefix.ts'
import { fsErrorLine, isFsError } from '../../../utils/errors.ts'
import { readFailExitCode } from '../../spec/usage.ts'
import { IOResult, materialize, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { SED_MISSING_SCRIPT, SED_NO_INPUT_EXIT, SED_NO_INPUT_FILES } from '../constants.ts'
import { executeProgram, parseOneCommand, parseProgram, type SedCommand } from '../sed_script.ts'
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
  const fl = new FlagView(opts.flags, specOf('sed'))
  if (!fl.asBool('i')) stream = stdinStream(stream, opts.stdin)
  // The script comes from -e expressions and -f script files (joined with
  // newlines, -e then -f as grep does) when any were given, otherwise from the
  // first positional operand.
  const eList = fl.asList('e')
  const fList = fl.asList('f')
  const scriptParts = [...eList]
  const firstPath = paths[0]
  const scriptPrefix =
    (firstPath === undefined ? undefined : mountPrefixOf(firstPath.virtual, firstPath.vfsPath)) ??
    opts.mountPrefix ??
    ''
  for (const filePath of fList) {
    const spec = PathSpec.fromStrPath(filePath, mountKey(filePath, scriptPrefix))
    let text = DEC.decode(await materialize(stream(spec)))
    if (text.endsWith('\n')) text = text.slice(0, -1)
    scriptParts.push(text)
  }
  const flagScript = eList.length > 0 || fList.length > 0
  if (!flagScript && texts[0] !== undefined) scriptParts.push(texts[0])
  const script = scriptParts.length > 0 ? scriptParts.join('\n') : undefined
  if (script === undefined) {
    return [null, new IOResult({ exitCode: 1, stderr: ENC.encode(`${SED_MISSING_SCRIPT}\n`) })]
  }
  const suppress = fl.asBool('n')
  const inPlace = fl.asBool('i')
  // -E / -r select Extended Regular Expressions; without them sed is BRE.
  const extended = fl.asBool('E') || fl.asBool('r')
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
    // A failed operand is skipped and reported, and the remaining operands
    // still process, per GNU sed (which keeps going on a missing file; the
    // repo exits 1 where GNU exits 2).
    let err = ''
    // sed owns its exit code rather than letting the executor's
    // chokepoint pick it, because GNU sed splits a failed operand two
    // ways (GNU sed 4.9). An OPEN error (a missing file) is exit 2,
    // reported, and the remaining operands still process: `sed -n p nope
    // ok.txt ok2.txt` prints both files. A READ error (a directory,
    // which opens fine and then fails) is exit 4 and FATAL: `sed -n p
    // dir ok.txt` prints nothing, `sed -n p ok.txt dir ok2.txt` stops
    // after ok.txt, and `sed -n p dir dir` reports one line, not two.
    // Hence the running max for the code and the break for the read
    // error; every other command in this family continues past a
    // directory, and only sed does not.
    let code = 0
    if (isSimpleSub) {
      // Run the substitution through the per-line engine rather than a single
      // whole-buffer `text.replace`: `^`/`$` must anchor per line and a
      // non-global `s///` substitutes the first match on *each* line, matching
      // GNU sed. A buffer-wide replace anchors at the buffer ends and only
      // touches the first match overall. See issue #326.
      if (inPlace) {
        const writes: Record<string, Uint8Array> = {}
        const edited: string[] = []
        for (const p of paths) {
          let data: Uint8Array
          try {
            data = await materialize(stream(p))
          } catch (e) {
            if (!isFsError(e)) throw e
            err += fsErrorLine('sed', p, e)
            code = Math.max(code, readFailExitCode('sed', e))
            if ((e as { code?: string }).code === 'EISDIR') break
            continue
          }
          const text = DEC.decode(data)
          const newText = executeProgram(text, commands, false, extended)
          const newData = ENC.encode(newText)
          await write(p, newData)
          writes[p.mountPath] = newData
          edited.push(p.mountPath)
        }
        return [
          null,
          new IOResult({
            writes,
            cache: edited,
            exitCode: code,
            stderr: err === '' ? null : ENC.encode(err),
          }),
        ]
      }
      const outputs: string[] = []
      const readOk: string[] = []
      for (const p of paths) {
        let data: Uint8Array
        try {
          data = await materialize(stream(p))
        } catch (e) {
          if (!isFsError(e)) throw e
          err += fsErrorLine('sed', p, e)
          code = Math.max(code, readFailExitCode('sed', e))
          if ((e as { code?: string }).code === 'EISDIR') break
          continue
        }
        const text = DEC.decode(data)
        outputs.push(executeProgram(text, commands, false, extended))
        readOk.push(p.mountPath)
      }
      const out: ByteSource = ENC.encode(outputs.join(''))
      return [
        out,
        new IOResult({
          cache: readOk,
          exitCode: code,
          stderr: err === '' ? null : ENC.encode(err),
        }),
      ]
    }

    // GNU -i redirects the whole output stream to the file whatever the
    // script ran: `p` doubles lines in place, `q` truncates, `a`/`i`/`c`
    // land their text. Gating on the command set left every non-s/d script
    // printing to stdout while reporting success.
    const modifying = inPlace
    const allOutputs: string[] = []
    const writes: Record<string, Uint8Array> = {}
    const edited: string[] = []
    for (const p of paths) {
      let data: Uint8Array
      try {
        data = await materialize(stream(p))
      } catch (e) {
        if (!isFsError(e)) throw e
        err += fsErrorLine('sed', p, e)
        code = Math.max(code, readFailExitCode('sed', e))
        if ((e as { code?: string }).code === 'EISDIR') break
        continue
      }
      const text = DEC.decode(data)
      const result = executeProgram(text, commands, suppress, extended)
      if (modifying) {
        const newData = ENC.encode(result)
        await write(p, newData)
        writes[p.mountPath] = newData
        edited.push(p.mountPath)
      } else {
        allOutputs.push(result)
      }
    }
    const io = new IOResult({
      exitCode: code,
      stderr: err === '' ? null : ENC.encode(err),
    })
    if (modifying) {
      io.writes = writes
      io.cache = edited
      return [null, io]
    }
    // GNU concatenates per-file output with no separator (each file's
    // output already carries its own newlines).
    const out: ByteSource = ENC.encode(allOutputs.join(''))
    return [out, io]
  }

  const raw = await readStdinAsync(opts.stdin)
  if (raw === null) {
    return [
      null,
      new IOResult({
        exitCode: SED_NO_INPUT_EXIT,
        stderr: ENC.encode(`${SED_NO_INPUT_FILES}\n`),
      }),
    ]
  }
  const text = DEC.decode(raw)
  const result = executeProgram(text, commands, suppress, extended)
  return [ENC.encode(result), new IOResult()]
}
