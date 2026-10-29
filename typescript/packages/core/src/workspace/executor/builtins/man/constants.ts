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

export const SECTION = '1'

// The title a page's header centers: the man macros' own for section 1,
// since no page here names a manual of its own.
export const MANUAL = 'General Commands Manual'

// The width a page is laid out to when neither $MANWIDTH nor $COLUMNS
// gives one, the narrowest it takes, and the widest: past 32769 columns
// groff discards characters or overflows (man-db 2.13.1 on
// debian:stable-slim), so a wider ask gets the widest page there is.
export const DEFAULT_WIDTH = 80
export const MIN_WIDTH = 20
export const MAX_WIDTH = 32769

// Where text starts under a heading, and where a tagged paragraph's text
// starts, both from the left margin.
export const TEXT_INDENT = 7
export const TAG_INDENT = 14

// The column `man -f` pads a page's name and section to.
export const WHATIS_WIDTH = 20

// A first operand that names a section, when a page follows it.
export const SECTION_RE = /^(?:[0-9][a-z0-9]*|[nl])$/

export const HINT = "Try 'man --help' or 'man --usage' for more information.\n"

export const NO_PAGE = "What manual page do you want?\nFor example, try 'man man'.\n"
