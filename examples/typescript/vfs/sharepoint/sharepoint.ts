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

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { MountMode, SharePointVFS, Workspace, type FileStat } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development'), override: true })

const REPORT_FILE = resolve(__HERE, 'test_results.md')
function requireToken(): string {
  const token = process.env.MS_GRAPH_DRIVE_TOKEN
  if (token === undefined) throw new Error('MS_GRAPH_DRIVE_TOKEN is required')
  return token
}

const token = requireToken()

type Test = [name: string, cmd: string]
type Result = [name: string, cmd: string, ok: boolean, stdout: string, stderr: string]

function lines(text: string): string[] {
  return text.split('\n')
}

async function pickSiteAndDrive(ws: Workspace): Promise<[string, string]> {
  let r = await ws.shell('ls /sharepoint/')
  const sites = lines(r.stdoutText.trim())
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (sites.length === 0) throw new Error('No SharePoint sites accessible')
  const site = sites[0]!
  r = await ws.shell(`ls "/sharepoint/${site}/"`)
  const drives = lines(r.stdoutText.trim())
    .map((d) => d.trim())
    .filter((d) => d !== '')
  if (drives.length === 0) throw new Error(`No drives in site '${site}'`)
  return [site, drives[0]!]
}

function buildTests(testDir: string, testFile: string): [Test[], Test[], Test[]] {
  const commands: Test[] = [
    ['mkdir', `mkdir "${testDir}"`],
    ['touch', `touch "${testFile}"`],
    ['echo write', `echo "hello world\nfoo bar\nhello again\napple\nbanana" > "${testFile}"`],
    ['ls', `ls "${testDir}"`],
    ['ls -l', `ls -l "${testDir}"`],
    ['ls -la', `ls -la "${testDir}"`],
    ['find', `find "${testDir}"`],
    ['tree', `tree "${testDir}"`],
    ['cat', `cat "${testFile}"`],
    ['head', `head "${testFile}"`],
    ['head -n 2', `head -n 2 "${testFile}"`],
    ['tail', `tail "${testFile}"`],
    ['tail -n 2', `tail -n 2 "${testFile}"`],
    ['wc', `wc "${testFile}"`],
    ['wc -l', `wc -l "${testFile}"`],
    ['wc -c', `wc -c "${testFile}"`],
    ['grep', `grep hello "${testFile}"`],
    ['grep -c', `grep -c hello "${testFile}"`],
    ['grep -n', `grep -n hello "${testFile}"`],
    ['grep -i', `grep -i HELLO "${testFile}"`],
    ['rg', `rg hello "${testDir}"`],
    ['rg -l', `rg -l hello "${testDir}"`],
    ['stat', `stat "${testFile}"`],
    ['file', `file "${testFile}"`],
    ['du', `du "${testDir}"`],
    ['basename', `basename "${testFile}"`],
    ['dirname', `dirname "${testFile}"`],
    ['realpath', `realpath "${testFile}"`],
    ['nl', `nl "${testFile}"`],
    ['rev', `rev "${testFile}"`],
    ['tac', `tac "${testFile}"`],
    ['sort', `sort "${testFile}"`],
    ['uniq', `uniq "${testFile}"`],
    ['cut -c1-5', `cut -c1-5 "${testFile}"`],
    ['tr a-z A-Z', `cat "${testFile}" | tr a-z A-Z`],
    ['fold -w 10', `fold -w 10 "${testFile}"`],
    ['fmt', `fmt "${testFile}"`],
    ['expand', `expand "${testFile}"`],
    ['unexpand', `unexpand "${testFile}"`],
    ['md5', `md5 "${testFile}"`],
    ['sha256sum', `sha256sum "${testFile}"`],
    ['base64', `base64 "${testFile}"`],
    ['xxd', `xxd "${testFile}"`],
    ['strings', `strings "${testFile}"`],
    ['column', `column "${testFile}"`],
    ['paste', `paste "${testFile}" "${testFile}"`],
    ['join', `join "${testFile}" "${testFile}"`],
    ['look', `look h "${testFile}"`],
    ['diff (same)', `diff "${testFile}" "${testFile}"`],
    ['cmp (same)', `cmp "${testFile}" "${testFile}"`],
    ['cp', `cp "${testFile}" "${testDir}/copy.txt"`],
    ['mv', `mv "${testDir}/copy.txt" "${testDir}/moved.txt"`],
    ['ln', `ln "${testDir}/moved.txt" "${testDir}/link.txt"`],
    ['rm link', `rm "${testDir}/link.txt"`],
    ['rm moved', `rm "${testDir}/moved.txt"`],
    ['cat > write2', `echo "second file" > "${testDir}/file2.txt"`],
    [
      'sed -f',
      `echo 's/hello/HELLO/' | tee "${testDir}/prog.sed" > /dev/null` +
        ` && sed -f "${testDir}/prog.sed" "${testFile}" && rm "${testDir}/prog.sed"`,
    ],
    ['grep -r', `grep -r hello "${testDir}"`],
    ['grep -rl', `grep -rl hello "${testDir}"`],
    ['find -name', `find "${testDir}" -name "*.txt"`],
    ['find -type f', `find "${testDir}" -type f`],
  ]

  const pipeTests: Test[] = [
    ['cat|wc -l', `cat "${testFile}" | wc -l`],
    ['cat|grep', `cat "${testFile}" | grep hello`],
    ['cat|head', `cat "${testFile}" | head -n 2`],
    ['grep|sort', `grep hello "${testFile}" | sort`],
    ['grep|wc', `grep hello "${testFile}" | wc -l`],
    ['find|wc', `find "${testDir}" | wc -l`],
    ['find|head', `find "${testDir}" | head -2`],
    ['cat|sort|uniq', `cat "${testFile}" | sort | uniq`],
    ['cat|grep|wc', `cat "${testFile}" | grep hello | wc -l`],
    ['cat|tr|sort|uniq', `cat "${testFile}" | tr a-z A-Z | sort | uniq`],
    ['find|grep|wc', `find "${testDir}" | grep hello | wc -l`],
    ['cat|sed', `cat "${testFile}" | sed 's/hello/HELLO/'`],
  ]

  const shellTests: Test[] = [
    ['variable', 'X=hello; echo $X'],
    ['arithmetic', 'echo $((2 + 3))'],
    ['cmd substitution', `echo $(cat "${testFile}" | wc -l) lines`],
    ['if-else exists', `if [ -f "${testFile}" ]; then echo exists; else echo missing; fi`],
    [
      'if-else missing',
      'if [ -f "/sharepoint/no/such/file" ]; then echo exists; else echo missing; fi',
    ],
    ['for loop', 'for i in 1 2 3; do echo $i; done'],
    ['while read', 'seq 3 | while read n; do echo line$n; done'],
    ['functions', 'greet() { echo hi; }; greet'],
    ['nested loops', 'for i in 1 2; do for j in a b; do echo $i$j; done; done'],
    ['error redirect', 'ls /nonexistent 2>/dev/null; echo ok'],
  ]

  return [commands, pipeTests, shellTests]
}

