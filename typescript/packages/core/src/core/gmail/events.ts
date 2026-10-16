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

import type { GmailAccessor } from '../../accessor/gmail.ts'
import { Delta, FileChangeKind, FileEvent, type PathSpec } from '../../types.ts'
import { mountPrefixOf } from '../../utils/key_prefix.ts'
import { compareCodePoints } from '../../utils/sort.ts'
import type { DeltaHook } from '../../events/base.ts'
import { changesUnder } from '../../events/delta.ts'
import { type TokenManager } from '../google/client.ts'
import { currentHistoryId, listHistory } from './history.ts'
import { type GmailLabel, listLabels } from './labels.ts'
import {
  extractAttachments,
  extractHeader,
  getMessageRaw,
  type GmailMessageRaw,
} from './messages.ts'
import { dateFromInternal, MSG_SUFFIX, msgFilename } from './readdir.ts'

/**
 * The paths a message is under `labelIds`: its file in each label's day
 * directory, and its attachment directory beside it when it has attachments,
 * named as the listings name them. Mirrors Python's `message_paths`.
 */
export function messagePaths(
  prefix: string,
  raw: GmailMessageRaw,
  labels: ReadonlyMap<string, GmailLabel>,
  labelIds: readonly string[],
): string[] {
  const mid = raw.id ?? ''
  const subject = extractHeader(raw.payload?.headers, 'Subject') || 'No Subject'
  const day = dateFromInternal(raw.internalDate ?? '0')
  const attached = extractAttachments(raw.payload).length > 0
  const file = msgFilename(subject, mid)
  const paths: string[] = []
  for (const labelId of labelIds) {
    const label = labels.get(labelId)
    if (label === undefined) continue
    const name = label.type === 'system' ? labelId : (label.name ?? labelId)
    paths.push(`${prefix}/${name}/${day}/${file}`)
    if (attached) paths.push(`${prefix}/${name}/${day}/${file.slice(0, -MSG_SUFFIX.length)}`)
  }
  return paths
}

/**
 * Each label's folder name, by label id, as the root listing names it: a
 * system label by its id, any other by its name. Mirrors Python's
 * `label_folders`.
 */
export function labelFolders(labels: readonly GmailLabel[]): Map<string, string> {
  return new Map(
    labels.map((label) => [
      label.id,
      label.type === 'system' ? label.id : (label.name ?? label.id),
    ]),
  )
}

/**
 * Record each label folder that left or was renamed, then each that appeared or
 * took a new name, and move the known paths below a renamed one (or forget them
 * below one that left), so a later change to one of its messages starts where
 * the message now is. Every path moves once, by the folder it was in: one label
 * can take the name another gave up in the same pull. Mirrors Python's
 * `_folders_moved`.
 */
function foldersMoved(
  changes: [FileChangeKind, string][],
  known: Map<string, string[]>,
  prefix: string,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): void {
  const moves = new Map<string, string | null>()
  for (const [labelId, name] of before) {
    const now = after.get(labelId)
    if (now !== name) moves.set(`${prefix}/${name}`, now === undefined ? null : `${prefix}/${now}`)
  }
  for (const old of moves.keys()) changes.push([FileChangeKind.DELETE, old])
  for (const [labelId, name] of after) {
    if (before.get(labelId) !== name) changes.push([FileChangeKind.CREATE, `${prefix}/${name}`])
  }
  for (const [mid, paths] of known) known.set(mid, moved(paths, moves))
}

/**
 * `paths` with each one in a moved folder put in its new one, or dropped when
 * its folder left. Mirrors Python's `_moved`.
 */
function moved(paths: readonly string[], moves: ReadonlyMap<string, string | null>): string[] {
  const out: string[] = []
  for (const path of paths) {
    const cut = path.lastIndexOf('/', path.lastIndexOf('/') - 1)
    const folder = path.slice(0, cut)
    const next = moves.get(folder)
    if (next === undefined) out.push(path)
    else if (next !== null) out.push(next + path.slice(cut))
  }
  return out
}

/**
 * Record how one message's paths moved: a path it left, one it reached, and
 * each message file it kept, whose labels changed. Mirrors Python's `_changed`.
 */
function changed(
  changes: [FileChangeKind, string][],
  before: readonly string[],
  after: readonly string[],
): void {
  const kept = new Set(before.filter((v) => after.includes(v)))
  for (const v of before) if (!kept.has(v)) changes.push([FileChangeKind.DELETE, v])
  for (const v of after) if (!kept.has(v)) changes.push([FileChangeKind.CREATE, v])
  for (const v of after) {
    if (kept.has(v) && v.endsWith(MSG_SUFFIX)) changes.push([FileChangeKind.UPDATE, v])
  }
}

/**
 * Checkpointed delta over Gmail's history. The checkpoint holds the history id
 * the next pull starts after, each label's folder name and, by message id, the
 * paths of each message a pull has seen. History records no label created,
 * renamed or deleted, so each pull lists the labels and compares the folders:
 * one that appeared, left or moved is reported whatever its messages did. A record names a message by id only, so each one added or
 * relabeled is read to name its paths: one under each label it holds, in the
 * day it arrived. Its labels before the record follow from the label changes
 * the records carry, so a relabel moves exactly the paths it should, and a file
 * it keeps is updated, since its labels are part of its content. A message
 * deleted for good cannot be read any more: one a pull has seen leaves the
 * paths it was, and one it has not reports the event root as unknown, as a
 * history id Gmail no longer keeps does. Mirrors Python's GmailDeltaHook.
 */
export class GmailDeltaHook implements DeltaHook {
  constructor(private readonly accessor: GmailAccessor) {}

