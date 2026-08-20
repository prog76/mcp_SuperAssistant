/**
 * InternalToolProvider：扩展自身作为工具提供方。
 *
 * 内置工具不依赖外部 MCP Server，由扩展本地实现（如 compact_context 触发上下文压缩），
 * 与外部 MCP 工具合并后注入网页 AI 的 prompt，并在 mcpClient.callTool / useMcpCommunication
 * 处被拦截执行（不要求 MCP 已连接）。
 *
 * 新增内置工具：在 INTERNAL_TOOLS 数组追加一条定义即可，执行分发按 name 匹配。
 */
import { createLogger } from '@extension/shared/lib/logger';
import { compactionService } from '../services/compaction.service';
import type { Tool } from '../types/stores';

const logger = createLogger('InternalToolProvider');

export interface InternalToolHandlerArgs {
  [key: string]: unknown;
}

export interface InternalToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: InternalToolHandlerArgs) => Promise<string>;
}

/** compact_context：触发一次上下文压缩，摘要注入新会话。 */
const COMPACT_CONTEXT_DEF: InternalToolDefinition = {
  name: 'compact_context',
  description:
    '将当前对话压缩为结构化摘要并注入新会话，用于长对话续接。摘要由当前对话 AI 生成，压缩后原文可回查。',
  inputSchema: {
    type: 'object',
    properties: {
      targetTokens: {
        type: 'number',
        description: '摘要目标 token 预算，默认 1200，范围 800~3000',
        minimum: 800,
        maximum: 3000,
      },
      todoContext: {
        type: 'string',
        description: '待续接任务状态摘要，缺省时忽略',
      },
    },
    required: [],
  },
  handler: async (args) => {
    const targetTokens = typeof args.targetTokens === 'number' ? args.targetTokens : undefined;
    const todoContext = typeof args.todoContext === 'string' ? args.todoContext : undefined;

    const result = await compactionService.compact({ targetTokens, todoContext });

    if (result.success) {
      return [
        `上下文压缩完成。compactionId: ${result.compactionId}，摘要约 ${result.summaryTokens ?? 0} tokens，已在新会话注入续接消息。`,
        result.error ? `注意：${result.error}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }
    return `上下文压缩失败：${result.error || '未知错误'}`;
  },
};

const INTERNAL_TOOLS: InternalToolDefinition[] = [COMPACT_CONTEXT_DEF];

/** 是否为内置工具名 */
export function isInternalTool(name: string): boolean {
  return INTERNAL_TOOLS.some(tool => tool.name === name);
}

/** 内置工具列表（与外部 MCP 工具相同的 Tool 结构，schema 为 JSON 字符串）。 */
export function getInternalTools(): Tool[] {
  return INTERNAL_TOOLS.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
    schema: JSON.stringify(tool.inputSchema),
    internal: true,
  }));
}

/**
 * 执行内置工具。非内置工具会抛错。
 */
export async function executeInternalTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const def = INTERNAL_TOOLS.find(tool => tool.name === name);
  if (!def) {
    throw new Error(`Internal tool '${name}' not found`);
  }
  logger.debug(`Executing internal tool: ${name}`, args);
  return def.handler(args);
}
