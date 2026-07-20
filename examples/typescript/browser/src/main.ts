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

import {
  GCSResource,
  GDocsResource,
  GDriveResource,
  GSheetsResource,
  GSlidesResource,
  GitHubResource,
  LangfuseResource,
  LinearResource,
  MountMode,
  OCIResource,
  OPFSResource,
  R2Resource,
  type Resource,
  S3Resource,
  type S3BrowserOperation,
  type S3BrowserSignOptions,
  TrelloResource,
  Workspace,
} from '@struktoai/mirage-browser'

type BackendName = 's3' | 'gcs' | 'r2' | 'oci'

const logEl = document.getElementById('log')!

function line(s: string, cls?: string): void {
  const div = document.createElement('div')
  if (cls !== undefined) div.className = cls
  div.textContent = s
  logEl.appendChild(div)
}

async function run(ws: Workspace, cmd: string): Promise<void> {
  line(`$ ${cmd}`, 'prompt')
  const res = await ws.execute(cmd)
  const out = res.stdoutText.replace(/\s+$/, '')
  if (out !== '') line(out)
  const err = res.stderrText.replace(/\s+$/, '')
  if (err !== '') line(err, 'err')
  if (res.exitCode !== 0) line(`exit=${String(res.exitCode)}`, 'err')
}

