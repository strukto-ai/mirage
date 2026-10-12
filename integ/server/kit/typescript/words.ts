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

// A word a provider's search tokenizes as grep -w does: ASCII letters and
// digits, with sentence punctuation around them at most.
const PLAIN_WORD = /^[.,;:!?"'()[\]]*[A-Za-z0-9]+[.,;:!?"'()[\]]*$/

// The plain words of `text`, joined by spaces. Linear's and Trello's search can
// miss a word inside a link or another token that is not a plain word (probed
// on the real APIs), so their fakes search only these and never find such a
// word.
export function plainWords(text: string): string {
  return text
    .split(/\s+/)
    .filter((word) => PLAIN_WORD.test(word))
    .join(' ')
}
