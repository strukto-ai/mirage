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

import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import { ensureDirPath } from './spill.ts'
import type {} from './service.ts'

/** The workspace directory spill artifacts land under when none is configured. */
const DEFAULT_SPILL_DIR = '/tmp/dsh-spill'

/** Bytes of randomness prefixed to a spill file name; 12 hex characters. */
const NAME_PREFIX_BYTES = 6

/** Hex characters of the session-id digest that names a session's directory. */
const SESSION_DIGEST_CHARS = 12

/** Configuration for the mirage spill store. */
export interface MirageSpillConfig {
  /**
   * Workspace directory the artifacts are written under, one
   * subdirectory per session. Must fall inside a mount this world can
   * write; the default sits on the `/tmp` ram mount the bundle patch
   * provides.
   */
  dir?: string
}

/**
 * Encode one caller-supplied string as a single safe path segment.
 *
 * `suggestedName` is a hint from a tool, never a path: it may be empty,
 * may spell `..`, and may carry separators or control characters. Only
 * the portable filename characters survive as themselves; everything
 * else, `~` included, becomes `~XXXX` so the encoding stays reversible
 * and cannot collide with a name that was already safe.
 *
 * @param raw the caller's suggested name.
 * @returns one path segment containing no separator and no traversal.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) return '~'
  // `.` is a portable filename character, so the loop below would pass
  // both of these through unchanged and hand a traversal to the join.
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    out +=
      ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)
        ? ch
        : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * The directory name one session's artifacts share.
 *
 * The id is digested rather than spelled out: a session id is an
 * identifier the host chose, and a directory listing an agent can read
 * is no place to republish it.
 *
 * @param sessionId the owning session's id.
 * @returns a single path segment naming that session's directory.
 */
export function sessionDirName(sessionId: string): string {
  const digest = createHash('sha256').update(sessionId).digest('hex')
  return `session-${digest.slice(0, SESSION_DIGEST_CHARS)}`
}

/**
 * Mirage-backed implementation of `ctx.spillStore`.
 *
 * The spill policy replaces an oversized tool result with a preview and
 * a locator, telling the model to read or grep it for the rest. That
 * only works if the locator names a file the model can reach, and in a
 * mirage world the model reaches the workspace, not the host: a spill
 * written to the harness's own disk hands it a path its next `grep`
 * cannot open, which reads as output the harness lost. So the artifact
 * is written through the same op door every other effect in this world
 * passes, and the locator is an ordinary workspace path.
 *
 * The seam asks for a private location. mirage has no permission bits
 * to offer: the workspace is the boundary, and a deployment that needs
 * the artifacts out of the agent's reach puts `dir` on a mount the
 * session has no grant for.
 */
export class MirageSpillStore extends SpillStore {
  static readonly inject = ['mirage']

  private readonly dir: string

  constructor(ctx: Context, config: MirageSpillConfig = {}) {
    super(ctx)
    this.dir = config.dir ?? DEFAULT_SPILL_DIR
  }

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    const workspace = await this.ctx.mirage.ready
    const dir = `${this.dir}/${sessionDirName(input.owner.sessionId)}`
    // Derived from the suggested name, never equal to it: the random
    // prefix is what keeps two results with one suggested name apart.
    const name = `${randomBytes(NAME_PREFIX_BYTES).toString('hex')}-${encodeSegment(input.suggestedName)}`
    const path = `${dir}/${name}`
    try {
      await ensureDirPath(
        { exists: (p) => workspace.fs.exists(p), mkdir: (p) => workspace.fs.mkdir(p) },
        dir,
      )
      await workspace.fs.writeFile(path, input.content)
    } catch (err) {
      // Rejecting is the contract: the spill policy keeps the inline
      // result on a failure, which is a bounded answer, where a locator
      // pointing at a file that was never written is a dead end the
      // model cannot tell from a real one.
      throw new Error(`mirage: cannot write spill artifact to ${path}`, { cause: err })
    }
    return {
      locator: SpillLocator(path),
      bytes: Buffer.byteLength(input.content, 'utf8'),
      retrievalHint: 'Use read with offset/limit, or grep this workspace path to search within it.',
    }
  }
}
