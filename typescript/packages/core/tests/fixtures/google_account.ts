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

import { KitRun, type JsonValue } from './kit_fake.ts'

export const TOKEN = 'gws-integ-token'
export const FILE_MIME = 'application/octet-stream'
export const FOLDER_MIME = 'application/vnd.google-apps.folder'
export const FILES = '/drive/v3/files'
export const FILE = '/drive/v3/files/:id'
export const DRIVES = '/drive/v3/drives'
export const UPLOAD = '/upload/drive/v3/files'
export const UPLOAD_FILE = '/upload/drive/v3/files/:id'
export const REVISION = '/drive/v3/files/:id/revisions/:revisionId'
export const MEDIA_QUERY = 'alt=media&supportsAllDrives=true'
export const CALENDARS = '/calendar/v3/calendars'
export const EVENTS = '/calendar/v3/calendars/:calendarId/events'
export const EVENT = '/calendar/v3/calendars/:calendarId/events/:eventId'
export const PRIMARY = 'integ@example.com'
export const GMAIL = '/gmail/v1/users/me'
export const MESSAGES = '/gmail/v1/users/me/messages'
export const MESSAGE = '/gmail/v1/users/me/messages/:id'
export const HISTORY = '/gmail/v1/users/me/history'
export const UNTIL_CLEARED = 1_000_000

const BOUNDARY = 'mirage-test-part'
const PARENTS = /'((?:[^'\\]|\\.)*)' in parents/g
const TEXT = /fullText contains '((?:[^'\\]|\\.)*)'/
const ENC = new TextEncoder()

// A calendar's events collection.
function eventsOf(calendar = PRIMARY): string {
  return `${CALENDARS}/${encodeURIComponent(calendar)}/events`
}

/** A Drive item as the fake answers it, as far as these tests read one. */
export interface DriveItem {
  [key: string]: JsonValue
  id: string
  name: string
  mimeType: string
  parents: string[]
  modifiedTime: string
}

/** A Drive listing answer. */
export interface DriveListing {
  [key: string]: JsonValue
  files: DriveItem[]
}

/** One request the fake listed. */
export interface Asked {
  method: string
  route: string
  path: string
  query: string
  body: JsonValue
}

/**
 * One Drive listing a client asked for: the folders its query names, the
 * shared drive it is asked in, the largest page it takes, whether it asks a
 * whole level of folders at once (as a tree walk does) rather than one
 * folder, the words a full-text search asks for, and its query string as
 * sent.
 */
export interface Listing {
  folders: string[]
  drive: string | null
  pageSize: number
  level: boolean
  text: string | null
  query: string
}

/** One attachment of a message: its file name, MIME type and bytes. */
export type Attachment = [string, string, string | Uint8Array]

/** A Gmail message as the fake answers it in full, as far as these tests read one. */
export interface GmailItem {
  [key: string]: JsonValue
  id: string
  sizeEstimate: number
  payload: { [key: string]: JsonValue; parts: { body: { attachmentId: string } }[] }
}

/** A Calendar event as the fake answers it, as far as these tests read one. */
export interface CalendarItem {
  [key: string]: JsonValue
  id: string
}

/**
 * One account on the Google Workspace fake, and what a test arranges its
 * Drive, its calendars and its mailbox by.
 *
 * Every change is the request a client of the service makes, so each id,
 * time, checksum and revision is one the fake hands out, as Google's are. It
 * needs nothing of core's own code, so node's suites, which test core's
 * build, use it as it is.
 */
export class GoogleAccount {
  readonly run: KitRun

  /** @param origin the Workspace fake's origin. */
  constructor(origin: string) {
    this.run = new KitRun(origin, { Authorization: `Bearer ${TOKEN}` })
  }

  /** A mount config's fields signed in to this account, plus `fields`. */
  fields(fields: Record<string, JsonValue> = {}): Record<string, JsonValue> {
    return { access_token: TOKEN, api_base: this.run.url, ...fields }
  }

  /** Make a folder in `parent` and answer its id. */
  folder(name: string, parent = 'root'): Promise<string> {
    return this.create(name, FOLDER_MIME, parent)
  }

  /**
   * Make an item with no content, a folder or a Docs, Sheets or Slides file,
   * in `parent` and answer its id.
   */
  async create(name: string, mime: string, parent = 'root'): Promise<string> {
    const made = await this.run.call<DriveItem>('POST', FILES, {
      json: { name, mimeType: mime, parents: [parent] },
    })
    return made.id
  }