async function runTest(ws: Workspace, name: string, cmd: string): Promise<Result> {
  try {
    const r = await ws.shell(cmd)
    return [name, cmd, r.exitCode === 0, r.stdoutText.trimEnd(), r.stderrText.trimEnd()]
  } catch (err) {
    return [name, cmd, false, '', err instanceof Error ? err.message : String(err)]
  }
}

async function runSection(ws: Workspace, tests: Test[]): Promise<Result[]> {
  const results: Result[] = []
  for (const [name, cmd] of tests) {
    const result = await runTest(ws, name, cmd)
    results.push(result)
    const [, , ok, stdout, stderr] = result
    console.log(`  ${ok ? '✅' : '❌'} ${name}`)
    if (stdout !== '') {
      const out = lines(stdout)
      for (const line of out.slice(0, 5)) console.log(`      | ${line}`)
      if (out.length > 5) console.log(`      | ... (${String(out.length)} lines)`)
    }
    if (stderr !== '') console.log(`      ERR: ${stderr.slice(0, 100)}`)
  }
  return results
}

function escapeMd(s: string): string {
  return s.replaceAll('|', '\\|').replaceAll('\n', ' ↵ ').trim().slice(0, 120)
}

function countPassed(results: Result[]): number {
  return results.filter(([, , ok]) => ok).length
}

