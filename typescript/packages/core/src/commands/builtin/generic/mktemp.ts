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

import { IOResult, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { rstripSlash } from '../../../utils/slash.ts'
import { mountKey } from '../../../utils/key_prefix.ts'
import { extraOperandError } from '../../spec/usage.ts'
import { CommandName } from '../../spec/types.ts'

const ENC = new TextEncoder()

function randomSuffix(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)] ?? ''
  }
  return out
}

function makePathSpec(virtual: string, mountPrefix: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: mountKey(virtual, mountPrefix),
    resolved: true,
  })
}

export async function mktempGeneric(
  texts: string[],
  opts: CommandOpts,
  mkdir: (p: PathSpec, parents?: boolean) => Promise<void>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
): Promise<CommandFnResult> {
  if (texts.length > 1) throw extraOperandError(CommandName.MKTEMP, texts[1] ?? '')
  const tFlag = opts.flags.t === true
  const directory = opts.flags.d === true || opts.flags.directory === true
  const dryRun = opts.flags.u === true || opts.flags.dry_run === true
  const suffix = typeof opts.flags.suffix === 'string' ? opts.flags.suffix : ''
  const tmpdirValue: unknown = opts.flags.p ?? opts.flags.tmpdir
  const templateArg = texts[0]
  let template = templateArg !== undefined && templateArg !== '' ? templateArg : 'tmp.XXXXXXXXXX'
  let parent: string
  if (tFlag) {
    parent = '/tmp'
  } else if (tmpdirValue instanceof PathSpec) {
    parent = tmpdirValue.virtual
  } else if (typeof tmpdirValue === 'string') {
    parent = tmpdirValue
  } else if (template.includes('/')) {
    // An explicit path template names its own directory (GNU); only a bare
    // template with no -p/-t falls back to the temp dir.
    const idx = template.lastIndexOf('/')
    parent = template.slice(0, idx) || '/'
    template = template.slice(idx + 1)
  } else {
    parent = '/tmp'
  }
  let xCount = 0
  while (xCount < template.length && template.charCodeAt(template.length - 1 - xCount) === 88) {
    xCount += 1
  }
  let name: string
  if (xCount > 0) {
    name = template.slice(0, template.length - xCount) + randomSuffix(xCount) + suffix
  } else {
    name = `${template}.${randomSuffix(8)}`
  }
  const path = `${rstripSlash(parent)}/${name}`
  if (!dryRun) {
    const mountPrefix = opts.mountPrefix ?? ''
    const quiet = opts.flags.q === true || opts.flags.quiet === true
    try {
      await mkdir(makePathSpec(parent, mountPrefix), true)
      if (directory) {
        await mkdir(makePathSpec(path, mountPrefix))
      } else {
        await write(makePathSpec(path, mountPrefix), new Uint8Array(0))
      }
    } catch (error) {
      // -q suppresses diagnostics about file/directory creation only
      // (GNU); usage errors and internal failures still propagate.
      if (!quiet) throw error
      return [null, new IOResult({ exitCode: 1 })]
    }
  }
  const result: ByteSource = ENC.encode(path + '\n')
  return [result, new IOResult()]
}
