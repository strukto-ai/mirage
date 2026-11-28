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

// `-o` naming and saving adapted from tvly 1.0.2's src/ui/render/emit.ts (MIT;
// see licenses/third_party/tavily-cli.txt).

import type { Context } from '../../../config.ts'
import type { FlagView } from '../../../spec/flag_view.ts'
import { IOResult, type CommandOutput } from '../../../../io/types.ts'
import { isMissingPath } from '../../../../errors/fs.ts'
import { PathSpec } from '../../../../types.ts'
import { systemNow } from '../../../../utils/clock.ts'
import { SYSTEM_IDS } from '../../../../utils/ids.ts'
import { ensureDir } from '../../operand.ts'

const ENC = new TextEncoder()
const DEFAULT_OUTPUT_DIR = '.tavily'
const WORD = /[a-z0-9]+/g

/** The stdout and stderr one tvly verb writes, gathered in order. */
export class Streams {
  readonly stdout: string[] = []
  readonly stderr: string[] = []

  out(line = ''): void {
    this.stdout.push(`${line}\n`)
  }

  err(line = ''): void {
    this.stderr.push(`${line}\n`)
  }

  /** The gathered text as a command's answer. */
  result(exitCode = 0): CommandOutput {
    const stderr = this.stderr.join('')
    return [
      ENC.encode(this.stdout.join('')),
      new IOResult({ ...(stderr === '' ? {} : { stderr: ENC.encode(stderr) }), exitCode }),
    ]
  }
}

/** The label as lower-case words joined by dashes, at most 40 long. */
export function outputSlug(label: string): string {
  const slug = (label.toLowerCase().match(WORD) ?? [])
    .join('-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '')
  return slug || 'result'
}

/**
 * The file `-o` names: as given, or for a bare `-o` a fresh one under
 * `.tavily/`; undefined without `-o`.
 */
export function resolveOutput(
  fl: FlagView,
  ctx: Context,
  command: string,
  label: string,
): PathSpec | undefined {
  const value = fl.raw('output')
  if (value instanceof PathSpec) return value
  if (value !== true) return undefined
  const now = new Date(systemNow() * 1000)
  const time = [now.getHours(), now.getMinutes(), now.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join('')
  const random = [...(ctx.ids ?? SYSTEM_IDS).secureBytes(3)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
  const name = `${command}-${outputSlug(label)}-${time}-${random}.json`
  return PathSpec.fromStrPath(`${DEFAULT_OUTPUT_DIR}/${name}`, undefined, ctx.cwd)
}

/**
 * Print JSON text, or save it to `output`. A folder the save creates is made
 * whole, and one named `.tavily` gets a `.gitignore` of `*` so saved results
 * stay out of git.
 */
export async function emit(
  streams: Streams,
  ctx: Context,
  text: string,
  output: PathSpec | undefined,
): Promise<void> {
  if (output === undefined) {
    streams.out(text)
    return
  }
  const vfs = ctx.vfs
  if (vfs === undefined) throw new Error('no workspace files')
  const folder = output.parent
  try {
    await vfs.stat(folder)
  } catch (err) {
    if (!isMissingPath(err)) throw err
    await ensureDir(vfs, folder)
    if (folder.virtual.split('/').pop() === DEFAULT_OUTPUT_DIR) {
      await vfs.write(folder.join('.gitignore'), ENC.encode('*\n'))
    }
  }
  await vfs.write(output, ENC.encode(`${text}\n`))
  streams.err(`Output saved to ${output.rawPath}`)
}

/** Whether the verb answers with its JSON rather than its text. */
export function jsonRequested(fl: FlagView, output: PathSpec | undefined): boolean {
  return fl.asBool('json') || output !== undefined
}
