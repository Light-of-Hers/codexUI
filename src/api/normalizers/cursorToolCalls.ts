import type { CommandExecutionData, UiMessage, UiToolCallData } from '../../types/codex'

export type CursorToolCommandMessage = {
  id: string
  role: 'system'
  text: string
  messageType: 'commandExecution'
  commandExecution: CommandExecutionData
}

export type CursorToolDisplayMessage = UiMessage & {
  messageType: 'toolCall'
  toolCall: UiToolCallData
}

type ParsedCursorToolCall = {
  subtype: string
  callId: string
  tool: string
  argumentsRaw: string
  arguments: Record<string, unknown> | null
  outputRaw: string
  output: Record<string, unknown> | null
}

const CURSOR_TOOL_HEADER = /^\[cursor tool_call ([^\]]+)\]\n/
const CURSOR_TOOL_COMPACT_HEADER = /^Cursor tool (`?.+?`?) (started|running|completed)(?: \(exit (-?\d+)\))?\n/
const CURSOR_SHELL_COMPACT_HEADER = /^Cursor shell (running|completed)(?: \(exit (-?\d+)\))?\n/
const CURSOR_TOOL_CALLED_HEADER = /^(Called|Calling) Cursor tool (`?.+?`?)\n/
const CODEX_UI_DATA_BLOCK = /<codex-ui-data>([\s\S]*?)<\/codex-ui-data>/
const CODEX_UI_DATA_BASE64_BLOCK = /\[codex-ui-data:base64\]([A-Za-z0-9+/=]+)\[\/codex-ui-data\]/
const CURSOR_PAYLOAD_FILE_LINE = /^\s*(?:└\s*)?payload:\s*(.+\.json)\s*$/m

export function isCursorToolCallText(value: string): boolean {
  return parseCursorToolCallText(value) !== null
}

export function isIncompleteCursorToolCallText(value: string): boolean {
  const parsed = parseCursorToolCallText(value)
  if (!parsed) return false
  return parsed.subtype !== 'completed' && parsed.outputRaw === ''
}

export function cursorToolCallDisplayIdFromText(value: string): string | null {
  const parsed = parseCursorToolCallText(value)
  if (!parsed) return null
  return cursorToolDisplayId(parsed)
}