  /** Upload a file holding `data` to `parent` and answer its id. */
  async upload(
    name: string,
    data: string | Uint8Array = '',
    parent = 'root',
    mime = FILE_MIME,
  ): Promise<string> {
    const metadata = JSON.stringify({ name, mimeType: mime, parents: [parent] })
    const head = ENC.encode(
      `--${BOUNDARY}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n` +
        `--${BOUNDARY}\r\nContent-Type: ${mime}\r\n\r\n`,
    )
    const bytes = typeof data === 'string' ? ENC.encode(data) : data
    const tail = ENC.encode(`\r\n--${BOUNDARY}--\r\n`)
    const body = new Uint8Array(head.length + bytes.length + tail.length)
    body.set(head)
    body.set(bytes, head.length)
    body.set(tail, head.length + bytes.length)
    const made = await this.run.call<DriveItem>('POST', `${UPLOAD}?uploadType=multipart`, {
      body,
      headers: { 'Content-Type': `multipart/related; boundary=${BOUNDARY}` },
    })
    return made.id
  }

  /**
   * Upload `data` at `path` in My Drive, making each folder on the way that
   * is not there yet, and answer the file's id; a file already at the path
   * takes the bytes as a new revision.
   */
  async put(path: string, data: string | Uint8Array): Promise<string> {
    const parts = path.split('/').filter((part) => part !== '')
    const name = parts.pop() ?? ''
    let parent = 'root'
    for (const folder of parts) {
      const held = (await this.listing(parent)).files.find(
        (row) => row.name === folder && row.mimeType === FOLDER_MIME,
      )
      parent = held?.id ?? (await this.folder(folder, parent))
    }
    const file = (await this.listing(parent)).files.find(
      (row) => row.name === name && row.mimeType !== FOLDER_MIME,
    )
    if (file === undefined) return this.upload(name, data, parent)
    await this.update(file.id, data)
    return file.id
  }

  /** Replace a file's bytes, a new revision, and answer it as Drive does. */
  update(fileId: string, data: string | Uint8Array): Promise<DriveItem> {
    return this.run.call<DriveItem>('PATCH', `${UPLOAD}/${fileId}?uploadType=media`, {
      body: typeof data === 'string' ? ENC.encode(data) : data,
    })
  }

  /** Change an item's metadata and answer it as Drive does. */
  patch(fileId: string, body: Record<string, JsonValue>): Promise<DriveItem> {
    return this.run.call<DriveItem>('PATCH', `${FILES}/${fileId}`, { json: body })
  }

  /** Delete an item, and everything in it for a folder. */
  async delete(fileId: string): Promise<void> {
    await this.run.call('DELETE', `${FILES}/${fileId}`)
  }

  /**
   * Make a shared drive and answer its id, which is also the id of the
   * folder at its top.
   */
  async sharedDrive(name: string): Promise<string> {
    const made = await this.run.call<{ id: string }>('POST', DRIVES, { json: { name } })
    return made.id
  }

  /** An item as Drive answers a request for it. */
  item(fileId: string): Promise<DriveItem> {
    return this.run.call<DriveItem>('GET', `${FILES}/${fileId}`)
  }

  /** What Drive answers for a listing of a folder's untrashed items. */
  listing(folderId = 'root', driveId?: string): Promise<DriveListing> {
    const params = new URLSearchParams({ q: `'${folderId}' in parents and trashed=false` })
    if (driveId !== undefined) {
      params.set('driveId', driveId)
      params.set('includeItemsFromAllDrives', 'true')
    }
    return this.run.call<DriveListing>('GET', `${FILES}?${params.toString()}`)
  }

  /** Answer the next `times` requests to `route` with Drive's refusal. */
  async refuse(
    method: string,
    route: string,
    status: number,
    message: string,
    opts: { reason?: string; times?: number; path?: string } = {},
  ): Promise<void> {
    const error = { message, domain: 'global', reason: opts.reason ?? 'forbidden' }
    await this.run.answerNext(
      method,
      route,
      status,
      { error: { code: status, message, errors: [error] } },
      opts.times ?? 1,
      opts.path,
    )
  }

  /**
   * Start the run afresh in the fake's base world: the account's own primary
   * calendar and its mailbox's system labels, which no request makes, so a
   * test reading either calls this first. `extras` are further states no
   * request makes, as `calendars`.
   */
  async reset(extras: Record<string, JsonValue> = {}): Promise<void> {
    await this.run.call('POST', '/reset', { json: { extras } })
  }

  /**
   * Give the account the calendars `entries` name, each with its role and
   * its events: a calendar another account shares, and the role it is
   * shared with, is a state no request makes, so it rides the fake's reset.
   * The run starts afresh, so this comes first.
   */
  async calendars(...entries: Record<string, JsonValue>[]): Promise<void> {
    await this.reset({ calendars: entries })
  }

