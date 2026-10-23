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

import type { TokenManager } from '../google/client.ts'
import * as history from './history.ts'
import * as labels from './labels.ts'
import type { GmailLabel } from './labels.ts'
import * as messages from './messages.ts'
import type { GmailMessageRaw, GmailMessageStub, ListMessagesOptions } from './messages.ts'

/**
 * Every Gmail request the gmail backend makes, as one object. A core op
 * reaches Gmail only through `accessor.gmail`. Mirrors Python's `GmailApi`.
 */
export interface GmailApi {
  listLabels(): Promise<GmailLabel[]>
  listMessages(opts?: ListMessagesOptions): Promise<GmailMessageStub[]>
  getMessageRaw(messageId: string): Promise<GmailMessageRaw>
  getAttachment(messageId: string, attachmentId: string): Promise<Uint8Array>
  currentHistoryId(): Promise<string>
  listHistory(start: string): Promise<[Record<string, unknown>[], string]>
}

/** The live `GmailApi`: one token manager, one wire call per method. */
export class GmailClient implements GmailApi {
  readonly tokenManager: TokenManager

  constructor(tokenManager: TokenManager) {
    this.tokenManager = tokenManager
  }

  listLabels(): Promise<GmailLabel[]> {
    return labels.listLabels(this.tokenManager)
  }

  listMessages(opts: ListMessagesOptions = {}): Promise<GmailMessageStub[]> {
    return messages.listMessages(this.tokenManager, opts)
  }

  getMessageRaw(messageId: string): Promise<GmailMessageRaw> {
    return messages.getMessageRaw(this.tokenManager, messageId)
  }

  getAttachment(messageId: string, attachmentId: string): Promise<Uint8Array> {
    return messages.getAttachment(this.tokenManager, messageId, attachmentId)
  }

  currentHistoryId(): Promise<string> {
    return history.currentHistoryId(this.tokenManager)
  }

  listHistory(start: string): Promise<[Record<string, unknown>[], string]> {
    return history.listHistory(this.tokenManager, start)
  }
}
