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

import { SHEETS_API_BASE, type TokenManager, googleHeaders } from '../google/_client.ts'

export class SheetsApiError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
    this.name = 'SheetsApiError'
  }
}

export async function appendValues(
  tm: TokenManager,
  spreadsheetId: string,
  range: string,
  valuesJson: string,
): Promise<unknown> {
  let values: unknown
  try {
    values = JSON.parse(valuesJson)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid JSON: ${msg}`)
  }
  const url = `${SHEETS_API_BASE}/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`
  const headers = await googleHeaders(tm)
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new SheetsApiError(`Sheets POST ${url} → ${String(r.status)} ${text}`, r.status)
  }
  return r.json()
}
