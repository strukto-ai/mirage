import type { Workspace } from '@struktoai/mirage-core'
import {
  applyPatchTool,
  setOpenAIAPI,
  setTracingDisabled,
  shellTool,
} from '@openai/agents'
import {
  MirageEditor,
  MirageShell,
  mirageExecuteTool,
  mirageReadFileTool,
} from '@struktoai/mirage-agents/openai'

export function configureOpenAIExample(ws: Workspace, defaultModel: string) {
  const baseURL = process.env.OPENAI_BASE_URL?.trim() ?? ''
  const api = process.env.OPENAI_API?.trim() ?? ''

  if (api !== '' && api !== 'chat_completions' && api !== 'responses') {
    throw new Error('OPENAI_API must be chat_completions or responses')
  }
  const selectedAPI = api || (baseURL === '' ? 'responses' : 'chat_completions')
  setOpenAIAPI(selectedAPI)
  if (baseURL !== '') {
    setTracingDisabled(true)
  }

  const hostedTools = [
    mirageReadFileTool(ws),
    shellTool({ shell: new MirageShell(ws) }),
    applyPatchTool({ editor: new MirageEditor(ws) }),
  ]
  const compatibleTools = [mirageReadFileTool(ws), mirageExecuteTool(ws)]

  return {
    model: process.env.OPENAI_MODEL?.trim() || defaultModel,
    tools: selectedAPI === 'responses' ? hostedTools : compatibleTools,
  }
}
