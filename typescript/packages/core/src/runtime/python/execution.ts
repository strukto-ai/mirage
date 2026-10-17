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

import type { PathSpec } from '../../types.ts'
import type { Program } from '../types.ts'
import { rstripSlash } from '../../utils/slash.ts'

// argv[0] for the two entry points that do not read it off the command line.
export const PAYLOAD_ARGV0 = '-c'
export const STDIN_ARGV0 = '-'
const STDIN_FILENAME = '<stdin>'

/**
 * The file CPython runs a program from, named the way it names it.
 *
 * A script and a program piped to stdin both come through CPython's file
 * entry point, which binds `__file__` to the file's name and compiles every frame
 * under it: the script operand made absolute against the working
 * directory as typed, never normalized (`./s.py` under /w is `/w/./s.py`),
 * or `<stdin>` for either stdin spelling. A payload, a module and a script
 * CLI come through no file. Pinned on CPython 3.13.5; mirrors Python's
 * main_filename.
 *
 * @param program the run, whose `scriptPath` and `prog` say which entry
 *   point the source came through.
 * @param cwd the working directory a relative script is made absolute
 *   against.
 */
export function mainFilename(program: Program, cwd: PathSpec | null): string | null {
  const script = program.scriptPath
  if (script === undefined) {
    return program.prog === '' || program.prog === STDIN_ARGV0 ? STDIN_FILENAME : null
  }
  const typed = script.rawPath !== '' ? script.rawPath : script.virtual
  if (typed.startsWith('/')) return typed
  if (cwd === null) return script.virtual
  return `${rstripSlash(cwd.virtual)}/${typed}`
}

/**
 * Wrap a program so a `-c` subprocess runs it the way CPython would.
 *
 * CPython hardcodes argv[0] to "-c" for a `-c` program, names every frame
 * "<string>" and binds no `__file__`, which is right for a payload and
 * wrong for the other entry points, so the program is re-compiled under its own
 * name with what CPython's file adapter binds. It also binds the script-CLI
 * contract before compiling the unmodified program. Mirrors Python's
 * prepare_source.
 *
 * @param program the run. A `prog` of none or "-c" with no script file
 *   means a payload, which CPython already reports correctly and which
 *   passes through untouched.
 * @param cwd the working directory the script is named against.
 */
export function prepareSource(program: Program, cwd: PathSpec | null): string {
  const filename = mainFilename(program, cwd)
  if (
    program.scriptCli !== true &&
    filename === null &&
    (program.prog ?? PAYLOAD_ARGV0) === PAYLOAD_ARGV0
  ) {
    return program.code
  }
  // JSON string literals are also Python string literals; encode twice so
  // Python's JSON decoder, not its source parser, handles source escapes.
  const source = `__import__('json').loads(${JSON.stringify(JSON.stringify(program.code))})`
  const prog = JSON.stringify(program.prog ?? PAYLOAD_ARGV0)
  const name = JSON.stringify(
    filename ?? (program.prog !== undefined && program.prog !== '' ? program.prog : '<string>'),
  )
  const lines = [`__import__('sys').argv[0] = ${prog}`]
  if (filename !== null) lines.push(`__file__ = ${JSON.stringify(filename)}`, '__cached__ = None')
  if (program.scriptCli === true) {
    const stdin = program.stdin === null ? 'None' : "__import__('sys').stdin.buffer.read()"
    lines.push(
      "argv = list(__import__('sys').argv)",
      `stdin = ${stdin}`,
      "__import__('sys').stdin = __import__('io').TextIOWrapper(" +
        "__import__('io').BytesIO(stdin or b''), encoding=__import__('sys').stdin.encoding, " +
        "errors=__import__('sys').stdin.errors)",
    )
  }
  lines.push(`exec(compile(${source}, ${name}, 'exec'), globals())`)
  return lines.join('\n')
}
