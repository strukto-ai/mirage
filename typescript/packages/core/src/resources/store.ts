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

import { compareCodePoints } from '../utils/sort.ts'
import type { ResourceStore } from './base.ts'
import { DELETED_TEMPLATES, ENTRY_KINDS, NAME, NOUN } from './constants.ts'
import { ResourceError } from './errors.ts'
import type {
  Entry,
  EntryInput,
  EntryKind,
  Fields,
  Policy,
  ResourceKind,
  ResourceRecords,
  RevealedEntry,
  Sealer,
  Template,
  TemplateInput,
} from './types.ts'

const POLICY = 'policy'
const TEMPLATE = 'template'

function checkName(kind: ResourceKind, name: string): void {
  if (!NAME.test(name)) {
    throw new ResourceError(
      'invalid',
      `${NOUN[kind]} name must be 1-63 of a-z 0-9 . _ -, starting with a letter or digit`,
    )
  }
}

function notFound(kind: ResourceKind, name: string): ResourceError {
  return new ResourceError('not_found', `no ${NOUN[kind]} named ${name}`)
}

function malformed(kind: ResourceKind, name: string, field: string): ResourceError {
  return new ResourceError('invalid', `${NOUN[kind]} ${name} has no ${field}`)
}

function stringOf(kind: ResourceKind, name: string, record: Fields, field: string): string {
  const value = record[field]
  if (typeof value !== 'string') throw malformed(kind, name, field)
  return value
}

function fieldsOf(kind: ResourceKind, name: string, record: Fields, field: string): Fields {
  const value = record[field]
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw malformed(kind, name, field)
  }
  return value
}

function templateOf(name: string, record: Fields): Template {
  const description = record.description
  return {
    name,
    description: typeof description === 'string' && description !== '' ? description : null,
    config: fieldsOf(TEMPLATE, name, record, 'config'),
  }
}

/**
 * The store's rules over two small backend parts: plain records and a
 * sealer. Calls run one at a time, so an edit's read and write see no other
 * call between them.
 */
export class RecordResourceStore implements ResourceStore {
  readonly scope: string
  private readonly records: ResourceRecords
  private readonly sealer: Sealer
  private tail: Promise<void> = Promise.resolve()

  constructor(scope: string, records: ResourceRecords, sealer: Sealer) {
    this.scope = scope
    this.records = records
    this.sealer = sealer
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run)
    this.tail = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  private async entryRecord(kind: EntryKind, name: string): Promise<Fields> {
    const record = await this.records.read(kind, name)
    if (record === null) throw notFound(kind, name)
    return record
  }

  private async entryOf(kind: EntryKind, name: string): Promise<Entry> {
    const record = await this.entryRecord(kind, name)
    return {
      name,
      type: stringOf(kind, name, record, 'type'),
      fields: fieldsOf(kind, name, record, 'fields'),
      sealed: Object.keys(await this.sealer.read(kind, name)).sort(compareCodePoints),
    }
  }

  private async sortedNames(folder: string): Promise<string[]> {
    return (await this.records.names(folder)).sort(compareCodePoints)
  }

  listEntries(kind: EntryKind): Promise<Entry[]> {
    return this.serial(async () => {
      const out: Entry[] = []
      for (const name of await this.sortedNames(kind)) out.push(await this.entryOf(kind, name))
      return out
    })
  }

  getEntry(kind: EntryKind, name: string): Promise<Entry> {
    return this.serial(() => this.entryOf(kind, name))
  }

