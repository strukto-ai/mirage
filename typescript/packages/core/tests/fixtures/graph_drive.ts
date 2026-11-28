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

import { randomUUID } from 'node:crypto'
import { KitRun } from './kit_fake.ts'

// The drive /me/drive names on the fake, and the one SharePoint mounts
// declare and name.
export const ONEDRIVE = 'default'
export const SITE_NAME = 'Main'
export const DRIVE_NAME = 'Documents'
export const DOWNLOAD = '/download/:tenant/:drive/*path'
const ME_DRIVE = '/me/drive/*rest'
const DRIVES = '/drives/:drive/*rest'
const SITES = '/sites'
const SITE_DRIVES = '/sites/:site/drives'
const BYTES = ['download', 'content', 'version_content']
// What a read or stat asks for; any other request it sends is reported.
const READS = ['item', 'children', 'content', 'version_content', 'download', 'sites', 'drives']

/** One request as the tests read it: its name, the path in the drive it names, and its query. */
export type Logged = [string, string, string]

interface Listed {
  method: string
  route: string
  path: string
  query: string
}

/**
 * Name a request to a drive's own routes as the tests read them.
 *
 * @param method the HTTP method.
 * @param path the request path, `/me/drive/...` or `/drives/{id}/...`.
 * @param query its query string.
 */
function driveRequest(method: string, path: string, query: string): Logged {
  const rest = path.startsWith('/drives/')
    ? path.split('/').slice(3).join('/')
    : path.slice('/me/drive/'.length)
  if (rest === 'root/delta') return ['delta', '', query]
  if (rest.startsWith('items/')) return ['item_by_id', rest, query]
  if (rest === 'root') return ['item', '', query]
  if (rest === 'root/children') return ['children', '', query]
  const relative = rest.slice('root:/'.length)
  const colon = relative.indexOf(':')
  const item = colon < 0 ? relative : relative.slice(0, colon)
  const action = colon < 0 ? '' : relative.slice(colon + 1)
  if (action === '') return [method === 'GET' ? 'item' : method, item, query]
  if (action === '/children') return ['children', item, query]
  if (action === '/content') return [method === 'PUT' ? 'upload' : 'content', item, query]
  if (action.startsWith('/versions/') && action.endsWith('/content'))
    return ['version_content', item, query]
  return [`${method} ${action}`, item, query]
}

/**
 * One drive on the integ Microsoft Graph (OneDrive) fake, and the writes a
 * test arranges it by. Twin of python/tests/fixtures/graph_drive.py.
 *
 * The fake keeps one account per access token, so each drive sends a token
 * of its own; `drive` is `default` for a OneDrive mount (`/me/drive`) or a
 * SharePoint document library the drive declares.
 */
export class GraphDrive {
  readonly token = randomUUID().replaceAll('-', '')
  readonly run: KitRun
  private readonly prefix: string

  /**
   * @param origin the fake's origin.
   * @param drive the drive's id, which is its name on the fake.
   */
  constructor(
    origin: string,
    readonly drive: string = ONEDRIVE,
  ) {
    this.run = new KitRun(origin, { Authorization: `Bearer ${this.token}` })
    this.prefix = drive === ONEDRIVE ? '/me/drive' : `/drives/${encodeURIComponent(drive)}`
  }

  /** Start the account afresh, its drive declared, its requests recorded from here. */
  async reset(): Promise<void> {
    await this.run.call('POST', '/reset', { json: { tenants: [this.token] } })
    if (this.drive !== ONEDRIVE)
      await this.run.call('PUT', `/drives/${encodeURIComponent(this.drive)}`)
    await this.run.recordRequests()
  }

  /**
   * A mount config for `provider` (onedrive or sharepoint) on the drive; a
   * SharePoint one is scoped to its site and library.
   */
  config(provider: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
    const given: Record<string, unknown> = {
      access_token: this.token,
      graph_base_url: this.run.url,
    }
    if (provider === 'sharepoint') Object.assign(given, { site: SITE_NAME, drive: this.drive })
    return { ...given, ...fields }
  }

  private item(path: string): string {
    return `${this.prefix}/root:/${path.split('/').map(encodeURIComponent).join('/')}`
  }

  /** Write a file's content as another client would, minting a new cTag, eTag and version. */
  async write(path: string, data: string | Uint8Array): Promise<void> {
    const body = typeof data === 'string' ? new TextEncoder().encode(data) : data
    await this.run.call('PUT', `${this.item(path)}:/content`, { body })
  }

