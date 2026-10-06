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

import { specOf } from '../../spec/builtins.ts'
import { FlagView } from '../../spec/flag_view.ts'
import { UsageError } from '../../errors.ts'
import { quoteText } from '../../quote.ts'
import { IOResult, type ByteSource } from '../../../io/types.ts'
import { PathSpec } from '../../../types.ts'
import type { CommandFnResult, CommandOpts } from '../../config.ts'
import { eexist, fsStrerror, isEnoent, isFsError } from '../../../utils/errors.ts'

import { extraOperandError } from '../../spec/usage.ts'
import { CommandName, type FlagValue } from '../../spec/types.ts'

const ENC = new TextEncoder()
const DEFAULT_TEMPLATE = 'tmp.XXXXXXXXXX'
// How many names a create draws before it gives up with EEXIST.
const ATTEMPTS = 100

function randomSuffix(length: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let out = ''
  for (let i = 0; i < length; i++) {
    out += chars[Math.floor(Math.random() * chars.length)] ?? ''
  }
  return out
}

/**
 * The template a create names, formed as GNU mktemp forms it: the formed
 * template, how many X's end its body, and the length of the suffix after
 * them. The name stays as typed, so a relative template or directory prints
 * and refuses relative: a bare template lives in the working directory, and
 * only a line with no template, -p/--tmpdir or -t joins a directory in
 * front of it ($TMPDIR if set, else /tmp; -t prefers $TMPDIR over -p).
 * Pinned against GNU coreutils 9.7 (debian:stable-slim). Mirrors Python's
 * plan_template.
 */
export function planTemplate(
  templateArg: string | undefined,
  suffixArg: string | undefined,
  destDir: string,
  useDestDir: boolean,
  t: boolean,
  envTmpdir: string,
): [string, number, number] {
  let template = templateArg ?? DEFAULT_TEMPLATE
  let suffix: string
  if (suffixArg !== undefined) {
    if (!template.endsWith('X')) {
      throw new UsageError(
        `mktemp: with --suffix, template '${quoteText(template)}' must end in X`,
        1,
      )
    }
    suffix = suffixArg
    template += suffix
  } else {
    const lastX = template.lastIndexOf('X')
    suffix = lastX >= 0 ? template.slice(lastX + 1) : ''
  }
  if (suffix.includes('/')) {
    throw new UsageError(
      `mktemp: invalid suffix '${quoteText(suffix)}', contains directory separator`,
      1,
    )
  }
  const body = template.slice(0, template.length - suffix.length)
  const xCount = body.length - body.replace(/X+$/, '').length
  if (xCount < 3) {
    throw new UsageError(`mktemp: too few X's in template '${quoteText(template)}'`, 1)
  }
  if (useDestDir || t || templateArg === undefined) {
    let directory: string
    if (t) {
      directory = envTmpdir || destDir || '/tmp'
      if (template.includes('/')) {
        throw new UsageError(
          `mktemp: invalid template, '${quoteText(template)}', contains directory separator`,
          1,
        )
      }
    } else {
      directory = destDir || envTmpdir || '/tmp'
      if (template.startsWith('/')) {
        throw new UsageError(
          `mktemp: invalid template, '${quoteText(template)}'; with --tmpdir, it may not be absolute`,
          1,
        )
      }
    }
    template = `${directory}${directory.endsWith('/') ? '' : '/'}${template}`
  }
  return [template, xCount, suffix.length]
}

/**
 * Create a temporary file or directory and print its name. The create is one
 * file or one directory, never a directory the line named: a missing one
 * answers ENOENT, the way GNU's open(O_CREAT|O_EXCL) does. The one exception
 * is /tmp when it is only the fallback: a system always has it, but a
 * workspace's root starts empty, so it is made on first use. `mkdir`/`write`
 * take the resolved virtual path, so the create lands on whichever mount
 * owns it, not the one the working directory is on. A name already taken is
 * never reused: GNU creates exclusively and draws again, so an existing file
 * is left alone, and -u names only a free one; `exists` asks the mount that
 * owns the name. Mirrors Python's mktemp.
 */
interface MktempFlags {
  readonly directory: boolean
  readonly tmpdir: PathSpec | null
  readonly useDestDir: boolean
  readonly templateMode: boolean
  readonly dryRun: boolean
  readonly suffix: string | null
  readonly quiet: boolean
}

function parseFlags(bag: Record<string, FlagValue>): MktempFlags {
  const fl = new FlagView(bag, specOf('mktemp'))
  return {
    directory: fl.asBool('directory'),
    tmpdir: fl.asPaths('tmpdir')[0] ?? fl.asPaths('p')[0] ?? null,
    useDestDir: fl.raw('tmpdir') !== undefined || fl.raw('p') !== undefined,
    templateMode: fl.asBool('t'),
    dryRun: fl.asBool('dry_run'),
    suffix: fl.asStr('suffix') ?? null,
    quiet: fl.asBool('quiet'),
  }
}

export async function mktempGeneric(
  texts: string[],
  opts: CommandOpts,
  mkdir: (p: PathSpec) => Promise<void>,
  write: (p: PathSpec, data: Uint8Array) => Promise<void>,
  exists?: (p: PathSpec) => Promise<boolean>,
): Promise<CommandFnResult> {
  const parsed = parseFlags(opts.flags)
  if (texts.length > 1) throw extraOperandError(CommandName.MKTEMP, texts[1] ?? '')
  const { directory, tmpdir, useDestDir, templateMode: t } = parsed
  const destDir = tmpdir?.rawPath ?? ''
  const envTmpdir = opts.env?.TMPDIR ?? ''
  const [template, xCount, suffixLen] = planTemplate(
    texts[0],
    parsed.suffix ?? undefined,
    destDir,
    useDestDir,
    t,
    envTmpdir,
  )
  const fallback = (texts.length === 0 || useDestDir || t) && destDir === '' && envTmpdir === ''
  const end = template.length - suffixLen
  const draw = (): string =>
    template.slice(0, end - xCount) + randomSuffix(xCount) + template.slice(end)
  const create = (path: PathSpec): Promise<void> =>
    directory ? mkdir(path) : write(path, new Uint8Array(0))
  let name = draw()
  try {
    let path = PathSpec.fromStrPath(name, undefined, opts.cwd)
    let attempt = 0
    while (exists !== undefined && (await exists(path))) {
      attempt += 1
      if (attempt >= ATTEMPTS) throw eexist(path.virtual)
      name = draw()
      path = PathSpec.fromStrPath(name, undefined, opts.cwd)
    }
    if (!parsed.dryRun) {
      try {
        await create(path)
      } catch (error) {
        if (!fallback || !isEnoent(error)) throw error
        await mkdir(PathSpec.fromStrPath('/tmp'))
        await create(path)
      }
    }
  } catch (error) {
    if (!isFsError(error)) throw error
    // -q suppresses the diagnostic about the create only (GNU); a bad
    // template still says so.
    if (parsed.quiet) return [null, new IOResult({ exitCode: 1 })]
    const kind = directory ? 'directory' : 'file'
    return [
      null,
      new IOResult({
        exitCode: 1,
        stderr: ENC.encode(
          `mktemp: failed to create ${kind} via template '${quoteText(template)}': ${String(fsStrerror(error))}\n`,
        ),
      }),
    ]
  }
  const result: ByteSource = ENC.encode(name + '\n')
  return [result, new IOResult()]
}
