type MermaidApi = (typeof import('mermaid'))['default']
type MermaidTheme = 'default' | 'dark'

const MERMAID_SELECTOR = '.message-mermaid[data-mermaid-source]'

let mermaidModulePromise: Promise<MermaidApi> | null = null
let mermaidRenderQueue: Promise<void> = Promise.resolve()
let mermaidRenderSequence = 0

function getMermaidTheme(root: HTMLElement): MermaidTheme {
  return root.ownerDocument.documentElement.classList.contains('dark') ? 'dark' : 'default'
}

function restoreMermaidSource(diagram: HTMLElement): void {
  const source = diagram.dataset.mermaidSource ?? ''
  const document = diagram.ownerDocument
  const pre = document.createElement('pre')
  const code = document.createElement('code')

  pre.className = 'message-mermaid-source'
  code.className = 'language-mermaid'
  code.textContent = source
  pre.append(code)
  diagram.replaceChildren(pre)
}

function markMermaidPending(diagram: HTMLElement): void {
  diagram.dataset.mermaidRenderId = String(++mermaidRenderSequence)
  diagram.dataset.mermaidState = 'pending'
  delete diagram.dataset.mermaidTheme
  restoreMermaidSource(diagram)
}

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid').then(({ default: mermaid }) => mermaid)
  }
  return mermaidModulePromise
}

function queueMermaidRender(source: string, theme: MermaidTheme): Promise<string> {
  const task = mermaidRenderQueue.then(async () => {
    const mermaid = await loadMermaid()
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme,
      flowchart: { htmlLabels: false },
    })
    const id = `codex-mermaid-${Date.now()}-${++mermaidRenderSequence}`
    const { svg } = await mermaid.render(id, source)
    return svg
  })

  mermaidRenderQueue = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}

function replaceWithMermaidSvg(diagram: HTMLElement, svg: string): void {
  const template = diagram.ownerDocument.createElement('template')
  template.innerHTML = svg
  if (!(template.content.firstElementChild instanceof SVGElement)) {
    throw new Error('Mermaid did not produce an SVG element.')
  }
  diagram.replaceChildren(template.content)
}

async function renderMermaidDiagram(root: HTMLElement, diagram: HTMLElement, theme: MermaidTheme): Promise<void> {
  const source = diagram.dataset.mermaidSource ?? ''
  if (!source.trim()) {
    diagram.dataset.mermaidState = 'error'
    return
  }

  const renderId = String(++mermaidRenderSequence)
  diagram.dataset.mermaidRenderId = renderId
  diagram.dataset.mermaidState = 'rendering'

  try {
    const svg = await queueMermaidRender(source, theme)
    if (!diagram.isConnected || diagram.dataset.mermaidRenderId !== renderId) return

    if (getMermaidTheme(root) !== theme) {
      markMermaidPending(diagram)
      void renderMermaidDiagrams(root)
      return
    }

    replaceWithMermaidSvg(diagram, svg)
    diagram.dataset.mermaidState = 'rendered'
    diagram.dataset.mermaidTheme = theme
  } catch {
    if (!diagram.isConnected || diagram.dataset.mermaidRenderId !== renderId) return
    restoreMermaidSource(diagram)
    diagram.dataset.mermaidState = 'error'
  }
}

export async function renderMermaidDiagrams(root: HTMLElement | null): Promise<void> {
  if (!root) return
  const theme = getMermaidTheme(root)
  const diagrams = Array.from(root.querySelectorAll<HTMLElement>(MERMAID_SELECTOR))
    .filter((diagram) => {
      const state = diagram.dataset.mermaidState
      return state === 'pending' || (state === 'rendered' && diagram.dataset.mermaidTheme !== theme)
    })

  for (const diagram of diagrams) {
    await renderMermaidDiagram(root, diagram, theme)
  }
}

export function observeMermaidTheme(root: HTMLElement): () => void {
  const documentRoot = root.ownerDocument.documentElement
  if (typeof MutationObserver === 'undefined') return () => {}

  let theme = getMermaidTheme(root)
  const observer = new MutationObserver(() => {
    const nextTheme = getMermaidTheme(root)
    if (nextTheme === theme) return
    theme = nextTheme

    for (const diagram of root.querySelectorAll<HTMLElement>(MERMAID_SELECTOR)) {
      markMermaidPending(diagram)
    }
    void renderMermaidDiagrams(root)
  })

  observer.observe(documentRoot, {
    attributes: true,
    attributeFilter: ['class'],
  })

  return () => observer.disconnect()
}