  /** Delete an item as another client would. */
  async remove(path: string): Promise<void> {
    const res = await this.run.request('DELETE', this.item(path))
    const text = await res.text()
    if (res.status >= 300) throw new Error(`DELETE ${path} -> ${String(res.status)} ${text}`)
  }

  /**
   * Edit a file's metadata as a rename or a property edit does: the eTag
   * and the stamp move, the cTag and the bytes stay. The fake has no route
   * for a bare property edit, so the row changes directly.
   *
   * The change reloads the run, which stops a recording, so the recording
   * starts again here: `log` lists the requests made since the edit.
   */
  async touch(path: string): Promise<void> {
    await this.run.execute(
      "UPDATE GraphFile SET etag = etag || '-edited', modified = '2027-01-01T00:00:00Z' " +
        'WHERE tenant = ? AND drive = ? AND path = ?',
      this.token,
      this.drive,
      path,
    )
    await this.run.recordRequests()
  }

  /** What a file holds now. */
  async content(path: string): Promise<Uint8Array> {
    return this.run.read(`${this.item(path)}:/content`)
  }

  /**
   * Change a file the moment its next download has taken its bytes: the
   * download answers what the file held, while Graph already holds `next`.
   * The download waits while another client writes `next`, then answers the
   * bytes it had before.
   */
  async writeAfterTheBytes(path: string, next: Uint8Array): Promise<void> {
    const old = await this.content(path)
    await this.run.beforeNext([['GET', DOWNLOAD]], async () => {
      await this.write(path, next)
      await this.run.answerNext('GET', DOWNLOAD, 200, old)
    })
  }

  /** The item Graph answers for a path. */
  async itemAt(path: string): Promise<Record<string, unknown>> {
    return this.run.call<Record<string, unknown>>('GET', this.item(path))
  }

  /** The cTag the item holds now. */
  async ctag(path: string): Promise<string> {
    return String((await this.itemAt(path)).cTag)
  }

  /**
   * Each request since recording started, as `[name, path, query]`: `item`,
   * `children`, `content`, `version_content`, `download`, `upload`, `delta`,
   * `sites` and `drives`, the path the one it names in the drive.
   */
  async log(): Promise<Logged[]> {
    const listed = await this.run.call<{ requests: Listed[] }>('GET', '/_kit/requests')
    return listed.requests.map((r) => {
      // A minted URL names its tenant for the kit; Graph's own query is the rest.
      const query = decodeURIComponent(r.query.replace(/(^|&)_tenant=[^&]*/, '')).replace(/^&/, '')
      if (r.route === DOWNLOAD) {
        return ['download', decodeURIComponent(r.path).split('/').slice(4).join('/'), query]
      }
      if (r.route === SITES) return ['sites', '', query]
      if (r.route === SITE_DRIVES) return ['drives', r.path.split('/')[2] ?? '', query]
      if (r.route === ME_DRIVE || r.route === DRIVES) {
        return driveRequest(r.method, decodeURIComponent(r.path), query)
      }
      return [`${r.method} ${r.route}`, r.path, query]
    })
  }

  /** How many requests of one name since recording started. */
  async count(name: string): Promise<number> {
    return (await this.log()).filter(([logged]) => logged === name).length
  }

  /** How many requests fetched bytes since recording started. */
  async fetches(): Promise<number> {
    return (await this.log()).filter(([logged]) => BYTES.includes(logged)).length
  }

  /**
   * The requests no read or stat should make, since recording started: a
   * second sites or drives lookup, a children listing past the
   * `childrenAllowed` a test's own `ls` makes, and any request a read does
   * not make, an upload, a delete or a delta read among them.
   */
  async reach(childrenAllowed = 0): Promise<string[]> {
    const log = await this.log()
    const out: string[] = []
    if (log.filter(([name]) => name === 'sites').length > 1) out.push('sites listed twice')
    if (log.filter(([name]) => name === 'drives').length > 1) out.push('drives listed twice')
    const children = log.filter(([name]) => name === 'children').map(([, path]) => path)
    for (const path of children.slice(childrenAllowed)) out.push(`children of ${path || '/'}`)
    for (const [name, path] of log) if (!READS.includes(name)) out.push(`${name} ${path}`)
    return out
  }

  /** The query of each request of one name, in order. */
  async queries(name: string): Promise<string[]> {
    return (await this.log()).filter(([logged]) => logged === name).map(([, , query]) => query)
  }
}
