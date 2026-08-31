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

export { ANNOUNCE_RE, ANNOUNCE_SUFFIX, announceFor, emit } from './announce.ts'
export { RunState, makePool, makeState } from './base.ts'
export type { Fake, Runtime, TenantState } from './base.ts'
export {
  DEFAULT_ADVERTISE_HOST,
  DEFAULT_BIND_HOST,
  advertiseHost,
  authorityHost,
  bindHost,
} from './bind.ts'
export { clearTenants, deleteOrder, untenanted } from './clear.ts'
export { Clock, TICK_MS } from './clock.ts'
export { parseConfig } from './config.ts'
export type { KitConfig } from './config.ts'
export { ClientPool } from './db.ts'
export type { ClientCtor, MinimalClient, PoolOptions } from './db.ts'
export {
  FixtureError,
  KitError,
  ResetBodyError,
  RouteError,
  TenantError,
  SeedError,
} from './errors.ts'
export {
  DEFAULT_FIXTURE,
  DEFAULT_FIXTURE_ROOT,
  INTEG_ROOT,
  SCHEMA_ROOT,
  fixturePath,
  loadFixture,
  schemaFor,
} from './fixture.ts'
export { HEALTH_PATH, RESET_PATH, createKitServer, makeRuntime, parseBody } from './http.ts'
export { Minter } from './mint.ts'
export { checkArgv, parseFixture, parseFixtureRoot, parseFlagPort, parsePort } from './port.ts'
export { parseRange, rangeHeaderOf, rangeReply } from './range.ts'
export type { ByteRange } from './range.ts'
export { Router, compilePath, route } from './route.ts'
export type { Ctx, KitHandler, KitRoute, Matched } from './route.ts'
export { applyReset, defaultTenantsOf, parseResetBody, withPathRun } from './reset.ts'
export {
  DEFAULT_RUN,
  DEFAULT_TENANT,
  RUN_HEADER,
  RUN_PREFIX,
  RUN_QUERY,
  TENANT_FIELD,
  TENANT_HEADER,
  TENANT_QUERY,
  checkName,
  idWhere,
  resolveRun,
  resolveTenant,
  runId,
  splitRunPath,
  tenantKeyName,
  tenantWhere,
} from './tenant.ts'
export type { Headers } from './tenant.ts'
export { SEQ_FIELD, delegateFor, delegateName, seedFixture } from './seed.ts'
export type { Dmmf, DmmfField, DmmfModel, SeedOptions } from './seed.ts'
export { serve, start } from './serve.ts'
export type { Arm, Started } from './serve.ts'
export type {
  Announce,
  JsonValue,
  MintSharing,
  Reply,
  ResetRequest,
  ResetResponse,
  RouteMatch,
  TenantKind,
  SeedReport,
} from './types.ts'
export { unrouted, unroutedLine } from './unrouted.ts'
