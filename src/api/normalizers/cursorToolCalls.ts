import type { CommandExecutionData } from '../../types/codex'

export type CursorToolCommandMessage = {
  id: string
  role: 'system'
  text: string
  messageType: 'commandExecution'
  commandExecution: CommandExecutionData
}

type ParsedCursorToolCall = {
  subtype: string
  callId: string
  tool: string
  arguments: Record<string, unknown> | null
  output: Record<string, unknown> | null
}

const CURSOR_TOOL_HEADER = /^\[cursor tool_call ([^\]]+)\]\n/

export function isIncompleteCursorToolCallText(value: string): boolean {
  const parsed = parseCursorToolCallText(value)
  if (!parsed) return false
  return parsed.subtype !== 'completed' && parsed.output === null
}

function parseJsonAfterLabel(value: string, label: string): Record<string, unknown> | null {
  const start = value.indexOf(label)
  if (start < 0) return null
  const jsonStart = start + label.length
  const jsonText = value.slice(jsonStart).trim()
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
  const start = value.indexOf(label)
  if (start < 0) return null
  const jsonStart = start + label.length
  const lineEnd = value.indexOf('\n', jsonStart)
  const jsonText = value.slice(jsonStart, lineEnd < 0 ? undefined : lineEnd).trim()
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

function readLineValue(value: string, label: string): string {
  const match = value.match(new RegExp(`^${label}:\\s*(.+)$`, 'm'))
  return match?.[1]?.trim() ?? ''
}

function parseCursorToolCallText(value: string): ParsedCursorToolCall | null {
  const header = value.match(CURSOR_TOOL_HEADER)
  if (!header) return null
  const subtype = header[1]?.trim() ?? ''
  const callId = readLineValue(value, 'call_id')
  const tool = readLineValue(value, 'tool')
  if (!subtype || !callId || !tool) return null
  return {
    subtype,
    callId,
    tool,
    arguments: parseJsonLineAfterLabel(value, 'arguments:'),
    output: parseJsonAfterLabel(value, 'output:'),
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
  return value
}

function hasErrorOutput(value: Record<string, unknown> | null): boolean {
  return Boolean(value?.error)
}

export function parseCursorToolCommandMessage(
  id: string,
  text: string,
  options: { includeInProgress?: boolean } = {},
): CursorToolCommandMessage | null {
  const parsed = parseCursorToolCallText(text)
  if (!parsed || parsed.tool !== 'shell') return null

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
    id: parsed.callId ? `cursor-command-${parsed.callId}` : id,
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
