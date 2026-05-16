import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import rehypeStringify from 'rehype-stringify'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkParse from 'remark-parse'
import remarkRehype from 'remark-rehype'
import { all as lowlightAll } from 'lowlight'
import { unified } from 'unified'
import { HIGHLIGHT_LANGUAGE_ALIASES } from '../../utils/codeLanguage.js'

type MarkdownRenderContext = {
  cwd: string
  kind: 'message' | 'plan'
  highlightVersion: number
}

type MarkdownRenderResult = {
  html: string
}

type MarkdownSourcePoint = {
  line?: number
}

type MarkdownSourcePosition = {
  start?: MarkdownSourcePoint
  end?: MarkdownSourcePoint
}

type MarkdownNode = {
  type: string
  position?: MarkdownSourcePosition
  [key: string]: unknown
  children?: MarkdownNode[]
}

type MarkdownElement = MarkdownNode & {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
  children: MarkdownNode[]
}

type MarkdownText = MarkdownNode & {
  type: 'text'
  value: string
}

type InlineToken =
  | { kind: 'text'; value: string }
  | { kind: 'url'; value: string; href: string }
  | { kind: 'file'; value: string; path: string; displayPath: string; line: number | null; endLine: number | null }
  | { kind: 'image'; alt: string; url: string; markdown: string }

type ParsedFileReference = {
  path: string
  line: number | null
  endLine: number | null
}

const MARKDOWN_RENDER_CACHE_LIMIT = 400
const markdownRenderCache = new Map<string, MarkdownRenderResult>()

export function clearMarkdownRendererCache(): void {
  markdownRenderCache.clear()
}

function normalizeLineRange(line: number | null, endLine: number | null = line): { startLine: number; endLine: number } | null {
  if (!Number.isFinite(line ?? NaN) || !Number.isFinite(endLine ?? NaN)) return null
  const startLine = Math.floor(line ?? NaN)
  const normalizedEndLine = Math.floor(endLine ?? NaN)
  if (startLine < 1 || normalizedEndLine < 1) return null
  return {
    startLine: Math.min(startLine, normalizedEndLine),
    endLine: Math.max(startLine, normalizedEndLine),
  }
}

function lineRangeQueryValue(line: number | null, endLine: number | null = line): string {
  const normalized = normalizeLineRange(line, endLine)
  if (!normalized) return ''
  return normalized.startLine === normalized.endLine
    ? String(normalized.startLine)
    : `${normalized.startLine}-${normalized.endLine}`
}

function appendLineQuery(href: string, line: number | null, endLine: number | null = line): string {
  const queryValue = lineRangeQueryValue(line, endLine)
  if (!queryValue) return href
  const separator = href.includes('?') ? '&' : '?'
  return `${href}${separator}line=${encodeURIComponent(queryValue)}`
}

function fileReferenceDisplayPath(pathValue: string, line: number | null, endLine: number | null = line): string {
  const queryValue = lineRangeQueryValue(line, endLine)
  return queryValue ? `${pathValue}:${queryValue}` : pathValue
}

export function renderMarkdownContent(
  text: string,
  context: MarkdownRenderContext,
  processorFactory: (renderContext: MarkdownRenderContext) => ReturnType<typeof createMarkdownProcessor> = createMarkdownProcessor,
): MarkdownRenderResult {
  const normalizedText = normalizeMarkdownText(text)
  const cacheKey = `${context.kind}\u0000${context.cwd}\u0000${context.highlightVersion}\u0000${normalizedText}`
  const cached = markdownRenderCache.get(cacheKey)
  if (cached) {
    markdownRenderCache.delete(cacheKey)
    markdownRenderCache.set(cacheKey, cached)
    return cached
  }

  let html = ''
  try {
    html = String(processorFactory(context).processSync(normalizedText))
  } catch {
    html = ''
  }

  if (!html.trim() && normalizedText.trim()) {
    html = renderPlainTextFallback(normalizedText)
  }

  const result = setBoundedCacheEntry(
    markdownRenderCache,
    cacheKey,
    { html },
    MARKDOWN_RENDER_CACHE_LIMIT,
  )
  return result
}

export function createMarkdownProcessor(context: MarkdownRenderContext) {
  const defaultAttributes = defaultSchema.attributes ?? {}

  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype)
    .use(rehypeSanitize, {
      ...defaultSchema,
      attributes: {
        ...defaultAttributes,
        code: [
          ...(defaultAttributes.code ?? []),
          ['className', /^language-./],
          ['className', 'math-inline', 'math-display'],
        ],
      },
    })
    .use(() => (tree) => {
      wrapMathSourceElements(tree as MarkdownNode)
    })
    .use(rehypeKatex)
    .use(rehypeHighlight, {
      aliases: HIGHLIGHT_LANGUAGE_ALIASES,
      languages: lowlightAll,
      detect: false,
    })
    .use(() => (tree) => {
      transformMarkdownTree(tree as MarkdownNode, context)
    })
    .use(rehypeStringify)
}

