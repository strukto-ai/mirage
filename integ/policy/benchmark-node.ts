export {}
const started = performance.now()
const { Workspace, RAMVFS, MountMode, SessionProfile } = await import('@struktoai/mirage-node')
const { run } = await import('./benchmark-suite.ts')
const importMs = performance.now() - started
const samples = await run(
  (policy) =>
    new Workspace(
      { '/data': new RAMVFS() },
      {
        mode: MountMode.WRITE,
        policies: [policy],
        profiles: { bench: SessionProfile({ commands: { deny: ['blocked'] } }) },
      },
    ),
)
console.log(
  JSON.stringify({
    host: 'node',
    runtime: process.version,
    import_ms: importMs,
    memory: process.memoryUsage(),
    memory_note:
      'RSS includes native/Wasm memory; heapUsed does not. No process memory cap imposed.',
    samples,
  }),
)
