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

import type { RunArgs } from '../types.ts'
import { rstripSlash } from '../../utils/slash.ts'

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
 */
export function mainFilename(args: RunArgs): string | null {
  const script = args.scriptPath
  if (script === undefined) {
    return args.prog === '' || args.prog === '-' ? STDIN_FILENAME : null
  }
  const typed = script.rawPath !== '' ? script.rawPath : script.virtual
  if (typed.startsWith('/')) return typed
  if (args.cwd === undefined) return script.virtual
  return `${rstripSlash(args.cwd.virtual)}/${typed}`
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
 */
export function prepareSource(args: RunArgs): string {
  const filename = mainFilename(args)
  if (args.scriptCli !== true && filename === null && (args.prog ?? '-c') === '-c') {
    return args.code
  }
  // JSON string literals are also Python string literals; encode twice so
  // Python's JSON decoder, not its source parser, handles source escapes.
  const source = `__import__('json').loads(${JSON.stringify(JSON.stringify(args.code))})`
  const prog = JSON.stringify(args.prog ?? '-c')
  const name = JSON.stringify(
    filename ?? (args.prog !== undefined && args.prog !== '' ? args.prog : '<string>'),
  )
  const lines = [`__import__('sys').argv[0] = ${prog}`]
  if (filename !== null) lines.push(`__file__ = ${JSON.stringify(filename)}`, '__cached__ = None')
  if (args.scriptCli === true) {
    const stdin = args.stdin === null ? 'None' : "__import__('sys').stdin.buffer.read()"
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
