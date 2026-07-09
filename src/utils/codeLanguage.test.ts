import { describe, expect, it } from 'vitest'
import {
  HIGHLIGHT_LANGUAGE_ALIASES,
  getEditorModeForPath,
  getHighlightLanguageForPath,
  normalizeHighlightLanguage,
} from './codeLanguage'

describe('code language mapping', () => {
  it('maps common source file paths to Ace editor modes', () => {
    expect(getEditorModeForPath('/tmp/app.tsx')).toBe('typescript')
    expect(getEditorModeForPath('/tmp/server.go')).toBe('golang')
    expect(getEditorModeForPath('/tmp/lib.rs')).toBe('rust')
    expect(getEditorModeForPath('/tmp/Dockerfile')).toBe('dockerfile')
    expect(getEditorModeForPath('/tmp/CMakeLists.txt')).toBe('cmake')
    expect(getEditorModeForPath('/tmp/main.cpp')).toBe('c_cpp')
    expect(getEditorModeForPath('/tmp/kernel.cu')).toBe('c_cpp')
    expect(getEditorModeForPath('/tmp/kernel.cuh')).toBe('c_cpp')
    expect(getEditorModeForPath('/tmp/style.scss')).toBe('scss')
  })

  it('maps file paths to highlight.js language identifiers', () => {
    expect(getHighlightLanguageForPath('/tmp/app.tsx')).toBe('typescript')
    expect(getHighlightLanguageForPath('/tmp/server.go')).toBe('go')
    expect(getHighlightLanguageForPath('/tmp/lib.rs')).toBe('rust')
    expect(getHighlightLanguageForPath('/tmp/Dockerfile')).toBe('dockerfile')
    expect(getHighlightLanguageForPath('/tmp/CMakeLists.txt')).toBe('cmake')
    expect(getHighlightLanguageForPath('/tmp/main.cpp')).toBe('cpp')
    expect(getHighlightLanguageForPath('/tmp/kernel.cu')).toBe('cpp')
    expect(getHighlightLanguageForPath('/tmp/kernel.cuh')).toBe('cpp')
    expect(getHighlightLanguageForPath('/tmp/style.scss')).toBe('scss')
  })

  it('normalizes VS Code-style and common fenced code language aliases', () => {
    expect(normalizeHighlightLanguage('shellscript')).toBe('bash')
    expect(normalizeHighlightLanguage('golang')).toBe('go')
    expect(normalizeHighlightLanguage('c++')).toBe('cpp')
    expect(normalizeHighlightLanguage('c#')).toBe('csharp')
    expect(normalizeHighlightLanguage('typescriptreact')).toBe('typescript')
    expect(normalizeHighlightLanguage('ps1')).toBe('powershell')
    expect(normalizeHighlightLanguage('toml')).toBe('ini')
    expect(normalizeHighlightLanguage('cuda')).toBe('cpp')
  })

  it('exposes rehype-highlight aliases in language-to-alias direction', () => {
    expect(HIGHLIGHT_LANGUAGE_ALIASES.bash).toContain('shellscript')
    expect(HIGHLIGHT_LANGUAGE_ALIASES.go).toContain('golang')
    expect(HIGHLIGHT_LANGUAGE_ALIASES.cpp).toContain('c++')
    expect(HIGHLIGHT_LANGUAGE_ALIASES.typescript).toContain('typescriptreact')
    expect(HIGHLIGHT_LANGUAGE_ALIASES.xml).toEqual(expect.arrayContaining(['html', 'htm', 'vue', 'svelte', 'astro']))
    expect(HIGHLIGHT_LANGUAGE_ALIASES.dos).toEqual(expect.arrayContaining(['bat', 'cmd', 'batchfile']))
    expect(HIGHLIGHT_LANGUAGE_ALIASES.ini).toContain('toml')
  })
})
