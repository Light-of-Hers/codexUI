const RICH_MARKDOWN_PATTERNS = [
  /```/u,
  /(?:^|[^\\])(?:\$\$|\$[^$\n]+\$)/u,
  /\\(?:mark|comment|cmt)\{/u,
  /==[^=\n]+==/u,
  /!?\[[^\]\n]+\]\([^\n)]+\)/u,
  /<\/?(?:details|summary|table|thead|tbody|tr|th|td|kbd|sup|sub)\b/iu,
]

export function needsRichMarkdownRenderer(text: string): boolean {
  if (!text) return false
  return RICH_MARKDOWN_PATTERNS.some((pattern) => pattern.test(text))
}
