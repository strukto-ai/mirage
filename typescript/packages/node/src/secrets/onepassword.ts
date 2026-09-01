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

import type { Client, Item } from '@1password/sdk'

import { SecretsError } from '@struktoai/mirage-core/secrets/errors'
import type { ResolvedSecret } from '@struktoai/mirage-core/secrets/types'

import type { OnePasswordConfig } from './config.ts'
import { VERSION } from '../version.ts'

export const OP_SCHEME = 'op://'
export const TOKEN_VAR = 'OP_SERVICE_ACCOUNT_TOKEN'
export const INTEGRATION_NAME = 'mirage'

// What `op://vault/item/notesPlain` addresses: an item's note is not
// an `ItemField`, so it is folded in under the name the ref grammar
// gives it rather than being invisible to a `key`.
export const NOTES_KEY = 'notesPlain'

/** A 1Password reference split into its parts. */
export interface OpRef {
  readonly vault: string
  readonly item: string
  /** The field label; empty for an item reference. */
  readonly field: string
}

/**
 * Split a 1Password secret reference into vault, item and field.
 *
 * Both of 1Password's own ref shapes are accepted, and they mean
 * different fetches: an item reference reads every field, so N
 * variables out of one item cost one call, while a field reference
 * (`op://<vault>/<item>[/<section>]/<field>`) is resolved as itself,
 * which is what the app's "Copy Secret Reference" button hands you.
 *
 * Throws SecretsError on an empty ref, one that is not an `op://` url,
 * or one naming less than a vault and an item.
 */
export function parseOpRef(ref: string): OpRef {
  if (ref === '') {
    throw new SecretsError("the '1password' source needs a ref: op://<vault>/<item>")
  }
  if (!ref.startsWith(OP_SCHEME)) {
    throw new SecretsError(`a '1password' ref is an op:// url, got '${ref}'`)
  }
  const parts = ref.slice(OP_SCHEME.length).split('/')
  const [vault, item] = parts
  if (vault === undefined || item === undefined || parts.some((part) => part === '')) {
    throw new SecretsError(`a '1password' ref names a vault and an item, got '${ref}'`)
  }
  return { vault, item, field: parts.length > 2 ? (parts[parts.length - 1] ?? '') : '' }
}

/**
 * Authenticate a 1Password SDK client.
 *
 * The SDK loads on first use (the lazy-module trick Python spells as
 * an import path). Built per fetch rather than cached, because a
 * fetched value lands on a session var and never refetches, so a cache
 * would keep an authenticated handle alive long past the line that
 * needed one. An absent `token` falls back to the process env, so a
 * deployment with one account declares nothing.
 *
 * Throws SecretsError when neither the config nor the env carries a
 * service account token.
 */
export async function onePasswordClient(config: OnePasswordConfig): Promise<Client> {
  const token = config.token ?? process.env[TOKEN_VAR] ?? ''
  if (token === '') {
    throw new SecretsError(
      "the '1password' source needs a service account token: set " +
        `${TOKEN_VAR}, or give the source a 'token'`,
    )
  }
  const { createClient } = await import('@1password/sdk')
  return await createClient({
    auth: token,
    integrationName: INTEGRATION_NAME,
    integrationVersion: VERSION,
  })
}

/**
 * Resolve a vault's id from the name a ref spells.
 *
 * A ref names a vault by title, which the item API cannot take, so
 * this is the extra call an item reference costs. An id matches too,
 * so a deployment that pins ids never pays for the title lookup being
 * wrong after a rename. Throws SecretsError when no vault matches.
 */
export async function findVaultId(client: Client, name: string): Promise<string> {
  for (const vault of await client.vaults.list()) {
    if (name === vault.id || name === vault.title) return vault.id
  }
  throw new SecretsError(`1password vault '${name}' not found`)
}

/**
 * Resolve an item's id within one vault, by title or by id.
 *
 * Throws SecretsError when no item of that title or id is in the
 * vault.
 */
export async function findItemId(client: Client, vaultId: string, name: string): Promise<string> {
  for (const item of await client.items.list(vaultId)) {
    if (name === item.id || name === item.title) return item.id
  }
  throw new SecretsError(`1password item '${name}' not found`)
}

/**
 * Shape one item into secret fields, keyed by field label.
 *
 * Labels are what a ref and a managed entry's `key` both address, and
 * 1Password fixes the built-in ones per category (an API Credential
 * item's secret is `credential`), so they are the keys here. Two
 * fields sharing a label in different sections is the one ambiguity,
 * and the later one wins -- the SDK refuses such a ref outright, so
 * neither shape promises more than the other.
 */
export function fieldsFromItem(item: Item): Record<string, string> {
  // Object.fromEntries, not keyed assignment: a field labelled
  // `__proto__` would otherwise assign through the prototype setter
  // and leave no own property for a `key` to select, where python's
  // dict keeps the label like any other.
  const fields = Object.fromEntries(
    item.fields.filter((field) => field.title !== '').map((field) => [field.title, field.value]),
  ) as Record<string, string>
  if (item.notes !== '' && !Object.hasOwn(fields, NOTES_KEY)) fields[NOTES_KEY] = item.notes
  return fields
}

/**
 * Fetch one secret from 1Password.
 *
 * A field reference is one `resolve` call and returns that field
 * alone, keyed by its label; an item reference is a vault lookup, an
 * item lookup and a get, and returns every field, which is what lets
 * one AWS item fill four variables on one await. 1Password does not
 * expire an item, so `expiresAt` stays absent.
 */
export async function fetchOnePassword(
  config: OnePasswordConfig,
  ref: string,
): Promise<ResolvedSecret> {
  const { vault, item, field } = parseOpRef(ref)
  const client = await onePasswordClient(config)
  if (field !== '') return { fields: { [field]: await client.secrets.resolve(ref) } }
  const vaultId = await findVaultId(client, vault)
  const itemId = await findItemId(client, vaultId, item)
  return { fields: fieldsFromItem(await client.items.get(vaultId, itemId)) }
}
