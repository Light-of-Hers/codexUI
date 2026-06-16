import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildCodexUiProviderConfigArgs,
  getCodexUiProviderCatalogSelection,
  parseCodexConfigToml,
  readCodexUiProviderDescriptors,
} from './codexUiProviders.js'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('codex-ui provider config', () => {
  it('parses model providers and codex-ui provider descriptors from raw TOML', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codexui-provider-config-'))
    try {
      await mkdir(join(codexHome, 'catalogs'), { recursive: true })
      await writeFile(
        join(codexHome, 'config.toml'),
        [
          '[model_providers.zed]',
          'name = "Zed Local"',
          'base_url = "http://127.0.0.1:4555/v1"',
          'wire_api = "responses"',
          'requires_openai_auth = false',
          '',
          '[model_providers.zed.env_http_headers]',
          'x-api-key = "ZED_API_KEY"',
          '',
          '[codex_ui.providers.zed]',
          'executable = "codex-zed"',
          'model_catalog_json = "catalogs/zed-models.json"',
          'default_model = "zed-large"',
        ].join('\n'),
        'utf8',
      )
      vi.stubEnv('CODEX_HOME', codexHome)

      expect(readCodexUiProviderDescriptors()).toEqual([
        {
          id: 'zed',
          label: 'Zed Local',
          executable: 'codex-zed',
          modelCatalogJson: join(codexHome, 'catalogs', 'zed-models.json'),
          defaultModel: 'zed-large',
          providerInfo: {
            name: 'Zed Local',
            base_url: 'http://127.0.0.1:4555/v1',
            wire_api: 'responses',
            requires_openai_auth: false,
            env_http_headers: {
              'x-api-key': 'ZED_API_KEY',
            },
          },
          hasUiConfig: true,
        },
      ])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('keeps executable from project config ignored by reading only CODEX_HOME config', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codexui-provider-home-'))
    const projectDir = await mkdtemp(join(tmpdir(), 'codexui-provider-project-'))
    try {
      await mkdir(join(projectDir, '.codex'), { recursive: true })
      await writeFile(
        join(projectDir, '.codex', 'config.toml'),
        [
          '[model_providers.evil]',
          'name = "Project Evil"',
          'base_url = "http://127.0.0.1:9/v1"',
          'wire_api = "responses"',
          '',
          '[codex_ui.providers.evil]',
          'executable = "run-project-command"',
        ].join('\n'),
        'utf8',
      )
      vi.stubEnv('CODEX_HOME', codexHome)

      expect(readCodexUiProviderDescriptors()).toEqual([])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
      await rm(projectDir, { recursive: true, force: true })
    }
  })

  it('expands home-prefixed catalog paths', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codexui-provider-home-path-'))
    try {
      await writeFile(
        join(codexHome, 'config.toml'),
        [
          '[model_providers.homecat]',
          'name = "Home Catalog"',
          'base_url = "http://127.0.0.1:4555/v1"',
          'wire_api = "responses"',
          '',
          '[codex_ui.providers.homecat]',
          'model_catalog_json = "~/.local/share/homecat/models.json"',
        ].join('\n'),
        'utf8',
      )
      vi.stubEnv('CODEX_HOME', codexHome)

      expect(readCodexUiProviderDescriptors()[0]?.modelCatalogJson).toBe(
        join(homedir(), '.local', 'share', 'homecat', 'models.json'),
      )
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('uses catalog metadata for model selection and Codex args', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codexui-provider-catalog-'))
    const catalogPath = join(codexHome, 'models.json')
    try {
      await writeFile(
        join(codexHome, 'config.toml'),
        [
          '[model_providers.zed]',
          'name = "Zed Local"',
          'base_url = "http://127.0.0.1:4555/v1"',
          'wire_api = "responses"',
          '',
          '[codex_ui.providers.zed]',
          'model_catalog_json = "models.json"',
          'default_model = "zed-large"',
        ].join('\n'),
        'utf8',
      )
      await writeFile(
        catalogPath,
        JSON.stringify({
          models: [
            { slug: 'zed-large', context_window: '128000' },
            { slug: 'zed-small', context_window: 32000 },
          ],
        }),
        'utf8',
      )
      vi.stubEnv('CODEX_HOME', codexHome)

      const descriptor = readCodexUiProviderDescriptors()[0]!
      expect(getCodexUiProviderCatalogSelection(descriptor, 'zed-small')).toEqual({
        metadata: [
          { id: 'zed-large', contextWindow: 128000 },
          { id: 'zed-small', contextWindow: 32000 },
        ],
        models: ['zed-small', 'zed-large'],
        currentModel: 'zed-small',
      })
      expect(buildCodexUiProviderConfigArgs(descriptor, 'zed-small')).toEqual([
        '-c',
        'model="zed-small"',
        '-c',
        'model_provider="zed"',
        '-c',
        `model_catalog_json=${JSON.stringify(catalogPath)}`,
      ])
    } finally {
      await rm(codexHome, { recursive: true, force: true })
    }
  })

  it('parses quoted dotted keys without treating dots as separators', () => {
    expect(parseCodexConfigToml([
      '[model_providers."moon.proxy"]',
      'name = "Moon Proxy"',
      '',
      '[codex_ui.providers."moon.proxy"]',
      'executable = "codex-moon-proxy"',
    ].join('\n'))).toEqual({
      model_providers: {
        'moon.proxy': {
          name: 'Moon Proxy',
        },
      },
      codex_ui: {
        providers: {
          'moon.proxy': {
            executable: 'codex-moon-proxy',
          },
        },
      },
    })
  })
})
