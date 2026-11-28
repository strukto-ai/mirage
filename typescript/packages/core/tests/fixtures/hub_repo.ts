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

import { createHash, randomUUID } from 'node:crypto'
import { KitRun, runToken } from './kit_fake.ts'

export const TENANT = 'hub'
export const REPO_ID = 'acme/widget'
export const KIND = 'models'
export const TREE = '/api/:kind/:ns/:name/tree/:rev'
export const TREE_UNDER = '/api/:kind/:ns/:name/tree/:rev/*path'
export const PATHS_INFO = '/api/:kind/:ns/:name/paths-info/:rev'
export const REVISION = '/api/:kind/:ns/:name/revision/:rev'
export const RESOLVE = '/:ns/:name/resolve/:rev/*path'
export const DATASET_RESOLVE = '/datasets/:ns/:name/resolve/:rev/*path'
export const SPACE_RESOLVE = '/spaces/:ns/:name/resolve/:rev/*path'
export const BRIDGE = '/xet-bridge/:hash'
export const UNTIL_CLEARED = 1_000_000

// What each Hub-facing request is named by in `log`.
const NAMES: Record<string, string> = {
  [TREE]: 'tree',
  [TREE_UNDER]: 'tree',
  [PATHS_INFO]: 'paths_info',
  [REVISION]: 'revision',
  [RESOLVE]: 'resolve',
  [DATASET_RESOLVE]: 'resolve',
  [SPACE_RESOLVE]: 'resolve',
  [BRIDGE]: 'bridge',
}

const ENC = new TextEncoder()

function bytesOf(data: string | Uint8Array): Uint8Array {
  return typeof data === 'string' ? ENC.encode(data) : data
}

/** The git blob sha of `data`, a plain file's oid and ETag. */
export function blobOid(data: string | Uint8Array): string {
  const body = bytesOf(data)
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${String(body.length)}\0`), Buffer.from(body)]))
    .digest('hex')
}

/** The LFS sha256 of `data`. */
export function lfsOid(data: string | Uint8Array): string {
  return createHash('sha256').update(bytesOf(data)).digest('hex')
}

/**
 * The Xet hash a test stores `data` under. The fake takes no Xet upload, so
 * any hash unique to the content serves.
 */
export function xetHash(data: string | Uint8Array): string {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from('xet:'), Buffer.from(bytesOf(data))]))
    .digest('hex')
}

/** The length of the git-lfs pointer that tracks `data`. */
export function pointerSize(data: string | Uint8Array): number {
  const body = bytesOf(data)
  return `version https://git-lfs.github.com/spec/v1\noid sha256:${lfsOid(body)}\nsize ${String(body.length)}\n`
    .length
}

/** One request as the tests read it: its name, path, revision and query. */
export type Logged = [string, string, string, string]

interface Listed {
  method: string
  route: string
  path: string
  query: string
  body: unknown
}

/**
 * One repository on the integ Hugging Face Hub fake, and the commits a test
 * arranges it by. Twin of python/tests/fixtures/hub_repo.py.
 *
 * A mount's endpoint is a bare origin, so the access token names the run
 * (`runToken`). The fake takes no Xet upload, so a file a commit stores on
 * Xet is marked so in the run's rows, as the upload would leave it.
 */
export class HubRepo {
  readonly token: string
  readonly run: KitRun

  /**
   * @param origin the fake's origin.
   * @param kind `models`, `datasets` or `spaces`.
   * @param repoId the repository, `namespace/name`.
   */
  constructor(
    readonly origin: string,
    readonly kind: string = KIND,
    readonly repoId: string = REPO_ID,
  ) {
    const name = randomUUID().replaceAll('-', '')
    this.token = runToken(name, TENANT)
    this.run = new KitRun(origin, { Authorization: `Bearer ${this.token}` }, name)
  }

  /** A mount config for the repository, as `buildVfs` takes it. */
  config(fields: Record<string, unknown> = {}): Record<string, unknown> {
    return { repo_id: this.repoId, endpoint: this.origin, token: this.token, ...fields }
  }

  /** Make the repository, empty, as its owner would; a space is made with an SDK, which the Hub requires of one. */
  async create(): Promise<void> {
    const [namespace = '', name = ''] = this.repoId.split('/')
    const made: Record<string, string> = {
      name,
      organization: namespace,
      type: this.kind.replace(/s$/, ''),
    }
    if (this.kind === 'spaces') made.sdk = 'static'
    await this.run.call('POST', '/api/repos/create', { json: made })
  }

