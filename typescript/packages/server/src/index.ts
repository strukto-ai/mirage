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

export { buildApp, type BuildAppOptions, type MirageApp } from './app.ts'
export {
  configToWorkspaceArgs,
  interpolateEnv,
  loadWorkspaceConfig,
  loadWorkspaceConfigFile,
  type MountBlock,
  type WorkspaceArgs,
  type WorkspaceConfigRaw,
} from './config.ts'
export {
  AuthMode,
  DEFAULT_TOKEN_FILE,
  ENV_AUTH_MODE,
  ENV_AUTH_TOKEN,
  ENV_JWT_ALG,
  ENV_JWT_AUDIENCE,
  ENV_JWT_AUTHORIZED_PARTIES,
  ENV_JWT_CLOCK_SKEW,
  ENV_JWT_ISSUER,
  ENV_JWT_PUBKEY,
  ENV_JWT_PUBKEY_FILE,
  JWTVerificationError,
  ensureTokenFile,
  readTokenFile,
  registerAuth,
  resolveAuthConfig,
  resolveLocalToken,
  type AuthConfig,
  type JWTConfig,
} from './auth/index.ts'
export { ENV_ALLOWED_HOSTS, ENV_DAEMON_PORT, ENV_IDLE_GRACE_SECONDS } from './env.ts'
