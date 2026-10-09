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

import type { WriteKind } from '../../cache/types.ts'

const ALL: readonly WriteKind[] = Object.freeze(['put', 'copy', 'delete'] as const)

/** The ops each backend conditions (docs/home/yaml.mdx, conditions.json). */
export const WRITE_CONDITIONS: Readonly<Record<string, readonly WriteKind[]>> = Object.freeze({
  s3: ALL,
  seaweedfs: ALL,
  minio: Object.freeze(['put'] as const),
  aliyun: ALL,
  backblaze: ALL,
  ceph: ALL,
  digitalocean: ALL,
  gcs: ALL,
  oci: ALL,
  qingstor: ALL,
  r2: ALL,
  scaleway: ALL,
  supabase: ALL,
  tencent: ALL,
  wasabi: ALL,
  box: ALL,
  dropbox: ALL,
})

/** A custom `vfs: s3` endpoint may be MinIO, so it gets MinIO's row. */
export const CUSTOM_ENDPOINT_CONDITIONS: readonly WriteKind[] = WRITE_CONDITIONS.minio ?? []

/** The domains AWS serves S3 from: the commercial partitions and China. */
export const AWS_DOMAINS: readonly string[] = ['amazonaws.com', 'amazonaws.com.cn']
