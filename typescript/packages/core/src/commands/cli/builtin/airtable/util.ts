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

import { AirtableAccessor } from '../../../../accessor/airtable.ts'
import type { AirtableConfig } from '../../../../core/airtable/config.ts'
import type { Row } from '../../../../core/airtable/normalize.ts'
import { materialize, type ByteSource } from '../../../../io/types.ts'
import { eacces } from '../../../../errors/fs.ts'
import type { CommandFnResult } from '../../../config.ts'
import { UsageError } from '../../../errors.ts'
import { FlagView } from '../../../spec/flag_view.ts'
import type { CLIInvocation, CLIVerbFn } from '../../types.ts'

const DEC = new TextDecoder()

export type Verb = (
  accessor: AirtableAccessor,
  inv: CLIInvocation,
  fl: FlagView,
) => Promise<CommandFnResult>

/** The line's install, validated against the program's config model. */
export function config(inv: CLIInvocation): AirtableConfig {
  return inv.config as AirtableConfig
}

/** Refuse an operand on a verb that takes none. */
export function noOperands(texts: readonly string[]): void {
  if (texts.length > 0) throw new UsageError(`unrecognized arguments: ${texts.join(' ')}`)
}

/** The one operand a verb requires, named as its usage line names it. */
export function oneOperand(texts: readonly string[], name: string): string {
  const first = texts[0]
  if (first === undefined) throw new UsageError(`the following arguments are required: ${name}`)
  noOperands(texts.slice(1))
  return first
}

/** The operand a verb may take once, null when the line has none. */
export function optionalOperand(texts: readonly string[]): string | null {
  noOperands(texts.slice(1))
  return texts[0] ?? null
}

/**
 * The base a line addresses, refused (EACCES) when `baseIds` excludes it.
 * Refused here, before any request, so a base the install was not given is
 * never reached: the scope the mount enforces on reads. The executor
 * prefixes the refusal with the words the line was typed under, `<head> base
 * get: <base-id>: Permission denied`, exit 1.
 */
export function scopedBase(config: AirtableConfig, baseId: string): string {
  const wanted = config.baseIds
  if (wanted !== undefined && !wanted.includes(baseId)) {
    throw eacces(baseId, `${baseId}: Permission denied`)
  }
  return baseId
}

/**
 * The schema table a line names, by id first and then by name. Airtable
 * takes either spelling in a path, and an id can never be another table's
 * name, so the id match wins.
 */
export function findTable(tables: readonly Row[], ref: string): Row | undefined {
  return tables.find((t) => t.id === ref) ?? tables.find((t) => t.name === ref)
}

/** A flag's value decoded as a JSON object. */
export function jsonObject(flag: string, text: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new UsageError(`${flag} must be valid JSON`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UsageError(`${flag} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

/** Piped input as text, a leading byte order mark dropped. */
export async function stdinText(stdin: ByteSource): Promise<string> {
  return DEC.decode(await materialize(stdin))
}

/**
 * Run one verb on its own accessor. A verb never names itself: the CLI may
 * be installed under any head word, so a refusal is left to the executor,
 * which prefixes it with the words the line was typed under.
 */
export function run(verb: Verb): CLIVerbFn {
  return (inv: CLIInvocation): Promise<CommandFnResult> =>
    verb(new AirtableAccessor(config(inv)), inv, new FlagView(inv.flags, inv.spec))
}