  async pull(root: PathSpec, checkpoint: string | null): Promise<Delta> {
    const tm = this.accessor.tokenManager
    const state = decode(checkpoint)
    if (state === null) return new Delta({ changes: [], checkpoint: await baseline(tm) })
    const [start, folders, known] = state
    const observed = new Date()
    let records: Record<string, unknown>[]
    let latest: string
    try {
      ;[records, latest] = await listHistory(tm, start)
    } catch (err) {
      if ((err as { status?: unknown }).status !== 404) throw err
      console.debug(`gmail history ${start} is gone: ${String(err)}`)
      const lost = new FileEvent({ kind: FileChangeKind.UNKNOWN, path: root, timestamp: observed })
      return new Delta({ changes: [lost], checkpoint: await baseline(tm) })
    }
    const prefix = mountPrefixOf(root.virtual, root.vfsPath).replace(/\/+$/, '')
    const listed = await listLabels(tm)
    const labels = new Map(listed.map((label) => [label.id, label]))
    const nowFolders = labelFolders(listed)
    const changes: [FileChangeKind, string][] = []
    foldersMoved(changes, known, prefix, folders, nowFolders)
    const added = new Set<string>()
    const first = new Map<string, Map<string, boolean>>()
    const gone: string[] = []
    const seenOf = (mid: string): Map<string, boolean> => {
      const seen = first.get(mid) ?? new Map<string, boolean>()
      first.set(mid, seen)
      return seen
    }
    for (const record of records) {
      for (const item of (record.messagesAdded ?? []) as {
        message?: { id?: string }
        labelIds?: string[]
      }[]) {
        const mid = item.message?.id ?? ''
        added.add(mid)
        seenOf(mid)
      }
      for (const [key, removes] of [
        ['labelsAdded', false],
        ['labelsRemoved', true],
      ] as const) {
        for (const item of (record[key] ?? []) as {
          message?: { id?: string }
          labelIds?: string[]
        }[]) {
          const seen = seenOf(item.message?.id ?? '')
          for (const labelId of item.labelIds ?? []) {
            if (!seen.has(labelId)) seen.set(labelId, removes)
          }
        }
      }
      for (const item of (record.messagesDeleted ?? []) as {
        message?: { id?: string }
        labelIds?: string[]
      }[]) {
        gone.push(item.message?.id ?? '')
      }
    }
    for (const [mid, seen] of first) {
      if (gone.includes(mid)) continue
      let raw: GmailMessageRaw
      try {
        raw = await getMessageRaw(tm, mid)
      } catch (err) {
        if ((err as { status?: unknown }).status !== 404) throw err
        console.debug(`gmail message ${mid} is gone: ${String(err)}`)
        gone.push(mid)
        continue
      }
      const now = raw.labelIds ?? []
      const after = messagePaths(prefix, raw, labels, now)
      let before = known.get(mid)
      if (before === undefined) {
        const held = [
          ...now.filter((label) => !seen.has(label)),
          ...[...seen].filter(([, removes]) => removes).map(([label]) => label),
        ]
        before = added.has(mid) ? [] : messagePaths(prefix, raw, labels, held)
      }
      changed(changes, before, after)
      known.set(mid, after)
    }
    let unknown = false
    for (const mid of new Set(gone)) {
      const was = known.get(mid)
      known.delete(mid)
      if (was !== undefined) changed(changes, was, [])
      else if (!added.has(mid)) unknown = true
    }
    const events = changesUnder(root, changes, observed)
    if (unknown) {
      events.push(new FileEvent({ kind: FileChangeKind.UNKNOWN, path: root, timestamp: observed }))
    }
    return new Delta({ changes: events, checkpoint: encode(latest, nowFolders, known) })
  }
}

/**
 * A checkpoint at the mailbox's present: its history id and its label folders,
 * with no message seen yet. Mirrors Python's `_baseline`.
 */
async function baseline(tm: TokenManager): Promise<string> {
  const history = await currentHistoryId(tm)
  return encode(history, labelFolders(await listLabels(tm)), new Map())
}

function encode(
  historyId: string,
  folders: ReadonlyMap<string, string>,
  known: ReadonlyMap<string, readonly string[]>,
): string {
  const labels: Record<string, string> = {}
  for (const id of [...folders.keys()].sort(compareCodePoints)) labels[id] = folders.get(id) ?? id
  const messages: Record<string, readonly string[]> = {}
  for (const mid of [...known.keys()].sort(compareCodePoints)) messages[mid] = known.get(mid) ?? []
  return JSON.stringify({ gmail: { history: historyId, labels, messages } })
}

/**
 * The history id, the label folders and the known paths a checkpoint holds,
 * null for a baseline. Mirrors Python's `_decode`.
 */
function decode(
  checkpoint: string | null,
): [string, Map<string, string>, Map<string, string[]>] | null {
  if (checkpoint === null) return null
  const data = JSON.parse(checkpoint) as {
    gmail?: {
      history?: unknown
      labels?: Record<string, unknown>
      messages?: Record<string, unknown[]>
    }
  }
  const state = data.gmail
  if (state === undefined || typeof state.history !== 'string') return null
  return [
    state.history,
    new Map(Object.entries(state.labels ?? {}).map(([id, name]) => [id, String(name)])),
    new Map(Object.entries(state.messages ?? {}).map(([mid, paths]) => [mid, paths.map(String)])),
  ]
}

/** Build the Gmail delta hook (`GmailDeltaHook`). Mirrors Python's `build_delta_hook`. */
export function buildDeltaHook(accessor: GmailAccessor): DeltaHook {
  return new GmailDeltaHook(accessor)
}
