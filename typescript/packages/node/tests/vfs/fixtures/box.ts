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

import { KitRun } from '../../../../core/tests/fixtures/kit_fake.ts'

export const TOKEN = 'unit'

/** One row a Box folder listing gives. */
interface Row {
  id: string
  type: string
  name: string
}

/** What Box answers for a file by id. */
interface FileAnswer {
  id: string
  modified_at: string
}

function names(path: string): string[] {
  return path.split('/').filter((p) => p !== '')
}

function placement(path: string): [string, string] {
  const parts = names(path)
  return [parts.slice(0, -1).join('/'), parts.at(-1) ?? '']
}

/**
 * One Box account on the kit's Box fake, and the writes a test arranges it
 * by, each item named by its path: slash-separated names from All Files.
 */
export class BoxAccount {
  readonly run: KitRun

  /** @param origin the Box fake's origin. */
  constructor(origin: string) {
    this.run = new KitRun(origin, { Authorization: `Bearer ${TOKEN}` })
  }

  /** Every row the folder `id`'s listing gives, page by page. */
  async entries(id: string): Promise<Row[]> {
    const rows: Row[] = []
    for (;;) {
      const page = await this.run.call<{ total_count: number; entries: Row[] }>(
        'GET',
        `/2.0/folders/${id}/items?offset=${String(rows.length)}`,
      )
      rows.push(...page.entries)
      if (page.entries.length === 0 || rows.length >= page.total_count) return rows
    }
  }

  /** The listing row of the item at `path`; null if none is there. */
  async rowAt(path: string): Promise<Row | null> {
    let row: Row | null = { id: '0', type: 'folder', name: '' }
    for (const name of names(path)) {
      if (row?.type !== 'folder') return null
      row = (await this.entries(row.id)).find((e) => e.name === name) ?? null
    }
    return row
  }

  /** The id of the item at `path`. */
  async idOf(path: string): Promise<string> {
    const row = await this.rowAt(path)
    if (row === null) throw new Error(`nothing at ${path}`)
    return row.id
  }

  /** The id of the folder at `path`, making those missing on the way. */
  async folderAt(path: string): Promise<string> {
    let folder = '0'
    for (const name of names(path)) {
      const found = (await this.entries(folder)).find((e) => e.name === name && e.type === 'folder')
      folder =
        found?.id ??
        (
          await this.run.call<{ id: string }>('POST', '/2.0/folders', {
            json: { name, parent: { id: folder } },
          })
        ).id
    }
    return folder
  }

  /**
   * Put `data` at `path` as another client would: a new version of the file
   * there, else a new file. Answers its id.
   */
  async write(path: string, data: Uint8Array): Promise<string> {
    const row = await this.rowAt(path)
    const body = new FormData()
    if (row !== null) {
      body.append('attributes', JSON.stringify({}))
      body.append('file', new Blob([data as Uint8Array<ArrayBuffer>]), 'version')
      await this.run.call('POST', `/2.0/files/${row.id}/content`, { body })
      return row.id
    }
    const [parent, name] = placement(path)
    const attributes = { name, parent: { id: await this.folderAt(parent) } }
    body.append('attributes', JSON.stringify(attributes))
    body.append('file', new Blob([data as Uint8Array<ArrayBuffer>]), name)
    const made = await this.run.call<{ entries: { id: string }[] }>('POST', '/2.0/files/content', {
      body,
    })
    return made.entries[0]?.id ?? ''
  }

  /** Create a web link at `path` and answer its id. */
  async webLink(path: string): Promise<string> {
    const [parent, name] = placement(path)
    const made = await this.run.call<{ id: string }>('POST', '/2.0/web_links', {
      json: { url: 'https://example.com', name, parent: { id: await this.folderAt(parent) } },
    })
    return made.id
  }

  /**
   * Move or rename the item at `path` to `to`, as another client would,
   * making the folders missing on the way.
   */
  async move(path: string, to: string): Promise<void> {
    const row = await this.rowAt(path)
    if (row === null) throw new Error(`nothing at ${path}`)
    const [parent, name] = placement(to)
    const kind = row.type === 'folder' ? 'folders' : 'files'
    await this.run.call('PUT', `/2.0/${kind}/${row.id}`, {
      json: { name, parent: { id: await this.folderAt(parent) } },
    })
  }

  /** Delete the item at `path`, a folder with everything in it. */
  async remove(path: string): Promise<void> {
    const row = await this.rowAt(path)
    if (row === null) throw new Error(`nothing at ${path}`)
    const kind: Record<string, string> = { file: 'files', folder: 'folders', web_link: 'web_links' }
    const query = row.type === 'folder' ? '?recursive=true' : ''
    await this.run.call('DELETE', `/2.0/${kind[row.type] ?? row.type}/${row.id}${query}`)
  }

  /** The bytes of the file at `path`; undefined if no file is there. */
  async content(path: string): Promise<Uint8Array | undefined> {
    const row = await this.rowAt(path)
    if (row?.type !== 'file') return undefined
    return this.run.read(`/2.0/files/${row.id}/content`)
  }

  /**
   * Store the file `id` with no sha1, as Box answers some; its new versions
   * keep none either. The run is reloaded, so a recording of its requests
   * stops.
   */
  async unhash(id: string): Promise<void> {
    await this.run.execute('UPDATE BoxItem SET sha1 = NULL WHERE id = ?', id)
  }

  /** What Box answers for the file `id`. */
  async fileInfo(id: string): Promise<FileAnswer> {
    return this.run.call<FileAnswer>('GET', `/2.0/files/${id}`)
  }
}