function setBoundedCacheEntry<K, V>(cache: Map<K, V>, key: K, value: V, limit: number): V {
  if (cache.has(key)) cache.delete(key)
  cache.set(key, value)
  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value as K | undefined
    if (oldestKey === undefined) break
    cache.delete(oldestKey)
  }
  return value
}

function normalizeMarkdownText(text: string): string {
  return text.replace(/\r\n/gu, '\n')
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

function renderPlainTextFallback(text: string): string {
  return `<p class="message-text">${escapeHtml(text)}</p>`
}

function isElement(node: MarkdownNode | null | undefined): node is MarkdownElement {
  return node !== null && node !== undefined && node.type === 'element' && typeof (node as MarkdownElement).tagName === 'string'
}

function isText(node: MarkdownNode | null | undefined): node is MarkdownText {
  return node !== null && node !== undefined && node.type === 'text' && typeof (node as MarkdownText).value === 'string'
}

function getClassList(node: MarkdownElement): string[] {
  const raw = node.properties?.className
  if (Array.isArray(raw)) {
    return raw.flatMap((entry) => typeof entry === 'string' ? [entry] : [])
  }
  if (typeof raw === 'string') return [raw]
  return []
}

function setClassList(node: MarkdownElement, classNames: string[]): void {
  const next = Array.from(new Set(classNames.filter((className) => className.trim().length > 0)))
  node.properties ??= {}
  node.properties.className = next
}

function addClass(node: MarkdownElement, className: string): void {
  const next = getClassList(node)
  if (!next.includes(className)) {
    next.push(className)
    setClassList(node, next)
  }
}

function getPropertyString(node: MarkdownElement, name: string): string {
  const value = node.properties?.[name]
  return typeof value === 'string' ? value : ''
}

function setProperty(node: MarkdownElement, name: string, value: unknown): void {
  node.properties ??= {}
  node.properties[name] = value
}

function normalizeSourceLine(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const line = Math.floor(value)
  return line >= 1 ? line : null
}

function readSourceLocation(position: MarkdownSourcePosition | undefined): { startLine: number; endLine: number } | null {
  const startLine = normalizeSourceLine(position?.start?.line)
  if (startLine === null) return null
  const endLine = normalizeSourceLine(position?.end?.line) ?? startLine
  return {
    startLine: Math.min(startLine, endLine),
    endLine: Math.max(startLine, endLine),
  }
}

function isMathCodeElement(node: MarkdownElement): boolean {
  if (node.tagName !== 'code') return false
  const classNames = getClassList(node)
  return classNames.includes('language-math') || classNames.includes('math-inline') || classNames.includes('math-display')
}

function isMathDisplayPre(node: MarkdownElement): boolean {
  if (node.tagName !== 'pre') return false
  return node.children.some((child) => isElement(child) && isMathCodeElement(child))
}

function createMathSourceWrapper(
  child: MarkdownElement,
  tagName: 'div' | 'span',
  className: string,
): MarkdownElement {
  return {
    type: 'element',
    tagName,
    position: child.position,
    properties: {
      className: ['message-math-source', 'message-scroll-anchor', className],
    },
    children: [child],
  }
}

function wrapMathSourceElements(node: MarkdownNode): void {
  if (!Array.isArray(node.children)) return

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index]
    if (!isElement(child)) {
      continue
    }

    if (isMathDisplayPre(child) && readSourceLocation(child.position)) {
      const wrapper = createMathSourceWrapper(child, 'div', 'message-math-source-display')
      node.children.splice(index, 1, wrapper)
      continue
    }

    if (isMathCodeElement(child) && readSourceLocation(child.position)) {
      const wrapper = createMathSourceWrapper(child, 'span', 'message-math-source-inline')
      node.children.splice(index, 1, wrapper)
      continue
    }

    wrapMathSourceElements(child)
  }
}

function annotateSourceLocations(node: MarkdownNode): void {
  if (isElement(node)) {
    const location = readSourceLocation(node.position)
    if (location) {
      setProperty(node, 'dataSourceLine', String(location.startLine))
      setProperty(node, 'dataSourceEndLine', String(location.endLine))
    }
  }

  if (!Array.isArray(node.children)) return
  for (const child of node.children) {
    annotateSourceLocations(child)
  }
}

function hasPreserveWhitespaceAncestor(ancestors: MarkdownElement[]): boolean {
  return ancestors.some((ancestor) => (
    ancestor.tagName === 'pre' ||
    ancestor.tagName === 'code' ||
    ancestor.tagName === 'textarea' ||
    ancestor.tagName === 'script' ||
    ancestor.tagName === 'style'
  ))
}

