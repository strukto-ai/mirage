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

import type { TokenManager } from '../../../core/google/_client.ts'
import { docsBase, driveBase, sheetsBase, slidesBase } from '../../../core/google/_client.ts'
import { ResourceName } from '../../../types.ts'
import { CommandSpec, OperandKind, Option } from '../../spec/types.ts'

// The official gws CLI generates one command per Discovery method and
// speaks raw API resources: `--params` carries path/query parameters,
// `--json` the request body, and the output is the API response JSON.
// Each entry here is one such passthrough method; the bespoke gws_*
// commands (create/batchUpdate/+read/+append/+write) stay hand-written.

export type GwsService = 'drive' | 'docs' | 'sheets' | 'slides'

export interface GwsMethod {
  service: GwsService
  resource: string
  method: string
  http: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  needsBody?: boolean
  rawBytes?: boolean
}

export function gwsCommandName(m: GwsMethod): string {
  return `gws ${m.service} ${m.resource} ${m.method}`
}

export const GWS_METHODS: readonly GwsMethod[] = [
  {
    service: 'docs',
    resource: 'documents',
    method: 'get',
    http: 'GET',
    path: '/documents/{documentId}',
  },
  {
    service: 'docs',
    resource: 'documents',
    method: 'create',
    http: 'POST',
    path: '/documents',
    needsBody: true,
  },
  {
    service: 'docs',
    resource: 'documents',
    method: 'batchUpdate',
    http: 'POST',
    path: '/documents/{documentId}:batchUpdate',
    needsBody: true,
  },
  {
    service: 'sheets',
    resource: 'spreadsheets',
    method: 'get',
    http: 'GET',
    path: '/spreadsheets/{spreadsheetId}',
  },
  {
    service: 'sheets',
    resource: 'spreadsheets',
    method: 'create',
    http: 'POST',
    path: '/spreadsheets',
    needsBody: true,
  },
  {
    service: 'sheets',
    resource: 'spreadsheets',
    method: 'batchUpdate',
    http: 'POST',
    path: '/spreadsheets/{spreadsheetId}:batchUpdate',
    needsBody: true,
  },
  {
    service: 'slides',
    resource: 'presentations',
    method: 'get',
    http: 'GET',
    path: '/presentations/{presentationId}',
  },
  {
    service: 'slides',
    resource: 'presentations',
    method: 'create',
    http: 'POST',
    path: '/presentations',
    needsBody: true,
  },
  {
    service: 'slides',
    resource: 'presentations',
    method: 'batchUpdate',
    http: 'POST',
    path: '/presentations/{presentationId}:batchUpdate',
    needsBody: true,
  },
  { service: 'drive', resource: 'files', method: 'list', http: 'GET', path: '/files' },
  { service: 'drive', resource: 'files', method: 'get', http: 'GET', path: '/files/{fileId}' },
  {
    service: 'drive',
    resource: 'files',
    method: 'create',
    http: 'POST',
    path: '/files',
    needsBody: true,
  },
  {
    service: 'drive',
    resource: 'files',
    method: 'update',
    http: 'PATCH',
    path: '/files/{fileId}',
    needsBody: true,
  },
  {
    service: 'drive',
    resource: 'files',
    method: 'copy',
    http: 'POST',
    path: '/files/{fileId}/copy',
  },
  {
    service: 'drive',
    resource: 'files',
    method: 'delete',
    http: 'DELETE',
    path: '/files/{fileId}',
  },
  {
    service: 'drive',
    resource: 'files',
    method: 'export',
    http: 'GET',
    path: '/files/{fileId}/export',
    rawBytes: true,
  },
  {
    service: 'drive',
    resource: 'permissions',
    method: 'create',
    http: 'POST',
    path: '/files/{fileId}/permissions',
    needsBody: true,
  },
  {
    service: 'drive',
    resource: 'permissions',
    method: 'list',
    http: 'GET',
    path: '/files/{fileId}/permissions',
  },
  {
    service: 'drive',
    resource: 'permissions',
    method: 'delete',
    http: 'DELETE',
    path: '/files/{fileId}/permissions/{permissionId}',
  },
] as const

export const GWS_API_SPEC = new CommandSpec({
  options: [
    new Option({ long: '--params', valueKind: OperandKind.TEXT }),
    new Option({ long: '--json', valueKind: OperandKind.TEXT }),
  ],
})

export const SERVICE_BASES: Record<GwsService, (tm: TokenManager) => string> = {
  drive: driveBase,
  docs: docsBase,
  sheets: sheetsBase,
  slides: slidesBase,
}

export const SERVICE_RESOURCES: Record<GwsService, string[]> = {
  drive: [ResourceName.GDRIVE],
  docs: [ResourceName.GDOCS, ResourceName.GDRIVE],
  sheets: [ResourceName.GSHEETS, ResourceName.GDRIVE],
  slides: [ResourceName.GSLIDES, ResourceName.GDRIVE],
}
