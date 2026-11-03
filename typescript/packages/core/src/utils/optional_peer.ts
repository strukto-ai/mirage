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

export interface OptionalPeerConfig {
  feature: string
  packageName: string
  docsUrl?: string
  /**
   * What to install outside npm, for a peer that needs it. A native peer
   * dlopens its system library while it loads, so a missing driver surfaces
   * as a load failure rather than a resolution failure, and only the caller
   * knows which driver its package wants.
   */
  systemHint?: string
}

export function loadOptionalPeer<T>(
  importer: () => Promise<T>,
  config: OptionalPeerConfig,
): Promise<T> {
  return importer().catch(missingPeer(config))
}

/**
 * What a failed import of an optional peer throws: an install hint when
 * the package does not resolve, else the load failure. Handed to the
 * import itself, `import('x').catch(missingPeer(...))`, a bundler leaves a
 * peer that is not installed to fail here at run time rather than failing
 * the build of every app that never uses it.
 */
export function missingPeer(config: OptionalPeerConfig): (err: unknown) => never {
  return (err) => {
    const code = (err as { code?: string } | null)?.code
    const docsLine = config.docsUrl !== undefined ? `\nSee ${config.docsUrl} for details.` : ''
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') {
      throw new Error(
        `${config.feature} requires the optional peer dependency ` +
          `\`${config.packageName}\`. Install it with:\n\n` +
          `    pnpm add ${config.packageName}\n` +
          docsLine,
      )
    }
    // The package resolved and would not load. Installing it again is the
    // wrong advice here, so without a hint the original error is the most
    // honest thing to report.
    if (config.systemHint === undefined) throw err
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      `${config.feature} could not load \`${config.packageName}\`: ${reason}\n\n` +
        `${config.systemHint}${docsLine}`,
      { cause: err },
    )
  }
}