function writeReport(
  site: string,
  drive: string,
  cmdResults: Result[],
  pipeResults: Result[],
  shellResults: Result[],
): void {
  const out = ['# SharePoint Comprehensive Integration Test Results\n']
  out.push(`**Site:** ${site}  \n**Drive:** ${drive}\n`)

  const allResults = [...cmdResults, ...pipeResults, ...shellResults]
  const total = allResults.length
  const passed = countPassed(allResults)
  const failed = total - passed
  const pct = total > 0 ? (passed / total) * 100 : 0
  out.push(
    `**Total: ${String(passed)} passed, ${String(failed)} failed,` +
      ` ${String(total)} total (${pct.toFixed(1)}%)**\n`,
  )

  const sections: [string, Result[]][] = [
    ['Individual Commands', cmdResults],
    ['Piping', pipeResults],
    ['Shell Features', shellResults],
  ]
  for (const [section, results] of sections) {
    out.push(`\n## ${section}\n`)
    out.push('| # | Test | Command | Status | Output |')
    out.push('|---|------|---------|--------|--------|')
    results.forEach(([name, cmd, ok, stdout, stderr], i) => {
      const detail = ok ? escapeMd(stdout) : escapeMd(stderr || stdout)
      out.push(
        `| ${String(i + 1)} | ${escapeMd(name)} | \`${escapeMd(cmd)}\` | ${ok ? '✅' : '❌'} | ${detail} |`,
      )
    })
    out.push(`\n**${String(countPassed(results))}/${String(results.length)} passed**\n`)
  }

  writeFileSync(REPORT_FILE, out.join('\n') + '\n')
  console.log(`\nReport: ${REPORT_FILE}`)
}

async function main(): Promise<void> {
  console.log('Token loaded ✓\n')

  const ws = new Workspace(
    { '/sharepoint/': new SharePointVFS({ accessToken: token }) },
    { mode: MountMode.WRITE },
  )
  try {
    const [site, drive] = await pickSiteAndDrive(ws)
    const base = `/sharepoint/${site}/${drive}`
    const testDir = `${base}/mirage-sp-test`
    const testFile = `${testDir}/hello.txt`
    console.log(`Site: ${site}, Drive: ${drive}`)
    console.log(`Test dir: ${testDir}\n`)

    const [commands, pipeTests, shellTests] = buildTests(testDir, testFile)

    console.log('=== Individual Commands ===')
    const cmdResults = await runSection(ws, commands)

    console.log('\n=== Piping ===')
    const pipeResults = await runSection(ws, pipeTests)

    console.log('\n=== Shell Features ===')
    const shellResults = await runSection(ws, shellTests)

    // chmod/chown/touch never hit the Graph API: attrs land in the
    // workspace namespace (durable, snapshot-captured) and merge into
    // dispatch-level stat.
    console.log(`=== metadata overlay on ${testFile} ===`)
    const metaRes = await ws.shell(
      `chmod 640 "${testFile}" && chown 500:dev "${testFile}" && touch -t 202601021530 "${testFile}"`,
    )
    console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
    const metaSt = (await ws.dispatch('stat', testFile)) as FileStat
    const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
    console.log(
      `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
    )

    // Cleanup
    console.log('\n=== Cleanup ===')
    await ws.shell(`rm -r "${testDir}"`)
    console.log('  done')

    writeReport(site, drive, cmdResults, pipeResults, shellResults)

    const allResults = [...cmdResults, ...pipeResults, ...shellResults]
    const total = allResults.length
    const passed = countPassed(allResults)
    console.log(
      `\n✓ ${String(passed)}/${String(total)} tests passed (${((passed / total) * 100).toFixed(1)}%)`,
    )
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
