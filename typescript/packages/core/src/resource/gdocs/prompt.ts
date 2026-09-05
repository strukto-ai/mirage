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

  gdoc.json structure (matches the Google Docs API documents.get response):
    {
      "documentId": "...",
      "title": "...",
      "body": {
        "content": [
          {                              # one element per block
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
      "namedStyles": {...},
      "revisionId": "...",
      "suggestionsViewMode": "..."
    }

  Useful jq paths:
    .title
    .body.content[].paragraph.elements[].textRun.content   # all text
    [.body.content[] | select(.table)] | length            # table count
    .revisionId`

export const GDOCS_WRITE_PROMPT = `  Service writes require a CLI for the intended account. When listed, consult
  Installed CLIs for its name and guide; a mount does not select a CLI account.

  Newline gotcha: bash double-quoted "...\\n..." is NOT a newline; the
  literal characters \\ + n end up in the doc. Either:
    --text $'line1\\nline2'                          # ANSI-C quoting
    --text "$(printf 'line1\\nline2')"               # printf interprets
    --json '{...}'                                # JSON handles escapes

  Delete:
    rm {prefix}/owned/<file>.gdoc.json      # permanent delete from Drive
    rm -f <path>                            # ignore if missing
    Only operates on .gdoc.json files; owned/ and shared/ themselves
    cannot be removed.`
