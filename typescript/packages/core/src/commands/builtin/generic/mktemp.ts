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
import { rstripSlash, stripSlash } from '../../../utils/slash.ts'
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

function makePathSpec(virtual: string): PathSpec {
  return new PathSpec({
    virtual,
    directory: virtual,
    resourcePath: stripSlash(virtual),
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
  const templateArg = texts[0]
  let template = templateArg !== undefined && templateArg !== '' ? templateArg : 'tmp.XXXXXXXXXX'
  let parent: string
  if (tFlag) {
    parent = '/tmp'
  } else if (typeof opts.flags.p === 'string') {
    parent = opts.flags.p
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
    name = template.slice(0, template.length - xCount) + randomSuffix(xCount)
  } else {
    name = `${template}.${randomSuffix(8)}`
  }
  const path = `${rstripSlash(parent)}/${name}`
  await mkdir(makePathSpec(parent), true)
  if (opts.flags.d === true) {
    await mkdir(makePathSpec(path))
  } else {
    await write(makePathSpec(path), new Uint8Array(0))
  }
  const result: ByteSource = ENC.encode(path + '\n')
  return [result, new IOResult()]
}
