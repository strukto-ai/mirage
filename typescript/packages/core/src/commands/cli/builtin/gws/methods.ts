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

import type { TokenManager } from '../../../../core/google/_client.ts'
import {
  docsBase,
  driveBase,
  gmailBase,
  sheetsBase,
  slidesBase,
} from '../../../../core/google/_client.ts'

// The official gws CLI generates one command per Discovery method and
// speaks raw API resources: `--params` carries path/query parameters,
// `--json` the request body, and the output is the API response JSON.
// Each entry here is one such passthrough method; the bespoke verbs
// (sheets read/write/append, docs write, the gmail helpers) stay
// hand-written beside them in the tree.

export type GwsService = 'drive' | 'docs' | 'sheets' | 'slides' | 'gmail'

export interface GwsMethod {
  service: GwsService
  resource: string
  method: string
  http: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: string
  needsBody?: boolean
  rawBytes?: boolean
  // Where a newly created file lands when the installation is scoped to a
  // folder. 'parents' means the request body takes a parents array, so the
  // scope is filled in there. 'relocate' means the API has no parents field
  // at all (the editors' create methods), so the new file is moved
  // afterwards with a Drive update. Absent means the method creates nothing.
  placement?: 'parents' | 'relocate'
  // Response key holding the new file's id, for 'relocate'.
  idField?: string
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
    placement: 'relocate',
    idField: 'documentId',
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
    placement: 'relocate',
    idField: 'spreadsheetId',
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
    placement: 'relocate',
    idField: 'presentationId',
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
    placement: 'parents',
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
    placement: 'parents',
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
  {
    service: 'gmail',
    resource: 'users labels',
    method: 'list',
    http: 'GET',
    path: '/users/{userId}/labels',
  },
  {
    service: 'gmail',
    resource: 'users messages',
    method: 'list',
    http: 'GET',
    path: '/users/{userId}/messages',
  },
  {
    service: 'gmail',
    resource: 'users messages',
    method: 'get',
    http: 'GET',
    path: '/users/{userId}/messages/{id}',
  },
  {
    service: 'gmail',
    resource: 'users messages',
    method: 'send',
    http: 'POST',
    path: '/users/{userId}/messages/send',
    needsBody: true,
  },
  {
    service: 'gmail',
    resource: 'users messages',
    method: 'trash',
    http: 'POST',
    path: '/users/{userId}/messages/{id}/trash',
  },
  {
    service: 'gmail',
    resource: 'users messages attachments',
    method: 'get',
    http: 'GET',
    path: '/users/{userId}/messages/{messageId}/attachments/{id}',
  },
]

export function gwsMethodDescription(m: GwsMethod): string {
  return `${m.http} ${m.path} (Google ${m.service} API passthrough)`
}

export const SERVICE_BASES: Record<GwsService, (tm: TokenManager) => string> = {
  drive: driveBase,
  docs: docsBase,
  sheets: sheetsBase,
  slides: slidesBase,
  gmail: gmailBase,
}
