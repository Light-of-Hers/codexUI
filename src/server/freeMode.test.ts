import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FREE_MODE_DEFAULT_MODEL,
  FREE_MODE_PROVIDER_ID,
  ARK_FALLBACK_MODEL,
  ARK_PROVIDER_ID,
  OPENCODE_ZEN_DEFAULT_MODEL,
  OPENCODE_ZEN_PROVIDER_ID,
  createDefaultFreeModeState,
  createDefaultOpenCodeZenFreeModeState,
  getArkModelMetadata,
  getArkModelSelection,
  getArkModels,
  getCursorModelMetadata,
  getCursorModelSelection,
  getCursorModels,
  getFreeModeConfigArgs,
  getMoonBridgeModelMetadata,
  getMoonBridgeModels,
  normalizeFreeModeState,
  shouldCreateDefaultFreeModeStateForMissingAuth,
} from './freeMode.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Moon Bridge catalog loading', () => {
  it('defaults external provider state to disabled', () => {
    expect(createDefaultFreeModeState()).toEqual({
      enabled: false,
      apiKey: null,
      model: 'openrouter/free',
    })
  })

  it('reads model slugs from the generated catalog', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codexui-moonbridge-'))
    const catalogPath = join(tempDir, 'models_catalog.json')
    try {
      await writeFile(
        catalogPath,
        JSON.stringify({
          models: [
            { slug: 'deepseek-v4-pro', context_window: 128000 },
            { slug: 'deepseek-v4-flash', context_window: '64000' },
            { slug: 'deepseek-v4-pro', context_window: 32000 },
          ],
        }),
        'utf8',
      )

      vi.stubEnv('CODEXUI_MOONBRIDGE_MODEL_CATALOG', catalogPath)

      expect(getMoonBridgeModels()).toEqual(['deepseek-v4-pro', 'deepseek-v4-flash'])
      expect(getMoonBridgeModelMetadata()).toEqual([
        { id: 'deepseek-v4-pro', contextWindow: 128000 },
        { id: 'deepseek-v4-flash', contextWindow: 64000 },
      ])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe('Cursor catalog loading', () => {
  it('reads model slugs from the generated catalog', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codexui-cursor-'))
    const catalogPath = join(tempDir, 'models_catalog.json')
    try {
      await writeFile(
        catalogPath,
        JSON.stringify({
          models: [
            { slug: 'gpt-5.5-medium', context_window: 128000 },
            { slug: 'gpt-5.4-mini', context_window: '32000' },
            { slug: 'gpt-5.5-medium', context_window: 64000 },
          ],
        }),
        'utf8',
      )

      vi.stubEnv('CODEXUI_CURSOR_MODEL_CATALOG', catalogPath)

      expect(getCursorModels()).toEqual(['gpt-5.5-medium', 'gpt-5.4-mini'])
      expect(getCursorModelMetadata()).toEqual([
        { id: 'gpt-5.5-medium', contextWindow: 128000 },
        { id: 'gpt-5.4-mini', contextWindow: 32000 },
      ])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('normalizes cursor state to enabled when persisted disabled', () => {
    expect(normalizeFreeModeState({
      enabled: false,
      apiKey: null,
      model: 'gpt-5.5-medium',
      provider: 'cursor',
      wireApi: 'responses',
    })).toEqual({
      enabled: true,
      apiKey: null,
      model: 'gpt-5.5-medium',
      provider: 'cursor',
      wireApi: undefined,
    })
  })

  it('uses the cursor catalog instead of a persisted OpenRouter model', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codexui-cursor-selection-'))
    const catalogPath = join(tempDir, 'models_catalog.json')
    try {
      await writeFile(
        catalogPath,
        JSON.stringify({
          models: [
            { slug: 'auto' },
            { slug: 'composer-2-fast' },
          ],
        }),
        'utf8',
      )

      vi.stubEnv('CODEXUI_CURSOR_MODEL_CATALOG', catalogPath)

      expect(getCursorModelSelection('openrouter/free')).toEqual({
        models: ['auto', 'composer-2-fast'],
        currentModel: 'auto',
      })
      expect(normalizeFreeModeState({
        enabled: false,
        apiKey: null,
        model: 'openrouter/free',
        provider: 'cursor',
        wireApi: 'responses',
      })).toEqual({
        enabled: true,
        apiKey: null,
        model: 'auto',
        provider: 'cursor',
        wireApi: undefined,
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe('Ark catalog loading', () => {
  it('reads model slugs from the generated catalog', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codexui-ark-'))
    const catalogPath = join(tempDir, 'models_catalog.json')
    try {
      await writeFile(
        catalogPath,
        JSON.stringify({
          models: [
            { slug: 'doubao-seed-2-0-code-preview-260215', context_window: 262144 },
            { slug: 'deepseek-v4-pro-260425', context_window: '1048576' },
            { slug: 'doubao-seed-2-0-code-preview-260215', context_window: 128000 },
          ],
        }),
        'utf8',
      )

      vi.stubEnv('CODEXUI_ARK_MODEL_CATALOG', catalogPath)

      expect(getArkModels()).toEqual(['doubao-seed-2-0-code-preview-260215', 'deepseek-v4-pro-260425'])
      expect(getArkModelMetadata()).toEqual([
        { id: 'doubao-seed-2-0-code-preview-260215', contextWindow: 262144 },
        { id: 'deepseek-v4-pro-260425', contextWindow: 1048576 },
      ])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('uses the Ark catalog instead of a persisted OpenRouter model', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codexui-ark-selection-'))
    const catalogPath = join(tempDir, 'models_catalog.json')
    try {
      await writeFile(
        catalogPath,
        JSON.stringify({
          models: [
            { slug: 'doubao-seed-2-0-code-preview-260215' },
            { slug: 'deepseek-v4-pro-260425' },
          ],
        }),
        'utf8',
      )

      vi.stubEnv('CODEXUI_ARK_MODEL_CATALOG', catalogPath)

      expect(getArkModelSelection('openrouter/free')).toEqual({
        models: ['doubao-seed-2-0-code-preview-260215', 'deepseek-v4-pro-260425'],
        currentModel: 'doubao-seed-2-0-code-preview-260215',
      })
      expect(normalizeFreeModeState({
        enabled: false,
        apiKey: null,
        model: 'openrouter/free',
        provider: ARK_PROVIDER_ID,
        wireApi: 'responses',
      })).toEqual({
        enabled: true,
        apiKey: null,
        model: 'doubao-seed-2-0-code-preview-260215',
        provider: ARK_PROVIDER_ID,
        wireApi: undefined,
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('falls back to the Ark coding default when the catalog is missing', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codexui-ark-missing-catalog-'))
    try {
      vi.stubEnv('XDG_DATA_HOME', tempDir)

      expect(getArkModelSelection('openrouter/free')).toEqual({
        models: [ARK_FALLBACK_MODEL],
        currentModel: ARK_FALLBACK_MODEL,
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})

describe('unauthenticated free mode defaults', () => {
  it('creates an enabled OpenCode Zen state for unauthenticated startup', () => {
    const state = createDefaultOpenCodeZenFreeModeState()

    expect(state.enabled).toBe(true)
    expect(state.provider).toBe('opencode-zen')
    expect(state.model).toBe(OPENCODE_ZEN_DEFAULT_MODEL)
    expect(state.wireApi).toBe('responses')
    expect(state.apiKey).toBeNull()
    expect(state.providerKeys).toEqual({})
  })

  it('routes app-server through the local OpenCode Zen proxy when a server port is available', () => {
    const state = createDefaultOpenCodeZenFreeModeState()

    const args = getFreeModeConfigArgs(state, 4173)

    expect(args).toContain(`model_provider="${OPENCODE_ZEN_PROVIDER_ID}"`)
    expect(args).toContain(`model="${OPENCODE_ZEN_DEFAULT_MODEL}"`)
    expect(args).toContain(`model_providers.${OPENCODE_ZEN_PROVIDER_ID}.base_url="http://127.0.0.1:4173/codex-api/zen-proxy/v1"`)
    expect(args).toContain(`model_providers.${OPENCODE_ZEN_PROVIDER_ID}.wire_api="responses"`)
    expect(args).toContain(`model_providers.${OPENCODE_ZEN_PROVIDER_ID}.experimental_bearer_token="zen-proxy-token"`)
  })

  it('uses the OpenCode Zen default model when persisted Zen state has an empty model', () => {
    const args = getFreeModeConfigArgs({
      ...createDefaultOpenCodeZenFreeModeState(),
      model: '',
    }, 4173)

    expect(args).toContain(`model="${OPENCODE_ZEN_DEFAULT_MODEL}"`)
  })

  it('keeps OpenRouter config available for manual free mode', () => {
    const args = getFreeModeConfigArgs({
      enabled: true,
      apiKey: 'sk-or-test',
      model: FREE_MODE_DEFAULT_MODEL,
      provider: 'openrouter',
      wireApi: 'responses',
    }, 4173)

    expect(args).toContain(`model_provider="${FREE_MODE_PROVIDER_ID}"`)
    expect(args).toContain(`model="${FREE_MODE_DEFAULT_MODEL}"`)
  })

  it('does not replace an intentionally disabled free mode state', () => {
    expect(shouldCreateDefaultFreeModeStateForMissingAuth({
      enabled: false,
      apiKey: null,
      model: FREE_MODE_DEFAULT_MODEL,
      provider: 'opencode-zen',
      wireApi: 'chat',
    }, false)).toBe(false)
  })

  it('creates the default only when state is absent and Codex auth is missing', () => {
    expect(shouldCreateDefaultFreeModeStateForMissingAuth(null, false)).toBe(true)
    expect(shouldCreateDefaultFreeModeStateForMissingAuth(null, true)).toBe(false)
  })
})
