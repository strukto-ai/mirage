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
import { homedir } from 'node:os'
import { join } from 'node:path'

type IniSections = Record<string, Record<string, string>>

const SECTION_TYPES = new Set(['profile', 'sso-session', 'services'])
const SECTION = /^([\w-]+)\s(["'])?([\w-@+.%:/]+)\2$/
const BLOCKED = new Set(['__proto__', 'profile __proto__'])

function filled(value: string | undefined): string | undefined {
  return value !== undefined && value !== '' ? value : undefined
}

/**
 * An AWS shared config or credentials file as the SDK's `parseIni` reads it:
 * `[profile x]` and `[services x]` keep their prefix as `profile.x`, a
 * section of another prefix is dropped, a nested `s3 =` block's keys read as
 * `s3.endpoint_url`, and a `__proto__` section refuses the file.
 */
export function parseSharedIni(text: string): IniSections {
  const sections: IniSections = Object.create(null) as IniSections
  let section: string | undefined
  let sub: string | undefined
  for (const raw of text.split(/\r?\n/)) {
    const line = (raw.split(/(^|\s)[;#]/)[0] ?? '').trim()
    if (line.startsWith('[') && line.endsWith(']')) {
      const name = line.slice(1, -1)
      if (BLOCKED.has(name)) throw new Error(`Found invalid profile name "${name}"`)
      const match = SECTION.exec(name)
      const prefix = match?.[1] ?? ''
      section =
        match === null
          ? name
          : SECTION_TYPES.has(prefix)
            ? `${prefix}.${match[3] ?? ''}`
            : undefined
      sub = undefined
      continue
    }
    const eq = line.indexOf('=')
    if (section === undefined || eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (value === '') {
      sub = key
      continue
    }
    if (sub !== undefined && raw.trimStart() === raw) sub = undefined
    const entries = (sections[section] ??= Object.create(null) as Record<string, string>)
    entries[sub !== undefined ? `${sub}.${key}` : key] = value
  }
  return sections
}

function sharedPath(variable: string, name: string): string {
  const path = filled(process.env[variable]) ?? join(homedir(), '.aws', name)
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function readSharedIni(path: string): IniSections {
  try {
    return parseSharedIni(readFileSync(path, 'utf-8'))
  } catch (err) {
    // The SDK reads an unreadable or malformed file as empty; so does this.
    console.debug(`shared config not read: ${path}: ${String(err)}`)
    return {}
  }
}

/** The config file's sections as the SDK's `getConfigData` keys them. */
function configProfiles(sections: IniSections): IniSections {
  const out: IniSections = Object.create(null) as IniSections
  const plain = sections.default
  if (plain !== undefined) out.default = plain
  for (const [key, value] of Object.entries(sections)) {
    const dot = key.indexOf('.')
    if (dot === -1 || !SECTION_TYPES.has(key.slice(0, dot))) continue
    out[key.startsWith('profile.') ? key.slice(dot + 1) : key] = value
  }
  return out
}

/**
 * The endpoint the SDK takes from its environment and shared config when a
 * client names none: `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL`, then the
 * `AWS_PROFILE` profile's `services` s3 `endpoint_url` and its own
 * `endpoint_url`, none of them when `ignore_configured_endpoint_urls` is
 * `true`. The SDK reads the profile from `AWS_PROFILE`, not from the
 * client's `profile` option.
 */
export function configuredEndpoint(): string | undefined {
  const config = configProfiles(readSharedIni(sharedPath('AWS_CONFIG_FILE', 'config')))
  const credentials = readSharedIni(sharedPath('AWS_SHARED_CREDENTIALS_FILE', 'credentials'))
  const name = filled(process.env.AWS_PROFILE) ?? 'default'
  const profile = { ...credentials[name], ...config[name] }
  const ignore =
    process.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS ?? profile.ignore_configured_endpoint_urls
  if (ignore === 'true') return undefined
  const services =
    profile.services !== undefined ? config[`services.${profile.services}`] : undefined
  return (
    filled(process.env.AWS_ENDPOINT_URL_S3) ??
    filled(process.env.AWS_ENDPOINT_URL) ??
    filled(services?.['s3.endpoint_url']) ??
    filled(profile.endpoint_url)
  )
}
