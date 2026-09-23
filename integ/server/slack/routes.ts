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

import { route } from '../kit/typescript/index.ts'
import type { KitRoute } from '../kit/typescript/index.ts'
import type { C } from './config.ts'
import {
  authTest,
  clientUserBoot,
  conversationsHistory,
  conversationsList,
  conversationsReplies,
  download,
  emojiList,
  pinsList,
  reactionsGet,
  usersInfo,
  usersList,
} from './reads.ts'
import { searchFiles, searchMessages } from './search.ts'
import { pins, postMessage, reactionsAdd } from './writes.ts'

// Slack's Web API is method-per-path under /api, so the routes are a flat
// table rather than a tree. GET and POST are both accepted on the read
// methods, which is what the vendor does and what the client relies on.
export function slackRoutes(): KitRoute<C>[] {
  return [
    route('POST', '/api/chat.postMessage', postMessage, { write: true }),
    route('POST', '/api/reactions.add', reactionsAdd, { write: true }),
    route('POST', '/api/pins.add', pins(true), { write: true }),
    route('POST', '/api/pins.remove', pins(false), { write: true }),
    route('GET', '/api/pins.list', pinsList),
    route('POST', '/api/pins.list', pinsList),
    route('GET', '/api/reactions.get', reactionsGet),
    route('POST', '/api/reactions.get', reactionsGet),
    route('GET', '/api/emoji.list', emojiList),
    route('POST', '/api/emoji.list', emojiList),
    route('GET', '/api/conversations.list', conversationsList),
    route('POST', '/api/conversations.list', conversationsList),
    route('GET', '/api/conversations.history', conversationsHistory),
    route('POST', '/api/conversations.history', conversationsHistory),
    route('GET', '/api/conversations.replies', conversationsReplies),
    route('POST', '/api/conversations.replies', conversationsReplies),
    route('GET', '/api/auth.test', authTest),
    route('POST', '/api/auth.test', authTest),
    route('POST', '/api/client.userBoot', clientUserBoot),
    route('GET', '/api/users.list', usersList),
    route('POST', '/api/users.list', usersList),
    route('GET', '/api/users.info', usersInfo),
    route('POST', '/api/users.info', usersInfo),
    route('GET', '/api/search.messages', searchMessages),
    route('POST', '/api/search.messages', searchMessages),
    route('GET', '/api/search.files', searchFiles),
    route('POST', '/api/search.files', searchFiles),
    route('GET', '/files/download/:id', download),
  ]
}
