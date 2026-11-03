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

import { makeS3Alias, REGION_ALIAS_SCHEMA, type S3AliasConfig } from '../s3_alias.ts'

export interface DigitalOceanConfig extends S3AliasConfig {
  region: string
}

export const DigitalOceanConfig = makeS3Alias({
  schema: REGION_ALIAS_SCHEMA,
  endpointFor: (config) => `https://${config.region}.digitaloceanspaces.com`,
})
