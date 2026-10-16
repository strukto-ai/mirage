import { readFile } from 'node:fs/promises'
import { GitHubVFS, PathSpec, Workspace } from '@struktoai/mirage-node'
import { GitHubEventHook } from '@struktoai/mirage-core/core/github/events'
import type { JsonValue } from '@struktoai/mirage-core/types'

async function main(): Promise<void> {
  const file = process.argv[2]
  const token = process.env.GITHUB_TOKEN
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/')
  if (!file || !token || !owner || !repo)
    throw new Error(
      'Set GITHUB_TOKEN and GITHUB_REPOSITORY (owner/repo), and pass a push JSON file',
    )
  const payload = JSON.parse(await readFile(file, 'utf8')) as JsonValue
  const vfs = await GitHubVFS.create({
    token,
    owner,
    repo,
    ref: (process.env.GITHUB_REF ?? 'main').replace(/^refs\/(heads|tags)\//, ''),
  })
  const ws = new Workspace({ '/github': vfs })
  const hook = new GitHubEventHook(vfs.accessor)
  const root = PathSpec.fromStrPath('/github', '')
  try {
    for (const change of await hook.toEvents(root, 'push', payload)) {
      await ws.notify(change)
      console.log(`${change.kind}: ${change.path.virtual}`)
    }
  } finally {
    await ws.close()
  }
}

await main()
