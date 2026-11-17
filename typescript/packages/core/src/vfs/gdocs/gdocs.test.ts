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

import { describe, expect, it } from 'vitest'
import { Engine, type Ending } from '../../core/jq/index.ts'
import { VFS_MD } from './gdocs.ts'

async function jqEval(obj: unknown, expr: string): Promise<unknown[]> {
  const engine = await Engine.open(expr, '{}', 'UTC')
  const ending: Ending = { stop: null }
  const outputs: unknown[] = []
  try {
    for await (const text of engine.run(JSON.stringify(obj), ending)) {
      outputs.push(JSON.parse(text))
    }
  } finally {
    await engine.close()
  }
  if (ending.stop?.kind === 'error') throw new Error(ending.stop.text)
  return outputs
}

const ALL_TEXT = '[.. | .textRun? // empty | .content] | add'
const OLD_FLAT_RECIPE = '.body.content[].paragraph.elements[].textRun.content'

interface Tab {
  tabProperties: { tabId: string; title: string; index: number; nestingLevel: number }
  documentTab: unknown
  childTabs?: Tab[]
}

function tab(tabId: string, title: string, text: string, childTabs?: Tab[]): Tab {
  return {
    tabProperties: { tabId, title, index: 0, nestingLevel: 0 },
    documentTab: {
      body: {
        content: [
          { sectionBreak: { sectionStyle: {} } },
          { paragraph: { elements: [{ textRun: { content: `${text}\n`, textStyle: {} } }] } },
        ],
      },
      documentStyle: {},
      namedStyles: {},
    },
    ...(childTabs === undefined ? {} : { childTabs }),
  }
}

const DOC = {
  documentId: 'doc1',
  title: 'Log',
  tabs: [
    tab('t.0', 'Tab 1', 'first tab'),
    tab('t.1', 'Tab 2', 'second tab', [tab('t.2', 'Child', 'child tab')]),
  ],
  revisionId: 'rev-3',
}

describe('VFS_MD', () => {
  it('renders prefix and includes buckets, structure, jq paths', () => {
    const rendered = VFS_MD.replace(/\{prefix\}/g, '/gdocs')
    expect(rendered).toContain('owned/')
    expect(rendered).toContain('shared/')
    expect(rendered).toContain('stay\n  in `owned/`')
    expect(rendered).toContain('`documents.get`')
    expect(rendered).toContain('.tabs[].documentTab')
    expect(rendered).toContain('childTabs')
  })

  it('no longer promises a top-level body', () => {
    // includeTabsContent=true leaves the singleton fields empty, so the
    // old recipe would return nothing at all on a live document.
    const rendered = VFS_MD.replace(/\{prefix\}/g, '/gdocs')
    expect(rendered).not.toContain(OLD_FLAT_RECIPE)
    expect(rendered).toContain('there is no\n  top-level `.body`')
  })

  it('states the recipe this test runs', () => {
    expect(VFS_MD).toContain(ALL_TEXT)
  })
})

describe('VFS_MD jq recipes', () => {
  it('reads every tab at any depth', async () => {
    expect(await jqEval(DOC, ALL_TEXT)).toEqual(['first tab\nsecond tab\nchild tab\n'])
  })
})

describe('VFS_MD file commands', () => {
  it('documents rm and mv for a write path', () => {
    expect(VFS_MD).toContain('On a `write` path, `rm` a file to delete it from Drive')
    expect(VFS_MD).toContain('`mv` it to a\n  new `<title>`')
  })
})