function hasIgnoredTextAncestor(ancestors: MarkdownElement[]): boolean {
  return ancestors.some((ancestor) => {
    if (
      ancestor.tagName === 'code' ||
      ancestor.tagName === 'pre' ||
      ancestor.tagName === 'a' ||
      ancestor.tagName === 'math' ||
      ancestor.tagName === 'annotation' ||
      ancestor.tagName === 'annotation-xml'
    ) {
      return true
    }

    const classNames = getClassList(ancestor)
    return classNames.includes('katex') || classNames.includes('katex-display')
  })
}

function isTaskListItem(node: MarkdownElement): boolean {
  const classNames = getClassList(node)
  return classNames.includes('task-list-item')
}

function isTaskCheckbox(node: MarkdownElement): boolean {
  return node.tagName === 'input' && getPropertyString(node, 'type') === 'checkbox'
}

function isWhitespaceText(node: MarkdownNode): boolean {
  return isText(node) && node.value.trim().length === 0
}

function transformMarkdownTree(root: MarkdownNode, context: MarkdownRenderContext): void {
  if (!Array.isArray(root.children)) return
  transformChildren(root, [], context)
  annotateSourceLocations(root)
}

function transformChildren(parent: MarkdownNode, ancestors: MarkdownElement[], context: MarkdownRenderContext): void {
  if (!Array.isArray(parent.children)) return

  for (let index = 0; index < parent.children.length; index += 1) {
    const child = parent.children[index]

    if (isText(child)) {
      if (hasIgnoredTextAncestor(ancestors)) {
        continue
      }

      if (child.value.trim().length === 0) {
        if (!hasPreserveWhitespaceAncestor(ancestors)) {
          parent.children.splice(index, 1)
          index -= 1
        }
        continue
      }

      const replacement = splitTextNode(child.value, context)
      if (replacement.length === 1 && replacement[0] === child) {
        continue
      }
      parent.children.splice(index, 1, ...replacement)
      index += replacement.length - 1
      continue
    }

    if (!isElement(child)) {
      continue
    }

    const nextAncestors = [...ancestors, child]
    transformChildren(child, nextAncestors, context)
    transformElement(child, parent, index, context)
  }
}

function transformElement(node: MarkdownElement, parent: MarkdownNode, index: number, context: MarkdownRenderContext): void {
  const tagName = node.tagName
  const parentTagName = isElement(parent) ? parent.tagName : ''

  if (/^h[1-6]$/u.test(tagName)) {
    addClass(node, 'message-heading')
    addClass(node, 'message-scroll-anchor')
    addClass(node, `message-heading-${tagName}`)
  } else if (tagName === 'p') {
    addClass(node, 'message-text')
    addClass(node, 'message-scroll-anchor')
    if (parentTagName === 'li') {
      addClass(node, 'message-list-item-text')
      addClass(node, 'message-list-item-paragraph')
    }
  } else if (tagName === 'blockquote') {
    addClass(node, 'message-blockquote')
    addClass(node, 'message-scroll-anchor')
  } else if (tagName === 'ul') {
    addClass(node, 'message-list')
    addClass(node, getClassList(node).includes('contains-task-list') ? 'message-task-list' : 'message-list-unordered')
  } else if (tagName === 'ol') {
    addClass(node, 'message-list')
    addClass(node, 'message-list-ordered')
  } else if (tagName === 'li') {
    addClass(node, 'message-list-item')
    addClass(node, 'message-scroll-anchor')
    if (isTaskListItem(node)) {
      addClass(node, 'message-task-item')
    }
    wrapListItemChildren(node)
  } else if (tagName === 'code') {
    if (parentTagName !== 'pre') {
      addClass(node, 'message-inline-code')
      linkInlineCodeFileReferences(node, context)
    }
  } else if (tagName === 'a') {
    enhanceAnchor(node, context.cwd)
  } else if (tagName === 'img') {
    enhanceImage(node, context.cwd)
  } else if (tagName === 'hr') {
    addClass(node, 'message-divider')
    addClass(node, 'message-scroll-anchor')
  } else if (tagName === 'table') {
    addClass(node, 'message-table')
    addClass(node, 'message-scroll-anchor')
    wrapTable(node, parent, index)
    return
  } else if (tagName === 'th' || tagName === 'td') {
    addClass(node, tagName === 'th' ? 'message-table-head-cell' : 'message-table-cell')
  } else if (tagName === 'pre') {
    wrapCodeBlock(node, parent, index)
    return
  } else if (tagName === 'em') {
    addClass(node, 'message-italic-text')
  } else if (tagName === 'strong') {
    addClass(node, 'message-bold-text')
  } else if (tagName === 'del') {
    addClass(node, 'message-strikethrough-text')
  }
}