  /**
   * Commit `files` as another client would, and the new head sha. A path
   * whose content is null is deleted. Marking a file as stored on Xet reloads
   * the run, which stops a recording, so the recording starts again here.
   */
  async commit(
    files: Record<string, string | Uint8Array | null>,
    xet = true,
    branch = 'main',
  ): Promise<string> {
    const lines: unknown[] = [{ key: 'header', value: { summary: 'test commit' } }]
    for (const [path, data] of Object.entries(files)) {
      if (data === null) {
        lines.push({ key: 'deletedFile', value: { path } })
        continue
      }
      lines.push({
        key: 'file',
        value: { path, encoding: 'base64', content: Buffer.from(bytesOf(data)).toString('base64') },
      })
    }
    const made = await this.run.call<{ commitOid: string }>(
      'POST',
      `/api/${this.kind}/${this.repoId}/commit/${branch}`,
      {
        body: ENC.encode(lines.map((line) => JSON.stringify(line)).join('\n')),
        headers: { 'Content-Type': 'application/x-ndjson' },
      },
    )
    const sha = made.commitOid
    const written = Object.entries(files).filter(
      (entry): entry is [string, string | Uint8Array] => entry[1] !== null,
    )
    if (xet && written.length > 0) {
      for (const [path, data] of written) {
        await this.run.execute(
          'UPDATE HfBlob SET lfsOid = ?, pointerSize = ?, xetHash = ? ' +
            'WHERE tenant = ? AND repo = ? AND sha = ? AND path = ?',
          lfsOid(data),
          pointerSize(data),
          xetHash(data),
          TENANT,
          `${this.kind}/${this.repoId}`,
          sha,
          path,
        )
      }
      await this.run.recordRequests()
    }
    return sha
  }

  /**
   * Point a new branch `name` at `sha`. The fake has no branch route, so the
   * ref is stored directly; this reloads the run, which stops a recording, so
   * the recording starts again here.
   */
  async branch(name: string, sha: string): Promise<void> {
    await this.run.execute(
      "INSERT INTO HfRef (tenant, repo, refType, name, sha) VALUES (?, ?, 'branch', ?, ?)",
      TENANT,
      `${this.kind}/${this.repoId}`,
      name,
      sha,
    )
    await this.run.recordRequests()
  }

  /** The commit sha a revision names now. */
  async head(revision = 'main'): Promise<string> {
    const made = await this.run.call<{ sha: string }>(
      'GET',
      `/api/${this.kind}/${this.repoId}/revision/${revision}`,
    )
    return made.sha
  }

  /**
   * Answer the next `times` requests `log` names `name` with the Hub's error
   * for `status`, carrying `code` as its `X-Error-Code` when one is given.
   */
  async refuse(name: string, status: number, code = '', times = UNTIL_CLEARED): Promise<void> {
    const method = name === 'paths_info' ? 'POST' : 'GET'
    const message = `fake ${name} refused`
    const headers: Record<string, string> = { 'X-Error-Message': message }
    if (code !== '') headers['X-Error-Code'] = code
    for (const [route, named] of Object.entries(NAMES)) {
      if (named !== name) continue
      await this.run.answerNext(
        method,
        route,
        status,
        { error: message },
        times,
        undefined,
        undefined,
        0,
        headers,
      )
    }
  }

  /**
   * Each Hub-facing request since recording started, as `[name, path,
   * revision, query]`: `tree`, `paths_info`, `revision`, `resolve` and
   * `bridge`; a paths-info request's path is its body.
   */
  async log(): Promise<Logged[]> {
    const listed = await this.run.call<{ requests: Listed[] }>('GET', '/_kit/requests')
    return listed.requests.map((r): Logged => {
      const name = NAMES[r.route]
      if (name === undefined) return [`${r.method} ${r.route}`, r.path, '', '']
      const path = decodeURIComponent(r.path)
      let after = ''
      if (name === 'tree' || name === 'paths_info' || name === 'revision') {
        after = path.split(`/${name.replace('_', '-')}/`)[1] ?? ''
      } else if (name === 'resolve') {
        after = path.split('/resolve/')[1] ?? ''
      }
      const cut = after.indexOf('/')
      const rev = cut === -1 ? after : after.slice(0, cut)
      let rest = cut === -1 ? '' : after.slice(cut + 1)
      if (name === 'paths_info') rest = JSON.stringify(r.body)
      return [name, rest, rev, r.query]
    })
  }

  /** How many requests `log` names `name` since recording started. */
  async count(name: string): Promise<number> {
    return (await this.log()).filter(([logged]) => logged === name).length
  }
}

/**
 * A repository of its own on the Hub fake, made empty.
 *
 * @param origin the fake's origin.
 * @param kind `models`, `datasets` or `spaces`.
 */
export async function madeRepo(origin: string, kind: string = KIND): Promise<HubRepo> {
  const made = new HubRepo(origin, kind)
  await made.run.call('POST', '/reset', { json: { tenants: [TENANT] } })
  await made.create()
  return made
}
