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

import {
  FileChangeKind,
  type FileEvent,
  type JsonValue,
  type PathSpec,
} from '@struktoai/mirage-core/types'
import { eventAt, field, textField } from '@struktoai/mirage-core/watch/index'
import type { NextcloudAccessor } from '../../accessor/nextcloud.ts'

// The node event classes `webhook_listeners` sends, and the change each one
// is.
const KIND_BY_CLASS: Readonly<Record<string, FileChangeKind>> = {
  'OCP\\Files\\Events\\Node\\NodeCreatedEvent': FileChangeKind.CREATE,
  'OCP\\Files\\Events\\Node\\NodeWrittenEvent': FileChangeKind.UPDATE,
  'OCP\\Files\\Events\\Node\\NodeTouchedEvent': FileChangeKind.UPDATE,
  'OCP\\Files\\Events\\Node\\NodeDeletedEvent': FileChangeKind.DELETE,
  'OCP\\Files\\Events\\Node\\NodeRenamedEvent': FileChangeKind.MOVE,
}

const DAV = '/remote.php/dav/files/'
const WEBDAV = '/remote.php/webdav'

/**
 * Map one Nextcloud `webhook_listeners` delivery onto mount paths.
 *
 * The consumer registers a webhook for the node events (Nextcloud 30 and
 * later) and passes each delivery's `event.class` with its body. Nothing here
 * runs a loop. A delivery names the node by its path in the instance,
 * `/<user>/files/<path>`; the mount is rooted at the WebDAV folder its URL
 * names, so the hook reads that root from the URL and maps only the nodes
 * below it. A rename into the mount is a CREATE and one out of it a DELETE; a
 * node outside it, or an event class the watcher does not model, maps to
 * nothing.
 *
 * Mirrors Python `NextcloudEventHook` (`core/nextcloud/watch.py`).
 */
export class NextcloudEventHook {
  private readonly root: string | null

  constructor(accessor: NextcloudAccessor) {
    this.root = filesRoot(accessor)
  }

  toEvents(root: PathSpec, eventClass: string, payload: JsonValue): Promise<readonly FileEvent[]> {
    return Promise.resolve(this.map(root, eventClass, payload))
  }

  /** The mount-relative path of an instance path, or null outside the mount. */
  private relative(node: string | undefined): string | null {
    const root = this.root
    if (node === undefined || root === null) return null
    const path = node.replace(/\/+$/, '')
    if (path === root) return ''
    return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null
  }

  private map(root: PathSpec, eventClass: string, payload: JsonValue): readonly FileEvent[] {
    const kind = Object.hasOwn(KIND_BY_CLASS, eventClass) ? KIND_BY_CLASS[eventClass] : undefined
    const event = field(payload, 'event') ?? null
    if (kind === undefined) return []
    if (kind !== FileChangeKind.MOVE) {
      const place = this.relative(textField(field(event, 'node') ?? null, 'path'))
      return place === null ? [] : [eventAt(root, place, kind)]
    }
    const source = this.relative(textField(field(event, 'source') ?? null, 'path'))
    const target = this.relative(textField(field(event, 'target') ?? null, 'path'))
    if (source !== null && target !== null) return [eventAt(root, target, kind, source)]
    if (target !== null) return [eventAt(root, target, FileChangeKind.CREATE)]
    if (source !== null) return [eventAt(root, source, FileChangeKind.DELETE)]
    return []
  }
}

/**
 * The instance path the mount's WebDAV URL is rooted at,
 * `/<user>/files[/<folder>]`, or null for a URL of another shape.
 */
function filesRoot(accessor: NextcloudAccessor): string | null {
  const config = accessor.config
  const path = decodeURIComponent(new URL(config.url).pathname).replace(/\/+$/, '')
  let user: string
  let folder: string
  if (`${path}/`.includes(DAV)) {
    const rest = `${path}/`.split(DAV).slice(1).join(DAV)
    const cut = rest.indexOf('/')
    user = rest.slice(0, cut)
    folder = rest.slice(cut + 1)
  } else if (path.includes(WEBDAV) && config.username) {
    user = config.username
    folder = path.split(WEBDAV).slice(1).join(WEBDAV)
  } else {
    return null
  }
  return `/${user}/files/${folder.replace(/^\/+|\/+$/g, '')}`.replace(/\/+$/, '')
}
