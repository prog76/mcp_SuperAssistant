// Core exports
import { McpClient } from './core/McpClient.js';
import { PluginRegistry } from './core/PluginRegistry.js';
import { EventEmitter } from './core/EventEmitter.js';

// Plugin implementations
import { SSEPlugin } from './plugins/sse/SSEPlugin.js';
import { WebSocketPlugin } from './plugins/websocket/WebSocketPlugin.js';
import { WebSocketTransport } from './plugins/websocket/WebSocketTransport.js';

// Configuration
import { DEFAULT_CLIENT_CONFIG } from './types/config.js';
import { createLogger } from '@extension/shared/lib/logger';

// Export core classes

const logger = createLogger('mcp_client');

export { McpClient, PluginRegistry, EventEmitter };

// Export plugins
export { SSEPlugin, WebSocketPlugin, WebSocketTransport };

// Export configuration
export { DEFAULT_CLIENT_CONFIG };

// Re-export types
export type {
  ITransportPlugin,
  PluginMetadata,
  PluginConfig,
  TransportType,
  ToolCallOptions,
  ToolCallProgress
} from './types/plugin.js';

export { TOOL_CALL_TIMEOUTS } from './types/plugin.js';

export type { 
  ClientConfig, 
  ConnectionRequest, 
  SSEPluginConfig, 
  WebSocketPluginConfig, 
  GlobalConfig 
} from './types/config.js';

export type { 
  Primitive, 
  NormalizedTool, 
  PrimitivesResponse, 
  ToolCallRequest, 
  ToolCallResult 
} from './types/primitives.js';

export type { AllEvents } from './types/events.js';

// Client pool for per-tab MCP sessions.
// Each McpClient owns its own transport instance, so streamable-HTTP servers
// assign a separate Mcp-Session-Id per key: one shared session under 'global'
// (used for tool/prompt listing) and one isolated session per browser tab
// ('tab-<id>'), so different chats get different server-side sessions.
const clients = new Map<string, McpClient>();

const GLOBAL_KEY = 'global';

/**
 * Get or create the client for a given session key
 */
async function getClientForKey(sessionKey: string = GLOBAL_KEY): Promise<McpClient> {
  let client = clients.get(sessionKey);
  if (!client) {
    try {
      client = new McpClient({ sessionKey });
      await client.initialize();

      // Set up global event listeners for connection status changes
      setupGlobalClientEventListeners(client);
    } catch (error) {
      logger.error(`[getClientForKey:${sessionKey}] Failed to initialize client:`, error);
      // Create a fallback client without plugin loading
      client = new McpClient({ sessionKey });
      // Don't initialize to avoid plugin loading issues
      setupGlobalClientEventListeners(client);
    }
    clients.set(sessionKey, client);
  }
  return client;
}

/**
 * Get or create the global (shared) MCP client instance
 */
async function getGlobalClient(): Promise<McpClient> {
  return getClientForKey(GLOBAL_KEY);
}

/**
 * Disconnect and drop the client for a given session key (e.g. when its tab closes)
 */
export async function disconnectMcpSession(sessionKey: string): Promise<void> {
  const client = clients.get(sessionKey);
  if (client) {
    clients.delete(sessionKey);
    if (client.isConnected()) {
      await client.disconnect().catch(error => {
        logger.error(`[disconnectMcpSession:${sessionKey}] Disconnect failed:`, error);
      });
    }
    logger.debug(`[disconnectMcpSession:${sessionKey}] Session released`);
  }
}

/**
 * Disconnect and drop every pooled client (e.g. on server config change or force reconnect)
 */
export async function resetAllMcpConnectionState(): Promise<void> {
  const entries = [...clients.entries()];
  await Promise.all(
    entries.map(async ([sessionKey, client]) => {
      clients.delete(sessionKey);
      if (client.isConnected()) {
        await client.disconnect().catch(error => {
          logger.error(`[resetAllMcpConnectionState:${sessionKey}] Disconnect failed:`, error);
        });
      }
    })
  );
  if (entries.length > 0) {
    logger.debug(`[resetAllMcpConnectionState] Released ${entries.length} session(s)`);
  }
}