  putEntry(kind: EntryKind, input: EntryInput): Promise<Entry> {
    return this.serial(async () => {
      checkName(kind, input.name)
      const given = Object.entries(input.sealed ?? {})
      const both = given.find(([key, value]) => value !== null && Object.hasOwn(input.fields, key))
      if (both !== undefined) {
        throw new ResourceError('invalid', `${both[0]} is given both plain and sealed`)
      }
      for (const other of ENTRY_KINDS) {
        if (other !== kind && (await this.records.read(other, input.name)) !== null) {
          throw new ResourceError('conflict', `${input.name} is already a ${NOUN[other]}`)
        }
      }
      const exists = (await this.records.read(kind, input.name)) !== null
      const removed = new Set(given.filter(([, value]) => value === null).map(([key]) => key))
      const sealed: Fields = {}
      if (exists) {
        for (const [key, value] of Object.entries(await this.sealer.read(kind, input.name))) {
          if (!Object.hasOwn(input.fields, key) && !removed.has(key)) sealed[key] = value
        }
      }
      for (const [key, value] of given) if (value !== null) sealed[key] = value
      await this.sealer.write(kind, input.name, sealed)
      await this.records.write(kind, input.name, {
        name: input.name,
        type: input.type,
        fields: input.fields,
      })
      return {
        name: input.name,
        type: input.type,
        fields: input.fields,
        sealed: Object.keys(sealed).sort(compareCodePoints),
      }
    })
  }

  deleteEntry(kind: EntryKind, name: string): Promise<void> {
    return this.serial(async () => {
      await this.entryRecord(kind, name)
      await this.sealer.wipe(kind, name)
      await this.records.remove(kind, name)
    })
  }

  revealEntry(kind: EntryKind, name: string): Promise<RevealedEntry> {
    return this.serial(async () => {
      const entry = await this.entryOf(kind, name)
      return { ...entry, sealed: await this.sealer.read(kind, name) }
    })
  }

  private async policyOf(name: string): Promise<Policy> {
    const record = await this.records.read(POLICY, name)
    if (record === null) throw notFound(POLICY, name)
    return { name, source: stringOf(POLICY, name, record, 'source') }
  }

  listPolicies(): Promise<Policy[]> {
    return this.serial(async () => {
      const out: Policy[] = []
      for (const name of await this.sortedNames(POLICY)) out.push(await this.policyOf(name))
      return out
    })
  }

  getPolicy(name: string): Promise<Policy> {
    return this.serial(() => this.policyOf(name))
  }

  putPolicy(policy: Policy): Promise<Policy> {
    return this.serial(async () => {
      checkName(POLICY, policy.name)
      await this.records.write(POLICY, policy.name, { name: policy.name, source: policy.source })
      return { name: policy.name, source: policy.source }
    })
  }

  deletePolicy(name: string): Promise<void> {
    return this.serial(async () => {
      if (!(await this.records.remove(POLICY, name))) throw notFound(POLICY, name)
    })
  }

  private async templateIn(folder: string, name: string): Promise<Template | null> {
    const record = await this.records.read(folder, name)
    return record === null ? null : templateOf(name, record)
  }

  private async liveTemplate(name: string): Promise<Template> {
    const template = await this.templateIn(TEMPLATE, name)
    if (template === null) throw notFound(TEMPLATE, name)
    return template
  }

  listTemplates(): Promise<Template[]> {
    return this.serial(async () => {
      const out: Template[] = []
      for (const name of await this.sortedNames(TEMPLATE)) out.push(await this.liveTemplate(name))
      return out
    })
  }

  getTemplate(name: string): Promise<Template> {
    return this.serial(() => this.liveTemplate(name))
  }

  putTemplate(input: TemplateInput): Promise<Template> {
    return this.serial(async () => {
      checkName(TEMPLATE, input.name)
      const template: Template = {
        name: input.name,
        description:
          input.description === undefined || input.description === '' ? null : input.description,
        config: input.config,
      }
      await this.records.write(TEMPLATE, template.name, { ...template })
      return template
    })
  }

  deleteTemplate(name: string): Promise<void> {
    return this.serial(async () => {
      const template = await this.liveTemplate(name)
      await this.records.write(DELETED_TEMPLATES, name, { ...template })
      await this.records.remove(TEMPLATE, name)
    })
  }

  restoreTemplate(name: string): Promise<Template> {
    return this.serial(async () => {
      const template = await this.templateIn(DELETED_TEMPLATES, name)
      if (template === null)
        throw new ResourceError('not_found', `no deleted template named ${name}`)
      if ((await this.records.read(TEMPLATE, name)) !== null) {
        throw new ResourceError('conflict', `a template named ${name} exists again`)
      }
      await this.records.write(TEMPLATE, name, { ...template })
      await this.records.remove(DELETED_TEMPLATES, name)
      return template
    })
  }
}
