import type { Workspace } from '@struktoai/mirage-core'
import {
  tool,
  type ToolOutputFileContent,
  type ToolOutputImage,
  type ToolOutputText,
} from '@openai/agents'
import { z } from 'zod'
import { readWorkspaceFile } from '../read-file.ts'

export type MirageReadFileOutput = ToolOutputText | ToolOutputImage | ToolOutputFileContent

async function readFileOutput(ws: Workspace, path: string): Promise<MirageReadFileOutput> {
  try {
    const result = await readWorkspaceFile(ws, path)
    if (result.kind === 'text') {
      return { type: 'text', text: result.content }
    }
    if (result.kind === 'image') {
      return {
        type: 'image',
        image: { data: Uint8Array.from(result.data), mediaType: result.mimeType },
      }
    }
    if (result.kind === 'file') {
      return {
        type: 'file',
        file: {
          data: Uint8Array.from(result.data),
          mediaType: result.mimeType,
          filename: result.filename,
        },
      }
    }
    return { type: 'text', text: result.note }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { type: 'text', text: `Unable to read ${path}: ${message}` }
  }
}

export function mirageReadFileTool(ws: Workspace) {
  return tool({
    name: 'read_file',
    description:
      'Read a file from the Mirage workspace. Returns UTF-8 text directly, images as model-visible image input, PDFs as model-visible file input, and a metadata description for other binary formats.',
    parameters: z.object({
      path: z.string().describe('Absolute path inside the Mirage workspace.'),
    }),
    execute: async ({ path }) => readFileOutput(ws, path),
  })
}
