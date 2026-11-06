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

import type { ResourceStore } from './base.ts'
import { DEFAULT_SCOPE } from './constants.ts'
import { RecordResourceStore } from './store.ts'
import type { EntryKind, Fields, ResourceRecords, Sealer } from './types.ts'

/** Records in a map, copied in and out so a caller's object never aliases one. */
export class MemoryRecords implements ResourceRecords {
  private readonly folders = new Map<string, Map<string, Fields>>()

  private folder(folder: string): Map<string, Fields> {
    let records = this.folders.get(folder)
    if (records === undefined) {
      records = new Map()
      this.folders.set(folder, records)
    }
    return records
  }

  read(folder: string, name: string): Promise<Fields | null> {
    const record = this.folder(folder).get(name)
    return Promise.resolve(record === undefined ? null : structuredClone(record))
  }

  write(folder: string, name: string, record: Fields): Promise<void> {
    this.folder(folder).set(name, structuredClone(record))
    return Promise.resolve()
  }

  remove(folder: string, name: string): Promise<boolean> {
    return Promise.resolve(this.folder(folder).delete(name))
  }

  names(folder: string): Promise<string[]> {
    return Promise.resolve([...this.folder(folder).keys()])
  }
}

/** Sealed values in a map: for tests, where nothing is kept. */
export class MemorySealer implements Sealer {
  private readonly values = new Map<string, Fields>()

  read(kind: EntryKind, name: string): Promise<Fields> {
    return Promise.resolve(structuredClone(this.values.get(`${kind}/${name}`) ?? {}))
  }

  write(kind: EntryKind, name: string, values: Fields): Promise<void> {
    if (Object.keys(values).length === 0) this.values.delete(`${kind}/${name}`)
    else this.values.set(`${kind}/${name}`, structuredClone(values))
    return Promise.resolve()
  }

  wipe(kind: EntryKind, name: string): Promise<void> {
    this.values.delete(`${kind}/${name}`)
    return Promise.resolve()
  }
}

export function memoryResourceStore(scope: string = DEFAULT_SCOPE): ResourceStore {
  return new RecordResourceStore(scope, new MemoryRecords(), new MemorySealer())
}