function linkInlineCodeFileReferences(node: MarkdownElement, context: MarkdownRenderContext): void {
  if (!Array.isArray(node.children) || node.children.length === 0) return
  if (!node.children.every(isText)) return

  const codeValue = node.children.map((child) => child.value).join('')
  const segments = splitPlainTextByLinks(codeValue)
  if (segments.length === 1 && segments[0].kind === 'text' && segments[0].value === codeValue) return

  const nextChildren: MarkdownNode[] = []
  for (const segment of segments) {
    if (segment.kind === 'text') {
      nextChildren.push({ type: 'text', value: segment.value })
      continue
    }

    if (segment.kind === 'url') {
      nextChildren.push({
        type: 'element',
        tagName: 'a',
        properties: {
          className: ['message-file-link', 'message-inline-code-link'],
          href: segment.href,
          target: '_blank',
          rel: 'noopener noreferrer',
          title: segment.href,
        },
        children: [{ type: 'text', value: segment.value }],
      })
      continue
    }

    if (segment.kind === 'file') {
      nextChildren.push({
        type: 'element',
        tagName: 'a',
        properties: {
          className: ['message-file-link', 'message-inline-code-link'],
          href: toBrowseUrl(segment.path, context.cwd, segment.line, segment.endLine),
          target: '_blank',
          rel: 'noopener noreferrer',
          title: fileReferenceDisplayPath(segment.path, segment.line, segment.endLine),
        },
        children: [{ type: 'text', value: segment.displayPath }],
      })
    }
  }

  node.children = nextChildren
}

function wrapListItemChildren(node: MarkdownElement): void {
  const originalChildren = node.children ?? []
  if (originalChildren.length === 0) return

  const children = [...originalChildren]
  let leadingCheckbox: MarkdownNode | null = null
  let startIndex = 0

  while (startIndex < children.length && isWhitespaceText(children[startIndex])) {
    startIndex += 1
  }

  if (startIndex < children.length && isElement(children[startIndex]) && isTaskCheckbox(children[startIndex] as MarkdownElement)) {
    const checkbox = children[startIndex] as MarkdownElement
    leadingCheckbox = {
      type: 'element',
      tagName: 'span',
      properties: {
        className: ['message-task-checkbox'],
        dataChecked: Boolean(checkbox.properties?.checked) ? 'true' : 'false',
        ariaHidden: 'true',
      },
      children: [
        {
          type: 'text',
          value: Boolean(checkbox.properties?.checked) ? '☑' : '☐',
        },
      ],
    }
    startIndex += 1
    while (startIndex < children.length && isWhitespaceText(children[startIndex])) {
      startIndex += 1
    }
  }

  const contentChildren = wrapListItemContentChildren(children.slice(startIndex))
  const wrappedContent: MarkdownElement = {
    type: 'element',
    tagName: 'div',
    position: node.position,
    properties: {
      className: ['message-list-item-content'],
    },
    children: contentChildren.length > 0 ? contentChildren : [],
  }

  node.children = leadingCheckbox ? [leadingCheckbox, wrappedContent] : [wrappedContent]
}

function isListItemBlockChild(node: MarkdownNode): boolean {
  if (!isElement(node)) return false
  const { tagName } = node
  return (
    /^h[1-6]$/u.test(tagName) ||
    tagName === 'p' ||
    tagName === 'blockquote' ||
    tagName === 'ul' ||
    tagName === 'ol' ||
    tagName === 'table' ||
    tagName === 'pre' ||
    tagName === 'hr' ||
    tagName === 'div'
  )
}

function wrapListItemContentChildren(children: MarkdownNode[]): MarkdownNode[] {
  if (children.length === 0) return []

  const wrapped: MarkdownNode[] = []
  let inlineRun: MarkdownNode[] = []

  const flushInlineRun = (): void => {
    if (inlineRun.length === 0) return
    wrapped.push({
      type: 'element',
      tagName: 'div',
      properties: {
        className: ['message-list-item-text'],
      },
      children: inlineRun,
    })
    inlineRun = []
  }

  for (const child of children) {
    if (isListItemBlockChild(child)) {
      flushInlineRun()
      wrapped.push(child)
      continue
    }
    inlineRun.push(child)
  }

  flushInlineRun()
  return wrapped
}

function wrapTable(node: MarkdownElement, parent: MarkdownNode, index: number): void {
  const wrapper: MarkdownElement = {
    type: 'element',
    tagName: 'div',
    position: node.position,
    properties: {
      className: ['message-table-wrap', 'message-scroll-anchor'],
    },
    children: [node],
  }

  if (!Array.isArray(parent.children)) return
  parent.children.splice(index, 1, wrapper)
}

