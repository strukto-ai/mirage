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

import dotenv from 'dotenv'
import {
  MountMode,
  SlackResource,
  Workspace,
  type SlackConfig,
} from '@struktoai/mirage-node'

dotenv.config({ path: '.env.development' })

function buildConfig(): SlackConfig {
  const token = process.env.SLACK_BOT_TOKEN
  if (token === undefined || token === '') {
    throw new Error('SLACK_BOT_TOKEN env var is required')
  }
  const searchToken = process.env.SLACK_USER_TOKEN
  return {
    token,
    ...(searchToken !== undefined && searchToken !== '' ? { searchToken } : {}),
  }
}

function assertNonEmpty(out: string, msg: string): void {
  if (out.trim() === '') throw new Error(`regression: ${msg}`)
}

async function main(): Promise<void> {
  const resource = new SlackResource(buildConfig())
  const ws = new Workspace({ '/slack': resource }, { mode: MountMode.READ })

  try {
    // ── discover structure ─────────────────────────────
    console.log('=== ls /slack/ (root) ===')
    let r = await ws.execute('ls /slack/')
    console.log(r.stdoutText)

    console.log('=== ls /slack/channels/ ===')
    r = await ws.execute('ls /slack/channels/ | head -n 5')
    console.log(r.stdoutText)

    console.log('=== ls /slack/users/ ===')
    r = await ws.execute('ls /slack/users/ | head -n 5')
    console.log(r.stdoutText)

    r = await ws.execute('ls /slack/channels/ | head -n 1')
    const firstCh = r.stdoutText.trim()
    if (firstCh === '') {
      console.log('no channels found')
      return
    }

    const base = `/slack/channels/${firstCh}`

    console.log(`=== ls ${firstCh} (dates) ===`)
    r = await ws.execute(`ls "${base}/" | tail -n 5`)
    console.log(r.stdoutText)

    // Pick the most recent date dir and target its chat.jsonl
    r = await ws.execute(`ls "${base}/" | tail -n 1`)
    const dateDir = r.stdoutText.trim()
    if (dateDir === '') {
      console.log('  no dates found')
      return
    }
    const datePath = `${base}/${dateDir}`
    const filePath = `${datePath}/chat.jsonl`
    const target = 'chat.jsonl'

    console.log(`  using date: ${datePath}`)
    console.log(`  using file: ${target}`)

    // ── ls inside date dir (chat.jsonl + files/) ──────
    console.log(`\n=== ls ${datePath}/ ===`)
    r = await ws.execute(`ls "${datePath}/"`)
    console.log(r.stdoutText.trimEnd())

    // ── cat ────────────────────────────────────────────
    console.log(`\n=== cat ${target} | head -n 3 ===`)
    r = await ws.execute(`cat "${filePath}" | head -n 3`)
    console.log(r.stdoutText.slice(0, 300))

    // ── cat user profile ───────────────────────────────
    r = await ws.execute('ls /slack/users/ | head -n 1')
    const firstUser = r.stdoutText.trim()
    console.log(`\n=== cat /slack/users/${firstUser} ===`)
    r = await ws.execute(`cat "/slack/users/${firstUser}"`)
    const userOut = r.stdoutText.trim()
    if (userOut !== '') {
      console.log(`  ${userOut.slice(0, 200)}`)
    } else {
      console.log('  (empty)')
    }

    // ── stat ───────────────────────────────────────────
    console.log(`\n=== stat ${target} ===`)
    r = await ws.execute(`stat "${filePath}"`)
    console.log(`  ${r.stdoutText.trim()}`)

    // ── wc ─────────────────────────────────────────────
    console.log(`\n=== wc -l ${target} ===`)
    r = await ws.execute(`wc -l "${filePath}"`)
    console.log(`  ${r.stdoutText.trim()}`)

    // ── head ───────────────────────────────────────────
    console.log(`\n=== head -n 2 ${target} ===`)
    r = await ws.execute(`head -n 2 "${filePath}"`)
    const headOut = r.stdoutText.trim()
    if (headOut !== '') {
      for (const line of headOut.split('\n')) {
        console.log(`  ${line.slice(0, 120)}`)
      }
    }

    // ── tail ───────────────────────────────────────────
    console.log(`\n=== tail -n 1 ${target} ===`)
    r = await ws.execute(`tail -n 1 "${filePath}"`)
    const tailOut = r.stdoutText.trim()
    if (tailOut !== '') {
      console.log(`  ${tailOut.slice(0, 120)}`)
    }

    // ── grep at FILE level ─────────────────────────────
    console.log(`\n=== grep message ${target} ===`)
    r = await ws.execute(`grep message "${filePath}"`)
    const grepOut = r.stdoutText.trim()
    const grepLines = grepOut === '' ? [] : grepOut.split('\n')
    console.log(`  matches: ${String(grepLines.length)}`)
    if (grepLines.length > 0) {
      console.log(`  first: ${grepLines[0]?.slice(0, 120) ?? ''}...`)
    }

    console.log(`\n=== grep -c message ${target} ===`)
    r = await ws.execute(`grep -c message "${filePath}"`)
    console.log(`  count: ${r.stdoutText.trim()}`)

    // ── rg (directory scan) ────────────────────────────
    console.log(`\n=== rg message ${base}/ ===`)
    r = await ws.execute(`rg message "${base}/"`)
    const rgOut = r.stdoutText.trim()
    const rgLines = rgOut === '' ? [] : rgOut.split('\n')
    console.log(`  matches across dates: ${String(rgLines.length)}`)

    console.log(`\n=== rg -l message ${base}/ ===`)
    r = await ws.execute(`rg -l message "${base}/"`)
    const rglOut = r.stdoutText.trim()
    const rglFiles = rglOut === '' ? [] : rglOut.split('\n')
    console.log(`  files with matches: ${String(rglFiles.length)}`)
    for (const f of rglFiles) {
      console.log(`  ${f}`)
    }

    // ── attachments: ls + stat on files/ ──────────────
    const filesDir = `${datePath}/files`
    console.log(`\n=== ls ${filesDir}/ (attachments) ===`)
    r = await ws.execute(`ls "${filesDir}/"`)
    const blobLines = r.stdoutText.trim() === '' ? [] : r.stdoutText.trim().split('\n')
    for (const line of blobLines) {
      console.log(`  ${line}`)
    }

    if (blobLines.length > 0) {
      const firstBlob = blobLines[0]?.split('/').pop() ?? ''
      const blobPath = `${filesDir}/${firstBlob}`
      console.log(`\n=== stat ${firstBlob} ===`)
      r = await ws.execute(`stat "${blobPath}"`)
      console.log(`  ${r.stdoutText.trim()}`)

      // search.files push-down via rg on files/
      console.log(`\n=== rg . ${filesDir}/ (search.files push-down) ===`)
      r = await ws.execute(`rg . "${filesDir}/"`)
      const pushdownOut = r.stdoutText.trim()
      const pushdownLines = pushdownOut === '' ? [] : pushdownOut.split('\n').slice(0, 5)
      for (const line of pushdownLines) {
        console.log(`  ${line.slice(0, 150)}`)
      }
    }

    // ── native search dispatch ─────────────────────────
    // search.messages requires a user token (xoxp-) with search:read.
    // Bot tokens get not_allowed_token_type. We probe these anyway to
    // document behavior.
    const nativeDispatch: { label: string; cmd: string }[] = [
      {
        label: `grep hello ${datePath}/chat.jsonl (date scope)`,
        cmd: `grep hello "${datePath}/chat.jsonl"`,
      },
      {
        label: `grep hello ${base}/ (channel scope)`,
        cmd: `grep hello "${base}/"`,
      },
      {
        label: 'grep hello /slack/channels/ (workspace scope)',
        cmd: 'grep hello /slack/channels/',
      },
      {
        label: 'rg hello /slack/ (workspace scope)',
        cmd: 'rg hello /slack/',
      },
    ]
    for (const { label, cmd } of nativeDispatch) {
      console.log(`\n=== ${label} ===`)
      r = await ws.execute(cmd)
      const out = r.stdoutText.trim()
      const err = r.stderrText.trim()
      const lines = out === '' ? [] : out.split('\n')
      console.log(`  exit=${String(r.exitCode)} matches: ${String(lines.length)}`)
      if (err !== '') {
        console.log(`  stderr: ${err.slice(0, 200)}`)
      }
      for (const line of lines.slice(0, 3)) {
        console.log(`  ${line.slice(0, 150)}`)
      }
    }

    // ── jq ─────────────────────────────────────────────
    console.log(`\n=== jq '.[] | .user' ${target} ===`)
    r = await ws.execute(`jq ".[] | .user" "${filePath}"`)
    console.log(`  exit=${String(r.exitCode)}`)
    const jqOut = r.stdoutText.trim()
    if (jqOut !== '') {
      for (const line of jqOut.split('\n').slice(0, 5)) {
        console.log(`  ${line}`)
      }
    }

    console.log(`\n=== cat ${target} | jq -r '.[] | .text' | head -n 5 ===`)
    r = await ws.execute(`cat "${filePath}" | jq -r ".[] | .text" | head -n 5`)
    console.log(`  exit=${String(r.exitCode)}`)
    const jqTextOut = r.stdoutText.trim()
    if (jqTextOut !== '') {
      for (const line of jqTextOut.split('\n').slice(0, 5)) {
        console.log(`  ${line}`)
      }
    }

    // ── tree ───────────────────────────────────────────
    console.log('\n=== tree -L 1 /slack/ ===')
    r = await ws.execute('tree -L 1 /slack/')
    console.log(`  exit=${String(r.exitCode)}`)
    const treeOut = r.stdoutText.trim()
    if (treeOut !== '') {
      for (const line of treeOut.split('\n')) {
        console.log(`  ${line}`)
      }
    }

    // ── find ───────────────────────────────────────────
    console.log(`\n=== find ${base}/ -name 'chat.jsonl' | tail -n 5 ===`)
    r = await ws.execute(`find "${base}/" -name "chat.jsonl" | tail -n 5`)
    console.log(`  exit=${String(r.exitCode)}`)
    const findOut = r.stdoutText.trim()
    if (findOut !== '') {
      for (const line of findOut.split('\n')) {
        console.log(`  ${line}`)
      }
    }

    console.log("\n=== find /slack/ -name 'general*' ===")
    r = await ws.execute('find /slack/ -name "general*"')
    console.log(`  exit=${String(r.exitCode)}`)
    const findGeneralOut = r.stdoutText.trim()
    if (findGeneralOut !== '') {
      for (const line of findGeneralOut.split('\n')) {
        console.log(`  ${line}`)
      }
    }

    // ── pwd / cd ───────────────────────────────────────
    console.log('\n=== pwd ===')
    r = await ws.execute('pwd')
    console.log(`  ${r.stdoutText.trim()}`)

    console.log(`\n=== cd "${base}" ===`)
    r = await ws.execute(`cd "${base}"`)
    console.log(`  exit=${String(r.exitCode)}`)

    console.log('\n=== pwd (after cd) ===')
    r = await ws.execute('pwd')
    console.log(`  ${r.stdoutText.trim()}`)

    // ── ls (no args) after cd — regression: would return [] if mount
    // prefix was dropped while rebuilding cwd's PathSpec.
    console.log('\n=== ls (no args, in channel dir) ===')
    r = await ws.execute('ls | tail -n 5')
    const relLsOut = r.stdoutText.trim()
    assertNonEmpty(relLsOut, '`ls` (no args) after cd returned empty')
    for (const line of relLsOut.split('\n')) {
      console.log(`  ${line}`)
    }

    // relative `cat` (after cd) for a path two segments deep
    const relChat = `${dateDir}/chat.jsonl`
    console.log(`\n=== cat ${relChat} (relative) | head -n 1 ===`)
    r = await ws.execute(`cat "${relChat}" | head -n 1`)
    const relCatOut = r.stdoutText.trim()
    assertNonEmpty(relCatOut, 'relative `cat` after cd returned empty')
    console.log(`  ${relCatOut.slice(0, 120)}`)

    // ── workspace-wide find — regression: would abort with
    // not_in_channel if any channel was inaccessible. Now skips
    // those channels and walks the rest.
    console.log("\n=== find /slack/ -name 'chat.jsonl' (must not abort) ===")
    r = await ws.execute(`find /slack/ -name "chat.jsonl" | wc -l`)
    const count = Number.parseInt(r.stdoutText.trim() === '' ? '0' : r.stdoutText.trim(), 10)
    console.log(`  matches: ${String(count)}`)
    if (r.exitCode !== 0) {
      throw new Error(`regression: workspace-wide find aborted; stderr=${r.stderrText}`)
    }
    if (count === 0) {
      throw new Error('regression: workspace-wide find returned no matches')
    }

    // ── glob expansion (KNOWN LIMITATION: only single-segment globs
    // are supported; multi-level patterns like `path/*/file` do not
    // walk intermediate `*` segments today).
    console.log(`\n=== echo ${base}/*/chat.jsonl (multi-level glob — limitation) ===`)
    r = await ws.execute(`echo "${base}/"*/chat.jsonl`)
    console.log(
      `  out=${JSON.stringify(r.stdoutText.trim().slice(0, 200))}  (multi-level globs are not expanded today)`,
    )

    console.log(`\n=== for f in ${base}/*/chat.jsonl (glob loop — limitation) ===`)
    r = await ws.execute(
      `for f in "${base}/"*/chat.jsonl; do echo found:$f; done | head -n 3`,
    )
    const loopOut = r.stdoutText.trim()
    if (loopOut !== '') {
      for (const line of loopOut.split('\n')) {
        console.log(`  ${line.slice(0, 120)}`)
      }
    } else {
      console.log('  (no output — multi-level glob limitation)')
    }
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
