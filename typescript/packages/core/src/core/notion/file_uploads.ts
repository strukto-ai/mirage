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

import type { HttpNotionTransport } from './client.ts'

export function createFileUpload(
  transport: HttpNotionTransport,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return transport.request({ method: 'POST', path: '/file_uploads', body })
}

/** Send one part of a multi-part upload. */
export function sendFilePart(
  transport: HttpNotionTransport,
  uploadId: string,
  filename: string,
  contentType: string,
  data: Uint8Array,
  partNumber: number,
): Promise<Record<string, unknown>> {
  const form = new FormData()
  form.set('file', new Blob([data as BlobPart], { type: contentType }), filename)
  form.set('part_number', String(partNumber))
  return transport.request({ method: 'POST', path: `/file_uploads/${uploadId}/send`, form })
}

/** Close a multi-part upload once every part has been sent. */
export function completeFileUpload(
  transport: HttpNotionTransport,
  uploadId: string,
): Promise<Record<string, unknown>> {
  return transport.request({ method: 'POST', path: `/file_uploads/${uploadId}/complete` })
}

export function getFileUpload(
  transport: HttpNotionTransport,
  uploadId: string,
): Promise<Record<string, unknown>> {
  return transport.request({ method: 'GET', path: `/file_uploads/${uploadId}` })
}

/** The first page of the integration's file uploads. */
export function listFileUploads(transport: HttpNotionTransport): Promise<Record<string, unknown>> {
  return transport.request({ method: 'GET', path: '/file_uploads' })
}