function wrapCodeBlock(node: MarkdownElement, parent: MarkdownNode, index: number): void {
  const firstCode = node.children.find((child) => isElement(child) && child.tagName === 'code') as MarkdownElement | undefined
  const code = firstCode ?? null
  const language = extractCodeLanguage(code)

  const wrapperChildren: MarkdownNode[] = []
  if (language) {
    wrapperChildren.push({
      type: 'element',
      tagName: 'div',
      properties: {
        className: ['message-code-language'],
      },
      children: [{ type: 'text', value: language }],
    })
  }

  addClass(node, 'message-code-pre')
  wrapperChildren.push(node)

  const wrapper: MarkdownElement = {
    type: 'element',
    tagName: 'div',
    position: node.position,
    properties: {
      className: ['message-code-block', 'message-scroll-anchor'],
    },
    children: wrapperChildren,
  }

  if (!Array.isArray(parent.children)) return
  parent.children.splice(index, 1, wrapper)
}

function extractCodeLanguage(code: MarkdownElement | null): string {
  if (!code) return ''
  const classNames = getClassList(code)
  const languageClass = classNames.find((className) => className.startsWith('language-'))
  return languageClass ? languageClass.slice('language-'.length) : ''
}

function enhanceAnchor(node: MarkdownElement, cwd: string): void {
  const href = getPropertyString(node, 'href').trim()
  if (!href) return

  const resolved = resolveMarkdownHref(href, cwd)
  if (!resolved) return

  setProperty(node, 'href', resolved.href)
  if (resolved.title) {
    setProperty(node, 'title', resolved.title)
  }
  setProperty(node, 'target', '_blank')
  setProperty(node, 'rel', 'noopener noreferrer')
  addClass(node, 'message-file-link')
}

function enhanceImage(node: MarkdownElement, cwd: string): void {
  const src = getPropertyString(node, 'src').trim()
  if (!src) return

  const renderedSrc = toRenderableImageUrl(src, cwd)
  if (!renderedSrc) return

  setProperty(node, 'src', renderedSrc)
  setProperty(node, 'loading', 'lazy')
  addClass(node, 'message-image-preview')
  addClass(node, 'message-markdown-image')

  const alt = getPropertyString(node, 'alt')
  if (!alt) {
    setProperty(node, 'alt', 'Embedded message image')
  }
}

function resolveMarkdownHref(href: string, cwd: string): { href: string; title: string } | null {
  const normalized = href.trim()
  if (!normalized) return null

  if (/^https?:\/\//u.test(normalized)) {
    return {
      href: normalized,
      title: normalized,
    }
  }

  const ref = parseFileReference(normalized)
  if (!ref) return null

  return {
    href: toBrowseUrl(normalized, cwd),
    title: normalized,
  }
}

function splitTextNode(text: string, context: MarkdownRenderContext): MarkdownNode[] {
  const segments = splitTextByMarkdownInlineTokens(text)
  const nodes: MarkdownNode[] = []

  for (const segment of segments) {
    if (segment.kind === 'text') {
      nodes.push({ type: 'text', value: segment.value })
      continue
    }

    if (segment.kind === 'url') {
      nodes.push({
        type: 'element',
        tagName: 'a',
        properties: {
          className: ['message-file-link'],
          href: segment.href,
          target: '_blank',
          rel: 'noopener noreferrer',
          title: segment.href,
        },
        children: [{ type: 'text', value: segment.value }],
      })
      continue
    }

    if (segment.kind === 'file') {
      nodes.push({
        type: 'element',
        tagName: 'a',
        properties: {
          className: ['message-file-link'],
          href: toBrowseUrl(segment.path, context.cwd, segment.line, segment.endLine),
          target: '_blank',
          rel: 'noopener noreferrer',
          title: fileReferenceDisplayPath(segment.path, segment.line, segment.endLine),
        },
        children: [{ type: 'text', value: segment.displayPath }],
      })
      continue
    }

    if (segment.kind === 'image') {
      const imageSrc = toRenderableImageUrl(segment.url, context.cwd)
      if (!imageSrc) {
        nodes.push({ type: 'text', value: segment.markdown })
        continue
      }

      nodes.push({
        type: 'element',
        tagName: 'img',
        properties: {
          className: ['message-image-preview', 'message-markdown-image'],
          src: imageSrc,
          alt: segment.alt || 'Embedded message image',
          loading: 'lazy',
        },
        children: [],
      })
    }
  }

  return nodes
}

