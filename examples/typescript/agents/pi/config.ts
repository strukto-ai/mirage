import type { ModelRuntime } from '@earendil-works/pi-coding-agent'

export async function configurePiModel(
  modelRuntime: ModelRuntime,
): Promise<ReturnType<ModelRuntime['getModel']>> {
  const provider = process.env.PI_PROVIDER?.trim() ?? ''
  const modelId = process.env.PI_MODEL?.trim() ?? ''
  const baseURL = process.env.PI_BASE_URL?.trim() ?? ''
  const apiKey = process.env.PI_API_KEY?.trim() ?? ''

  if (provider === '' && modelId === '' && baseURL === '' && apiKey === '') {
    return undefined
  }
  if (provider === '' || modelId === '') {
    throw new Error('PI_PROVIDER and PI_MODEL must be set together')
  }
  if (baseURL !== '') {
    modelRuntime.registerProvider(provider, { baseUrl: baseURL })
  }
  if (apiKey !== '') {
    await modelRuntime.setRuntimeApiKey(provider, apiKey)
  }

  const model = modelRuntime.getModel(provider, modelId)
  if (model === undefined) {
    throw new Error(`Unknown Pi model: ${provider}/${modelId}`)
  }
  return model
}
