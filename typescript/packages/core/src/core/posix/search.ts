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
import { mountedPath } from '../../utils/key_prefix.ts'
import { singleQuote } from '../../utils/quote.ts'
import { GREP } from './constants.ts'
import type { RunFn } from './types.ts'
import { joinRoot } from './utils.ts'
import { rstripSlash } from '../../utils/slash.ts'

/**
 * The grep that lists the files under `scopes` holding `text`.
 *
 * @param text the plain text.
 * @param scopes the directories, where the files are.
 * @param ignoreCase fold ASCII case.
 */
export function grepCommand(text: string, scopes: string[], ignoreCase: boolean): string {
  const words = [GREP, ...(ignoreCase ? ['-i'] : []), '-e', singleQuote(text)]
  return [...words, '--', ...scopes.map(singleQuote)].join(' ')
}

/**
 * The files under `under` whose bytes hold `text`, as grep where they are
 * finds them.
 *
 * The answer is exact, since every file is searched, so a whole word is
 * asked as plain text: a file the word only sits inside is one more read.
 * Only an exit of 0 or 1 with nothing on stderr, and output that is
 * NUL-ended names, answers: a host that runs no commands (one forced to
 * internal-sftp says so on stdout and exits 1), a grep that refuses an
 * option (busybox exits 1 for one), or a file it could not read (which the
 * walk then reports) leaves every file to be read.
 *
 * @param run runs a line where the files are.
 * @param root the path there the mount is rooted at.
 * @param text the plain text.
 * @param under the directories walked.
 * @param ignoreCase fold ASCII case, which is all the text needs.
 */
export async function filesContaining(
  run: RunFn,
  root: string,
  text: string,
  under: PathSpec[],
  ignoreCase: boolean,
): Promise<PathSpec[] | null> {
  const scopes = under.map((p) => joinRoot(root, p.mountPath))
  const [status, out, err] = await run(grepCommand(text, scopes, ignoreCase))
  if ((status !== 0 && status !== 1) || err.length > 0) return null
  if (out.length > 0 && out[out.length - 1] !== 0) return null
  const [first] = under
  if (first === undefined) return []
  const base = rstripSlash(root)
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const hits: PathSpec[] = []
  let start = 0
  for (let end = out.indexOf(0); end !== -1; end = out.indexOf(0, start)) {
    let name: string
    try {
      name = decoder.decode(out.subarray(start, end))
    } catch (error) {
      console.debug(`grep names unread: ${String(error)}`)
      return null
    }
    if (!name.startsWith(`${base}/`)) return null
    hits.push(mountedPath(first, name.slice(base.length)))
    start = end + 1
  }
  return hits
}
