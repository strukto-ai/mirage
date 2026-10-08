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

import { AirtableVFS } from '../../vfs/airtable/airtable.ts'
import type { BaseVFS } from '../../vfs/base.ts'
import { BinViewVFS } from '../../vfs/bin/bin.ts'
import { BoxVFS } from '../../vfs/box/box.ts'
import { ChromaVFS } from '../../vfs/chroma/chroma.ts'
import { DatabricksVolumeVFSBase } from '../../vfs/databricks_volume/databricks_volume.ts'
import { DevVFS } from '../../vfs/dev/dev.ts'
import { DifyVFS } from '../../vfs/dify/dify.ts'
import { DiscordVFSBase } from '../../vfs/discord/discord.ts'
import { DropboxVFS } from '../../vfs/dropbox/dropbox.ts'
import { GCalVFS } from '../../vfs/gcal/gcal.ts'
import { GDocsVFS } from '../../vfs/gdocs/gdocs.ts'
import { GDriveVFS } from '../../vfs/gdrive/gdrive.ts'
import { GitHubVFS } from '../../vfs/github/github.ts'
import { GmailVFS } from '../../vfs/gmail/gmail.ts'
import { GSheetsVFS } from '../../vfs/gsheets/gsheets.ts'
import { GSlidesVFS } from '../../vfs/gslides/gslides.ts'
import { HistoryViewVFS } from '../../vfs/history/history.ts'
import { JaegerVFSBase } from '../../vfs/jaeger/jaeger.ts'
import { LanceDBVFSBase } from '../../vfs/lancedb/lancedb.ts'
import { LangfuseVFS } from '../../vfs/langfuse/langfuse.ts'
import { LinearVFS } from '../../vfs/linear/linear.ts'
import { Mem0VFS } from '../../vfs/mem0/mem0.ts'
import { MongoDBVFSBase } from '../../vfs/mongodb/mongodb.ts'
import { NotionVFSBase } from '../../vfs/notion/notion.ts'
import { OneDriveVFS } from '../../vfs/onedrive/onedrive.ts'
import { PostgresVFSBase } from '../../vfs/postgres/postgres.ts'
import { QdrantVFS } from '../../vfs/qdrant/qdrant.ts'
import { RAMVFS } from '../../vfs/ram/ram.ts'
import { RedisResourceBase } from '../../vfs/redis/redis.ts'
import { S3VFSBase } from '../../vfs/s3/s3.ts'
import { SharePointVFS } from '../../vfs/sharepoint/sharepoint.ts'
import { SlackVFSBase } from '../../vfs/slack/slack.ts'
import { TrelloVFS } from '../../vfs/trello/trello.ts'
import { WandbVFS } from '../../vfs/wandb/wandb.ts'
import { RegisteredCommand } from '../config.ts'
import { AIRTABLE_COMMANDS } from './airtable/index.ts'
import { BIN_COMMANDS } from './bin/index.ts'
import { BOX_COMMANDS } from './box/index.ts'
import { CHROMA_COMMANDS } from './chroma/index.ts'
import { DATABRICKS_VOLUME_COMMANDS } from './databricks_volume/index.ts'
import { DEV_COMMANDS } from './dev/index.ts'
import { DIFY_COMMANDS } from './dify/index.ts'
import { DISCORD_COMMANDS } from './discord/index.ts'
import { DROPBOX_COMMANDS } from './dropbox/index.ts'
import { GCAL_COMMANDS } from './gcal/index.ts'
import { GDOCS_COMMANDS } from './gdocs/index.ts'
import { GDRIVE_COMMANDS } from './gdrive/index.ts'
import { makeGenericCommands } from './generic_bind/index.ts'
import { GITHUB_COMMANDS } from './github/index.ts'
import { GMAIL_COMMANDS } from './gmail/index.ts'
import { GSHEETS_COMMANDS } from './gsheets/index.ts'
import { GSLIDES_COMMANDS } from './gslides/index.ts'
import { HISTORY_COMMANDS } from './history/index.ts'
import { JAEGER_COMMANDS } from './jaeger/index.ts'
import { LANCEDB_COMMANDS } from './lancedb/index.ts'
import { LANGFUSE_COMMANDS } from './langfuse/index.ts'
import { LINEAR_COMMANDS } from './linear/index.ts'
import { MEM0_COMMANDS } from './mem0/index.ts'
import { MONGODB_COMMANDS } from './mongodb/index.ts'
import { NOTION_COMMANDS } from './notion/index.ts'
import { ONEDRIVE_COMMANDS } from './onedrive/index.ts'
import { POSTGRES_COMMANDS } from './postgres/index.ts'
import { QDRANT_COMMANDS } from './qdrant/index.ts'
import { RAM_COMMANDS } from './ram/index.ts'
import { REDIS_COMMANDS } from './redis/index.ts'
import { S3_COMMANDS } from './s3/index.ts'
import { SHAREPOINT_COMMANDS } from './sharepoint/index.ts'
import { SLACK_COMMANDS } from './slack/index.ts'
import { TRELLO_COMMANDS } from './trello/index.ts'
import { WANDB_COMMANDS } from './wandb/index.ts'

// A VFS class, whatever its constructor's visibility (GitHubVFS builds
// through a factory).
interface VFSClass {
  readonly prototype: BaseVFS
}

// The shell commands of each builtin VFS class, kept on the class itself:
// keyed by the class, not its name, so a minified bundle still finds them,
// and under a global symbol, so a VFS extending a class from another copy
// of this package finds that copy's commands, as the BaseVFS brand does. A
// package registers the backends it ships (core's below, node's and the
// browser's from their own `commands/builtin/backends.ts`). Python finds
// the same tables by class path and imports them on first mount.
const BACKEND_COMMANDS: unique symbol = Symbol.for('mirage.backendCommands')

