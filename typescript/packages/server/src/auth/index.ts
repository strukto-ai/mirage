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

export {
  AuthMode,
  ENV_AUTH_MODE,
  ENV_AUTH_TOKEN,
  ENV_JWT_ALG,
  ENV_JWT_AUDIENCE,
  ENV_JWT_AUTHORIZED_PARTIES,
  ENV_JWT_CLOCK_SKEW,
  ENV_JWT_ISSUER,
  ENV_JWT_PUBKEY,
  ENV_JWT_PUBKEY_FILE,
  resolveAuthConfig,
  resolveLocalToken,
  type AuthConfig,
  type JWTConfig,
} from './config.ts'
export { JWTVerificationError } from './jwt.ts'
export { registerAuth } from './middleware.ts'
export { defaultTokenFile, ensureTokenFile, readTokenFile } from './storage.ts'
