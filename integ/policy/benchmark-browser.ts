import { SessionProfile } from '@struktoai/mirage-core/policy/profile'
import { Workspace, RAMVFS, MountMode } from '@struktoai/mirage-browser'
import { run } from './benchmark-suite.ts'

export async function benchmark() {
  return run(
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
}
