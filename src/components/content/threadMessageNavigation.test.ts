import { describe, expect, it } from 'vitest'
import type { UiMessage } from '../../types/codex'
import { buildUserMessageNavigationItems } from './threadMessageNavigation'

function message(overrides: Partial<UiMessage>): UiMessage {
  return {
    id: overrides.id ?? 'message-id',
    role: overrides.role ?? 'user',
    text: overrides.text ?? '',
    ...overrides,
  }
}

describe('buildUserMessageNavigationItems', () => {
  it('returns user messages with stable ordinals and original message indexes', () => {
    const items = buildUserMessageNavigationItems([
      message({ id: 'system-1', role: 'system', text: 'configured' }),
      message({ id: 'user-1', text: 'First prompt' }),
      message({ id: 'assistant-1', role: 'assistant', text: 'Done' }),
      message({ id: 'user-2', text: 'Second prompt' }),
    ])

    expect(items.map((item) => ({
      id: item.id,
      ordinal: item.ordinal,
      messageIndex: item.messageIndex,
      preview: item.preview,
    }))).toEqual([
      { id: 'user-1', ordinal: 1, messageIndex: 1, preview: 'First prompt' },
      { id: 'user-2', ordinal: 2, messageIndex: 3, preview: 'Second prompt' },
    ])
  })

  it('normalizes whitespace and truncates previews without losing the full title', () => {
    const items = buildUserMessageNavigationItems([
      message({ id: 'user-1', text: '  Please\n\nsummarize   this long message ' }),
    ], 18)

    expect(items).toHaveLength(1)
    expect(items[0].preview).toBe('Please summarize…')
    expect(items[0].title).toBe('Please summarize this long message')
  })

  it('uses attachments as fallback content for empty user text', () => {
    const items = buildUserMessageNavigationItems([
      message({
        id: 'user-1',
        text: '',
        fileAttachments: [{ label: 'report.md', path: '/tmp/report.md' }],
        images: ['file:///tmp/screenshot.png'],
      }),
    ])

    expect(items[0].preview).toBe('Files: report.md · 1 image')
    expect(items[0].title).toBe('Files: report.md · 1 image')
  })
})
