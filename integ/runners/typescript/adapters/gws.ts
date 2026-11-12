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

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MailEntry } from '../../../server/mail/rfc822.ts'
import { buildRfc822 } from '../../../server/mail/rfc822.ts'
import type { Target } from '../harness.ts'
import { integRoot } from '../harness.ts'
import { runId } from '../../../server/kit/typescript/tenant.ts'

// The gws fake's world for a target, shared by the node adapter and the
// Cloudflare battery: both open their mounts over the same seeded run.
const GDRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder'

// The gws fake's credential: a bearer as it is, and the one refresh token its
// /token exchanges.
export const GWS_TOKEN = 'gws-integ-token'

async function gwsJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const headers = new Headers(init?.headers)
  headers.set('Authorization', `Bearer ${GWS_TOKEN}`)
  const r = await fetch(url, { ...init, headers })
  if (!r.ok) throw new Error(`gws fake request failed: ${url} -> ${String(r.status)}`)
  return (await r.json()) as Record<string, unknown>
}

async function gwsFolder(base: string, name: string, parent: string): Promise<string> {
  const q = `name='${name}' and '${parent}' in parents and trashed=false`
  const listed = await gwsJson(`${base}/drive/v3/files?q=${encodeURIComponent(q)}`)
  const files = listed.files as { id: string }[]
  const first = files[0]
  if (first !== undefined) return first.id
  const created = await gwsJson(`${base}/drive/v3/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: GDRIVE_FOLDER_MIME, parents: [parent] }),
  })
  return created.id as string
}

// The fake Google Workspace server is external and shared; /reset gives
// each run a clean, deterministic state. Each mount is scoped to a
// per-mount folder via GoogleConfig.folderId, the s3 key_prefix analog.
interface GwsAppEntry {
  kind: 'doc' | 'sheet' | 'slide'
  name: string
  text?: string
  rows?: string[][]
}

// Native files are API objects, not byte blobs, so they seed through the
// same editor APIs the backends speak instead of fixture uploads.
async function seedGwsApps(base: string, entries: GwsAppEntry[]): Promise<void> {
  for (const entry of entries) {
    if (entry.kind === 'doc') {
      const doc = await gwsJson(`${base}/v1/documents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: entry.name }),
      })
      const requests = [{ insertText: { location: { index: 1 }, text: entry.text ?? '' } }]
      await gwsJson(`${base}/v1/documents/${doc.documentId as string}:batchUpdate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }),
      })
    } else if (entry.kind === 'sheet') {
      const sheet = await gwsJson(`${base}/v4/spreadsheets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ properties: { title: entry.name } }),
      })
      const id = sheet.spreadsheetId as string
      await gwsJson(`${base}/v4/spreadsheets/${id}/values/Sheet1:append`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: entry.rows ?? [] }),
      })
    } else {
      await gwsJson(`${base}/v1/presentations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: entry.name }),
      })
    }
  }
}

interface CalendarEntry {
  summary: string
  // A timed event carries dateTime with a mandatory offset; an all-day one
  // carries a floating date and no zone at all.
  start: { date?: string; dateTime?: string }
  end: { date?: string; dateTime?: string }
}

interface SeedCalendar {
  id: string
  summary: string
  timeZone?: string
  accessRole?: string
  hidden?: boolean
  events?: CalendarEntry[]
}

interface SeedForm {
  title: string
  documentTitle?: string
  description?: string
  items?: Record<string, unknown>[]
  responses?: Record<string, unknown>[]
}

interface CalendarFixture {
  events: CalendarEntry[]
  calendars?: SeedCalendar[]
}

function gwsManifest<T>(name: string | undefined): T | undefined {
  if (name === undefined) return undefined
  return JSON.parse(readFileSync(join(integRoot(), 'fixtures', `${name}.json`), 'utf8')) as T
}

// Messages are API objects: each manifest entry becomes an RFC822 payload
// inserted through messages.insert with internalDateSource=dateHeader, so
// date dirs come from the manifest, not the server clock.
async function seedGwsMail(base: string, entries: MailEntry[]): Promise<void> {
  for (const entry of entries) {
    const raw = Buffer.from(buildRfc822(entry), 'utf-8')
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
    await gwsJson(`${base}/gmail/v1/users/me/messages?internalDateSource=dateHeader`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw, labelIds: entry.labels ?? [] }),
    })
  }
}

// Events are API objects, so they seed through events.insert and take the
// ids the server mints; the manifest pins the times, which is what the day
// directories are derived from.
async function seedGwsCalendar(base: string, entries: CalendarEntry[]): Promise<void> {
  for (const entry of entries) {
    await gwsJson(`${base}/calendar/v3/calendars/primary/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    })
  }
}

