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

import type { JsonValue } from '../kit/typescript/index.ts'

export type Json = Record<string, JsonValue>

export interface MetaRow {
  workspaceName: string
  workspaceId: string
  botId: string
  botName: string
  maxUploadSize: number
  urlBase: string
  createdTime: string
  lastEditedTime: string
  createdBy: string
  lastEditedBy: string
}

export interface PageRow {
  id: string
  parentType: string
  parentId: string | null
  titleText: string
  propertiesJson: string
  iconJson: string | null
  coverJson: string | null
  inTrash: boolean
  createdTime: string
  lastEditedTime: string
  createdBy: string
  lastEditedBy: string
  url: string
}
export interface DatabaseRow {
  id: string
  parentType: string
  parentId: string | null
  titleText: string
  titleJson: string
  descriptionJson: string | null
  propertiesJson: string
  isInline: boolean
  inTrash: boolean
  createdTime: string
  lastEditedTime: string
  createdBy: string
  lastEditedBy: string
  url: string
}
export interface BlockRow {
  id: string
  parentId: string
  position: number
  type: string
  payloadJson: string
  hasChildren: boolean
  inTrash: boolean
  createdTime: string
  lastEditedTime: string
  createdBy: string
  lastEditedBy: string
}
export interface UserRow {
  id: string
  name: string
  avatarUrl: string | null
  type: string
  detailJson: string
}
export interface CommentRow {
  id: string
  parentType: string
  parentId: string
  discussionId: string
  richTextJson: string
  createdTime: string
  lastEditedTime: string
  createdBy: string
}

export interface BlockSpec {
  type: string
  payload: Json
  children: BlockSpec[]
}