function splitTextByMarkdownInlineTokens(text: string): InlineToken[] {
  const segments: InlineToken[] = []
  let cursor = 0
  let scanFrom = 0

  while (scanFrom < text.length) {
    const match = findNextMarkdownInlineToken(text, scanFrom)
    if (!match) break

    const { start, end, token, kind } = match
    if (start > cursor) {
      segments.push(...splitPlainTextByLinks(text.slice(cursor, start)))
    }

    const parsed = kind === 'image'
      ? parseMarkdownImageToken(token)
      : parseMarkdownLinkToken(token)

    if (!parsed) {
      segments.push(...splitPlainTextByLinks(text.slice(start, end)))
      cursor = end
      scanFrom = end
      continue
    }

    if (kind === 'image') {
      segments.push({
        kind: 'image',
        alt: parsed.label,
        url: parsed.target,
        markdown: token,
      })
    } else if (/^https?:\/\//u.test(parsed.target)) {
      segments.push({
        kind: 'url',
        value: parsed.label || parsed.target,
        href: parsed.target,
      })
    } else {
      const ref = parseFileReference(parsed.target)
      if (ref) {
        segments.push({
          kind: 'file',
          value: parsed.target,
          path: ref.path,
          displayPath: parsed.label || parsed.target,
          line: ref.line,
          endLine: ref.endLine,
        })
      } else {
        segments.push({ kind: 'text', value: token })
      }
    }

    cursor = end
    scanFrom = end
  }

  if (cursor < text.length) {
    segments.push(...splitPlainTextByLinks(text.slice(cursor)))
  }

  return segments
}

function findNextMarkdownInlineToken(
  source: string,
  fromIndex: number,
): { start: number; end: number; token: string; kind: 'link' | 'image' } | null {
  let openIndex = source.indexOf('[', fromIndex)
  while (openIndex >= 0) {
    const isImage = openIndex > 0 && source[openIndex - 1] === '!'
    const start = isImage ? openIndex - 1 : openIndex
    const labelEnd = source.indexOf(']', openIndex + 1)
    if (labelEnd < 0) {
      openIndex = source.indexOf('[', openIndex + 1)
      continue
    }
    if (source[labelEnd + 1] !== '(') {
      openIndex = source.indexOf('[', openIndex + 1)
      continue
    }

    let depth = 1
    let index = labelEnd + 2
    let hasNewLine = false
    while (index < source.length) {
      const char = source[index]
      if (char === '\n') {
        hasNewLine = true
        break
      }
      if (char === '(') depth += 1
      if (char === ')') {
        depth -= 1
        if (depth === 0) {
          const token = source.slice(start, index + 1)
          const parsed = isImage ? parseMarkdownImageToken(token) : parseMarkdownLinkToken(token)
          if (parsed) {
            return {
              start,
              end: index + 1,
              token,
              kind: isImage ? 'image' : 'link',
            }
          }
          break
        }
      }
      index += 1
    }

    if (hasNewLine) {
      openIndex = source.indexOf('[', openIndex + 1)
      continue
    }
    openIndex = source.indexOf('[', openIndex + 1)
  }

  return null
}

