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

import { createClient } from '@1password/sdk'
import {
  INTEGRATION_NAME,
  OnePasswordConfig,
  readOnepassword,
  serviceAccountToken,
} from '@struktoai/mirage-core/secrets/onepassword'
import { registerSecrets } from '@struktoai/mirage-core/secrets/registry'
import { VERSION } from '@struktoai/mirage-core/version'

// The `1password` source in a Worker, registered on import. Its own
// module because it bundles 1Password's SDK, about 13 MiB of
// WebAssembly, which a Worker that reads no 1Password secret shouldn't
// carry. The SDK's core loads that WebAssembly from disk, which a
// Worker can't; the wrangler alias the quickstart gives swaps in
// onepassword_core, the same core importing it as a module.
registerSecrets('1password', OnePasswordConfig, (config, ref) =>
  readOnepassword(ref, () =>
    createClient({
      auth: serviceAccountToken(config),
      integrationName: INTEGRATION_NAME,
      integrationVersion: VERSION,
    }),
  ),
)
