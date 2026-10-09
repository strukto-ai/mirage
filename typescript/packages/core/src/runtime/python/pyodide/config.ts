export interface PyodideConfig {
  /** Maximum simultaneous top-level calls, default 1; hosts without isolated async context serialize. */
  maxConcurrency?: number
  autoLoadFromImports?: boolean
  bootstrapCode?: string
  /** Trusted host module URL. Its default initializer receives Pyodide and may return cleanup. */
  initModule?: string
  denyPackages?: readonly string[]
  /**
   * Virtual paths prepended to sys.path once the mounts are in place, so
   * an agent can `import openpyxl` without writing sys.path.append
   * itself. Entries are MOUNT paths, not host paths: the glob runs
   * inside the interpreter against the mounted tree. A `.whl` may be
   * named directly (zipimport reads a pure-python wheel in place), and a
   * pattern may contain `*`, `?` or `[`.
   *
   * Prepended, not appended: a vendored package of the same name must
   * win over a bundled one, which is also CPython's own PYTHONPATH
   * precedence.
   */
  sysPath?: readonly string[]
  /**
   * Packages loaded from the distribution when each interpreter starts:
   * per invocation, or once per named console session. The subsequent
   * autoLoadFromImports scan skips packages already loaded at initialization.
   */
  packages?: readonly string[]
  /**
   * Where package wheels are fetched from. Distinct from `home`, which
   * only sets indexURL: the npm pyodide package ships the lock file and
   * NO wheels, so a deployment that wants `packages` working offline
   * points this at its own prebuilt distribution. A `://` value makes
   * package loading a network fetch; a local path keeps it on disk.
   */
  packageBaseUrl?: string
  /** A custom pyodide-lock.json, for a prebuilt distribution. */
  lockFileURL?: string
  // Where the pyodide distribution loads from; falls back to
  // MIRAGE_PYODIDE_HOME, then the installed package in Node or the
  // pinned CDN in the browser. Override for self-hosted assets.
  home?: string
}

export const KEYS: readonly (keyof PyodideConfig)[] = [
  'maxConcurrency',
  'autoLoadFromImports',
  'bootstrapCode',
  'initModule',
  'denyPackages',
  'home',
  'sysPath',
  'packages',
  'packageBaseUrl',
  'lockFileURL',
]
