import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDirectoryListingHtml, createEditorReferenceText, createLocalBrowseEntry, createMarkdownPreviewHtml, createTextEditorHtml, deleteLocalBrowseEntry, encodeAnnotationSourceForLocalBrowse, findAnnotationCommentInSource, findRenderedInlineCodeSelectionInSource, getDirectoryItemList, isMarkdownPath } from './localBrowseUi'
import { KATEX_STYLESHEET_HREF } from './katexAssets'

let tempDir = ''

afterEach(async () => {
  if (!tempDir) return
  await rm(tempDir, { recursive: true, force: true })
  tempDir = ''
})

describe('local browse markdown preview', () => {
  it('formats editor references from 1-based line ranges', () => {
    expect(createEditorReferenceText('/tmp/note.md', 3)).toBe('/tmp/note.md:3')
    expect(createEditorReferenceText('/tmp/note.md', 3, 7)).toBe('/tmp/note.md:3-7')
    expect(createEditorReferenceText('/tmp/note.md', 7, 3)).toBe('/tmp/note.md:3-7')
    expect(createEditorReferenceText('/tmp/note.md', 0)).toBe('')
    expect(createEditorReferenceText('   ', 1)).toBe('')
  })

  it('encodes annotation source without over-escaping LaTeX comments', () => {
    expect(encodeAnnotationSourceForLocalBrowse(String.raw`$\sum_{i=1}^n i^2$`)).toBe(String.raw`$\sum_{i=1}^n i^2$`)
    expect(encodeAnnotationSourceForLocalBrowse('literal } brace')).toBe(String.raw`literal \} brace`)
    expect(encodeAnnotationSourceForLocalBrowse('literal { brace')).toBe(String.raw`literal \{ brace`)
    expect(encodeAnnotationSourceForLocalBrowse(String.raw`$\{$`)).toBe(String.raw`$\\\{$`)
  })

  it('locates nested comments independently for editing', () => {
    const source = String.raw`Review \comment{outer note \comment{inner note}} and \cmt{inner note}.`
    const nestedStart = source.indexOf(String.raw`\comment{inner note}`)
    const outerEnd = source.indexOf(String.raw`\comment{outer note \comment{inner note}}`) + String.raw`\comment{outer note \comment{inner note}}`.length
    const laterStart = source.indexOf(String.raw`\cmt{inner note}`)

    expect(findAnnotationCommentInSource(source, 'inner note')).toMatchObject({
      comment: 'inner note',
      commentStartOffset: nestedStart,
      commentEndOffset: nestedStart + String.raw`\comment{inner note}`.length,
      commentInsertionEndOffset: outerEnd,
    })
    expect(findAnnotationCommentInSource(source, 'inner note', 1)).toMatchObject({
      comment: 'inner note',
      commentStartOffset: laterStart,
      commentEndOffset: laterStart + String.raw`\cmt{inner note}`.length,
      commentInsertionEndOffset: laterStart + String.raw`\cmt{inner note}`.length,
    })
  })

  it('maps a rendered inline-code selection through its closing delimiter', () => {
    const source = 'Plain git status then `git status`.'
    const annotatedSource = 'Plain git status then `git status`\\comment{check}.'

    expect(findRenderedInlineCodeSelectionInSource(source, 'git status', { requireInlineCodeEnd: true })).toEqual({
      startOffset: 23,
      endOffset: 34,
    })
    expect(`${source.slice(0, 34)}\\comment{check}${source.slice(34)}`).toBe('Plain git status then `git status`\\comment{check}.')
    const annotationHtml = createMarkdownPreviewHtml('/tmp/note.md', annotatedSource)
    expect(annotationHtml).toContain('>git status</code>')
    expect(annotationHtml).toContain('data-annotation-comment="check"')
  })

  it('recognizes markdown files for preview support', () => {
    expect(isMarkdownPath('/tmp/note.md')).toBe(true)
    expect(isMarkdownPath('/tmp/note.markdown')).toBe(true)
    expect(isMarkdownPath('/tmp/note.txt')).toBe(false)
  })

  it('shows preview controls only for markdown editor pages', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-local-preview-'))
    const markdownPath = join(tempDir, 'note.md')
    const textPath = join(tempDir, 'note.txt')
    await writeFile(markdownPath, '# Preview me\n', 'utf8')
    await writeFile(textPath, 'plain text\n', 'utf8')

    const markdownEditorHtml = await createTextEditorHtml(markdownPath)
    expect(markdownEditorHtml).toContain('id="copyRefBtn"')
    expect(markdownEditorHtml).toContain('id="previewBtn"')
    expect(markdownEditorHtml).toContain('id="floatingSelectionActions"')
    expect(markdownEditorHtml).toContain('id="floatingHighlightBtn"')
    expect(markdownEditorHtml).toContain('id="floatingMarkBtn"')
    expect(markdownEditorHtml).toContain('id="floatingSelectionCommentBtn"')
    expect(markdownEditorHtml).toContain('id="floatingHighlightActions"')
    expect(markdownEditorHtml).toContain('id="floatingRemoveHighlightBtn"')
    expect(markdownEditorHtml).toContain('id="floatingAddHighlightCommentBtn"')
    expect(markdownEditorHtml).toContain('id="floatingMarkActions"')
    expect(markdownEditorHtml).toContain('id="floatingUnmarkBtn"')
    expect(markdownEditorHtml).toContain('id="floatingAddMarkCommentBtn"')
    expect(markdownEditorHtml).toContain('id="floatingCommentActions"')
    expect(markdownEditorHtml).toContain('id="floatingAddCommentBtn"')
    expect(markdownEditorHtml).toContain('id="floatingEditCommentBtn"')
    expect(markdownEditorHtml).toContain('id="floatingRemoveCommentBtn"')
    expect(markdownEditorHtml).toContain('id="floatingCommentEditor"')
    expect(markdownEditorHtml).toContain('id="floatingCommentInput"')
    expect(markdownEditorHtml).toContain('id="floatingSaveCommentBtn"')
    expect(markdownEditorHtml).toContain('id="floatingCancelCommentBtn"')
    expect(markdownEditorHtml).toContain('floating-highlight-action')
    expect(markdownEditorHtml).toContain('id="previewSplitter"')
    expect(markdownEditorHtml).toContain('role="separator"')
    expect(markdownEditorHtml).toContain('cursor: row-resize')
    expect(markdownEditorHtml).toContain('previewSplitStorageKeyVertical')
    expect(markdownEditorHtml).toContain('previewVisibleStorageKey')
    expect(markdownEditorHtml).toContain('codex.localBrowse.previewVisible.v1:')
    expect(markdownEditorHtml).toContain('loadPreviewVisible')
    expect(markdownEditorHtml).toContain('savePreviewVisible')
    expect(markdownEditorHtml).toContain('setPreviewVisible(true, false)')
    expect(markdownEditorHtml).toContain("const shrinkKey = stacked ? 'ArrowUp' : 'ArrowLeft'")
    expect(markdownEditorHtml).toContain('capturePreviewScrollState')
    expect(markdownEditorHtml).toContain('restorePreviewScrollState')
    expect(markdownEditorHtml).toContain('suppressPreviewScrollSync')
    expect(markdownEditorHtml).toContain('isPreviewScrollSyncSuppressed')
    expect(markdownEditorHtml).toContain('previewScrollAnchorSelector')
    expect(markdownEditorHtml).toContain('bindPreviewScrollSync')
    expect(markdownEditorHtml).toContain('schedulePreviewScrollSyncFromEditor')
    expect(markdownEditorHtml).toContain('scheduleEditorScrollSyncFromPreview')
    expect(markdownEditorHtml).toContain("editor.session.on('changeScrollTop'")
    expect(markdownEditorHtml).toContain("scrollIntoView({ block: 'start', inline: 'nearest' })")
    expect(markdownEditorHtml).toContain("previewFrame.addEventListener('load'")
    expect(markdownEditorHtml).toContain('codex-local-markdown-preview-jump')
    expect(markdownEditorHtml).toContain('codex-local-markdown-preview-selection')
    expect(markdownEditorHtml).toContain('codex-local-markdown-highlight-click')
    expect(markdownEditorHtml).toContain('codex-local-markdown-mark-click')
    expect(markdownEditorHtml).toContain('codex-local-markdown-comment-click')
    expect(markdownEditorHtml).toContain('codex-local-markdown-highlight-dismiss')
    expect(markdownEditorHtml).toContain('codex-local-markdown-preview-save')
    expect(markdownEditorHtml).toContain('handlePreviewMessage')
    expect(markdownEditorHtml).toContain('showFloatingHighlightButton')
    expect(markdownEditorHtml).toContain('showFloatingRemoveHighlightButton')
    expect(markdownEditorHtml).toContain('dismissFloatingHighlightActions')
    expect(markdownEditorHtml).toContain('highlightCurrentSelection')
    expect(markdownEditorHtml).toContain('markCurrentSelection')
    expect(markdownEditorHtml).toContain('addCommentToCurrentSelection')
    expect(markdownEditorHtml).toContain('addCommentToCurrentHighlight')
    expect(markdownEditorHtml).toContain('addCommentToCurrentMark')
    expect(markdownEditorHtml).toContain('commentInsertIndexAfterMarkup')
    expect(markdownEditorHtml).toContain('showFloatingCommentEditor')
    expect(markdownEditorHtml).toContain('submitFloatingCommentEditor')
    expect(markdownEditorHtml).toContain('floatingCommentEditor.addEventListener')
    expect(markdownEditorHtml).toContain("event.key === 'Enter' && !event.shiftKey && !event.isComposing")
    expect(markdownEditorHtml).not.toContain('window.prompt')
    expect(markdownEditorHtml).toContain('removeCurrentHighlight')
    expect(markdownEditorHtml).toContain('unmarkCurrentMark')
    expect(markdownEditorHtml).toContain('editCurrentComment')
    expect(markdownEditorHtml).toContain('addCommentToCurrentComment')
    expect(markdownEditorHtml).toContain('removeCurrentComment')
    expect(markdownEditorHtml).toContain('findCommentMarkupInEditor')
    expect(markdownEditorHtml).toContain('findRenderedInlineCodeSelectionInSource')
    expect(markdownEditorHtml).toContain('containsInlineCode')
    expect(markdownEditorHtml).toContain('endsInInlineCode')
    expect(markdownEditorHtml).toContain('if (lastPreviewHighlightSelection && highlightPreviewSelection()) return;')
    expect(markdownEditorHtml).toContain('if (lastPreviewHighlightSelection && markPreviewSelection()) return;')
    expect(markdownEditorHtml).toContain('const insertIndex = lastPreviewHighlightSelection')
    expect(markdownEditorHtml).toContain('findMarkMarkupInEditor')
    expect(markdownEditorHtml).toContain('encodeAnnotationSource')
    expect(markdownEditorHtml).toContain('saveEditorContent();')
    expect(markdownEditorHtml).toContain("editor.session.replace(new Range(start.row, start.column, end.row, end.column), '==' + selectedSource + '==')")
    expect(markdownEditorHtml).toContain('findHighlightMarkupInEditor')
    expect(markdownEditorHtml).toContain('highlightEndIndex')
    expect(markdownEditorHtml).toContain('matchedOccurrence')
    expect(markdownEditorHtml).toContain('removeHighlightMarkup')
    expect(markdownEditorHtml).toContain('clipTop')
    expect(markdownEditorHtml).toContain('clipBottom')
    expect(markdownEditorHtml).toContain("editor.selection.on('changeSelection'")
    expect(markdownEditorHtml).toContain('editorPointerSelectionActive')
    expect(markdownEditorHtml).toContain('editor.container.contains(target)')
    expect(markdownEditorHtml).toContain("window.addEventListener('mouseup'")
    expect(markdownEditorHtml).toContain('lastPreviewHighlightSelection')
    expect(markdownEditorHtml).toContain('lastPreviewClickedHighlight')
    expect(markdownEditorHtml).toContain('lastPreviewClickedMark')
    expect(markdownEditorHtml).toContain('lastPreviewClickedComment')
    expect(markdownEditorHtml).toContain("target.closest('.floating-highlight-action')")
    expect(markdownEditorHtml).not.toContain("target.closest('#editor') || target.closest('#previewFrame')")
    expect(markdownEditorHtml).toContain('id="previewFrame"')
    expect(markdownEditorHtml).toContain('/codex-local-preview')
    const inlineScript = markdownEditorHtml.match(/<script>\s*([\s\S]*?)\s*<\/script>\s*<\/body>/u)?.[1] ?? ''
    expect(inlineScript).toContain('const saveBtn = document.getElementById')
    expect(inlineScript).toContain('const isFloatingCommentEditorOpen = () => Boolean(')
    expect(inlineScript).toContain('if (!isFloatingCommentEditorOpen()) {\n        hideFloatingCommentEditor();\n      }')
    expect(inlineScript).toContain('if (isFloatingCommentEditorOpen()) return;')
    expect(inlineScript).not.toContain("event.stopPropagation();\n          hideFloatingCommentEditor();\n          return;")
    expect(() => new Function(inlineScript)).not.toThrow()
    expect(inlineScript.indexOf('let lineWrapEnabled = true;')).toBeLessThan(inlineScript.indexOf('editor.session.setUseWrapMode(lineWrapEnabled);'))
    const referenceHelperIndex = markdownEditorHtml.indexOf('const createEditorReferenceText =')
    expect(referenceHelperIndex).toBeGreaterThan(-1)
    expect(referenceHelperIndex).toBeLessThan(markdownEditorHtml.indexOf('return createEditorReferenceText('))

    const textEditorHtml = await createTextEditorHtml(textPath)
    expect(textEditorHtml).toContain('id="copyRefBtn"')
    expect(textEditorHtml).not.toContain('id="previewBtn"')
    expect(textEditorHtml).not.toContain('id="floatingSelectionActions"')
    expect(textEditorHtml).not.toContain('id="floatingHighlightBtn"')
    expect(textEditorHtml).not.toContain('id="floatingMarkBtn"')
    expect(textEditorHtml).not.toContain('id="floatingSelectionCommentBtn"')
    expect(textEditorHtml).not.toContain('id="floatingHighlightActions"')
    expect(textEditorHtml).not.toContain('id="floatingRemoveHighlightBtn"')
    expect(textEditorHtml).not.toContain('id="floatingAddHighlightCommentBtn"')
    expect(textEditorHtml).not.toContain('id="floatingMarkActions"')
    expect(textEditorHtml).not.toContain('id="floatingAddMarkCommentBtn"')
    expect(textEditorHtml).not.toContain('id="floatingCommentActions"')
    expect(textEditorHtml).not.toContain('id="floatingAddCommentBtn"')
    expect(textEditorHtml).not.toContain('id="floatingCommentEditor"')
    expect(textEditorHtml).not.toContain('id="floatingCommentInput"')
    expect(textEditorHtml).not.toContain('id="previewSplitter"')
    expect(textEditorHtml).not.toContain('id="previewFrame"')
  })

  it('uses the Rust Ace mode for Rust editor pages', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-local-rust-editor-'))
    const rustPath = join(tempDir, 'main.rs')
    await writeFile(rustPath, 'fn main() { println!("hello"); }\n', 'utf8')

    const editorHtml = await createTextEditorHtml(rustPath)

    expect(editorHtml).toContain("editor.session.setMode('ace/mode/rust')")
    expect(editorHtml).toContain('id="languageLabel">Rust<')
  })

  it('renders a language selector with the detected mode selected', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-lang-select-'))
    const cuPath = join(tempDir, 'kernel.cu')
    await writeFile(cuPath, '__global__ void k() {}\n', 'utf8')

    const editorHtml = await createTextEditorHtml(cuPath)

    expect(editorHtml).toContain('id="langSelect"')
    expect(editorHtml).toContain('value="c_cpp" selected')
    expect(editorHtml).toContain('>C / C++<')
    expect(editorHtml).toContain('id="languageLabel">C / C++<')
    expect(editorHtml).toContain("editor.session.setMode('ace/mode/' + langSelect.value)")
  })

  it('uses GitHub-style syntax colors in local editor pages', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-local-github-editor-'))
    const tsPath = join(tempDir, 'example.ts')
    await writeFile(tsPath, 'const answer: number = 42\n', 'utf8')

    const editorHtml = await createTextEditorHtml(tsPath)

    expect(editorHtml).toContain("editor.setTheme(theme === 'dark' ? 'ace/theme/github_dark' : 'ace/theme/github')")
    expect(editorHtml).toContain('--syntax-keyword: #cf222e;')
    expect(editorHtml).toContain('--syntax-keyword: #ff7b72;')
    expect(editorHtml).toContain('.ace_entity.ace_name.ace_function')
    expect(editorHtml).toContain('.ace_marker-layer .ace_selected-word')
  })

  it('binds Ctrl+S to saving in the local editor page', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-local-save-shortcut-'))
    const textPath = join(tempDir, 'note.txt')
    await writeFile(textPath, 'hello\n', 'utf8')

    const editorHtml = await createTextEditorHtml(textPath)

    expect(editorHtml).toContain('const saveEditorContent = async () =>')
    expect(editorHtml).toContain('const isEditorSaveShortcut = (event) =>')
    expect(editorHtml).toContain("window.addEventListener('keydown'")
    expect(editorHtml).toContain('event.preventDefault()')
    expect(editorHtml).toContain('event.stopPropagation()')
    expect(editorHtml).toContain('capture: true')
    expect(editorHtml).toContain('saveEditorContent();')
  })

  it('handles non-JSON Git diff responses with an actionable error', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-local-git-diff-editor-'))
    const textPath = join(tempDir, 'note.txt')
    await writeFile(textPath, 'hello\n', 'utf8')

    const editorHtml = await createTextEditorHtml(textPath)

    expect(editorHtml).toContain("const responseText = await response.text();")
    expect(editorHtml).toContain('payload = JSON.parse(responseText);')
    expect(editorHtml).toContain('Restart CodexUI to load the latest server routes.')
  })

  it('renders side-by-side read-only Git version editors with copyable references', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-local-git-diff-view-'))
    const textPath = join(tempDir, 'note.txt')
    await writeFile(textPath, 'hello\n', 'utf8')

    const editorHtml = await createTextEditorHtml(textPath)

    expect(editorHtml).toContain('id="gitDiffBaseEditor"')
    expect(editorHtml).toContain('id="gitDiffCompareEditor"')
    expect(editorHtml).toContain("gitDiffBaseEditor = ace.edit('gitDiffBaseEditor')")
    expect(editorHtml).toContain('readOnly: true')
    expect(editorHtml).toContain('baseContent || \'\'')
    expect(editorHtml).toContain('compareContent || \'\'')
    expect(editorHtml).toContain('copyActiveGitDiffReference')
    expect(editorHtml).toContain('activeGitDiffEditor.getSelectionRange()')
    expect(editorHtml).toContain("data.base === 'worktree'")
    expect(editorHtml).toContain("data.compare === 'worktree'")
    expect(editorHtml).toContain('gitDiffBaseEditor.setReadOnly(!baseEditable)')
    expect(editorHtml).toContain('gitDiffCompareEditor.setReadOnly(!compareEditable)')
    expect(editorHtml).toContain('const saveActiveGitDiffEditor = async () =>')
    expect(editorHtml).toContain('Saved working tree and refreshed Git diff')
    expect(editorHtml).toContain('git-diff-added-line')
    expect(editorHtml).toContain('git-diff-removed-line')
    expect(editorHtml).toContain('git-diff-empty-line')
    expect(editorHtml).toContain('const aligned = [];')
    expect(editorHtml).toContain('aligned.map((row) => row.baseText)')
    expect(editorHtml).toContain('aligned.map((row) => row.compareText)')
    expect(editorHtml).toContain('gitDiffAlignedRows = aligned')
    expect(editorHtml).toContain('row.baseLine !== null : row.compareLine !== null')
  })

  it('embeds Git diff beside the editor with matching wrap and range copy controls', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-local-git-diff-split-'))
    const textPath = join(tempDir, 'note.txt')
    await writeFile(textPath, 'hello\n', 'utf8')

    const editorHtml = await createTextEditorHtml(textPath)

    expect(editorHtml).toContain('id="wrapBtn"')
    expect(editorHtml).toContain('editor.session.setUseWrapMode(lineWrapEnabled)')
    expect(editorHtml).toContain('editor-shell[data-diff="true"] .git-diff-panel')
    expect(editorHtml).toContain('id="copyGitDiffRefBtn"')
    expect(editorHtml).toContain('gitDiffBaseEditor.session.setUseWrapMode(lineWrapEnabled)')
    expect(editorHtml).toContain('gitDiffCompareEditor.session.setUseWrapMode(lineWrapEnabled)')
    expect(editorHtml).toContain('const syncGitDiffScroll = (sourceEditor, targetEditor) =>')
    expect(editorHtml).toContain('targetEditor.session.setScrollTop(sourceEditor.session.getScrollTop())')
    expect(editorHtml).toContain("gitDiffBaseEditor.session.on('changeScrollTop'")
    expect(editorHtml).toContain("gitDiffCompareEditor.session.on('changeScrollTop'")
    expect(editorHtml).toContain('if (previewVisible) setPreviewVisible(false)')
    expect(editorHtml).toContain('setGitDiffVisible(false);')
  })

  it('renders markdown preview HTML with local links, images, and code blocks', () => {
    const html = createMarkdownPreviewHtml('/tmp/preview space/note.md', [
      '# Preview Title',
      '',
      '[Docs](./docs/readme.md)',
      '',
      '$$',
      'L_0',
      '$$',
      '',
      'This is ==important==\\comment{highlight note}, ==`git status`==, and \\mark{use `updated` first}.',
      '',
      String.raw`Review \mark{annotated text}\comment{check this} and \cmt{standalone note}.`,
      '',
      '![Diagram](./assets/diagram.png)',
      '',
      '```ts',
      'const enabled: boolean = true',
      '```',
    ].join('\n'))

    expect(html).toContain('message-heading message-scroll-anchor message-heading-h1')
    expect(html).toContain('class="message-file-link"')
    expect(html).toContain('href="/codex-local-browse/tmp/preview%20space/docs/readme.md"')
    expect(html).toContain('class="message-image-preview message-markdown-image"')
    expect(html).toContain('src="/codex-local-image?path=%2Ftmp%2Fpreview%20space%2Fassets%2Fdiagram.png"')
    expect(html).toContain('data-browse-href="/codex-local-browse/tmp/preview%20space/assets/diagram.png"')
    expect(html).toContain('message-code-block')
    expect(html).toContain('class="message-code-copy-button"')
    expect(html).toContain('aria-label="Copy code"')
    expect(html).toContain('<mark class="message-highlight" data-highlight-source="important">important</mark>')
    expect(html).toContain('data-highlight-source="&#x60;git status&#x60;"')
    expect(html).toContain('<mark class="message-annotation-mark" data-annotation-mark="annotated text">annotated text</mark>')
    expect(html).toContain('data-annotation-mark="use &#x60;updated&#x60; first"')
    expect(html).toContain('class="message-annotation-comment" role="note"')
    expect(html).toContain('class="message-annotation-label" aria-hidden="true">cmt</span>')
    expect(html).toContain('<span class="message-annotation-body">highlight note</span>')
    expect(html).toContain('<span class="message-annotation-body">check this</span>')
    expect(html).toContain('<span class="message-annotation-body">standalone note</span>')
    expect(html).toContain('--highlight-bg: #fff3b0;')
    expect(html).toContain('--highlight-bg: rgba(187, 128, 9, 0.42);')
    expect(html).toContain('--annotation-mark-bg: rgba(9, 105, 218, 0.12);')
    expect(html).toContain('--annotation-mark-bg: rgba(56, 139, 253, 0.18);')
    expect(html).toContain('.message-annotation {\n      display: inline;')
    expect(html).not.toContain('.message-annotation {\n      display: inline-flex;')
    expect(html).toContain('message-scroll-anchor')
    expect(html).toContain('language-ts')
    expect(html).toContain('--syntax-keyword: #d73a49;')
    expect(html).toContain('--syntax-keyword: #ff7b72;')
    expect(html).toContain('.message-code-copy-button[data-copied="true"]')
    expect(html).toContain('const copyCodeBlock = async (button) =>')
    expect(html).toContain("targetElement?.closest('button.message-code-copy-button')")
    expect(html).toContain("button.setAttribute('aria-label', 'Code copied')")
    expect(html).toContain('.hljs-title.function_')
    expect(html).toContain('message-math-source-display')
    expect(html).toContain('data-source-line="5"')
    expect(html).toContain('target.nodeType === Node.TEXT_NODE')
    expect(html).toContain('postHighlightSelection')
    expect(html).toContain('postHighlightActionDismiss')
    expect(html).toContain('activePreviewActionTarget')
    expect(html).toContain('isPreviewPointerSelectionActive')
    expect(html).toContain('scheduleHighlightSelectionPost')
    expect(html).toContain('if (isPreviewPointerSelectionActive) return;')
    expect(html).toContain("document.addEventListener('selectionchange', () => scheduleHighlightSelectionPost(true));")
    expect(html).toContain('scheduleFloatingActionPositionUpdate')
    expect(html).toContain("window.addEventListener('scroll', scheduleFloatingActionPositionUpdate")
    expect(html).toContain("window.addEventListener('resize', scheduleFloatingActionPositionUpdate")
    expect(html).toContain('postSaveRequest')
    expect(html).toContain('isPreviewSaveShortcut')
    expect(html).toContain('serializeRect')
    expect(html).toContain('mark.message-highlight')
    expect(html).toContain('mark.message-annotation-mark')
    expect(html).toContain('occurrence')
    expect(html).toContain('codex-local-markdown-highlight-click')
    expect(html).toContain('codex-local-markdown-mark-click')
    expect(html).toContain('codex-local-markdown-comment-click')
    expect(html).toContain('data-annotation-mark')
    expect(html).toContain('data-highlight-source')
    expect(html).toContain('sourceText: markSource')
    expect(html).toContain('sourceText: highlightSource')
    expect(html).toContain('codex-local-markdown-highlight-dismiss')
    expect(html).toContain('codex-local-markdown-preview-save')
    expect(html).toContain("img.message-markdown-image[data-browse-href]")
    expect(html).toContain("window.open(imageBrowseHref, '_blank', 'noopener,noreferrer')")
    expect(html).toContain('data-source-line=')
    expect(html).toContain('data-source-end-line=')
    expect(html).toContain('codex-local-markdown-preview-jump')
    expect(html).toContain('data-source-line="1"')
  })

  it('renders file add and delete controls in directory listings', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-local-browse-listing-'))
    const filePath = join(tempDir, 'note.txt')
    const folderPath = join(tempDir, 'docs')
    await writeFile(filePath, 'hello\n', 'utf8')
    await mkdir(folderPath)
    await writeFile(join(folderPath, '.keep'), 'x\n', 'utf8')

    const html = await createDirectoryListingHtml(tempDir)

    expect(html).toContain('id="newFileForm"')
    expect(html).toContain('id="newFileName"')
    expect(html).toContain('id="createFileBtn"')
    expect(html).toContain('id="newDirForm"')
    expect(html).toContain('id="newDirName"')
    expect(html).toContain('id="createDirBtn"')
    expect(html).toContain('class="icon-btn danger delete-entry-btn"')
    expect(html).toContain('data-name="note.txt"')
    expect(html).toContain('Delete note.txt')
    expect(html).toContain(`aria-label="Raw note.txt" href="/codex-local-browse${encodeURI(filePath)}?raw=1"`)
    expect(html).toContain(`class="file-link" href="/codex-local-browse${encodeURI(filePath)}"`)
    const listingUl = html.slice(html.indexOf('<ul>'), html.indexOf('</ul>'));
    expect((listingUl.match(/class="icon-btn danger delete-entry-btn"/gu) ?? []).length).toBe(2)
    expect(html).toContain('docs/')
  })

  it('lists files and directories directory-first via getDirectoryItemList', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-local-browse-itemlist-'))
    await mkdir(join(tempDir, 'zdir'))
    await mkdir(join(tempDir, 'adir'))
    await writeFile(join(tempDir, 'b.txt'), 'x\n', 'utf8')
    await writeFile(join(tempDir, '.hidden'), 'x\n', 'utf8')

    const entries = await getDirectoryItemList(tempDir)
    const names = entries.map((entry) => entry.name)
    expect(names).toEqual(['adir', 'zdir', 'b.txt'])
    expect(entries[0].isDirectory).toBe(true)
    expect(entries[2].isDirectory).toBe(false)
    expect(entries.find((entry) => entry.name === 'b.txt')?.editable).toBe(true)

    const withHidden = await getDirectoryItemList(tempDir, { showHidden: true })
    expect(withHidden.map((entry) => entry.name)).toContain('.hidden')
  })

  it('creates and deletes directory entries through the shared mutation helpers', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-local-browse-mutation-'))
    const dirPath = join(tempDir, 'docs')

    const createdPath = await createLocalBrowseEntry(tempDir, 'docs', 'directory')

    expect(createdPath).toBe(dirPath)
    expect((await stat(dirPath)).isDirectory()).toBe(true)

    await deleteLocalBrowseEntry(dirPath)

    await expect(stat(dirPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('skips broken symlinks in directory listings', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'codexui-local-browse-broken-link-'))
    const filePath = join(tempDir, 'note.txt')
    const brokenLinkPath = join(tempDir, 'missing-skill')
    await writeFile(filePath, 'hello\n', 'utf8')
    await symlink(join(tempDir, 'missing-target'), brokenLinkPath)

    const html = await createDirectoryListingHtml(tempDir)

    expect(html).toContain('note.txt')
    expect(html).not.toContain('missing-skill')
  })

  it('links KaTeX assets in standalone markdown preview', () => {
    const html = createMarkdownPreviewHtml('/tmp/preview space/note.md', 'Plain preview')

    expect(html).toContain(`<link rel="stylesheet" href="${KATEX_STYLESHEET_HREF}" />`)
  })
})
