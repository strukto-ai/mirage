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

export function fail(message: string, exitCode = 1): never {
  process.stderr.write(message + '\n')
  process.exit(exitCode)
}

export function exitCodeFromResponse(r: unknown): number {
  if (typeof r !== 'object' || r === null) return 0
  const obj = r as Record<string, unknown>
  const inner =
    obj.kind === 'io' ? obj : ((obj.result as Record<string, unknown> | null | undefined) ?? null)
  if (
    inner !== null &&
    inner.kind === 'io' &&
    typeof inner.exitCode === 'number' &&
    Number.isFinite(inner.exitCode)
  ) {
    return Math.min(255, Math.max(0, Math.trunc(inner.exitCode)))
  }
  if (typeof obj.status === 'string' && (obj.status === 'failed' || obj.status === 'canceled')) {
    return 2
  }
  return 0
}

export async function handleResponse(r: Response): Promise<unknown> {
  if (r.status >= 400) {
    let detail = await r.text()
    try {
      const parsed = JSON.parse(detail) as { detail?: string }
      if (parsed.detail !== undefined) detail = parsed.detail
    } catch {
      // body wasn't JSON; fall through with the raw text as detail
    }
    fail(`daemon error ${String(r.status)}: ${detail}`, 2)
  }
  if (r.status === 204) return {}
  const text = await r.text()
  if (text === '') return {}
  return JSON.parse(text) as unknown
}

export function formatAge(epoch: number, now: number = Date.now() / 1000): string {
  const delta = Math.max(0, now - epoch)
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
      .replace(/\s+$/, ''),
  )
  for (const row of norm) {
    out.push(
      row
        .map((c, i) => pad(c, widths[i] ?? c.length))
        .join('  ')
        .replace(/\s+$/, ''),
    )
  }
  return out.join('\n')
}
