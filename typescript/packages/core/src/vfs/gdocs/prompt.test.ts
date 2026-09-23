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
import { jqEval } from '../../core/jq/eval.ts'
import { GDOCS_PROMPT, GDOCS_WRITE_PROMPT } from './prompt.ts'

const ALL_TEXT = '[.. | .textRun? // empty | .content] | add'
const TAB_NAMES = '[.. | .tabProperties? // empty | .title]'
const TAB_COUNT = '[.. | .tabProperties? // empty] | length'
const FIRST_TAB =
  '[.tabs[0].documentTab.body.content[]\n      | .paragraph?.elements[]?.textRun.content] | add'
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

describe('GDOCS_PROMPT', () => {
  it('renders prefix and includes buckets, structure, jq paths', () => {
    const rendered = GDOCS_PROMPT.replace(/\{prefix\}/g, '/gdocs')
    expect(rendered).toContain('owned/')
    expect(rendered).toContain('shared/')
    expect(rendered).toContain('shared with you by others')
    expect(rendered).toContain('still in owned/')
    expect(rendered).toContain('gdoc.json structure')
    expect(rendered).toContain('.tabs[].documentTab')
    expect(rendered).toContain('childTabs')
    expect(rendered).toContain('tabProperties')
  })

  it('no longer promises a top-level body', () => {
    // includeTabsContent=true leaves the singleton fields empty, so the
    // old recipe would return nothing at all on a live document.
    const rendered = GDOCS_PROMPT.replace(/\{prefix\}/g, '/gdocs')
    expect(rendered).not.toContain(OLD_FLAT_RECIPE)
    expect(rendered).toContain('There is no top-level .body')
  })

  it('states the recipes this test runs', () => {
    const rendered = GDOCS_PROMPT.replace(/\{prefix\}/g, '/gdocs')
    for (const recipe of [ALL_TEXT, TAB_NAMES, TAB_COUNT, FIRST_TAB]) {
      expect(rendered).toContain(recipe)
    }
  })
})

describe('GDOCS_PROMPT jq recipes', () => {
  it('reads every tab at any depth', async () => {
    expect(await jqEval(DOC, ALL_TEXT)).toEqual(['first tab\nsecond tab\nchild tab\n'])
  })

  it('names child tabs too', async () => {
    expect(await jqEval(DOC, TAB_NAMES)).toEqual([['Tab 1', 'Tab 2', 'Child']])
    expect(await jqEval(DOC, TAB_COUNT)).toEqual([3])
  })

  it('survives the leading sectionBreak', async () => {
    // The `?` is load-bearing: content[0] is a sectionBreak with no
    // .paragraph, and the un-guarded path raises "Cannot iterate over
    // null" on every real document.
    expect(await jqEval(DOC, FIRST_TAB)).toEqual(['first tab\n'])
  })
})

describe('GDOCS_WRITE_PROMPT', () => {
  it('matches actual command flag signatures', () => {
    expect(GDOCS_WRITE_PROMPT).toContain('gws docs write')
    expect(GDOCS_WRITE_PROMPT).toContain('--document')
    expect(GDOCS_WRITE_PROMPT).toContain('--text')
    expect(GDOCS_WRITE_PROMPT).toContain('--tab')
    expect(GDOCS_WRITE_PROMPT).toContain('gws docs --help')
    expect(GDOCS_WRITE_PROMPT).toContain('gws docs documents batchUpdate --json')
  })

  it('says an unnamed tab is the first one', () => {
    expect(GDOCS_WRITE_PROMPT).toContain('FIRST tab')
    expect(GDOCS_WRITE_PROMPT).toContain('[.. | .tabProperties? // empty | .tabId]')
  })

  it('documents rm and the newline gotcha', () => {
    expect(GDOCS_WRITE_PROMPT).toContain('rm ')
    expect(GDOCS_WRITE_PROMPT).toContain('.gdoc.json')
    expect(GDOCS_WRITE_PROMPT).toContain("$'")
  })
})