function splitPlainTextByLinks(text: string): InlineToken[] {
  const segments: InlineToken[] = []
  const pattern = /https?:\/\/[^\s<>"'`，。；：！？、()[\]{}「」『』《》]+|file:\/\/[^\n<>"'`，。；：！？、[\]{}「」『』《》]+|["'](?:[A-Za-z]:[\\/]|~\/|\.{1,2}\/|\/)[^\n"']+["']|`(?:[A-Za-z]:[\\/]|~\/|\.{1,2}\/|\/)[^`\n]+`|(?<![\p{L}\p{N}._@()-])(?:[A-Za-z]:[\\/]|~\/|\.{1,2}\/|\/)[^\s<>"'`，。；：！？、()[\]{}「」『』《》]+|(?:[A-Za-z0-9._@()-]+[\\/])+[A-Za-z0-9._@()-]+\.[A-Za-z0-9]{1,12}(?::\d+(?:-\d+)?(?::\d+)?)?(?:#L\d+(?:-L?\d+)?(?:C\d+)?)?/gu
  let cursor = 0

  for (const match of text.matchAll(pattern)) {
    if (typeof match.index !== 'number') continue

    const start = match.index
    const end = start + match[0].length

    if (start > cursor) {
      segments.push({ kind: 'text', value: text.slice(cursor, start) })
    }

    let token = match[0]
    let trailingPunctuation = ''
    while (/[.,;:!?，。；：！？、]$/u.test(token)) {
      trailingPunctuation = token.slice(-1) + trailingPunctuation
      token = token.slice(0, -1)
    }

    const wrapped = trimLinkWrappers(token)
    token = wrapped.core
    const leading = wrapped.leading
    const trailing = wrapped.trailing + trailingPunctuation

    if (leading) {
      segments.push({ kind: 'text', value: leading })
    }

    const href = token.startsWith('http://') || token.startsWith('https://')
      ? token
      : token.startsWith('file://')
        ? normalizeFileUrlToPath(token)
        : ''

    if (href && /^https?:\/\//u.test(href)) {
      segments.push({ kind: 'url', value: token, href: token })
      if (trailing) {
        segments.push({ kind: 'text', value: trailing })
      }
      cursor = end
      continue
    }

    const ref = parseFileReference(token)
    if (ref) {
      segments.push({
        kind: 'file',
        value: token,
        path: ref.path,
        displayPath: fileReferenceDisplayPath(ref.path, ref.line, ref.endLine),
        line: ref.line,
        endLine: ref.endLine,
      })
      if (trailing) {
        segments.push({ kind: 'text', value: trailing })
      }
      cursor = end
      continue
    }

    segments.push({ kind: 'text', value: match[0] })
    cursor = end
  }

  if (cursor < text.length) {
    segments.push({ kind: 'text', value: text.slice(cursor) })
  }

  return segments
}

function trimLinkWrappers(value: string): { core: string; leading: string; trailing: string } {
  let core = value
  let leading = ''
  let trailing = ''

  const wrapperPairs: Record<string, string> = {
    '(': ')',
    '[': ']',
    '{': '}',
    '<': '>',
    '"': '"',
    '\'': '\'',
    '`': '`',
    '“': '”',
    '‘': '’',
  }

  while (core.length > 0) {
    const opening = core[0]
    const closing = Object.prototype.hasOwnProperty.call(wrapperPairs, opening) ? wrapperPairs[opening] : ''
    if (!closing || !core.endsWith(closing)) break
    leading += opening
    trailing += closing
    core = core.slice(1, -1)
  }

  return { core, leading, trailing }
}

function parseMarkdownLinkToken(value: string): { label: string; target: string } | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(')')) return null
  const labelCloseIndex = trimmed.indexOf(']')
  if (labelCloseIndex <= 1) return null
  if (trimmed[labelCloseIndex + 1] !== '(') return null
  const labelRaw = trimmed.slice(1, labelCloseIndex).trim()
  const targetRaw = trimmed.slice(labelCloseIndex + 2, -1).trim()
  if (labelRaw.includes('\n') || targetRaw.includes('\n')) return null
  const label = trimLinkWrappers(labelRaw).core.trim() || labelRaw
  const target = trimLinkWrappers(targetRaw).core.trim()
  if (!target) return null
  return { label, target }
}

function parseMarkdownImageToken(value: string): { label: string; target: string } | null {
  const trimmed = value.trim()
  if (!trimmed.startsWith('![') || !trimmed.endsWith(')')) return null
  const labelCloseIndex = trimmed.indexOf(']')
  if (labelCloseIndex < 2) return null
  if (trimmed[labelCloseIndex + 1] !== '(') return null
  const labelRaw = trimmed.slice(2, labelCloseIndex).trim()
  const targetRaw = trimmed.slice(labelCloseIndex + 2, -1).trim()
  if (labelRaw.includes('\n') || targetRaw.includes('\n')) return null
  const label = trimLinkWrappers(labelRaw).core.trim() || labelRaw
  const target = trimLinkWrappers(targetRaw).core.trim()
  if (!target) return null
  return { label, target }
}

function isFilePath(value: string): boolean {
  if (!value || /[\r\n]/u.test(value)) return false
  if (value.endsWith('/') || value.endsWith('\\')) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(value)) return false

  const looksLikeUnixAbsolute = value.startsWith('/')
  const looksLikeWindowsAbsolute = /^[A-Za-z]:[\\/]/u.test(value)
  const looksLikeRelative = value.startsWith('./') || value.startsWith('../') || value.startsWith('~/')
  if (looksLikeUnixAbsolute || looksLikeWindowsAbsolute || looksLikeRelative) return true

  const looksLikeBareFilename = /^[A-Za-z0-9._@() -]+\.[A-Za-z0-9]{1,12}$/u.test(value)
  if (looksLikeBareFilename) return true

  return /^[A-Za-z0-9._@() -]+(?:[\\/][A-Za-z0-9._@() -]+)+$/u.test(value)
}

function getBasename(pathValue: string): string {
  const normalized = pathValue.replace(/\\/gu, '/')
  const name = normalized.split('/').filter(Boolean).pop()
  return name || pathValue
}

function normalizePathSeparators(pathValue: string): string {
  return pathValue.replace(/\\/gu, '/')
}

function normalizeFileUrlToPath(pathValue: string): string {
  if (!pathValue.startsWith('file://')) return pathValue
  let stripped = pathValue.replace(/^file:\/\//u, '')
  try {
    stripped = decodeURIComponent(stripped)
  } catch {
    // Keep best-effort path if decoding fails.
  }
  if (/^\/[A-Za-z]:\//u.test(stripped)) {
    stripped = stripped.slice(1)
  }
  return stripped
}

function inferHomeFromCwd(cwd: string): string {
  const normalized = normalizePathSeparators(cwd)
  const userMatch = normalized.match(/^\/Users\/([^/]+)/u)
  if (userMatch) return `/Users/${userMatch[1]}`
  const homeMatch = normalized.match(/^\/home\/([^/]+)/u)
  if (homeMatch) return `/home/${homeMatch[1]}`
  return ''
}

function normalizePathDots(pathValue: string): string {
  const normalized = normalizePathSeparators(pathValue)
  if (!normalized) return normalized

  let root = ''
  let rest = normalized
  const driveMatch = rest.match(/^([A-Za-z]:)(\/.*)?$/u)
  if (driveMatch) {
    root = `${driveMatch[1]}/`
    rest = (driveMatch[2] ?? '').replace(/^\/+/u, '')
  } else if (rest.startsWith('/')) {
    root = '/'
    rest = rest.slice(1)
  }

  const parts = rest.split('/').filter(Boolean)
  const stack: string[] = []
  for (const part of parts) {
    if (part === '.') continue
    if (part === '..') {
      if (stack.length > 0) stack.pop()
      continue
    }
    stack.push(part)
  }

  const joined = stack.join('/')
  if (root) return `${root}${joined}`.replace(/\/+$/u, '') || root
  return joined || normalized
}

function resolveRelativePath(pathValue: string, cwd: string): string {
  const normalizedPath = normalizePathSeparators(normalizeFileUrlToPath(pathValue.trim()))
  if (!normalizedPath) return ''

  const looksLikeAbsolute = normalizedPath.startsWith('/') || /^[A-Za-z]:\//u.test(normalizedPath)
  if (looksLikeAbsolute) return normalizePathDots(normalizedPath)

  if (normalizedPath.startsWith('~/')) {
    const homeBase = inferHomeFromCwd(cwd)
    if (homeBase) {
      return normalizePathDots(`${homeBase}/${normalizedPath.slice(2)}`)
    }
  }

  const base = normalizePathSeparators(cwd.trim())
  if (!base) return normalizePathDots(normalizedPath)
  return normalizePathDots(`${base.replace(/\/+$/u, '')}/${normalizedPath}`)
}

function parseFileReference(value: string): ParsedFileReference | null {
  if (!value) return null

  let pathValue = value.trim()
  const wrapped = trimLinkWrappers(pathValue)
  pathValue = wrapped.core.trim()
  let line: number | null = null
  let endLine: number | null = null

  const hashLineMatch = pathValue.match(/^(.*)#L(\d+)(?:-L?(\d+))?(?:C\d+)?$/u)
  if (hashLineMatch) {
    pathValue = hashLineMatch[1]
    line = Number(hashLineMatch[2])
    endLine = Number(hashLineMatch[3] ?? hashLineMatch[2])
  } else {
    const colonLineMatch = pathValue.match(/^(.*):(\d+)(?:-(\d+))?(?::\d+)?$/u)
    if (colonLineMatch) {
      pathValue = colonLineMatch[1]
      line = Number(colonLineMatch[2])
      endLine = Number(colonLineMatch[3] ?? colonLineMatch[2])
    }
  }

  pathValue = normalizeFileUrlToPath(pathValue)
  try {
    pathValue = decodeURIComponent(pathValue)
  } catch {
    // Keep best-effort path if decoding fails.
  }
  if (!isFilePath(pathValue)) return null
  const normalizedRange = normalizeLineRange(line, endLine)
  return {
    path: pathValue,
    line: normalizedRange?.startLine ?? null,
    endLine: normalizedRange?.endLine ?? null,
  }
}

function toBrowseUrl(pathValue: string, cwd = '', line: number | null = null, endLine: number | null = line): string {
  const normalized = pathValue.trim()
  if (!normalized) return '#'

  const parsed = parseFileReference(normalized)
  const candidatePath = parsed?.path ?? normalized
  const resolved = resolveRelativePath(candidatePath, cwd)
  if (!resolved) return '#'

  const normalizedResolved = resolved.startsWith('/') ? resolved : `/${resolved}`
  return appendLineQuery(
    `/codex-local-browse${encodeURI(normalizedResolved)}`,
    parsed?.line ?? line,
    parsed?.endLine ?? endLine,
  )
}

function toRenderableImageUrl(value: string, cwd = ''): string {
  const normalized = value.trim()
  if (!normalized) return ''
  if (
    normalized.startsWith('data:') ||
    normalized.startsWith('blob:') ||
    normalized.startsWith('http://') ||
    normalized.startsWith('https://') ||
    normalized.startsWith('/codex-local-image?')
  ) {
    return normalized
  }

  if (normalized.startsWith('file://')) {
    return `/codex-local-image?path=${encodeURIComponent(normalized)}`
  }

  const ref = parseFileReference(normalized)
  if (ref) {
    const resolved = resolveRelativePath(ref.path, cwd)
    if (resolved) {
      const normalizedResolved = resolved.startsWith('/') ? resolved : `/${resolved}`
      return `/codex-local-image?path=${encodeURIComponent(normalizedResolved)}`
    }
  }

  return ''
}