  /**
   * Make an event and answer its id; a `YYYY-MM-DD` pair is an all-day
   * event. `opts` names its calendar, the id to give it (one the fake mints
   * when absent) and further fields, as `description`.
   */
  async event(
    summary: string,
    start: string,
    end: string,
    opts: { calendar?: string; eventId?: string; fields?: Record<string, JsonValue> } = {},
  ): Promise<string> {
    const key = start.length === 10 ? 'date' : 'dateTime'
    const body: Record<string, JsonValue> = {
      summary,
      start: { [key]: start },
      end: { [key]: end },
      ...opts.fields,
    }
    if (opts.eventId !== undefined) body.id = opts.eventId
    const made = await this.run.call<CalendarItem>('POST', eventsOf(opts.calendar), { json: body })
    return made.id
  }

  /** Change an event's fields. */
  async changeEvent(
    eventId: string,
    fields: Record<string, JsonValue>,
    calendar = PRIMARY,
  ): Promise<void> {
    await this.run.call('PATCH', `${eventsOf(calendar)}/${eventId}`, { json: fields })
  }

  /** Delete an event. */
  async deleteEvent(eventId: string, calendar = PRIMARY): Promise<void> {
    await this.run.call('DELETE', `${eventsOf(calendar)}/${eventId}`)
  }

  /** An event as Calendar answers a request for it, in its calendar's zone. */
  eventItem(eventId: string, calendar = PRIMARY): Promise<CalendarItem> {
    return this.run.call<CalendarItem>('GET', `${eventsOf(calendar)}/${eventId}`)
  }

  /** Change a calendar's own details, as `summary` or `timeZone`, on one the account owns. */
  async changeCalendar(fields: Record<string, JsonValue>, calendar = PRIMARY): Promise<void> {
    await this.run.call('PATCH', `${CALENDARS}/${encodeURIComponent(calendar)}`, { json: fields })
  }

  /** The sync token a whole listing of the calendar ends with now. */
  async syncToken(calendar = PRIMARY): Promise<string> {
    const made = await this.run.call<{ nextSyncToken: string }>('GET', eventsOf(calendar))
    return made.nextSyncToken
  }

  /**
   * Each Calendar request made since recording started: an events listing
   * `['list', calendar, timeMin, timeMax]`, with null for a bound it leaves
   * open, a search `['search', calendar, q]`, and a deletion
   * `['delete', calendar, event]`; any other request is named by its method
   * and route, with its path.
   */
  async calendarLog(): Promise<(string | null)[][]> {
    const listed = await this.run.call<{ requests: Asked[] }>('GET', '/_kit/requests')
    return listed.requests.map((r) => {
      const parts = r.path.split('/').map((part) => decodeURIComponent(part))
      const query = new URLSearchParams(r.query)
      if (r.method === 'GET' && r.route === EVENTS) {
        const q = query.get('q')
        if (q !== null) return ['search', parts[4] ?? '', q]
        return ['list', parts[4] ?? '', query.get('timeMin'), query.get('timeMax')]
      }
      if (r.method === 'DELETE' && r.route === EVENT) {
        return ['delete', parts[4] ?? '', parts[6] ?? '']
      }
      return [`${r.method} ${r.route}`, r.path]
    })
  }

  /**
   * Put a message in the mailbox, dated by its Date header, and answer its
   * id. `opts` names the labels it carries, by name (one the mailbox has not
   * is made), its From, its Date, which is the time Gmail files it at, its
   * To and its attachments.
   */
  async message(
    subject: string,
    body: string,
    opts: {
      labels?: string[]
      sender?: string
      date?: string
      to?: string
      attachments?: Attachment[]
    } = {},
  ): Promise<string> {
    const mark = 'mirage-test-mail'
    const parts = [`--${mark}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`]
    for (const [filename, mime, data] of opts.attachments ?? []) {
      const encoded = Buffer.from(typeof data === 'string' ? ENC.encode(data) : data).toString(
        'base64',
      )
      parts.push(
        `--${mark}\r\nContent-Type: ${mime}; name="${filename}"\r\n` +
          `Content-Disposition: attachment; filename="${filename}"\r\n` +
          `Content-Transfer-Encoding: base64\r\n\r\n${encoded}\r\n`,
      )
    }
    const raw =
      `From: ${opts.sender ?? 'Ana <ana@example.com>'}\r\nTo: ${opts.to ?? 'me@example.com'}\r\n` +
      `Subject: ${subject}\r\nDate: ${opts.date ?? 'Mon, 5 Jan 2026 09:00:00 +0000'}\r\n` +
      `MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${mark}"\r\n\r\n` +
      parts.join('') +
      `--${mark}--\r\n`
    const made = await this.run.call<{ id: string }>(
      'POST',
      `${MESSAGES}?internalDateSource=dateHeader`,
      {
        json: {
          raw: Buffer.from(raw).toString('base64url'),
          labelIds: opts.labels ?? ['INBOX'],
        },
      },
    )
    return made.id
  }