/**
 * A gws target's own world on the fake, which both hosts' batteries open
 * their mounts over: its run scoped, reset, its drives and folders made
 * and its apps, mail and events seeded. Returns the run's base and each
 * gdrive mount's folder id.
 */
export async function seedGwsWorld(
  target: Target,
): Promise<{ base: string; folderIds: Record<string, string> }> {
  let base = process.env.GWS_URL ?? ''
  while (base.endsWith('/')) base = base.slice(0, -1)
  if (base === '') throw new Error('gdrive target requires GWS_URL')
  // Every call below goes to this run's own world. gws keeps per-run state
  // already; what it lacked was a way for a mount to ask for one, since a
  // mount hands its base URL to a client and never sees the request. Scoping
  // the base once covers the reset, the drive and folder creation, the seeds
  // and every mount, which is what makes this one line rather than sixteen.
  base = `${base}/_run/${runId()}`
  // Native mounts (gdocs/gsheets/gslides) render the modified date into
  // filenames, so those targets pin the server clock. Secondary calendars
  // and seeded form responses ride the same call rather than being
  // inserted: a calendar's accessRole and a form response are both states
  // no API call can produce. They go under `extras`, the kit's channel for
  // a seed a fixture row cannot state; the base world (system labels, the
  // primary calendar) is fixture rows now that gws seeds through the kit.
  const calendar = gwsManifest<CalendarFixture>(target.calendar)
  const forms = gwsManifest<SeedForm[]>(target.forms)
  const reset: Record<string, unknown> = {}
  const extras: Record<string, unknown> = {}
  if (target.epoch !== undefined) reset.epoch = target.epoch
  if (calendar?.calendars !== undefined) extras.calendars = calendar.calendars
  if (forms !== undefined) extras.forms = forms
  // A multi-tab document is the third such state: the Docs API has no
  // request that creates a tab, so one cannot be seeded through the editor
  // APIs the way the single-tab `apps` docs are.
  const docTabDocs = gwsManifest<unknown[]>(target.docs)
  if (docTabDocs !== undefined) extras.docs = docTabDocs
  if (Object.keys(extras).length > 0) reset.extras = extras
  await gwsJson(`${base}/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reset),
  })
  const driveIds: Record<string, string> = {}
  const folderIds: Record<string, string> = {}
  for (const m of target.mounts) {
    if (m.vfs !== 'gdrive') continue
    // A mount may live inside a Shared Drive: the drive is created once
    // per name and its id is the walk's start.
    const drive = m.drive
    if (drive !== undefined && !(drive in driveIds)) {
      const created = (await gwsJson(`${base}/drive/v3/drives`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: drive }),
      })) as { id: string }
      driveIds[drive] = created.id
    }
    let parent = drive !== undefined ? (driveIds[drive] as string) : 'root'
    for (const segment of String(m.root).split('/')) {
      parent = await gwsFolder(base, segment, parent)
    }
    folderIds[m.path] = parent
  }
  const apps = gwsManifest<GwsAppEntry[]>(target.apps)
  if (apps !== undefined) await seedGwsApps(base, apps)
  const mail = gwsManifest<MailEntry[]>(target.mail)
  if (mail !== undefined) await seedGwsMail(base, mail)
  if (calendar !== undefined) await seedGwsCalendar(base, calendar.events)
  return { base, folderIds }
}