interface Registered {
  readonly [BACKEND_COMMANDS]?: () => readonly RegisteredCommand[]
}

/** Serve `commands` on every mount of `cls` and its subclasses. */
export function registerBackendCommands(
  cls: VFSClass,
  commands: () => readonly RegisteredCommand[],
): void {
  Object.defineProperty(cls, BACKEND_COMMANDS, { value: commands, configurable: true })
}

// The commands registered for `cls` itself, not inherited from a base.
function registeredFor(cls: unknown): readonly RegisteredCommand[] | undefined {
  if (typeof cls !== 'function' || !Object.hasOwn(cls, BACKEND_COMMANDS)) return undefined
  return (cls as Registered)[BACKEND_COMMANDS]?.()
}

// The one VFS name a backend's commands were registered under, or null for
// a set that spans several (the Hugging Face repo kinds share one table).
function familyOf(commands: readonly RegisteredCommand[]): string | null {
  const names = new Set(commands.flatMap((cmd) => (cmd.vfs === null ? [] : [cmd.vfs])))
  const [only] = names
  return names.size === 1 && only !== undefined ? only : null
}

function renamed(cmd: RegisteredCommand, vfs: string): RegisteredCommand {
  return new RegisteredCommand({
    name: cmd.name,
    spec: cmd.spec,
    vfs,
    filetype: cmd.filetype,
    fn: cmd.fn,
    aggregate: cmd.aggregate,
    write: cmd.write,
    pathGuarded: cmd.pathGuarded,
    limit: cmd.limit,
  })
}

/**
 * Every shell command a mount of `vfs` serves.
 *
 * A builtin's are the ones registered for the first class in its hierarchy
 * that has any; a command registered under that backend's one VFS name is
 * registered under the VFS's own instead, so an S3-compatible alias serves
 * S3's commands as itself. Any other VFS serves the generic set. Either set
 * loses what the VFS overrides, and the commands the VFS was handed come
 * last, so they win. Mirrors Python's `mount_commands`.
 */
export function mountCommands(vfs: BaseVFS): RegisteredCommand[] {
  let found: RegisteredCommand[] | null = null
  let cls: unknown = vfs.constructor
  while (typeof cls === 'function' && found === null) {
    const commands = registeredFor(cls)
    if (commands !== undefined) {
      const family = familyOf(commands)
      found = commands.map((cmd) =>
        family !== null && cmd.vfs === family && family !== vfs.name ? renamed(cmd, vfs.name) : cmd,
      )
    }
    cls = Object.getPrototypeOf(cls)
  }
  const kept = (found ?? makeGenericCommands(vfs.name, { overrides: vfs.overrides })).filter(
    (cmd) => !vfs.overrides.has(cmd.name),
  )
  return [...kept, ...vfs.commands()]
}

registerBackendCommands(AirtableVFS, () => AIRTABLE_COMMANDS)
registerBackendCommands(BinViewVFS, () => BIN_COMMANDS)
registerBackendCommands(BoxVFS, () => BOX_COMMANDS)
registerBackendCommands(ChromaVFS, () => CHROMA_COMMANDS)
registerBackendCommands(DatabricksVolumeVFSBase, () => DATABRICKS_VOLUME_COMMANDS)
registerBackendCommands(DevVFS, () => DEV_COMMANDS)
registerBackendCommands(DifyVFS, () => DIFY_COMMANDS)
registerBackendCommands(DiscordVFSBase, () => DISCORD_COMMANDS)
registerBackendCommands(DropboxVFS, () => DROPBOX_COMMANDS)
registerBackendCommands(GCalVFS, () => GCAL_COMMANDS)
registerBackendCommands(GDocsVFS, () => GDOCS_COMMANDS)
registerBackendCommands(GDriveVFS, () => GDRIVE_COMMANDS)
registerBackendCommands(GitHubVFS, () => GITHUB_COMMANDS)
registerBackendCommands(GmailVFS, () => GMAIL_COMMANDS)
registerBackendCommands(GSheetsVFS, () => GSHEETS_COMMANDS)
registerBackendCommands(GSlidesVFS, () => GSLIDES_COMMANDS)
registerBackendCommands(HistoryViewVFS, () => HISTORY_COMMANDS)
registerBackendCommands(JaegerVFSBase, () => JAEGER_COMMANDS)
registerBackendCommands(LanceDBVFSBase, () => LANCEDB_COMMANDS)
registerBackendCommands(LangfuseVFS, () => LANGFUSE_COMMANDS)
registerBackendCommands(LinearVFS, () => LINEAR_COMMANDS)
registerBackendCommands(Mem0VFS, () => MEM0_COMMANDS)
registerBackendCommands(MongoDBVFSBase, () => MONGODB_COMMANDS)
registerBackendCommands(NotionVFSBase, () => NOTION_COMMANDS)
registerBackendCommands(OneDriveVFS, () => ONEDRIVE_COMMANDS)
registerBackendCommands(PostgresVFSBase, () => POSTGRES_COMMANDS)
registerBackendCommands(QdrantVFS, () => QDRANT_COMMANDS)
registerBackendCommands(RAMVFS, () => RAM_COMMANDS)
registerBackendCommands(RedisResourceBase, () => REDIS_COMMANDS)
registerBackendCommands(S3VFSBase, () => S3_COMMANDS.toArray())
registerBackendCommands(SharePointVFS, () => SHAREPOINT_COMMANDS)
registerBackendCommands(SlackVFSBase, () => SLACK_COMMANDS)
registerBackendCommands(TrelloVFS, () => TRELLO_COMMANDS)
registerBackendCommands(WandbVFS, () => WANDB_COMMANDS)
