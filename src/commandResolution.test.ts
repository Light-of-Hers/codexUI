import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveCodexCursorCommand } from './commandResolution'

afterEach(() => {
  vi.unstubAllEnvs()
})

async function writeVersionCommand(path: string): Promise<void> {
  await writeFile(path, '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nexit 1\n', 'utf8')
  await chmod(path, 0o755)
}

describe('command resolution', () => {
  it('resolves the explicit Codex Cursor command', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'codexui-command-resolution-'))
    try {
      const command = join(tempDir, 'codex-cursor')
      await writeVersionCommand(command)
      vi.stubEnv('CODEXUI_CODEX_CURSOR_COMMAND', command)

      expect(resolveCodexCursorCommand()).toBe(command)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
