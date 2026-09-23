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

export const GDOCS_PROMPT = `{prefix}
  owned/
    <date>_<title>__<doc-id>.gdoc.json
  shared/
    <date>_<title>__<doc-id>.gdoc.json

  Filename: <YYYY-MM-DD>_<title>__<doc-id>.gdoc.json
    <YYYY-MM-DD>  modifiedTime, used for date-glob (e.g. 2026-05-*)
    <title>       sanitized: spaces->_, non-[A-Za-z0-9_.-]->_, <=100 chars
    <doc-id>      Google Docs document ID

  Buckets:
    owned/   docs you created
    shared/  docs shared with you by others
             - does NOT include docs you own and shared with others;
               those are still in owned/.

  gdoc.json structure (the Google Docs API documents.get response, read
  with includeTabsContent=true so every tab is present):
    {
      "documentId": "...",
      "title": "...",
      "tabs": [                          # one entry per top-level tab
        {
          "tabProperties": {
            "tabId": "t.0",              # names a tab for gws docs write
            "title": "Tab 1",
            "index": 0
          },
          "documentTab": {
            "body": {
              "content": [
                {                          # one element per block
                  "paragraph": {
                    "elements": [
                      { "textRun": { "content": "the actual text\\n",
                                     "textStyle": {...} } }
                    ],
                    "paragraphStyle": {...}
                  }
                },
                { "table": {...} },
                { "sectionBreak": {...} }
              ]
            },
            "documentStyle": {...},
            "namedStyles": {...}
          },
          "childTabs": [ { ...same shape, nested to any depth... } ]
                                       # a NESTED tab additionally carries
                                       # parentTabId and nestingLevel; a
                                       # root tab carries neither
        }
      ],
      "revisionId": "..."
    }

  There is no top-level .body. A tab-aware response leaves the singleton
  fields (.body, .documentStyle, .namedStyles) empty and hangs every
  tab's content off .tabs[].documentTab instead. Tabs also nest, so text
  can sit at any depth under .childTabs; the recursive recipes below read
  a one-tab and a fifty-tab document alike.

  Useful jq paths:
    .title
    [.. | .tabProperties? // empty | .title]             # every tab name
    [.. | .textRun? // empty | .content] | add           # all text, any depth
    [.. | .tabProperties? // empty] | length             # tab count
    [.tabs[0].documentTab.body.content[]
      | .paragraph?.elements[]?.textRun.content] | add   # first tab only
    .revisionId

  The first block of a body is always a sectionBreak, which carries no
  .paragraph, so a path through .paragraph needs the \`?\` or it fails with
  "Cannot iterate over null".`

export const GDOCS_WRITE_PROMPT = `  Writes go through the gws CLI if installed:
    gws docs write --document <doc-id> --text "text to append"
    gws docs write --document <doc-id> --tab <tab-id> --text "..."
    See gws docs --help for the raw API passthroughs.

  Tab targeting: without --tab the text lands on the FIRST tab, which is
  the Docs API's own default. Read the tab ids out of the file with
  [.. | .tabProperties? // empty | .tabId].

  Newline gotcha: bash double-quoted "...\\n..." is NOT a newline; the
  literal characters \\ + n end up in the doc. Either:
    --text $'line1\\nline2'                          # ANSI-C quoting
    --text "$(printf 'line1\\nline2')"               # printf interprets
    gws docs documents batchUpdate --json '{...}'    # JSON handles escapes

  Delete:
    rm {prefix}/owned/<file>.gdoc.json      # permanent delete from Drive
    rm -f <path>                            # ignore if missing
    Only operates on .gdoc.json files; owned/ and shared/ themselves
    cannot be removed.`
