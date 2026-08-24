import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

export type TransportType = 'sse' | 'websocket' | 'streamable-http';

export interface PluginConfig {
  [key: string]: any;
}

/**
 * Progress notification payload forwarded from MCP `notifications/progress`.
 */
export interface ToolCallProgress {
  progress: number;
  total?: number;
  message?: string;
}

/**
 * Options for long-running tool calls.
 *
 * The MCP SDK applies a default 60s timeout per request. For long-running
 * tools, servers can emit `notifications/progress` messages which reset the
 * timer when `resetTimeoutOnProgress` is enabled, keeping the call alive as
 * long as the server keeps making progress.
 */
export interface ToolCallOptions {
  /**
   * Idle timeout (ms) between progress notifications. Defaults to
   * TOOL_CALL_TIMEOUTS.idleTimeout. Any progress event resets it.
   */
  timeout?: number;
  /** Absolute ceiling (ms) for the whole tool call. Defaults to TOOL_CALL_TIMEOUTS.maxTotalTimeout. */
  maxTotalTimeout?: number;
  /** Receives progress notifications emitted by the server (not shown to the LLM). */
  onProgress?: (progress: ToolCallProgress) => void;
}

/**
 * Default timeouts for tool calls:
 * - A call is dropped after `idleTimeout` of silence from the server...
 * - ...but any progress notification resets that idle timer,
 * - and no call may exceed `maxTotalTimeout` overall.
 */
export const TOOL_CALL_TIMEOUTS = {
  idleTimeout: 30_000,
  maxTotalTimeout: 10 * 60_000,
} as const;


export interface PluginMetadata {
  readonly name: string;
  readonly version: string;
  readonly transportType: TransportType;
  readonly description?: string;
  readonly author?: string;
}

export interface ITransportPlugin {
  readonly metadata: PluginMetadata;
  
  initialize(config: PluginConfig): Promise<void>;
  connect(uri: string): Promise<Transport>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  isSupported(uri: string): boolean;
  getDefaultConfig(): PluginConfig;
  
  // Health monitoring
  isHealthy(): Promise<boolean>;
  
  // Tool operations
  callTool(client: Client, toolName: string, args: any, options?: ToolCallOptions): Promise<any>;
  getPrimitives(client: Client): Promise<any[]>;

  // Prompt operations
  getPrompt?(client: Client, name: string, args?: Record<string, unknown>): Promise<unknown>;
}

export interface PluginEvents {
  'plugin:initialized': { plugin: ITransportPlugin };
  'plugin:connected': { plugin: ITransportPlugin; uri: string };
  'plugin:disconnected': { plugin: ITransportPlugin };
  'plugin:error': { plugin: ITransportPlugin; error: Error };
  'plugin:health-check': { plugin: ITransportPlugin; healthy: boolean };
}