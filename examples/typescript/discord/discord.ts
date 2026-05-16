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
  DiscordResource,
  MountMode,
  Workspace,
  type DiscordConfig,
} from '@struktoai/mirage-node'

dotenv.config({ path: '.env.development' })

function buildConfig(): DiscordConfig {
  const token = process.env.DISCORD_BOT_TOKEN
  if (token === undefined || token === '') {
    throw new Error('DISCORD_BOT_TOKEN env var is required')
  }
  return { token }
}

function assertNonEmpty(out: string, msg: string): void {
  if (out.trim() === '') throw new Error(`regression: ${msg}`)
}

async function main(): Promise<void> {
  const resource = new DiscordResource(buildConfig())
  const ws = new Workspace({ '/discord': resource }, { mode: MountMode.READ })

  try {
    console.log('=== ls /discord/ (guilds) ===')
    let r = await ws.execute('ls /discord/')
    console.log(r.stdoutText)
    assertNonEmpty(r.stdoutText, 'ls /discord/ returned no guilds')

    const guild = r.stdoutText.trim().split('\n')[0]!.trim()
    console.log(`=== ls /discord/${guild}/channels/ ===`)
    r = await ws.execute(`ls "/discord/${guild}/channels/"`)
    console.log(r.stdoutText)
    assertNonEmpty(r.stdoutText, 'no channels in first guild')

    const ch = r.stdoutText.trim().split('\n')[0]!.trim()
    const base = `/discord/${guild}/channels/${ch}`

    // ── pick a date with messages ──────────────────
    console.log(`\n=== ls ${base}/ (date directories, last 5) ===`)
    r = await ws.execute(`ls "${base}/" | tail -n 5`)
    console.log(r.stdoutText)
    const dates = r.stdoutText
      .trim()
      .split('\n')
      .map((d) => d.trim())
      .filter((d) => d !== '')
    if (dates.length === 0) {
      console.log('  (no date directories — channel is empty)')
      return
    }
    let targetDate = dates[dates.length - 1]!
    for (let i = dates.length - 1; i >= 0; i--) {
      const d = dates[i]!
      const test = await ws.execute(`cat "${base}/${d}/chat.jsonl" | head -c 1`)
      if (test.stdoutText.trim() !== '') {
        targetDate = d
        break
      }
    }
    console.log(`  using date: ${targetDate}`)
    const filePath = `${base}/${targetDate}/chat.jsonl`

    // ── cat chat.jsonl ─────────────────────────────
    console.log(`\n=== cat ${targetDate}/chat.jsonl | head -n 3 ===`)
    r = await ws.execute(`cat "${filePath}" | head -n 3`)
    console.log(r.stdoutText.slice(0, 300))

    // ── date dir contents ──────────────────────────
    console.log(`\n=== ls ${base}/${targetDate}/ ===`)
    r = await ws.execute(`ls "${base}/${targetDate}/"`)
    console.log(r.stdoutText)

    // ── files dir ──────────────────────────────────
    console.log(`\n=== ls ${base}/${targetDate}/files/ (attachments) ===`)
    r = await ws.execute(`ls "${base}/${targetDate}/files/"`)
    const filesOut = r.stdoutText.trim()
    if (filesOut !== '') {
      for (const line of filesOut.split('\n').slice(0, 5)) console.log(`  ${line}`)
    } else {
      console.log('  (no attachments on this date)')
    }

    // ── grep at FILE level ─────────────────────────
    console.log(`\n=== grep at FILE level: grep -c . ${targetDate}/chat.jsonl ===`)
    r = await ws.execute(`grep -c . "${filePath}"`)
    console.log(`  line count: ${r.stdoutText.trim()}`)

    // ── grep at CHANNEL level (Discord search push-down) ──
    console.log(`\n=== grep at CHANNEL level: grep -m 5 . ${base}/ ===`)
    r = await ws.execute(`grep -m 5 . "${base}/"`)
    console.log(`  exit=${String(r.exitCode)}`)
    const chanOut = r.stdoutText.trim()
    if (chanOut !== '') {
      for (const line of chanOut.split('\n').slice(0, 5)) console.log(`  ${line.slice(0, 120)}`)
    } else {
      console.log('  (no results)')
    }
    const err = r.stderrText
    if (err !== '') console.log(`  stderr: ${err.slice(0, 200)}`)

    // ── grep at GUILD level ────────────────────────
    console.log(`\n=== grep at GUILD level: grep -m 5 . /discord/${guild}/ ===`)
    r = await ws.execute(`grep -m 5 . "/discord/${guild}/"`)
    console.log(`  exit=${String(r.exitCode)}`)
    const guildOut = r.stdoutText.trim()
    if (guildOut !== '') {
      for (const line of guildOut.split('\n').slice(0, 5)) console.log(`  ${line.slice(0, 120)}`)
    }

    // ── jq pipeline ────────────────────────────────
    console.log(`\n=== jq -r '.[] | .author.username' ${targetDate}/chat.jsonl ===`)
    r = await ws.execute(`jq -r ".[] | .author.username" "${filePath}" | head -n 5`)
    const jqOut = r.stdoutText.trim()
    if (jqOut !== '') {
      for (const line of jqOut.split('\n').slice(0, 5)) console.log(`  ${line}`)
    }

    // ── stat ───────────────────────────────────────
    console.log(`\n=== stat ${filePath} ===`)
    r = await ws.execute(`stat "${filePath}"`)
    console.log(`  ${r.stdoutText.trim().slice(0, 200)}`)

    // ── wc ─────────────────────────────────────────
    console.log(`\n=== wc -l ${targetDate}/chat.jsonl ===`)
    r = await ws.execute(`wc -l "${filePath}"`)
    console.log(`  ${r.stdoutText.trim()}`)

    // ── tree ───────────────────────────────────────
    console.log(`\n=== tree -L 2 /discord/${guild}/ | head -n 20 ===`)
    r = await ws.execute(`tree -L 2 "/discord/${guild}/" | head -n 20`)
    for (const line of r.stdoutText.trim().split('\n').slice(0, 20)) {
      console.log(`  ${line}`)
    }

    // ── find chat.jsonl everywhere ────────────────
    console.log(`\n=== find /discord/${guild}/ -name chat.jsonl | head -n 5 ===`)
    r = await ws.execute(`find "/discord/${guild}/" -name "chat.jsonl" | head -n 5`)
    console.log(`  exit=${String(r.exitCode)}`)
    if (r.exitCode !== 0) {
      throw new Error(
        `regression: find chat.jsonl exited ${String(r.exitCode)} (soft errors should not abort)`,
      )
    }
    const findOut = r.stdoutText.trim()
    if (findOut !== '') {
      for (const line of findOut.split('\n')) console.log(`  ${line}`)
    }

    // ── pwd / cd / relative ────────────────────────
    console.log(`\n=== cd ${base} ===`)
    r = await ws.execute(`cd "${base}"`)
    console.log(`  exit=${String(r.exitCode)}`)

    console.log('\n=== pwd (after cd) ===')
    r = await ws.execute('pwd')
    console.log(`  ${r.stdoutText.trim()}`)

    console.log(`\n=== cat ${targetDate}/chat.jsonl (relative) | head -n 1 ===`)
    r = await ws.execute(`cat "${targetDate}/chat.jsonl" | head -n 1`)
    if (r.stdoutText.trim() !== '') {
      console.log(`  ${r.stdoutText.trim().slice(0, 120)}`)
    }
  } finally {
    await ws.close()
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
