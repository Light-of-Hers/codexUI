import { describe, expect, it } from 'vitest'
import { needsRichMarkdownRenderer } from './markdownLoadPolicy'

describe('needsRichMarkdownRenderer', () => {
  it('keeps ordinary prose and lightweight formatting on the local renderer', () => {
    expect(needsRichMarkdownRenderer('Plain response with **bold**, `inline code`, and:\n\n- one\n- two')).toBe(false)
  })

  it.each([
    '```ts\nconst value = 1\n```',
    'Energy is $E = mc^2$.',
    '$$\nE = mc^2\n$$',
    '[Docs](./README.md)',
    '![Preview](./preview.png)',
    '\\mark{review this}\\comment{why}',
    'Use ==highlighted text== here.',
    '<details><summary>More</summary></details>',
  ])('loads the rich renderer for %s', (text) => {
    expect(needsRichMarkdownRenderer(text)).toBe(true)
  })
})
