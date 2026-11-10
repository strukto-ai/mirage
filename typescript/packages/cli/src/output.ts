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

export type Formatter<T = unknown> = (obj: T) => string

export function emit<T = unknown>(obj: T, human?: Formatter<T>): void {
  if (human !== undefined && process.stdout.isTTY) {
    process.stdout.write(human(obj) + '\n')
    return
  }
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n')
}

/** The help of an `<id>` argument. */
export const ID_HELP = 'The ID, or the name: a name is unique, so it works as an ID.'

/** What `get -o` prints instead of its default: YAML, a file `create -f` and `update -f` read back. */
export type Output = 'yaml'

/** `-o yaml`, refused otherwise. */
export function outputOf(value: string): Output {
  if (value === 'yaml') return value
  return fail(`-o takes yaml, not '${value}'`, 2)
}

/** Print `obj` as YAML when `-o yaml` asks, else as `emit` does. */
export async function show<T>(
  obj: T,
  output: Output | undefined,
  human: Formatter<T>,
): Promise<void> {
  if (output === 'yaml') {
    const { dumpYaml } = await import('@struktoai/mirage-node/utils/yaml')
    process.stdout.write(dumpYaml(obj))
    return
  }
  emit(obj, human)
}

export function fail(message: string, exitCode = 1): never {
  process.stderr.write(message + '\n')
  process.exit(exitCode)
}

export function exitCodeFromResponse(r: unknown): number {
  if (typeof r !== 'object' || r === null) return 0
  const obj = r as Record<string, unknown>
  const inner =
    'exit_code' in obj ? obj : ((obj.result as Record<string, unknown> | null | undefined) ?? null)
  if (inner !== null && typeof inner.exit_code === 'number' && Number.isFinite(inner.exit_code)) {
    return Math.min(255, Math.max(0, Math.trunc(inner.exit_code)))
  }
  if (typeof obj.status === 'string' && (obj.status === 'failed' || obj.status === 'canceled')) {
    return 2
  }
  return 0
}

/**
 * The `error` object of a daemon's error body, or null when the body is not
 * one, such as a proxy's error page. Mirrors Python's `error_of`.
 */
export function errorOf(
  text: string,
): { message: string; errno?: string; refusal?: { reason: string } | null } | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  const error =
    body !== null && typeof body === 'object' && !Array.isArray(body)
      ? (body as { error?: unknown }).error
      : undefined
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return null
  return typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string; errno?: string; refusal?: { reason: string } | null })
    : null
}

/** The message of a daemon's error body, or the body as it came. Mirrors Python's `error_message`. */
export function errorMessage(text: string): string {
  return errorOf(text)?.message ?? text
}

export async function handleResponse(r: Response): Promise<unknown> {
  if (r.status >= 400) fail(`error ${String(r.status)}: ${errorMessage(await r.text())}`, 2)
  if (r.status === 204) return {}
  const text = await r.text()
  if (text === '') return {}
  return JSON.parse(text) as unknown
}

export function formatAge(epoch: number): string {
  const delta = Math.max(0, Date.now() / 1000 - epoch)
  if (delta < 60) return `${String(Math.floor(delta))}s`
  if (delta < 3600) return `${String(Math.floor(delta / 60))}m`
  if (delta < 86400) return `${String(Math.floor(delta / 3600))}h`
  return `${String(Math.floor(delta / 86400))}d`
}

export function formatTable(headers: string[], rows: (string | undefined)[][]): string {
  if (rows.length === 0) return headers.join('  ')
  const norm: string[][] = rows.map((row) => row.map((c) => c ?? ''))
  const widths = headers.map((h) => h.length)
  for (const row of norm) {
    for (let i = 0; i < row.length; i++) {
      widths[i] = Math.max(widths[i] ?? 0, row[i]?.length ?? 0)
    }
  }
  const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length))
  const out: string[] = []
  out.push(
    headers
      .map((h, i) => pad(h, widths[i] ?? h.length))
      .join('  ')
      .trimEnd(),
  )
  for (const row of norm) {
    out.push(
      row
        .map((c, i) => pad(c, widths[i] ?? c.length))
        .join('  ')
        .trimEnd(),
    )
  }
  return out.join('\n')
}
