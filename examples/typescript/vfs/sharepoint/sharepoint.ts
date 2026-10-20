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

import { randomUUID } from 'node:crypto'
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

// Python's shlex.quote, so the printed commands match the Python example.
function shellQuote(value: string): string {
  if (value === '') return "''"
  if (/^[\w@%+=:,./-]+$/.test(value)) return value
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

async function pickSiteAndDrive(ws: Workspace): Promise<[string, string]> {
  let r = await ws.shell('ls /sharepoint/')
  const sites = lines(r.stdoutText.trim())
    .map((s) => s.trim())
    .filter((s) => s !== '')
  if (sites.length === 0) throw new Error('No SharePoint sites accessible')
  const site = sites[0]!
  r = await ws.shell(`ls ${shellQuote(`/sharepoint/${site}/`)}`)
  const drives = lines(r.stdoutText.trim())
    .map((d) => d.trim())
    .filter((d) => d !== '')
  if (drives.length === 0) throw new Error(`No drives in site '${site}'`)
  return [site, drives[0]!]
}

function buildTests(testDir: string, testFile: string): [Test[], Test[], Test[]] {
  const commands: Test[] = [
    ['touch', `touch ${shellQuote(testFile)}`],
    [
      'echo write',
      `echo "hello world\nfoo bar\nhello again\napple\nbanana" > ${shellQuote(testFile)}`,
    ],
    ['ls', `ls ${shellQuote(testDir)}`],
    ['ls -l', `ls -l ${shellQuote(testDir)}`],
    ['ls -la', `ls -la ${shellQuote(testDir)}`],
    ['find', `find ${shellQuote(testDir)}`],
    ['tree', `tree ${shellQuote(testDir)}`],
    ['cat', `cat ${shellQuote(testFile)}`],
    ['head', `head ${shellQuote(testFile)}`],
    ['head -n 2', `head -n 2 ${shellQuote(testFile)}`],
    ['tail', `tail ${shellQuote(testFile)}`],
    ['tail -n 2', `tail -n 2 ${shellQuote(testFile)}`],
    ['wc', `wc ${shellQuote(testFile)}`],
    ['wc -l', `wc -l ${shellQuote(testFile)}`],
    ['wc -c', `wc -c ${shellQuote(testFile)}`],
    ['grep', `grep hello ${shellQuote(testFile)}`],
    ['grep -c', `grep -c hello ${shellQuote(testFile)}`],
    ['grep -n', `grep -n hello ${shellQuote(testFile)}`],
    ['grep -i', `grep -i HELLO ${shellQuote(testFile)}`],
    ['rg', `rg hello ${shellQuote(testDir)}`],
    ['rg -l', `rg -l hello ${shellQuote(testDir)}`],
    ['stat', `stat ${shellQuote(testFile)}`],
    ['file', `file ${shellQuote(testFile)}`],
    ['du', `du ${shellQuote(testDir)}`],
    ['basename', `basename ${shellQuote(testFile)}`],
    ['dirname', `dirname ${shellQuote(testFile)}`],
    ['realpath', `realpath ${shellQuote(testFile)}`],
    ['nl', `nl ${shellQuote(testFile)}`],
    ['rev', `rev ${shellQuote(testFile)}`],
    ['tac', `tac ${shellQuote(testFile)}`],
    ['sort', `sort ${shellQuote(testFile)}`],
    ['uniq', `uniq ${shellQuote(testFile)}`],
    ['cut -c1-5', `cut -c1-5 ${shellQuote(testFile)}`],
    ['tr a-z A-Z', `cat ${shellQuote(testFile)} | tr a-z A-Z`],
    ['fold -w 10', `fold -w 10 ${shellQuote(testFile)}`],
    ['fmt', `fmt ${shellQuote(testFile)}`],
    ['expand', `expand ${shellQuote(testFile)}`],
    ['unexpand', `unexpand ${shellQuote(testFile)}`],
    ['md5', `md5 ${shellQuote(testFile)}`],
    ['sha256sum', `sha256sum ${shellQuote(testFile)}`],
    ['base64', `base64 ${shellQuote(testFile)}`],
    ['xxd', `xxd ${shellQuote(testFile)}`],
    ['strings', `strings ${shellQuote(testFile)}`],
    ['column', `column ${shellQuote(testFile)}`],
    ['paste', `paste ${shellQuote(testFile)} ${shellQuote(testFile)}`],
    ['join', `join ${shellQuote(testFile)} ${shellQuote(testFile)}`],
    ['look', `look h ${shellQuote(testFile)}`],
    ['diff (same)', `diff ${shellQuote(testFile)} ${shellQuote(testFile)}`],
    ['cmp (same)', `cmp ${shellQuote(testFile)} ${shellQuote(testFile)}`],
    ['cp', `cp ${shellQuote(testFile)} ${shellQuote(`${testDir}/copy.txt`)}`],
    ['mv', `mv ${shellQuote(`${testDir}/copy.txt`)} ${shellQuote(`${testDir}/moved.txt`)}`],
    ['ln', `ln ${shellQuote(`${testDir}/moved.txt`)} ${shellQuote(`${testDir}/link.txt`)}`],
    ['rm link', `rm ${shellQuote(`${testDir}/link.txt`)}`],
    ['rm moved', `rm ${shellQuote(`${testDir}/moved.txt`)}`],
    ['cat > write2', `echo "second file" > ${shellQuote(`${testDir}/file2.txt`)}`],
    [
      'sed -f',
      `echo 's/hello/HELLO/' | tee ${shellQuote(`${testDir}/prog.sed`)} > /dev/null` +
        ` && sed -f ${shellQuote(`${testDir}/prog.sed`)} ${shellQuote(testFile)} && rm ${shellQuote(`${testDir}/prog.sed`)}`,
    ],
    ['grep -r', `grep -r hello ${shellQuote(testDir)}`],
    ['grep -rl', `grep -rl hello ${shellQuote(testDir)}`],
    ['find -name', `find ${shellQuote(testDir)} -name "*.txt"`],
    ['find -type f', `find ${shellQuote(testDir)} -type f`],
  ]

  const pipeTests: Test[] = [
    ['cat|wc -l', `cat ${shellQuote(testFile)} | wc -l`],
    ['cat|grep', `cat ${shellQuote(testFile)} | grep hello`],
    ['cat|head', `cat ${shellQuote(testFile)} | head -n 2`],
    ['grep|sort', `grep hello ${shellQuote(testFile)} | sort`],
    ['grep|wc', `grep hello ${shellQuote(testFile)} | wc -l`],
    ['find|wc', `find ${shellQuote(testDir)} | wc -l`],
    ['find|head', `find ${shellQuote(testDir)} | head -2`],
    ['cat|sort|uniq', `cat ${shellQuote(testFile)} | sort | uniq`],
    ['cat|grep|wc', `cat ${shellQuote(testFile)} | grep hello | wc -l`],
    ['cat|tr|sort|uniq', `cat ${shellQuote(testFile)} | tr a-z A-Z | sort | uniq`],
    ['find|grep|wc', `find ${shellQuote(testDir)} | grep hello | wc -l`],
    ['cat|sed', `cat ${shellQuote(testFile)} | sed 's/hello/HELLO/'`],
  ]

  const shellTests: Test[] = [
    ['variable', 'X=hello; echo $X'],
    ['arithmetic', 'echo $((2 + 3))'],
    ['cmd substitution', `echo $(cat ${shellQuote(testFile)} | wc -l) lines`],
    [
      'if-else exists',
      `if [ -f ${shellQuote(testFile)} ]; then echo exists; else echo missing; fi`,
    ],
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

async function makeScratchDir(ws: Workspace, path: string): Promise<void> {
  const r = await ws.shell(`mkdir ${shellQuote(path)}`)
  if (r.exitCode !== 0) throw new Error(`mkdir ${path} failed: ${r.stderrText.trim()}`)
}

async function runSuite(
  ws: Workspace,
  testDir: string,
  testFile: string,
): Promise<[Result[], Result[], Result[]]> {
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
    `chmod 640 ${shellQuote(testFile)} && chown 500:dev ${shellQuote(testFile)} && touch -t 202601021530 ${shellQuote(testFile)}`,
  )
  console.log(`  chmod/chown/touch exit=${String(metaRes.exitCode)}`)
  const metaSt = (await ws.dispatch('stat', testFile)) as FileStat
  const metaMode = metaSt.mode !== null ? metaSt.mode.toString(8) : '-'
  console.log(
    `  dispatch stat: mode=${metaMode} uid=${String(metaSt.uid)} gid=${String(metaSt.gid)} mtime=${String(metaSt.modified)}`,
  )

  return [cmdResults, pipeResults, shellResults]
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
    const testDir = `${base}/mirage-sp-test-${randomUUID().replaceAll('-', '').slice(0, 8)}`
    const testFile = `${testDir}/hello.txt`
    console.log(`Site: ${site}, Drive: ${drive}`)
    console.log(`Test dir: ${testDir}\n`)

    await makeScratchDir(ws, testDir)
    let results: [Result[], Result[], Result[]]
    try {
      results = await runSuite(ws, testDir, testFile)
    } finally {
      console.log('\n=== Cleanup ===')
      await ws.shell(`rm -r ${shellQuote(testDir)}`)
      console.log('  done')
    }
    const [cmdResults, pipeResults, shellResults] = results

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
