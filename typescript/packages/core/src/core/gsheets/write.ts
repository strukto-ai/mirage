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

import { googleRequest, sheetsBase, type TokenManager } from '../google/client.ts'
import { ApiError } from '../api/errors.ts'

class SheetsApiError extends ApiError {
  declare readonly status: number
  constructor(message: string, status: number) {
    super(message, status)
    this.name = 'SheetsApiError'
  }
}

function parseValues(valuesJson: string): unknown {
  try {
    return JSON.parse(valuesJson)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Invalid JSON: ${msg}`)
  }
}

function sheetsError(verb: string, url: string, response: Response, text: string): SheetsApiError {
  return new SheetsApiError(
    `Sheets ${verb} ${url} → ${String(response.status)} ${text}`,
    response.status,
  )
}

export async function appendValues(
  tm: TokenManager,
  spreadsheetId: string,
  range: string,
  valuesJson: string,
): Promise<unknown> {
  const values = parseValues(valuesJson)
  const url = `${sheetsBase(tm)}/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED`
  return googleRequest(tm, 'POST', url, {
    json: { values },
    errorOf: (response, text) => sheetsError('POST', url, response, text),
  })
}

export async function updateValues(
  tm: TokenManager,
  spreadsheetId: string,
  range: string,
  valuesJson: string,
): Promise<unknown> {
  const values = parseValues(valuesJson)
  const url = `${sheetsBase(tm)}/spreadsheets/${spreadsheetId}/values/${range}?valueInputOption=USER_ENTERED`
  return googleRequest(tm, 'PUT', url, {
    json: { values },
    errorOf: (response, text) => sheetsError('PUT', url, response, text),
  })
}