function parseJsonAfterLabel(value: string, label: string): Record<string, unknown> | null {
  const jsonText = parseTextAfterLabel(value, label)
  if (!jsonText) return null
  try {
    const parsed = JSON.parse(jsonText)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function parseJsonLineAfterLabel(value: string, label: string): Record<string, unknown> | null {
  const jsonText = parseLineTextAfterLabel(value, label)
  if (!jsonText) return null
  try {
    const parsed = JSON.parse(jsonText)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

function parseArgumentsPreviewAfterLabel(value: string, label: string): Record<string, unknown> | null {
  return normalizeCommandFieldsFromPreview(parseJsonLineAfterLabel(value, label))
}

function normalizeCommandFieldsFromPreview(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null
  let next: Record<string, unknown> | null = null
  for (const key of ['command', 'cmd']) {
    const raw = value[key]
    if (typeof raw !== 'string') continue
    const normalized = raw.replace(/\r/gu, '\\r').replace(/\n/gu, '\\n')
    if (normalized === raw) continue
    next ??= { ...value }
    next[key] = normalized
  }
  return next ?? value
}

function parseTextAfterLabel(value: string, label: string): string {
  const start = value.indexOf(label)
  if (start < 0) return ''
  return value.slice(start + label.length).trim()
}

function parseLineTextAfterLabel(value: string, label: string): string {
  const start = value.indexOf(label)
  if (start < 0) return ''
  const jsonStart = start + label.length
  const lineEnd = value.indexOf('\n', jsonStart)
  return value.slice(jsonStart, lineEnd < 0 ? undefined : lineEnd).trim()
}

function readLineValue(value: string, label: string): string {
  const match = value.match(new RegExp(`^\\s*(?:└\\s*)?${label}:\\s*(.+)$`, 'm'))
  return match?.[1]?.trim() ?? ''
}

function parseCursorToolCallText(value: string): ParsedCursorToolCall | null {
  const hiddenPayload = parseHiddenCursorToolPayload(value)
  if (hiddenPayload) return hiddenPayload

  const header = value.match(CURSOR_TOOL_HEADER)
  if (header) {
    const subtype = header[1]?.trim() ?? ''
    const callId = readLineValue(value, 'call_id')
    const tool = readLineValue(value, 'tool')
    if (!subtype || !callId || !tool) return null
    return {
      subtype,
      callId,
      tool,
      argumentsRaw: parseLineTextAfterLabel(value, 'arguments:'),
      arguments: parseArgumentsPreviewAfterLabel(value, 'arguments:'),
      outputRaw: parseTextAfterLabel(value, 'output:'),
      output: parseJsonAfterLabel(value, 'output:'),
    }
  }

  const compactToolHeader = value.match(CURSOR_TOOL_COMPACT_HEADER)
  const compactShellHeader = value.match(CURSOR_SHELL_COMPACT_HEADER)
  const compactHeader = compactToolHeader ?? compactShellHeader

  if (compactHeader) {
    const tool = compactToolHeader
    ? compactToolHeader[1]?.replace(/^`|`$/g, '').trim() ?? ''
    : 'shell'
    const subtype = compactToolHeader
    ? (compactToolHeader[2] ?? 'started')
    : (compactShellHeader?.[1] === 'completed' ? 'completed' : 'started')
    const callId = readLineValue(value, 'call_id')
    if (!subtype || !callId || !tool) return null
    return {
      subtype,
      callId,
      tool,
      argumentsRaw: parseLineTextAfterLabel(value, 'args:') || parseLineTextAfterLabel(value, 'arguments:'),
      arguments: parseArgumentsPreviewAfterLabel(value, 'args:') || parseArgumentsPreviewAfterLabel(value, 'arguments:'),
      outputRaw: parseTextAfterLabel(value, 'output:'),
      output: parseJsonAfterLabel(value, 'output:'),
    }
  }

  // New proxy commentary format: "Called/Calling Cursor tool `name`"
  const calledHeader = value.match(CURSOR_TOOL_CALLED_HEADER)
  if (calledHeader) {
    const tool = calledHeader[2]?.replace(/^`|`$/g, '').trim() ?? ''
    const subtype = calledHeader[1] === 'Called' ? 'completed' : 'started'
    const callId = callIdFromPayloadPath(value) || readLineValue(value, 'call_id')
    if (!tool) return null
    return {
      subtype,
      callId,
      tool,
      argumentsRaw: parseLineTextAfterLabel(value, 'args:'),
      arguments: parseArgumentsPreviewAfterLabel(value, 'args:'),
      outputRaw: parseLineTextAfterLabel(value, 'output:'),
      output: parseJsonLineAfterLabel(value, 'output:'),
    }
  }

  return null
}

function callIdFromPayloadPath(value: string): string {
  const path = value.match(CURSOR_PAYLOAD_FILE_LINE)?.[1]?.trim() ?? ''
  if (!path) return ''
  const filename = path.split('/').pop() ?? ''
  return filename.replace(/\.json$/i, '')
}

function callIdFromMessageId(id: string): string {
  const match = id.match(/^msg_cursor_tool_\w+_(.+)$/)
  return match?.[1]?.trim() ?? ''
}

function parseHiddenCursorToolPayload(value: string): ParsedCursorToolCall | null {
  const payloadText = readCodexUiPayloadText(value)
  if (!payloadText) return null
  let payload: Record<string, unknown>
  try {
    const parsed = JSON.parse(payloadText)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    payload = parsed as Record<string, unknown>
  } catch {
    return null
  }
  if (payload.type !== 'cursor_tool_call') return null

  const subtype = readString(payload.subtype)
  const callId = readString(payload.call_id)
  const tool = readString(payload.tool)
  if (!subtype || !callId || !tool) return null

  const argumentsValue = payload.arguments
  const outputValue = payload.output
  const argumentsRecord = argumentsValue && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue)
    ? argumentsValue as Record<string, unknown>
    : null
  const outputRecord = outputValue && typeof outputValue === 'object' && !Array.isArray(outputValue)
    ? outputValue as Record<string, unknown>
    : null

  return {
    subtype,
    callId,
    tool,
    argumentsRaw: argumentsRecord ? JSON.stringify(argumentsRecord) : '',
    arguments: argumentsRecord,
    outputRaw: outputRecord ? JSON.stringify(outputRecord) : '',
    output: outputRecord,
  }
}

export function cursorToolPayloadPathFromText(value: string): string {
  const match = value.match(CURSOR_PAYLOAD_FILE_LINE)
  return match?.[1]?.trim() ?? ''
}

function readCodexUiPayloadText(value: string): string {
  const base64Match = value.match(CODEX_UI_DATA_BASE64_BLOCK)
  if (base64Match?.[1]) {
    return decodeBase64Utf8(base64Match[1])
  }
  const xmlMatch = value.match(CODEX_UI_DATA_BLOCK)
  return xmlMatch?.[1] ?? ''
}

function decodeBase64Utf8(value: string): string {
  try {
    if (typeof atob === 'function') {
      const binary = atob(value)
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
      return new TextDecoder().decode(bytes)
    }
  } catch {
    // Fall through to Buffer for Node-based tests and server-side normalization.
  }

  try {
    const bufferCtor = (globalThis as { Buffer?: { from(value: string, encoding: 'base64'): { toString(encoding: 'utf8'): string } } }).Buffer
    return bufferCtor?.from(value, 'base64').toString('utf8') ?? ''
  } catch {
    return ''
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function commandFromArguments(args: Record<string, unknown> | null): string {
  return readString(args?.command) || readString(args?.cmd)
}

function cwdFromArguments(args: Record<string, unknown> | null): string | null {
  const cwd = readString(args?.workingDirectory) || readString(args?.cwd)
  return cwd || null
}

function outputRecord(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null
  const success = value.success
  if (success && typeof success === 'object' && !Array.isArray(success)) {
    return success as Record<string, unknown>
  }
  const error = value.error
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    return error as Record<string, unknown>
  }
  const failure = value.failure
  if (failure && typeof failure === 'object' && !Array.isArray(failure)) {
    return failure as Record<string, unknown>
  }
  return value
}

function hasErrorOutput(value: Record<string, unknown> | null): boolean {
  return Boolean(value?.error || value?.failure)
}

function cursorToolDisplayId(parsed: ParsedCursorToolCall): string {
  const prefix = parsed.tool === 'shell' ? 'cursor-command' : 'cursor-tool'
  return parsed.callId ? `${prefix}-${parsed.callId}` : prefix
}

function cursorToolStatus(parsed: ParsedCursorToolCall): string {
  if (parsed.subtype === 'completed' || parsed.outputRaw) return 'completed'
  return parsed.subtype || 'started'
}

function formatJsonBlock(value: Record<string, unknown> | null, raw: string): string {
  if (value) return JSON.stringify(value, null, 2)
  return raw
}

function formatGenericCursorToolMessage(parsed: ParsedCursorToolCall): string {
  const toolCall = toCursorToolCallData(parsed)
  const lines = [`${toolCall.title} (${toolCall.status})`]
  if (toolCall.meta.length > 0) lines.push(toolCall.meta.join(' | '))
  if (toolCall.input) lines.push('', 'Input:', '```json', toolCall.input, '```')
  if (toolCall.output) lines.push('', 'Output:', '```json', toolCall.output, '```')
  if (toolCall.error) lines.push('', 'Error:', toolCall.error)
  return lines.join('\n')
}

function toCursorToolCallData(parsed: ParsedCursorToolCall): UiToolCallData {
  const output = formatJsonBlock(parsed.output, parsed.outputRaw)
  const outputIsError = hasErrorOutput(parsed.output)
  const status = outputIsError
    ? 'failed'
    : cursorToolStatus(parsed) === 'completed'
      ? 'completed'
      : 'inProgress'

  return {
    kind: 'cursor',
    title: `Cursor tool: ${parsed.tool}`,
    name: parsed.tool,
    status,
    server: 'cursor-cli',
    input: formatJsonBlock(parsed.arguments, parsed.argumentsRaw),
    output: outputIsError ? '' : output,
    error: outputIsError ? output : '',
    progress: status === 'inProgress' ? 'Running' : '',
    durationMs: null,
    meta: ['Cursor CLI'],
  }
}

export function parseCursorToolMessage(
  id: string,
  text: string,
  options: { includeInProgress?: boolean } = {},
): CursorToolCommandMessage | CursorToolDisplayMessage | null {
  const command = parseCursorToolCommandMessage(id, text, options)
  if (command) return command

  const parsed = parseCursorToolCallText(text)
  if (!parsed) return null
  if (!parsed.callId) parsed.callId = callIdFromMessageId(id) || id
  const completed = parsed.subtype === 'completed' || parsed.outputRaw !== ''
  if (!completed && !options.includeInProgress) return null

  return {
    id: cursorToolDisplayId(parsed),
    role: 'system',
    text: formatGenericCursorToolMessage(parsed),
    messageType: 'toolCall',
    toolCall: toCursorToolCallData(parsed),
  }
}

export function parseCursorToolCommandMessage(
  id: string,
  text: string,
  options: { includeInProgress?: boolean } = {},
): CursorToolCommandMessage | null {
  const parsed = parseCursorToolCallText(text)
  if (!parsed || parsed.tool !== 'shell') return null
  if (!parsed.callId) parsed.callId = callIdFromMessageId(id) || id

  const command = commandFromArguments(parsed.arguments)
  if (!command) return null

  const output = outputRecord(parsed.output)
  const outputIsError = hasErrorOutput(parsed.output)
  const stdout = readString(output?.stdout)
  const stderr = readString(output?.stderr)
  const message = readString(output?.message)
  const interleavedOutput = readString(output?.interleavedOutput)
  const aggregatedOutput = stdout || stderr
    ? [stdout, stderr].filter(Boolean).join(stderr && stdout ? '\n' : '')
    : interleavedOutput || message
  const exitCode = readNumber(output?.exitCode)
  const completed = parsed.subtype === 'completed' || parsed.output !== null
  if (!completed && !options.includeInProgress) return null

  return {
    id: parsed.callId ? cursorToolDisplayId(parsed) : id,
    role: 'system',
    text: command,
    messageType: 'commandExecution',
    commandExecution: {
      command,
      cwd: cwdFromArguments(parsed.arguments) || cwdFromArguments(output),
      status: completed ? (outputIsError || (exitCode !== null && exitCode !== 0) ? 'failed' : 'completed') : 'inProgress',
      aggregatedOutput,
      exitCode,
    },
  }
}