/**
 * Set up event listeners on the global client to handle connection events
 */
function setupGlobalClientEventListeners(client: McpClient): void {
  // Listen for connection status changes and forward them to any registered listeners
  client.on('connection:status-changed', (event) => {
    logger.debug('[Global Client] Connection status changed:', event);
    
    // Emit a global event that can be caught by the background script
    if (typeof window !== 'undefined' && window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('mcp:connection-status-changed', { 
        detail: event 
      }));
    }
    
    // Also try to broadcast via chrome runtime if available
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'mcp:connection-status-changed',
        payload: event,
        origin: 'mcpclient'
      }).catch(() => {
        // Ignore errors if background script isn't listening
      });
    }
  });

  client.on('client:connected', (event) => {
    logger.debug('[Global Client] Client connected:', event);
  });

  client.on('client:disconnected', (event) => {
    logger.debug('[Global Client] Client disconnected:', event);
  });

  client.on('client:error', (event) => {
    logger.error('[Global Client] Client error:', event.error);
  });
}

/**
 * Create a new MCP client instance
 */
export async function createMcpClient(config?: Partial<import('./types/config.js').ClientConfig>): Promise<McpClient> {
  const client = new McpClient(config);
  await client.initialize();
  return client;
}

/**
 * Auto-detect transport type from URI
 */
function detectTransportType(uri: string): import('./types/plugin.js').TransportType {
  try {
    const url = new URL(uri);
    if (url.protocol === 'ws:' || url.protocol === 'wss:') {
      return 'websocket';
    }
    // For HTTP/HTTPS, default to SSE (traditional behavior)
    // Users can manually select streamable-http if desired
    return 'sse';
  } catch {
    return 'sse';
  }
}

// =============================================================================
// BACKWARD COMPATIBILITY API
// =============================================================================

export function isMcpServerConnected(): boolean {
  const client = clients.get(GLOBAL_KEY);
  return client ? client.isConnected() : false;
}

export async function checkMcpServerConnection(): Promise<boolean> {
  try {
    const client = await getGlobalClient();
    return await client.isHealthy();
  } catch (error) {
    logger.error('[Backward Compatibility] checkMcpServerConnection failed:', error);
    return false;
  }
}

export async function callToolWithBackwardsCompatibility(
  uri: string,
  toolName: string,
  args: { [key: string]: unknown },
  adapterName?: string,
  transportType?: import('./types/plugin.js').TransportType,
  options?: import('./types/plugin.js').ToolCallOptions,
  sessionKey: string = GLOBAL_KEY
): Promise<any> {
  const client = await getClientForKey(sessionKey);
  const type = transportType || detectTransportType(uri);

  if (!client.isConnected()) {
    await client.connect({ uri, type });
  }

  return await client.callTool(toolName, args, adapterName, options);
}

export async function getPrimitivesWithBackwardsCompatibility(
  uri: string,
  forceRefresh: boolean = false,
  transportType?: import('./types/plugin.js').TransportType,
  sessionKey: string = GLOBAL_KEY
): Promise<any[]> {
  const client = await getGlobalClient();
  const type = transportType || detectTransportType(uri);
  
  if (!client.isConnected()) {
    await client.connect({ uri, type });
  }
  
  const response = await client.getPrimitives(forceRefresh);
  
  // Convert back to old format
  const primitives: any[] = [];
  
  response.tools.forEach(tool => {
    primitives.push({ type: 'tool', value: tool });
  });
  
  response.resources.forEach(resource => {
    primitives.push({ type: 'resource', value: resource });
  });
  
  response.prompts.forEach(prompt => {
    primitives.push({ type: 'prompt', value: prompt });
  });
  
  return primitives;
}

