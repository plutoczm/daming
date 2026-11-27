/**
 * Protocol parser and capability kernel for multi-turn paid Agents.
 *
 * This module is deliberately pure: no process, file, network, plugin,
 * provider key or SQLite access. Only the trusted Host can send a model
 * turn. A model's "tool_calls" are DATA, never executable instructions.
 */
export type SafeToolName = 'count_characters' | 'find_literal';
export type SafeToolCall = {
  callId: string; name: SafeToolName;
  input: { text: string; needle?: string };
};
export type SafeToolResult = {
  toolCallId: string; name: SafeToolName; text: string;
};
export type ParsedModelTurn = {
  finishReason: 'stop' | 'tool_calls';
  content: string;
  toolCalls: readonly SafeToolCall[];
  usage: { inputTokens: number | null; outputTokens: number | null };
};
export type GovernedTurnState =
  | 'awaiting_model_authorization'
  | 'awaiting_cash_reconciliation'
  | 'completed_cash_unknown'
  | 'blocked';
export type MultiTurnSnapshot = {
  state: GovernedTurnState;
  turns: number;
  pendingToolCalls: readonly SafeToolCall[];
  safeToolResults: readonly SafeToolResult[];
  lastContent: string;
  paidDispatchPermitted: false;
  autoPaidContinuationPermitted: false;
  vendorInvoiceReconciled: false;
};
export class GovernedToolError extends Error {}
function dict(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 &&
    v <= 1000000 ? v : null;
}
function parseTool(item: unknown): SafeToolCall {
  if (!dict(item) || typeof item.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(item.id) ||
      item.type !== 'function' || !dict(item.function) ||
      (item.function.name !== 'count_characters' &&
       item.function.name !== 'find_literal') ||
      typeof item.function.arguments !== 'string' ||
      item.function.arguments.length > 4096) {
    throw new GovernedToolError('agent_tool_contract_invalid');
  }
  let args: unknown;
  try { args = JSON.parse(item.function.arguments); }
  catch { throw new GovernedToolError('agent_tool_arguments_invalid'); }
  if (!dict(args) || typeof args.text !== 'string' ||
      args.text.length > 2048 || Buffer.byteLength(args.text, 'utf8') > 8192 ||
      Object.keys(args).some(k => k !== 'text' && k !== 'needle') ||
      (item.function.name === 'count_characters' &&
        (Object.keys(args).length !== 1)) ||
      (item.function.name === 'find_literal' &&
        (typeof args.needle !== 'string' || args.needle.length < 1 ||
         args.needle.length > 100 || Object.keys(args).length !== 2))) {
    throw new GovernedToolError('agent_tool_arguments_untrusted');
  }
  return {
    callId: item.id, name: item.function.name,
    input: { text: args.text,
      ...(typeof args.needle === 'string' ? { needle: args.needle } : {}) }
  };
}
export function parseGovernedChatTurn(raw: unknown): ParsedModelTurn {
  if (!dict(raw) || raw.object !== 'chat.completion' ||
      !Array.isArray(raw.choices) || raw.choices.length !== 1 ||
      !dict(raw.choices[0]) || !dict(raw.choices[0].message)) {
    throw new GovernedToolError('agent_model_envelope_invalid');
  }
  const choice = raw.choices[0];
  if (!dict(choice) || !dict(choice.message)) {
    throw new GovernedToolError('agent_model_turn_invalid');
  }
  const message = choice.message;
  if (message.role !== 'assistant' || (choice.finish_reason !== 'stop' &&
      choice.finish_reason !== 'tool_calls') ||
      !(typeof message.content === 'string' || message.content === null) ||
      (typeof message.content === 'string' &&
       (message.content.length > 16000 ||
        Buffer.byteLength(message.content, 'utf8') > 64000)) ||
      message.function_call !== undefined) {
    throw new GovernedToolError('agent_model_turn_invalid');
  }
  const calls: SafeToolCall[] = [];
  if (choice.finish_reason === 'tool_calls') {
    if (!Array.isArray(message.tool_calls) ||
        message.tool_calls.length < 1 || message.tool_calls.length > 2) {
      throw new GovernedToolError('agent_model_tools_too_many');
    }
    const seen = new Set<string>();
    for (const value of message.tool_calls) {
      const parsed = parseTool(value);
      if (seen.has(parsed.callId)) throw new GovernedToolError('agent_model_tool_id_reused');
      seen.add(parsed.callId); calls.push(parsed);
    }
  } else if (message.tool_calls != null &&
      (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 0)) {
    throw new GovernedToolError('agent_model_finish_conflict');
  }
  return {
    finishReason: choice.finish_reason,
    content: message.content ?? '',
    toolCalls: calls,
    usage: {
      inputTokens: dict(raw.usage) ? count(raw.usage.prompt_tokens) : null,
      outputTokens: dict(raw.usage) ? count(raw.usage.completion_tokens) : null
    }
  };
}
export const GOVERNED_MODEL_TOOLS = Object.freeze([
  { type: 'function', function: {
    name: 'count_characters', description: 'Count characters in supplied text. No network or files.',
    parameters: { type: 'object', properties: { text: { type: 'string' } },
      required: ['text'], additionalProperties: false }
  }},
  { type: 'function', function: {
    name: 'find_literal', description: 'Find literal substring in supplied text. No regex or shell.',
    parameters: { type: 'object', properties: {
      text: { type: 'string' }, needle: { type: 'string' } },
      required: ['text','needle'], additionalProperties: false }
  }}
] as const);
/** Pure, bounded processing of MODEL-PROPOSED tool calls. */
export function runGovernedMemoryTool(call: SafeToolCall): SafeToolResult {
  if (!call || (call.name !== 'count_characters' && call.name !== 'find_literal') ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(call.callId) ||
      !call.input || typeof call.input.text !== 'string' ||
      call.input.text.length > 2048 ||
      Buffer.byteLength(call.input.text, 'utf8') > 8192) {
    throw new GovernedToolError('agent_tool_execution_invalid');
  }
  const text = call.input.text;
  let result: string;
  if (call.name === 'count_characters') {
    result = JSON.stringify({ characters: Array.from(text).length,
      utf8Bytes: Buffer.byteLength(text, 'utf8') });
  } else {
    if (typeof call.input.needle !== 'string' ||
        call.input.needle.length < 1 || call.input.needle.length > 100) {
      throw new GovernedToolError('agent_tool_needle_invalid');
    }
    result = JSON.stringify({ found: text.includes(call.input.needle),
      position: text.indexOf(call.input.needle) });
  }
  return { toolCallId: call.callId, name: call.name, text: result };
}

