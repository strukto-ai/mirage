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

import { FileEvent, type FileChangeKind, type JsonValue, type PathSpec } from '../types.ts'
import { mountPrefixOf } from '../utils/key_prefix.ts'
import { rstripSlash, stripSlash } from '../utils/slash.ts'
import { specFor } from './delta.ts'

/**
 * Lift a mount-relative path onto the mount `root` sits behind.
 *
 * Mirrors Python `virtual_of` (`watch/events.py`).
 */
export function virtualOf(root: PathSpec, relative: string): string {
  const prefix = rstripSlash(mountPrefixOf(root.virtual, root.vfsPath))
  const stem = stripSlash(relative)
  if (stem === '') return prefix === '' ? '/' : prefix
  return prefix === '' ? `/${stem}` : `${prefix}/${stem}`
}

/**
 * Build one framed `FileEvent` for a mount-relative path.
 *
 * The timestamp is when the mapping ran, not when the service says the change
 * happened: `FileEvent` documents its stamp as the observation time, and a
 * service clock would be a different clock from every other producer's.
 *
 * Mirrors Python `event_at` (`watch/events.py`).
 */
export function eventAt(
  root: PathSpec,
  relative: string,
  kind: FileChangeKind,
  previous: string | null = null,
): FileEvent {
  return new FileEvent({
    kind,
    path: specFor(root, virtualOf(root, relative)),
    timestamp: new Date(),
    previousPath: previous === null ? null : specFor(root, virtualOf(root, previous)),
  })
}

/**
 * Read one field from a notification body, or undefined.
 *
 * A payload arrives as whatever the service sent, so it may not be an object
 * at all; a reader that assumed one would throw on a malformed delivery
 * rather than skipping it.
 *
 * Mirrors Python `field` (`watch/events.py`).
 */
export function field(payload: JsonValue, name: string): JsonValue | undefined {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  return payload[name]
}

/**
 * Read one string field from a notification body, or undefined.
 *
 * Mirrors Python `text_field` (`watch/events.py`).
 */
export function textField(payload: JsonValue, name: string): string | undefined {
  const value = field(payload, name)
  return typeof value === 'string' ? value : undefined
}