export async function getPromptWithBackwardsCompatibility(
  uri: string,
  promptName: string,
  args?: Record<string, unknown>,
  transportType?: import('./types/plugin.js').TransportType
): Promise<unknown> {
  const client = await getGlobalClient();
  const type = transportType || detectTransportType(uri);

  if (!client.isConnected()) {
    await client.connect({ uri, type });
  }

  return await client.getPrompt(promptName, args);
}

export async function forceReconnectToMcpServer(
  uri: string,
  transportType?: import('./types/plugin.js').TransportType,
  sessionKey: string = GLOBAL_KEY
): Promise<void> {
  const client = await getClientForKey(sessionKey);
  const type = transportType || detectTransportType(uri);
  
  if (client.isConnected()) {
    await client.disconnect();
  }
  
  await client.connect({ uri, type });
}

export async function runWithBackwardsCompatibility(uri: string, transportType?: import('./types/plugin.js').TransportType): Promise<void> {
  const client = await getGlobalClient();
  const type = transportType || detectTransportType(uri);
  
  await client.connect({ uri, type });
  
  const response = await client.getPrimitives();
  logger.debug(`Connected, found ${response.tools.length} tools, ${response.resources.length} resources, ${response.prompts.length} prompts`);
}

export function resetMcpConnectionState(): void {
  const client = clients.get(GLOBAL_KEY);
  if (client && client.isConnected()) {
    client.disconnect().catch(error => {
      logger.error('[Backward Compatibility] resetMcpConnectionState failed:', error);
    });
  }
}

export function resetMcpConnectionStateForRecovery(): void {
  logger.debug('[Backward Compatibility] resetMcpConnectionStateForRecovery - handled by plugin health monitoring');
}

export function abortMcpConnection(): void {
  const client = clients.get(GLOBAL_KEY);
  if (client) {
    client.disconnect().catch(error => {
      logger.error('[Backward Compatibility] abortMcpConnection failed:', error);
    });
  }
}

// Legacy aliases
export const callToolWithSSE = callToolWithBackwardsCompatibility;
export const getPrimitivesWithSSE = getPrimitivesWithBackwardsCompatibility;
export const runWithSSE = runWithBackwardsCompatibility;

// WebSocket-specific functions
export async function connectWithWebSocket(uri: string, config?: Partial<import('./types/config.js').ClientConfig>): Promise<McpClient> {
  const client = new McpClient(config);
  await client.initialize();
  await client.connect({ uri, type: 'websocket' });
  return client;
}

export async function callToolWithWebSocket(
  uri: string,
  toolName: string,
  args: { [key: string]: unknown }
): Promise<any> {
  const client = await getGlobalClient();
  await client.connect({ uri, type: 'websocket' });
  return await client.callTool(toolName, args);
}

export async function getPrimitivesWithWebSocket(
  uri: string,
  forceRefresh: boolean = false
): Promise<any[]> {
  const client = await getGlobalClient();
  await client.connect({ uri, type: 'websocket' });
  
  const response = await client.getPrimitives(forceRefresh);
  
  const primitives: any[] = [];
  response.tools.forEach(tool => primitives.push({ type: 'tool', value: tool }));
  response.resources.forEach(resource => primitives.push({ type: 'resource', value: resource }));
  response.prompts.forEach(prompt => primitives.push({ type: 'prompt', value: prompt }));
  
  return primitives;
}

// Utility function for normalizing tools
export function normalizeToolsFromPrimitives(primitives: any[]): any[] {
  return primitives
    .filter(p => p.type === 'tool')
    .map(p => {
      const tool = p.value;
      return {
        name: tool.name,
        description: tool.description || '',
        input_schema: tool.inputSchema || tool.input_schema || {},
        schema: tool.inputSchema ? JSON.stringify(tool.inputSchema) : 
                tool.input_schema ? JSON.stringify(tool.input_schema) : '{}',
        ...(tool.uri && { uri: tool.uri }),
        ...(tool.arguments && { arguments: tool.arguments })
      };
    });
}