/** Always pauses after one potentially billable model result. This is the
 * hard boundary until a trusted invoice/per-call attribution exists.
 * A synthetic offline test may repeatedly invoke applyModelResult() to
 * validate a full tool loop, but production Host MUST NOT auto-call again.
 */
export class GovernedToolTurnKernel {
  private turns = 0;
  private pending: SafeToolCall[] = [];
  private latest: SafeToolResult[] = [];
  private content = '';
  private state: GovernedTurnState = 'awaiting_model_authorization';
  applyModelResult(raw: unknown): MultiTurnSnapshot {
    if (this.state !== 'awaiting_model_authorization' || this.turns >= 4)
      throw new GovernedToolError('agent_turn_not_authorized');
    const parsed = parseGovernedChatTurn(raw);
    this.turns++;
    this.pending = [...parsed.toolCalls];
    this.latest = parsed.toolCalls.map(runGovernedMemoryTool);
    this.content = parsed.content;
    this.state = parsed.finishReason === 'tool_calls'
      ? 'awaiting_cash_reconciliation' : 'completed_cash_unknown';
    return this.snapshot();
  }
  /** Only for non-network tests where no provider cash has been incurred.
   * There is deliberately no public "settle" method for paid operations. */
  advanceSyntheticOfflineTest(): MultiTurnSnapshot {
    if (this.state !== 'awaiting_cash_reconciliation')
      throw new GovernedToolError('agent_test_advance_denied');
    this.state = 'awaiting_model_authorization';
    return this.snapshot();
  }
  snapshot(): MultiTurnSnapshot {
    return {
      state: this.state, turns: this.turns,
      pendingToolCalls: [...this.pending], safeToolResults: [...this.latest],
      lastContent: this.content, paidDispatchPermitted: false,
      autoPaidContinuationPermitted: false, vendorInvoiceReconciled: false
    };
  }
}
