import { afterEach, describe, expect, it } from 'vitest'
import * as markdownRenderer from './markdownRenderer'

const baseContext = {
  cwd: '/home/ubuntu/Documents/New Project (2)',
  kind: 'message' as const,
  highlightVersion: 7,
}

function render(text: string, kind: 'message' | 'plan' = 'message'): string {
  return markdownRenderer.renderMarkdownContent(text, {
    ...baseContext,
    kind,
  }).html
}

afterEach(() => {
  markdownRenderer.clearMarkdownRendererCache()
})

describe('renderMarkdownContent', () => {
  it('renders GitHub-style markdown, KaTeX, highlighting, and local file links', () => {
    const html = render(`
# Title

> Quote

- [x] done
- [ ] todo

1. First
2. Second

| A | B |
| :-- | --: |
| ~~1~~ | [src/App.vue](./src/App.vue) and \`inline\` |

Inline math $E = mc^2$ and https://example.com.

\`\`\`js
const answer = 42
\`\`\`
`)

    expect(html).toContain('<h1 class="message-heading message-scroll-anchor message-heading-h1"')
    expect(html).toContain('<blockquote class="message-blockquote message-scroll-anchor"')
    expect(html).toContain('message-task-list')
    expect(html).toContain('class="message-task-checkbox"')
    expect(html).toContain('data-checked="true"')
    expect(html).toContain('class="message-list message-list-ordered"')
    expect(html).toContain('class="message-table-wrap message-scroll-anchor"')
    expect(html).toContain('class="message-table-head-cell"')
    expect(html).toContain('class="message-inline-code"')
    expect(html).toContain('message-file-link')
    expect(html).toContain('href="https://example.com"')
    expect(html).toContain('class="katex"')
    expect(html).toContain('message-code-block message-scroll-anchor')
    expect(html).toContain('hljs')
    expect(html).toContain('message-table-cell')
    expect(html).toContain('src/App.vue')
  })

  it('annotates rendered blocks with source line metadata for preview jumps', () => {
    const html = render([
      '# Title',
      '',
      'Paragraph',
      '',
      '- item',
      '',
      '```js',
      'const answer = 42',
      '```',
    ].join('\n'))

    expect(html).toContain('data-source-line="1"')
    expect(html).toContain('data-source-end-line="1"')
    expect(html).toContain('data-source-line="3"')
    expect(html).toContain('data-source-line="5"')
    expect(html).toContain('data-source-line="7"')
    expect(html).toContain('data-source-end-line="9"')
  })

  it('wraps math nodes with source metadata for preview jumps', () => {
    const html = render([
      'Inline $L_0$ text',
      '',
      '$$',
      'L_1',
      '$$',
    ].join('\n'))

    expect(html).toContain('message-math-source-inline')
    expect(html).toContain('message-math-source-display')
    expect(html).toContain('data-source-line="1"')
    expect(html).toContain('data-source-line="3"')
    expect(html).toContain('katex-display')
  })

  it('renders double-equals text as highlighted markdown', () => {
    const html = render('Plain ==important note== text and `==code==`.')

    expect(html).toContain('<mark class="message-highlight" data-highlight-source="important note">important note</mark>')
    expect(html).toContain('<code class="message-inline-code"')
    expect(html).toContain('>==code==</code>')
  })

  it('renders highlights that contain inline code and math with source metadata', () => {
    const html = render('Run ==`git status` with $x^2$== now.')

    expect(html).toContain('class="message-highlight"')
    expect(html).toContain('data-highlight-source="&#x60;git status&#x60; with $x^2$"')
    expect(html).toContain('>git status</code>')
    expect(html).toContain('class="katex"')
    expect(html).not.toContain('==`git status`')
  })

  it('preserves raw link and math bodies for interactive highlights and marks', () => {
    const html = render('Read ==[Docs](./docs/readme.md) and `version`== plus \\mark{cost $x^2$ and [Guide](./guide.md)}.')

    expect(html).toContain('data-highlight-source="[Docs](./docs/readme.md) and &#x60;version&#x60;"')
    expect(html).toContain('data-annotation-mark="cost $x^2$ and [Guide](./guide.md)"')
    expect(html).toContain('href="/codex-local-browse/home/ubuntu/Documents/New%20Project%20(2)/docs/readme.md"')
    expect(html).toContain('href="/codex-local-browse/home/ubuntu/Documents/New%20Project%20(2)/guide.md"')
    expect(html).toContain('class="katex"')
  })

  it('renders inline mark and comment annotation commands', () => {
    const html = render('Review \\mark{this part}\\comment{check terms} and \\cmt{loose note}, but keep `\\mark{code}\\comment{nope}`.')

    expect(html).toContain('class="message-annotation"')
    expect(html).toContain('<mark class="message-annotation-mark" data-annotation-mark="this part">this part</mark>')
    expect(html).toContain('class="message-annotation-comment" role="note"')
    expect(html).toContain('class="message-annotation-label" aria-hidden="true">cmt</span>')
    expect(html).toContain('<span class="message-annotation-body">check terms</span>')
    expect(html).toContain('<span class="message-annotation-body">loose note</span>')
    expect(html).toContain('<code class="message-inline-code"')
    expect(html).toContain(String.raw`>\mark{code}\comment{nope}</code>`)
  })

  it('renders marks that contain inline code', () => {
    const html = render('Rule: \\mark{only `notebook = "."` or `notebook = "_notebooks/<path>"`}.')

    expect(html).toContain('<mark class="message-annotation-mark" data-annotation-mark=')
    expect(html).toContain('&#x60;notebook = &#x22;.&#x22;&#x60;')
    expect(html).toContain('>notebook = "."</code>')
    expect(html).toContain('>notebook = "_notebooks/&#x3C;path>"</code>')
    expect(html).not.toContain(String.raw`\mark{only`)
  })

  it('renders annotation comments that contain inline math and code', () => {
    const html = render('Review \\cmt{check $E = mc^2$ and `dtype`} now.')

    expect(html).toContain('class="message-annotation-comment" role="note"')
    expect(html).toContain('class="message-annotation-label" aria-hidden="true">cmt</span>')
    expect(html).toContain('<span class="message-annotation-body">check ')
    expect(html).toContain('class="katex"')
    expect(html).toContain('data-annotation-comment="check $E = mc^2$ and &#x60;dtype&#x60;"')
    expect(html).toContain('<code class="message-inline-code"')
    expect(html).toContain('>dtype</code>')
    expect(html).not.toContain(String.raw`\cmt{check`)
  })

  it('renders nested annotation comments', () => {
    const html = render(String.raw`Review \comment{outer note \comment{inner note}} now.`)

    expect((html.match(/class="message-annotation-comment"/gu) ?? []).length).toBe(2)
    expect(html).toContain('<span class="message-annotation-body">outer note ')
    expect(html).toContain('<span class="message-annotation-body">inner note</span>')
  })

  it('renders marked annotations with rich adjacent comments', () => {
    const html = render('Review \\mark{A}\\cmt{math $x^2$ and `code`} inline.')

    expect(html).toContain('<mark class="message-annotation-mark" data-annotation-mark="A">A</mark>')
    expect(html).toContain('class="message-annotation-comment" role="note"')
    expect(html).toContain('data-annotation-comment="math $x^2$ and &#x60;code&#x60;"')
    expect(html).toContain('class="katex"')
    expect(html).toContain('>code</code>')
    expect(html).not.toContain(String.raw`\cmt{math`)
  })

  it('renders sanitized HTML collapse blocks', () => {
    const html = render([
      '<details open onclick="alert(1)">',
      '<summary>More</summary>',
      '',
      'Hidden **markdown**',
      '<script>alert(1)</script>',
      '</details>',
    ].join('\n'))

    expect(html).toContain('<details open class="message-collapse message-scroll-anchor"')
    expect(html).toContain('<summary class="message-collapse-summary"')
    expect(html).toContain('<strong class="message-bold-text"')
    expect(html).toContain('>markdown</strong>')
    expect(html).not.toContain('onclick')
    expect(html).not.toContain('<script')
  })

  it('wraps tight list item inline content in a single text block', () => {
    const html = render('- `repos/codexUI`：`origin/crz/dev` → `18dd52c`')

    expect(html).toContain('<div class="message-list-item-text"')
    expect(html).toMatch(/<code class="message-inline-code"[^>]*>repos\/codexUI<\/code>：<code class="message-inline-code"[^>]*>origin\/crz\/dev<\/code> → <code class="message-inline-code"[^>]*>18dd52c<\/code>/u)
  })

  it('does not split ambiguous slash text into absolute tail links', () => {
    const html = render('origin/crz/dev and xx/yy')

    expect(html).toContain('origin/crz/dev and xx/yy')
    expect(html).not.toContain('message-file-link')
    expect(html).not.toContain('title="/crz/dev"')
    expect(html).not.toContain('title="/yy"')
  })

  it('does not split Chinese slash text into absolute tail links', () => {
    const html = render('本地编辑页的系统浅/深色主题、中文字体都正常。')

    expect(html).toContain('系统浅/深色主题')
    expect(html).not.toContain('message-file-link')
    expect(html).not.toContain('title="/深色主题"')
  })

  it('does not link a lone root path fragment after inline code', () => {
    const html = render('`agent`/Codex')

    expect(html).toContain('<code class="message-inline-code"')
    expect(html).toContain('>agent</code>/Codex')
    expect(html).not.toContain('message-file-link')
  })

  it('preserves backslash escapes in command inline code', () => {
    const html = render(String.raw`Ran \`printf '%s\n' "$HOME"\``)

    expect(html).toContain(String.raw`printf '%s\n' "$HOME"`)
    expect(html).not.toContain(String.raw`printf '%s\\n' "$HOME"`)
    expect(html).not.toContain("printf '%s\n' &quot;$HOME&quot;")
  })

  it('parses local markdown links with spaces in the target', () => {
    const html = render('MARK [hosting_manager.py](/home/ubuntu/Documents/New Project (2)/hosting_manager.py)')

    expect(html).toContain('href="/codex-local-browse/home/ubuntu/Documents/New%20Project%20(2)/hosting_manager.py"')
    expect(html).toContain('title="/home/ubuntu/Documents/New Project (2)/hosting_manager.py"')
    expect(html).toContain('hosting_manager.py')
  })

  it('preserves line ranges in local markdown links', () => {
    const html = render('MARK [hosting_manager.py](/home/ubuntu/Documents/New Project (2)/hosting_manager.py:3-7)')

    expect(html).toContain('href="/codex-local-browse/home/ubuntu/Documents/New%20Project%20(2)/hosting_manager.py?line=3-7"')
    expect(html).toContain('title="/home/ubuntu/Documents/New Project (2)/hosting_manager.py:3-7"')
    expect(html).toContain('hosting_manager.py')
  })

  it('links file paths that appear inside inline code', () => {
    const html = render('Run `./src/App.vue:3-7` before continuing.')

    expect(html).toMatch(/Run <code class="message-inline-code"[^>]*><a class="message-file-link message-inline-code-link"/u)
    expect(html).toContain('href="/codex-local-browse/home/ubuntu/Documents/New%20Project%20(2)/src/App.vue?line=3-7"')
    expect(html).toContain('title="./src/App.vue:3-7"')
    expect(html).toContain('>./src/App.vue:3-7</a></code> before continuing.')
  })

  it('keeps command inline code as code while linking embedded file paths', () => {
    const html = render('`npx vitest run src/composables/useDesktopState.test.ts src/api/normalizers/v2.test.ts src/server/freeMode.test.ts src/server/codexAppServerBridge.inlinePayload.test.ts`')

    expect(html).toMatch(/<code class="message-inline-code"[^>]*>npx vitest run /u)
    expect(html).toContain('message-inline-code-link')
    expect(html).toContain('href="/codex-local-browse/home/ubuntu/Documents/New%20Project%20(2)/src/composables/useDesktopState.test.ts"')
    expect(html).toContain('href="/codex-local-browse/home/ubuntu/Documents/New%20Project%20(2)/src/api/normalizers/v2.test.ts"')
    expect(html).toContain('href="/codex-local-browse/home/ubuntu/Documents/New%20Project%20(2)/src/server/freeMode.test.ts"')
    expect(html).toContain('href="/codex-local-browse/home/ubuntu/Documents/New%20Project%20(2)/src/server/codexAppServerBridge.inlinePayload.test.ts"')
    expect(html).not.toContain('href="/codex-local-browse/home/ubuntu/Documents/New%20Project%20(2)/npx')
  })

  it('links directory paths that appear inside inline code', () => {
    const html = render('Open `.superpowers/plans/2026-05-18-codex-cursor/` next.')

    expect(html).toMatch(/Open <code class="message-inline-code"[^>]*><a class="message-file-link message-inline-code-link"/u)
    expect(html).toContain('href="/codex-local-browse/home/ubuntu/Documents/New%20Project%20(2)/.superpowers/plans/2026-05-18-codex-cursor"')
    expect(html).toContain('>.superpowers/plans/2026-05-18-codex-cursor/</a></code> next.')
  })

  it('expands tilde paths from root workspaces', () => {
    const html = markdownRenderer.renderMarkdownContent('Open `~/work/my-agent-configs/AGENTS.md` next.', {
      ...baseContext,
      cwd: '/root/work/my-agent-configs/repos/codexUI',
    }).html

    expect(html).toContain('href="/codex-local-browse/root/work/my-agent-configs/AGENTS.md"')
    expect(html).toContain('>~/work/my-agent-configs/AGENTS.md</a></code> next.')
    expect(html).not.toContain('/root/work/my-agent-configs/repos/codexUI/~/work')
  })

  it('renders local markdown images through the local image route', () => {
    const html = render('![diagram](/home/ubuntu/Documents/New Project (2)/diagram.png)')

    expect(html).toContain('message-markdown-image')
    expect(html).toContain('message-image-preview')
    expect(html).toContain('src="/codex-local-image?path=%2Fhome%2Fubuntu%2FDocuments%2FNew%20Project%20(2)%2Fdiagram.png"')
    expect(html).toContain('data-browse-href="/codex-local-browse/home/ubuntu/Documents/New%20Project%20(2)/diagram.png"')
    expect(html).toContain('alt="diagram"')
  })

  it('does not rewrite file-like text inside code blocks', () => {
    const html = render('```txt\n[hosting_manager.py](/home/ubuntu/Documents/New Project (2)/hosting_manager.py)\n```')

    expect(html).toContain('message-code-block')
    expect(html).toContain('[hosting_manager.py](/home/ubuntu/Documents/New Project (2)/hosting_manager.py)')
    expect(html).not.toContain('message-file-link')
  })

  it('emits Mermaid placeholders with their source for browser-side rendering', () => {
    const html = render('```mermaid\nflowchart LR\n  A[Start] --> B[Finish]\n```')

    expect(html).toContain('class="message-mermaid message-scroll-anchor"')
    expect(html).toContain('data-mermaid-state="pending"')
    expect(html).toContain('data-mermaid-source="flowchart LR')
    expect(html).toMatch(/<pre class="message-mermaid-source"[^>]*><code class="hljs language-mermaid"[^>]*>flowchart LR/u)
    expect(html).not.toContain('message-code-block')
  })

  it('highlights expanded fenced code language aliases', () => {
    const html = render('```shellscript\necho "$HOME"\n```')

    expect(html).toContain('hljs-built_in')
    expect(html).toContain('hljs-variable')
  })

  it('shares the same renderer for message and plan contexts', () => {
    const text = 'Plan with $a^2 + b^2 = c^2$ and [src/App.vue](./src/App.vue)'
    expect(render(text, 'message')).toBe(render(text, 'plan'))
  })

  it('falls back to escaped text when the processor fails', () => {
    const failingFactory = () => ({
      processSync() {
        throw new Error('boom')
      },
    }) as unknown as ReturnType<typeof markdownRenderer.createMarkdownProcessor>

    const html = markdownRenderer.renderMarkdownContent('<b>unsafe</b>', baseContext, failingFactory).html
    expect(html).toContain('&lt;b&gt;unsafe&lt;/b&gt;')
  })
})