function makePresigner(backend: BackendName) {
  return async (
    path: string,
    op: S3BrowserOperation,
    opts: S3BrowserSignOptions = {},
  ): Promise<string> => {
    const r = await fetch(`/presign/${backend}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, op, opts }),
    })
    if (!r.ok) {
      const body = await r.text().catch(() => '')
      throw new Error(`presigner ${backend} → ${String(r.status)} ${body}`)
    }
    const { url } = (await r.json()) as { url: string }
    return url
  }
}

async function fetchConfigured(): Promise<BackendName[]> {
  try {
    const r = await fetch('/presign/status')
    if (!r.ok) return []
    const { configured } = (await r.json()) as { configured: BackendName[] }
    return configured
  } catch {
    return []
  }
}

function buildResource(backend: BackendName): Resource {
  const provider = makePresigner(backend)
  switch (backend) {
    case 's3':
      return new S3Resource({ bucket: backend, presignedUrlProvider: provider })
    case 'gcs':
      return new GCSResource({ bucket: backend, presignedUrlProvider: provider })
    case 'r2':
      return new R2Resource({ bucket: backend, presignedUrlProvider: provider })
    case 'oci':
      return new OCIResource({ bucket: backend, presignedUrlProvider: provider })
  }
}

async function demoOpfs(ws: Workspace): Promise<void> {
  line('')
  line('━━━ OPFS (/) — full shell demo ━━━', 'prompt')
  await ws.fs.writeFile('/hello.txt', 'hello from OPFS\n')
  await ws.fs.mkdir('/notes')
  await ws.fs.writeFile('/notes/q1.csv', 'revenue,100\nexpense,80\nprofit,20\n')
  await run(ws, 'ls /')
  await run(ws, 'cat /hello.txt')
  await run(ws, 'head -n 2 /notes/q1.csv')
  await run(ws, 'wc /notes/q1.csv')
  await run(ws, 'grep revenue /notes/q1.csv')
}

/**
 * Trello demo. Unlike S3/GCS/OCI which need a server-side presigner, Trello's
 * REST API supports CORS and uses URL-param auth, so the browser can call
 * api.trello.com directly. The TrelloResource holds apiKey/apiToken just like
 * S3Resource holds accessKeyId/secretAccessKey, and ships a full set of shell
 * commands (ls/cat/tree/grep/find/jq/...) registered against `resource: trello`.
 */
async function demoTrello(ws: Workspace): Promise<void> {
  line('')
  line('━━━ Trello (/trello/) — direct browser → api.trello.com ━━━', 'prompt')
  await run(ws, 'ls /trello/')
  const wsRes = await ws.execute('ls /trello/workspaces/ | head -n 1')
  const ws0 = wsRes.stdoutText.trim()
  if (ws0 === '') return
  const wsBase = `/trello/workspaces/${ws0}`
  await run(ws, `cat ${wsBase}/workspace.json`)
  await run(ws, `tree -L 3 ${wsBase}`)
  const bRes = await ws.execute(`ls ${wsBase}/boards/ | head -n 1`)
  const b0 = bRes.stdoutText.trim()
  if (b0 === '') return
  const boardBase = `${wsBase}/boards/${b0}`
  await run(ws, `cat ${boardBase}/board.json`)
  await run(ws, `jq -r ".board_name" ${boardBase}/board.json`)
  await run(ws, `find ${boardBase} -name "card.json" | head -n 3`)
}

/**
 * Linear demo. Like Trello, Linear's GraphQL API supports CORS so the browser
 * can call api.linear.app/graphql directly — no proxy needed.
 */
async function demoLinear(ws: Workspace): Promise<void> {
  line('')
  line('━━━ Linear (/linear/) — direct browser → api.linear.app/graphql ━━━', 'prompt')
  await run(ws, 'ls /linear/')
  const tRes = await ws.execute('ls /linear/teams/ | head -n 1')
  const t0 = tRes.stdoutText.trim()
  if (t0 === '') return
  const teamBase = `/linear/teams/${t0}`
  await run(ws, `cat ${teamBase}/team.json`)
  await run(ws, `tree -L 2 ${teamBase}`)
  const iRes = await ws.execute(`ls ${teamBase}/issues/ | head -n 1`)
  const i0 = iRes.stdoutText.trim()
  if (i0 === '') return
  await run(ws, `cat ${teamBase}/issues/${i0}/issue.json`)
  await run(ws, `jq -r ".title" ${teamBase}/issues/${i0}/issue.json`)
  await run(ws, `find ${teamBase} -name "issue.json" | head -n 3`)
}

async function demoLangfuse(ws: Workspace): Promise<void> {
  line('')
  line('━━━ Langfuse (/langfuse/) — direct browser → cloud.langfuse.com ━━━', 'prompt')
  await run(ws, 'ls /langfuse/')
  await run(ws, 'ls /langfuse/datasets/')
  const dRes = await ws.execute('ls /langfuse/datasets/ | head -n 1')
  const d0 = dRes.stdoutText.trim()
  if (d0 === '') return
  const dPath = `/langfuse/datasets/${d0}`
  await run(ws, `ls ${dPath}`)
  await run(ws, `wc -l ${dPath}/items.jsonl`)
  await run(ws, `head -n 2 ${dPath}/items.jsonl`)
  await run(ws, 'ls /langfuse/prompts/')
  const pRes = await ws.execute('ls /langfuse/prompts/ | head -n 1')
  const p0 = pRes.stdoutText.trim()
  if (p0 !== '') await run(ws, `tree /langfuse/prompts/${p0}`)
}

/**
 * GitHub demo. GitHub's REST API supports CORS and uses an Authorization
 * header — same model as Linear. The repo's tree is fetched once at resource
 * creation and cached, so subsequent `ls`/`cat` calls hit it without round
 * trips except for blob fetches when reading file contents.
 */
async function demoGitHub(ws: Workspace): Promise<void> {
  line('')
  line('━━━ GitHub (/github/) — direct browser → api.github.com ━━━', 'prompt')
  await run(ws, 'ls /github/')
  await run(ws, 'tree -L 1 /github/')
  for (const name of ['README.md', 'package.json', 'pyproject.toml']) {
    const res = await ws.execute(`head -n 8 /github/${name}`)
    if (res.exitCode === 0 && res.stdoutText.trim() !== '') {
      line(`$ head -n 8 /github/${name}`, 'prompt')
      line(res.stdoutText.replace(/\s+$/, ''))
      break
    }
  }
}

/**
 * Google Docs demo. The OAuth2 token endpoint and Docs/Drive APIs are CORS-
 * enabled, so the browser can call them directly with a refresh_token grant —
 * same model as Linear/GitHub. Note: this exposes client_secret in the bundle,
 * which is fine for trusted environments / personal demos but should be
 * proxied through a backend in production.
 */
async function demoGdocs(ws: Workspace): Promise<void> {
  line('')
  line('━━━ Google Docs (/gdocs/) — direct browser → docs.googleapis.com ━━━', 'prompt')
  await run(ws, 'ls /gdocs/')
  const ownedRes = await ws.execute('ls /gdocs/owned/ | head -n 1')
  const first = ownedRes.stdoutText.trim().split('\n')[0]
  if (first === undefined || first === '') return
  const path = `/gdocs/owned/${first.split('/').pop() ?? first}`
  await run(ws, `stat "${path}"`)
  await run(ws, `jq -r ".title" "${path}"`)
  await run(ws, `head -n 5 "${path}"`)
}

async function demoGsheets(ws: Workspace): Promise<void> {
  line('')
  line('━━━ Google Sheets (/gsheets/) — direct browser → sheets.googleapis.com ━━━', 'prompt')
  await run(ws, 'ls /gsheets/')
  const ownedRes = await ws.execute('ls /gsheets/owned/ | head -n 1')
  const first = ownedRes.stdoutText.trim().split('\n')[0]
  if (first === undefined || first === '') return
  const path = `/gsheets/owned/${first.split('/').pop() ?? first}`
  await run(ws, `stat "${path}"`)
  await run(ws, `jq -r ".properties.title" "${path}"`)
}

async function demoGslides(ws: Workspace): Promise<void> {
  line('')
  line('━━━ Google Slides (/gslides/) — direct browser → slides.googleapis.com ━━━', 'prompt')
  await run(ws, 'ls /gslides/')
  const ownedRes = await ws.execute('ls /gslides/owned/ | head -n 1')
  const first = ownedRes.stdoutText.trim().split('\n')[0]
  if (first === undefined || first === '') return
  const path = `/gslides/owned/${first.split('/').pop() ?? first}`
  await run(ws, `stat "${path}"`)
  await run(ws, `jq -r ".title" "${path}"`)
}

async function demoGdrive(ws: Workspace): Promise<void> {
  line('')
  line('━━━ Google Drive (/gdrive/) — folder tree + gws commands reused via multi-resource ━━━', 'prompt')
  await run(ws, 'ls /gdrive/')
  await run(ws, 'tree -L 1 /gdrive/')
  await run(ws, "find /gdrive/ -name '*.gdoc.json' | head -n 3")
}

/**
 * Cloud-backend demo via real shell commands. `ws.execute('ls /s3/…')` now
 * flows through core's S3_COMMANDS, which internally branches on
 * `config.presignedUrlProvider` and dispatches each AWS SDK command to a
 * presigned URL fetch — mirroring Python's `async_session(config)` seam.
 */
async function demoCloud(ws: Workspace, backend: BackendName): Promise<void> {
  const mount = `/${backend}/`
  line('')
  line(`━━━ ${backend.toUpperCase()} (${mount}) — ws.execute shell ━━━`, 'prompt')
  const stamp = String(Date.now())
  const writeKey = `${mount}browser-demo/${stamp}.txt`
  await run(ws, `echo 'hello from browser ${backend}' > ${writeKey}`)
  await run(ws, `cat ${writeKey}`)
  await run(ws, `stat ${writeKey}`)
  await run(ws, `ls ${mount}browser-demo/`)
  await run(ws, `wc -c ${writeKey}`)
  await run(ws, `rm ${writeKey}`)
}

async function main(): Promise<void> {
  line('mirage-ai — browser workspace with OPFS + cloud backends', 'ok')
  const configured = await fetchConfigured()
  line(`configured backends: ${configured.length > 0 ? configured.join(', ') : '(none)'}`, 'ok')

  const resources: Record<string, Resource> = {
    '/': new OPFSResource({ root: 'mirage-browser-demo' }),
  }
  for (const b of configured) resources[`/${b}/`] = buildResource(b)

  const trelloKey = __TRELLO_API_KEY__
  const trelloToken = __TRELLO_API_TOKEN__
  const trelloEnabled = trelloKey !== '' && trelloToken !== ''
  if (trelloEnabled) {
    resources['/trello/'] = new TrelloResource({
      apiKey: trelloKey,
      apiToken: trelloToken,
    })
  }

  const linearKey = __LINEAR_API_KEY__
  const linearEnabled = linearKey !== ''
  if (linearEnabled) {
    resources['/linear/'] = new LinearResource({ apiKey: linearKey })
  }

  const lfPublic = __LANGFUSE_PUBLIC_KEY__
  const lfSecret = __LANGFUSE_SECRET_KEY__
  const lfHost = __LANGFUSE_HOST__
  const langfuseEnabled = lfPublic !== '' && lfSecret !== ''
  if (langfuseEnabled) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
    resources['/langfuse/'] = new LangfuseResource({
      publicKey: lfPublic,
      secretKey: lfSecret,
      ...(lfHost !== '' ? { host: lfHost } : {}),
      defaultTraceLimit: 10,
      defaultFromTimestamp: sevenDaysAgo,
    })
  }

  const githubToken = __GITHUB_TOKEN__
  const githubOwner = __GITHUB_OWNER__
  const githubRepo = __GITHUB_REPO__
  const githubEnabled = githubToken !== '' && githubOwner !== '' && githubRepo !== ''
  if (githubEnabled) {
    try {
      resources['/github/'] = await GitHubResource.create({
        token: githubToken,
        owner: githubOwner,
        repo: githubRepo,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      line(`github: ${msg}`, 'err')
    }
  }

  const googleClientId = __GOOGLE_CLIENT_ID__
  const googleClientSecret = __GOOGLE_CLIENT_SECRET__
  const googleRefreshToken = __GOOGLE_REFRESH_TOKEN__
  const gdocsEnabled =
    googleClientId !== '' && googleClientSecret !== '' && googleRefreshToken !== ''
  if (gdocsEnabled) {
    resources['/gdocs/'] = new GDocsResource({
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      refreshToken: googleRefreshToken,
    })
    resources['/gsheets/'] = new GSheetsResource({
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      refreshToken: googleRefreshToken,
    })
    resources['/gslides/'] = new GSlidesResource({
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      refreshToken: googleRefreshToken,
    })
    resources['/gdrive/'] = new GDriveResource({
      clientId: googleClientId,
      clientSecret: googleClientSecret,
      refreshToken: googleRefreshToken,
    })
  }

  const ws = new Workspace(resources, { mode: MountMode.WRITE })

  await demoOpfs(ws)
  if (trelloEnabled) {
    try {
      await demoTrello(ws)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      line(`trello: ${msg}`, 'err')
    }
  }
  if (linearEnabled) {
    try {
      await demoLinear(ws)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      line(`linear: ${msg}`, 'err')
    }
  }
  if (langfuseEnabled) {
    try {
      await demoLangfuse(ws)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      line(`langfuse: ${msg}`, 'err')
    }
  }
  if (githubEnabled && resources['/github/'] !== undefined) {
    try {
      await demoGitHub(ws)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      line(`github: ${msg}`, 'err')
    }
  }
  if (gdocsEnabled) {
    try {
      await demoGdocs(ws)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      line(`gdocs: ${msg}`, 'err')
    }
    try {
      await demoGsheets(ws)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      line(`gsheets: ${msg}`, 'err')
    }
    try {
      await demoGslides(ws)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      line(`gslides: ${msg}`, 'err')
    }
    try {
      await demoGdrive(ws)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      line(`gdrive: ${msg}`, 'err')
    }
  }
  for (const b of configured) {
    try {
      await demoCloud(ws, b)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      line(`${b}: ${msg}`, 'err')
      if (/failed to fetch|network/i.test(msg)) {
        line(
          `  → likely a CORS-config issue on the ${b} bucket; the presigned URL reached ` +
            `the cloud but the browser rejected the response. Configure the bucket ` +
            `to allow origin http://localhost:5174 (GET/PUT/HEAD/DELETE/POST + ` +
            `standard headers) to unblock. OCI's S3-compat endpoint tends to be ` +
            `permissive by default; AWS S3, GCS, and R2 require explicit CORS rules.`,
          'err',
        )
      }
    }
  }

  line('')
  line('done. reload page to verify OPFS persistence across sessions.', 'ok')

  await ws.close()
}

main().catch((err: unknown) => {
  line(String(err instanceof Error ? err.stack ?? err.message : err), 'err')
})
