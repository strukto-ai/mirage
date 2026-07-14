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

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { GitHubCIResource, MountMode, Workspace, type FileStat } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../.env.development') })

const TOKEN = process.env.GITHUB_TOKEN
if (TOKEN === undefined || TOKEN === '') {
  throw new Error('GITHUB_TOKEN env var is required')
}

async function run(ws: Workspace, cmd: string): Promise<{ out: string; err: string; code: number }> {
  try {
    const r = await ws.execute(cmd)
    return { out: r.stdoutText, err: r.stderrText, code: r.exitCode }
  } catch (err) {
    return { out: '', err: err instanceof Error ? err.message : String(err), code: 1 }
  }
}

function printOut(label: string, out: string, err: string, max = 500): void {
  console.log(`=== ${label} ===`)
  if (out !== '') console.log(out.length > max ? out.slice(0, max) + '...' : out)
  if (err !== '') process.stderr.write(`  STDERR: ${err.trim().slice(0, 200)}\n`)
}

async function main(): Promise<void> {
  const resource = new GitHubCIResource({
    token: TOKEN!,
    owner: 'strukto-ai',
    repo: 'mirage',
    maxRuns: 300,
  })
  const ws = new Workspace({ '/ci': resource }, { mode: MountMode.READ })
  try {
    const root = await run(ws, 'ls /ci/')
    printOut('ls /ci/ (root)', root.out, root.err)

    const workflowsResult = await run(ws, 'ls /ci/workflows/')
    printOut('ls /ci/workflows/', workflowsResult.out, workflowsResult.err)

    const workflows = workflowsResult.out.trim().split('\n').filter((s) => s !== '')
    if (workflows.length === 0) {
      console.log('no workflows found')
      return
    }
    const wfName = workflows[0]!.trim().split('/').pop() ?? ''

    const wfShow = await run(ws, `cat "/ci/workflows/${wfName}"`)
    printOut(`cat /ci/workflows/${wfName}`, wfShow.out, wfShow.err)

    const runsResult = await run(ws, 'ls /ci/runs/')
    printOut('ls /ci/runs/', runsResult.out, runsResult.err)

    const runs = runsResult.out.trim().split('\n').filter((s) => s !== '')
    if (runs.length === 0) {
      console.log('no runs found')
      return
    }
    const runName = runs[0]!.trim().split('/').pop() ?? ''
    const runPath = `/ci/runs/${runName}`

    const runLs = await run(ws, `ls "${runPath}/"`)
    printOut(`ls ${runPath}/`, runLs.out, runLs.err)

    const runJson = await run(ws, `cat "${runPath}/run.json" | head -n 20`)
    printOut(`cat ${runPath}/run.json | head -n 20`, runJson.out, runJson.err)

    const runStat = await run(ws, `stat "${runPath}"`)
    console.log(`=== stat ${runPath} ===`)
    console.log(`  ${runStat.out.trim()}`)


    // chmod/chown/touch never hit the Actions API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on ${runPath} ===`)
    const metaRes = await ws.execute(
      `chmod 640 "${runPath}" && chown 500:dev "${runPath}" && touch -t 202601021530 "${runPath}"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    try {
      const metaSt = (await ws.dispatch('stat', `${runPath}`)) as FileStat
      const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
      console.log(
        `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
      )
    } catch {
      console.log('  dispatch stat: run path unavailable (check GITHUB_TOKEN)')
    }

    const jobsPath = `${runPath}/jobs`
    const jobsLs = await run(ws, `ls "${jobsPath}/"`)
    printOut(`ls ${jobsPath}/`, jobsLs.out, jobsLs.err)

    const jobsLines = jobsLs.out.trim().split('\n').filter((s) => s !== '')
    const jsonJobs = jobsLines.filter((j) => j.endsWith('.json'))
    const logJobs = jobsLines.filter((j) => j.endsWith('.log'))

    const firstJsonJob = jsonJobs[0]
    if (firstJsonJob !== undefined) {
      const jobName = firstJsonJob
      const jobPath = `${jobsPath}/${jobName}`
      const jobJson = await run(ws, `cat "${jobPath}" | head -n 20`)
      printOut(`cat ${jobName} | head -n 20`, jobJson.out, jobJson.err)

      const jobStat = await run(ws, `stat "${jobPath}"`)
      console.log(`=== stat ${jobName} ===`)
      console.log(`  ${jobStat.out.trim()}`)
    }

    const firstLogJob = logJobs[0]
    if (firstLogJob !== undefined) {
      const logName = firstLogJob
      const logPath = `${jobsPath}/${logName}`
      const logHead = await run(ws, `head -n 20 "${logPath}"`)
      printOut(`head -n 20 ${logName}`, logHead.out, logHead.err, 1000)

      const logTail = await run(ws, `tail -n 10 "${logPath}"`)
      printOut(`tail -n 10 ${logName}`, logTail.out, logTail.err)

      const logWc = await run(ws, `wc -l "${logPath}"`)
      console.log(`=== wc -l ${logName} ===`)
      console.log(`  ${logWc.out.trim()}`)
    }

    const annPath = `${runPath}/annotations.jsonl`
    const annResult = await run(ws, `cat "${annPath}"`)
    console.log(`=== cat ${annPath} ===`)
    const annOut = annResult.out.trim()
    if (annOut !== '') {
      for (const line of annOut.split('\n').slice(0, 5)) console.log(`  ${line.slice(0, 120)}`)
    } else {
      console.log('  (no annotations)')
    }

    const artifactsLs = await run(ws, `ls "${runPath}/artifacts/"`)
    console.log(`=== ls ${runPath}/artifacts/ ===`)
    if (artifactsLs.out.trim() !== '') console.log(artifactsLs.out)
    else console.log('  (no artifacts)')

    const treeOut = await run(ws, 'tree -L 2 /ci/')
    printOut('tree -L 2 /ci/', treeOut.out, treeOut.err, 1500)

    const findLog = await run(ws, "find /ci/runs/ -name '*.log' | head -n 10")
    printOut("find /ci/runs/ -name '*.log' | head -n 10", findLog.out, findLog.err)

    const findJson = await run(ws, "find /ci/runs/ -name '*.json' | head -n 10")
    printOut("find /ci/runs/ -name '*.json' | head -n 10", findJson.out, findJson.err)

    const wfStat = await run(ws, 'stat "/ci/workflows/"')
    console.log('=== stat /ci/workflows/ ===')
    console.log(`  ${wfStat.out.trim()}`)

    const runsStat = await run(ws, 'stat "/ci/runs/"')
    console.log('=== stat /ci/runs/ ===')
    console.log(`  ${runsStat.out.trim()}`)
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
