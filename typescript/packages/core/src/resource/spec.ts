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

function toSnake(key: string): string {
  return key.replace(/(?<!^)(?=[A-Z])/g, '_').toLowerCase()
}

/**
 * A remote mount spec from a config whose Python field names are the
 * snake_case of the TS keys. The spec is consumed by Python mirage in
 * the sandbox, so keys are snake_cased; undefined values and
 * functions (unserializable callbacks like a refresh hook) are
 * dropped. Only use this where the Python config really is a pure
 * casing rename of the TS one — a backend with renamed fields
 * hand-maps instead (see s3's remoteMountSpec).
 */
export function remoteSpec(
  resource: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || typeof value === 'function') continue
    out[toSnake(key)] = value
  }
  return { resource, config: out }
}
