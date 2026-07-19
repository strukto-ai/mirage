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

export const GSLIDES_PROMPT = `{prefix}
  owned/
    <date>_<title>__<presentation-id>.gslide.json
  shared/
    <date>_<title>__<presentation-id>.gslide.json

  Filename: <YYYY-MM-DD>_<title>__<presentation-id>.gslide.json
    <YYYY-MM-DD>       modifiedTime, used for date-glob (e.g. 2026-05-*)
    <title>            sanitized: spaces->_, non-[A-Za-z0-9_.-]->_, <=100 chars
    <presentation-id>  Google Slides presentation ID

  Buckets:
    owned/   presentations you created
    shared/  presentations shared with you by others
             - does NOT include presentations you own and shared with others;
               those are still in owned/.

  gslide.json structure (matches the Google Slides API presentations.get response):
    {
      "presentationId": "...",
      "title": "...",
      "pageSize": { "width": {...}, "height": {...} },
      "slides": [
        {                                      # one element per slide
          "objectId": "...",
          "pageElements": [
            {
              "objectId": "...",
              "shape": {
                "shapeType": "TEXT_BOX",
                "text": {
                  "textElements": [
                    { "textRun": { "content": "the actual text\\n",
                                   "style": {...} } }
                  ]
                }
              }
            },
            { "image": {...} },
            { "table": {...} }
          ]
        }
      ],
      "masters": [...],
      "layouts": [...]
    }

  Useful jq paths:
    .title
    .slides | length                                                    # slide count
    .slides[].pageElements[].shape.text.textElements[].textRun.content  # all text
    .slides[0].objectId`

export const GSLIDES_WRITE_PROMPT = `  Write commands:
    gws slides presentations create --json '{"title": "My Deck"}'

    gws slides presentations batchUpdate \\
      --params '{"presentationId": "<id>"}' \\
      --json   '{"requests": [{"createSlide": {"insertionIndex": 1, "slideLayoutReference": {"predefinedLayout": "BLANK"}}}]}'

  Delete:
    rm {prefix}/owned/<file>.gslide.json     # permanent delete from Drive
    rm -f <path>                             # ignore if missing
    Only operates on .gslide.json files; owned/ and shared/ themselves
    cannot be removed.`
