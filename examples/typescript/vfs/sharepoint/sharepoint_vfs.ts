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
import { MountMode, SharePointVFS, Workspace } from '@struktoai/mirage-node'

const __HERE = fileURLToPath(new URL('.', import.meta.url))
dotenv.config({ path: resolve(__HERE, '../../../../.env.development'), override: true })

const REPORT_FILE = resolve(__HERE, 'sharepoint_vfs_results.md')

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

// diff and comm exit 1 when the inputs differ; with output, that is a pass.
const DIFF_EXIT1_OK = new Set(['diff different', 'comm'])

async function runTest(ws: Workspace, name: string, cmd: string): Promise<Result> {
  try {
    const r = await ws.shell(cmd)
    const stdout = r.stdoutText
    let ok = r.exitCode === 0
    if (!ok && DIFF_EXIT1_OK.has(name) && r.exitCode === 1 && stdout !== '') ok = true
    return [name, cmd, ok, stdout.trimEnd(), r.stderrText.trimEnd()]
  } catch (err) {
    return [name, cmd, false, '', err instanceof Error ? err.message : String(err)]
  }
}

async function runSection(ws: Workspace, tests: Test[], sectionName: string): Promise<Result[]> {
  console.log(`\n=== ${sectionName} ===`)
  const results: Result[] = []
  for (const [name, cmd] of tests) {
    const result = await runTest(ws, name, cmd)
    results.push(result)
    const [, , ok, stdout, stderr] = result
    console.log(`  ${ok ? '✅' : '❌'} ${name}`)
    if (stdout !== '') {
      const out = lines(stdout)
      for (const line of out.slice(0, 3)) console.log(`      | ${line}`)
      if (out.length > 3) console.log(`      | ... (${String(out.length)} lines)`)
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

function writeReport(site: string, drive: string, allSections: [string, Result[]][]): void {
  const out = ['# SharePoint VFS Integration Test Results\n']
  out.push(`**Site:** ${site}  \n**Drive:** ${drive}\n`)
  out.push('Tests use `ws.shell()` — Mirage VFS layer (in-process).\n')

  const allResults = allSections.flatMap(([, results]) => results)
  const total = allResults.length
  const passed = countPassed(allResults)
  out.push(
    `**Total: ${String(passed)} passed, ${String(total - passed)} failed,` +
      ` ${String(total)} total (${((passed / total) * 100).toFixed(1)}%)**\n`,
  )

  for (const [sectionName, results] of allSections) {
    out.push(`\n## ${sectionName}\n`)
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
  const r = await ws.shell(`mkdir "${path}"`)
  if (r.exitCode !== 0) throw new Error(`mkdir ${path} failed: ${r.stderrText.trim()}`)
}

async function runSuite(
  ws: Workspace,
  d: string,
  f1: string,
  f2: string,
): Promise<[string, Result[]][]> {
  // --- Setup ---
  const setup: Test[] = [
    ['write f1', `echo "hello world\nfoo bar\nhello again\napple\nbanana" > "${f1}"`],
    [
      'write f2',
      `echo "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10" > "${f2}"`,
    ],
  ]
  const setupResults = await runSection(ws, setup, 'Setup')

  // --- Read commands ---
  const readCmds: Test[] = [
    ['cat', `cat "${f1}"`],
    ['head', `head "${f1}"`],
    ['head -n 2', `head -n 2 "${f1}"`],
    ['head -c 10', `head -c 10 "${f1}"`],
    ['tail', `tail "${f1}"`],
    ['tail -n 2', `tail -n 2 "${f1}"`],
    ['cat f2', `cat "${f2}"`],
    ['head -n 5 f2', `head -n 5 "${f2}"`],
    ['tail -n 3 f2', `tail -n 3 "${f2}"`],
  ]
  const readResults = await runSection(ws, readCmds, 'Read Commands')

  // --- Metadata ---
  const metaCmds: Test[] = [
    ['ls', `ls "${d}"`],
    ['ls -l', `ls -l "${d}"`],
    ['ls -la', `ls -la "${d}"`],
    ['ls -lh', `ls -lh "${d}"`],
    ['stat f1', `stat "${f1}"`],
    ['stat f2', `stat "${f2}"`],
    ['file f1', `file "${f1}"`],
    ['file f2', `file "${f2}"`],
    ['du', `du "${d}"`],
    ['du f1', `du "${f1}"`],
    ['find', `find "${d}"`],
    ['find -name', `find "${d}" -name "*.txt"`],
    ['find -type f', `find "${d}" -type f`],
    ['tree', `tree "${d}"`],
    ['basename', `basename "${f1}"`],
    ['dirname', `dirname "${f1}"`],
    ['realpath', `realpath "${f1}"`],
  ]
  const metaResults = await runSection(ws, metaCmds, 'Metadata Commands')

  // --- Search ---
  const searchCmds: Test[] = [
    ['grep hello', `grep hello "${f1}"`],
    ['grep -c hello', `grep -c hello "${f1}"`],
    ['grep -n hello', `grep -n hello "${f1}"`],
    ['grep -i HELLO', `grep -i HELLO "${f1}"`],
    ['grep -v hello', `grep -v hello "${f1}"`],
    ['grep -r hello', `grep -r hello "${d}"`],
    ['grep -rl hello', `grep -rl hello "${d}"`],
    ['grep -rc hello', `grep -rc hello "${d}"`],
    ['rg hello', `rg hello "${d}"`],
    ['rg -l hello', `rg -l hello "${d}"`],
    ['rg -c hello', `rg -c hello "${d}"`],
  ]
  const searchResults = await runSection(ws, searchCmds, 'Search Commands')

  // --- Text Processing ---
  const textCmds: Test[] = [
    ['wc', `wc "${f1}"`],
    ['wc -l', `wc -l "${f1}"`],
    ['wc -c', `wc -c "${f1}"`],
    ['wc -w', `wc -w "${f1}"`],
    ['sort', `sort "${f1}"`],
    ['sort -r', `sort -r "${f1}"`],
    ['uniq', `uniq "${f1}"`],
    ['rev', `rev "${f1}"`],
    ['tac', `tac "${f1}"`],
    ['nl', `nl "${f1}"`],
    ['cut -c1-5', `cut -c1-5 "${f1}"`],
    ["cut -d' ' -f1", `cut -d' ' -f1 "${f1}"`],
    ['tr a-z A-Z', `cat "${f1}" | tr a-z A-Z`],
    ['fold -w 10', `fold -w 10 "${f1}"`],
    ['fmt', `fmt "${f1}"`],
    ['expand', `expand "${f1}"`],
    ['unexpand', `unexpand "${f1}"`],
    ['column', `column "${f1}"`],
    ['paste', `paste "${f1}" "${f2}"`],
    ['join', `join "${f1}" "${f1}"`],
    ['look h', `look h "${f1}"`],
    ['strings', `strings "${f1}"`],
  ]
  const textResults = await runSection(ws, textCmds, 'Text Processing')

  // --- Hash/Encode ---
  const encodeCmds: Test[] = [
    ['md5', `md5 "${f1}"`],
    ['sha256sum', `sha256sum "${f1}"`],
    ['base64 encode', `base64 "${f1}"`],
    ['base64 decode', `base64 "${f1}" | base64 -d`],
    ['xxd', `xxd "${f1}"`],
    ['xxd -l 16', `xxd -l 16 "${f1}"`],
  ]
  const encodeResults = await runSection(ws, encodeCmds, 'Hash/Encode')

  // --- Write/Mutate ---
  const writeCmds: Test[] = [
    ['cp', `cp "${f1}" "${d}/copy.txt"`],
    ['cat copy', `cat "${d}/copy.txt"`],
    ['mv', `mv "${d}/copy.txt" "${d}/moved.txt"`],
    ['cat moved', `cat "${d}/moved.txt"`],
    ['ln', `ln "${d}/moved.txt" "${d}/link.txt"`],
    ['cat link', `cat "${d}/link.txt"`],
    ['rm link', `rm "${d}/link.txt"`],
    ['rm moved', `rm "${d}/moved.txt"`],
    ['echo append', `echo "appended line" >> "${f1}"`],
    ['cat after append', `cat "${f1}"`],
    ['touch new', `touch "${d}/empty.txt"`],
    ['ls after touch', `ls "${d}"`],
  ]
  const writeResults = await runSection(ws, writeCmds, 'Write/Mutate Commands')

  // --- Pipes ---
  const pipeCmds: Test[] = [
    ['cat|wc -l', `cat "${f1}" | wc -l`],
    ['cat|grep|wc', `cat "${f1}" | grep hello | wc -l`],
    ['cat|head|wc', `cat "${f2}" | head -n 5 | wc -l`],
    ['cat|sort|uniq', `cat "${f1}" | sort | uniq`],
    ['cat|tr|sort', `cat "${f1}" | tr a-z A-Z | sort`],
    ['grep|sort|uniq', `grep hello "${f1}" | sort | uniq`],
    ['find|wc -l', `find "${d}" -type f | wc -l`],
    ['find|grep|head', `find "${d}" | grep txt | head -3`],
    ['cat|sed', `cat "${f1}" | sed 's/hello/HELLO/g'`],
    ['cat|awk', `cat "${f1}" | awk '{print NR, $0}'`],
    ['cat|grep -c', `cat "${f1}" | grep -c hello`],
    ['seq|while', 'seq 5 | while read n; do echo "num=$n"; done'],
  ]
  const pipeResults = await runSection(ws, pipeCmds, 'Pipes')

  // --- Shell features ---
  const shellCmds: Test[] = [
    ['variable', 'X=sharepoint; echo $X'],
    ['arithmetic', 'echo $((10 * 3 + 2))'],
    ['cmd subst', `echo $(wc -l < "${f1}") lines`],
    ['if file exists', `if [ -f "${f1}" ]; then echo yes; else echo no; fi`],
    ['if file missing', 'if [ -f "/sharepoint/x/y/z" ]; then echo yes; else echo no; fi'],
    ['for loop', 'for i in a b c; do echo $i; done'],
    ['while read', 'echo "1\n2\n3" | while read x; do echo got_$x; done'],
    ['function def', 'add() { echo $(($1 + $2)); }; add 3 4'],
    ['nested for', 'for i in 1 2; do for j in x y; do echo $i$j; done; done'],
    ['error suppress', 'cat /nonexistent 2>/dev/null; echo ok'],
    ['string ops', 'S="hello world"; echo ${#S}'],
    ['multiline', `cat "${f1}" | while read line; do echo ">>$line"; done`],
  ]
  const shellResults = await runSection(ws, shellCmds, 'Shell Features')

  // --- Compare ---
  const compareCmds: Test[] = [
    ['diff same', `diff "${f1}" "${f1}"`],
    ['cmp same', `cmp "${f1}" "${f1}"`],
    ['diff different', `diff "${f1}" "${f2}"`],
    ['comm', `comm "${f1}" "${f2}"`],
  ]
  const compareResults = await runSection(ws, compareCmds, 'Compare Commands')

  return [
    ['Setup', setupResults],
    ['Read Commands', readResults],
    ['Metadata Commands', metaResults],
    ['Search Commands', searchResults],
    ['Text Processing', textResults],
    ['Hash/Encode', encodeResults],
    ['Write/Mutate Commands', writeResults],
    ['Pipes', pipeResults],
    ['Shell Features', shellResults],
    ['Compare Commands', compareResults],
  ]
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
    const d = `${base}/mirage-vfs-test-${randomUUID().replaceAll('-', '').slice(0, 8)}`
    const f1 = `${d}/hello.txt`
    const f2 = `${d}/data.txt`
    console.log(`Site: ${site}, Drive: ${drive}`)
    console.log(`Test dir: ${d}`)

    await makeScratchDir(ws, d)
    let allSections: [string, Result[]][]
    try {
      allSections = await runSuite(ws, d, f1, f2)
    } finally {
      // --- Cleanup ---
      console.log('\n=== Cleanup ===')
      await ws.shell(`rm -r "${d}"`)
      console.log('  done')
    }

    writeReport(site, drive, allSections)

    const allResults = allSections.flatMap(([, results]) => results)
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
