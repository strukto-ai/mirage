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

import type { CITransport } from './_client.ts'

export interface CIArtifact {
  id: number
  name?: string
  size_in_bytes?: number
  updated_at?: string
  [k: string]: unknown
}

export async function listArtifacts(
  transport: CITransport,
  owner: string,
  repo: string,
  runId: string,
): Promise<CIArtifact[]> {
  const items = await transport.getPaginated(
    `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts`,
    'artifacts',
  )
  return items as CIArtifact[]
}

export async function downloadArtifact(
  transport: CITransport,
  owner: string,
  repo: string,
  artifactId: string,
): Promise<Uint8Array> {
  return transport.getBytes(`/repos/${owner}/${repo}/actions/artifacts/${artifactId}/zip`)
}