  /** A message as Gmail answers a request for it in full. */
  mail(messageId: string): Promise<GmailItem> {
    return this.run.call<GmailItem>('GET', `${MESSAGES}/${messageId}?format=full`)
  }

  /** Make a user label and answer its id. */
  async label(name: string): Promise<string> {
    return (await this.run.call<{ id: string }>('POST', `${GMAIL}/labels`, { json: { name } })).id
  }

  /** The history id the mailbox is at. */
  async historyId(): Promise<string> {
    return (await this.run.call<{ historyId: string }>('GET', `${GMAIL}/profile`)).historyId
  }

  /** Move a message to the trash. */
  async trash(messageId: string): Promise<void> {
    await this.run.call('POST', `${MESSAGES}/${messageId}/trash`)
  }

  /** Add labels to a message and take others off it, by label id. */
  async modify(messageId: string, add: string[] = [], remove: string[] = []): Promise<void> {
    await this.run.call('POST', `${MESSAGES}/${messageId}/modify`, {
      json: { addLabelIds: add, removeLabelIds: remove },
    })
  }

  /** Delete a message for good. */
  async deleteMessage(messageId: string): Promise<void> {
    await this.run.call('DELETE', `${MESSAGES}/${messageId}`)
  }

  /** Rename a user label. */
  async renameLabel(labelId: string, name: string): Promise<void> {
    await this.run.call('PATCH', `${GMAIL}/labels/${labelId}`, { json: { name } })
  }

  /** Delete a user label, which every message holding it loses. */
  async deleteLabel(labelId: string): Promise<void> {
    await this.run.call('DELETE', `${GMAIL}/labels/${labelId}`)
  }

  /** The untrashed item named `name` in My Drive, null when there is none. */
  async find(name: string): Promise<DriveItem | null> {
    const params = new URLSearchParams({ q: `name = '${name}' and trashed = false` })
    const made = await this.run.call<DriveListing>('GET', `${FILES}?${params.toString()}`)
    return made.files[0] ?? null
  }

  /** Every untrashed item in My Drive, as Drive answers them. */
  async items(): Promise<DriveItem[]> {
    const params = new URLSearchParams({ q: 'trashed = false', pageSize: '1000' })
    return (await this.run.call<DriveListing>('GET', `${FILES}?${params.toString()}`)).files
  }

  /** The bytes a file holds now, as text. */
  async content(fileId: string): Promise<string> {
    return new TextDecoder().decode(await this.run.read(`${FILES}/${fileId}?alt=media`))
  }

  /** Each request to `route` since recording started, as the fake lists it. */
  async asked(method: string, route: string): Promise<Asked[]> {
    const listed = await this.run.call<{ requests: Asked[] }>('GET', '/_kit/requests')
    return listed.requests.filter((r) => r.method === method && r.route === route)
  }

  /** Each Drive listing asked since recording started, in order. */
  async listings(): Promise<Listing[]> {
    return (await this.asked('GET', FILES)).map((r) => {
      const query = new URLSearchParams(r.query)
      const q = query.get('q') ?? ''
      return {
        folders: [...q.matchAll(PARENTS)].map((m) => m[1] ?? ''),
        drive: query.get('driveId'),
        pageSize: Number(query.get('pageSize') ?? '0'),
        level: q.startsWith('('),
        text: TEXT.exec(q)?.[1] ?? null,
        query: r.query,
      }
    })
  }

  /**
   * Each request made since recording started, as `[name, detail]`. A
   * listing is `list` with the folders its query names joined by commas, an
   * item `get` and its bytes `media`, each with its id, a revision's bytes
   * `revision` with its revision id, and the shared drives `drives`; any
   * other request is named by its method and route, with its path.
   */
  async log(): Promise<[string, string][]> {
    const listed = await this.run.call<{ requests: Asked[] }>('GET', '/_kit/requests')
    return listed.requests.map((r): [string, string] => {
      const query = new URLSearchParams(r.query)
      const last = r.path.slice(r.path.lastIndexOf('/') + 1)
      if (r.method === 'GET' && r.route === FILES) {
        const folders = [...(query.get('q') ?? '').matchAll(PARENTS)].map((m) => m[1] ?? '')
        return ['list', folders.join(',')]
      }
      if (r.method === 'GET' && r.route === FILE) {
        return [query.get('alt') === 'media' ? 'media' : 'get', last]
      }
      if (r.method === 'GET' && r.route === REVISION) return ['revision', last]
      if (r.method === 'GET' && r.route === DRIVES) return ['drives', '']
      return [`${r.method} ${r.route}`, r.path]
    })
  }
}
