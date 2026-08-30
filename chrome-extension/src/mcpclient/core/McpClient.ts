import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import { EventEmitter } from './EventEmitter.js';
import { PluginRegistry } from './PluginRegistry.js';
import { SSEPlugin } from '../plugins/sse/SSEPlugin.js';
import { WebSocketPlugin } from '../plugins/websocket/WebSocketPlugin.js';
import { StreamableHttpPlugin } from '../plugins/streamable-http/StreamableHttpPlugin.js';
import type { ClientConfig, ConnectionRequest } from '../types/config.js';
import { DEFAULT_CLIENT_CONFIG } from '../types/config.js';
import type { TransportType, ITransportPlugin, PluginConfig } from '../types/plugin.js';
import type { Primitive, NormalizedTool, PrimitivesResponse } from '../types/primitives.js';
import { getSessionId, saveSessionId, clearSessionId } from '../utils/session-store.js';
import type { AllEvents } from '../types/events.js';
import { createLogger } from '@extension/shared/lib/logger';
import { analyticsService } from '../../../utils/analytics-service.js';


const logger = createLogger('McpClient');

export class McpClient extends EventEmitter<AllEvents> {
  private registry: PluginRegistry;
  private config: ClientConfig;
  private client: Client | null = null;
  private activePlugin: ITransportPlugin | null = null;
  private activeTransport: Transport | null = null;
  private isConnectedFlag: boolean = false;
  private connectionPromise: Promise<void> | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private primitivesCache: PrimitivesResponse | null = null;
  private primitivesCacheTime: number = 0;
  private readonly CACHE_TTL = 300000; // 5 minutes
  /** Last connection request, used to reconnect when a resumed session turns out to be expired */
  private lastConnectionRequest: ConnectionRequest | null = null;
  /** True when the active transport resumed a previously stored Mcp-Session-Id */
  private resumedFromSavedSession = false;

  constructor(config: Partial<ClientConfig> = {}) {
    super();

    this.config = {
      ...DEFAULT_CLIENT_CONFIG,
      ...config,
      global: {
        ...DEFAULT_CLIENT_CONFIG.global,
        ...config.global,
      },
      plugins: {
        ...DEFAULT_CLIENT_CONFIG.plugins,
        ...config.plugins,
      },
    };

    this.registry = new PluginRegistry();

    // Forward registry events
    this.registry.on('registry:plugin-registered', data => {
      this.emit('registry:plugin-registered', data);
    });

    this.registry.on('registry:plugins-loaded', data => {
      this.emit('registry:plugins-loaded', data);
    });

    logger.debug('[McpClient] Initialized with config:', this.config);
    this.emit('client:initialized', { config: this.config });
  }

  async initialize(): Promise<void> {
    try {
      logger.debug('[McpClient] Loading default plugins...');
      await this.registry.loadDefaultPlugins();
      logger.debug('[McpClient] Initialization complete');
    } catch (error) {
      logger.error('[McpClient] Initialization failed:', error);
      logger.debug('[McpClient] Attempting manual plugin registration as fallback...');

      try {
        // Try manual registration as fallback for Service Worker environments
        await this.manualPluginRegistration();
        logger.debug('[McpClient] Manual plugin registration successful');
      } catch (fallbackError) {
        logger.error('[McpClient] Manual plugin registration also failed:', fallbackError);
        throw error; // Throw original error
      }
    }
  }

  private async manualPluginRegistration(): Promise<void> {
    // Use static imports that are available at module level
    await this.registry.register(new SSEPlugin());
    await this.registry.register(new WebSocketPlugin());
    await this.registry.register(new StreamableHttpPlugin());

    logger.debug('[McpClient] Manual plugin registration completed');
  }

  async connect(request: ConnectionRequest): Promise<void> {
    // If same connection type and already connected, skip
    if (this.isConnectedFlag && this.activePlugin?.metadata.transportType === request.type) {
      logger.debug(`Already connected via ${request.type}, skipping`);
      return;
    }

    // If there's a connection in progress, wait for it but check if it's for the same URI
    if (this.connectionPromise) {
      logger.debug('[McpClient] Connection already in progress, waiting...');
      try {
        await this.connectionPromise;
        // Check if the completed connection is what we wanted
        if (this.isConnectedFlag && this.activePlugin?.metadata.transportType === request.type) {
          logger.debug('[McpClient] Existing connection matches request');
          return;
        }
      } catch (error) {
        logger.debug('[McpClient] Previous connection failed, starting new one');
        // Clear the failed promise to allow new connection
        this.connectionPromise = null;
      }
    }

    // Disconnect from current connection if switching types
    if (this.isConnectedFlag && this.activePlugin?.metadata.transportType !== request.type) {
      logger.debug(`Switching from ${this.activePlugin?.metadata.transportType} to ${request.type}`);
      await this.disconnect();
    }

    this.connectionPromise = this.performConnection(request);

    try {
      await this.connectionPromise;
    } finally {
      this.connectionPromise = null;
    }
  }

  private async performConnection(request: ConnectionRequest): Promise<void> {
    const { uri, type, config: pluginConfig } = request;

    this.lastConnectionRequest = request;
    // Remember whether we are about to resume a stored session, so tool calls
    // can fall back to a fresh session if the server no longer has it (404).
    if (type === 'streamable-http' && this.config.sessionKey) {
      try {
        this.resumedFromSavedSession = (await getSessionId(this.config.sessionKey)) !== null;
      } catch {
        this.resumedFromSavedSession = false;
      }
    } else {
      this.resumedFromSavedSession = false;
    }

    try {
      logger.debug(`Connecting to ${uri} via ${type}`);
      this.emit('client:connecting', { uri, type });

      // Disconnect from current connection if exists
      if (this.isConnectedFlag) {
        await this.disconnect();
      }

      // Get the plugin configuration (include the session key so the
      // streamable-HTTP plugin can persist/resume the Mcp-Session-Id)
      const finalConfig = {
        ...this.config.plugins[type],
        ...pluginConfig,
        sessionKey: this.config.sessionKey,
      };

      // Get and initialize the plugin
      const plugin = await this.registry.getInitializedPlugin(type, finalConfig);

      if (!plugin.isSupported(uri)) {
        throw new Error(`Plugin ${type} does not support URI: ${uri}`);
      }

      // Get transport from plugin (plugin creates but doesn't connect)
      const transport = await plugin.connect(uri);

      // Set up disconnection callback for WebSocket plugin
      if (type === 'websocket' && 'setDisconnectionCallback' in plugin) {
        (plugin as any).setDisconnectionCallback((reason: string, code?: number, details?: string) => {
          logger.debug(`WebSocket disconnection detected: ${reason} (code: ${code})`);
          
          // Mark as disconnected immediately
          this.isConnectedFlag = false;
          
          // Emit disconnection event with details
          this.emit('connection:status-changed', {
            isConnected: false,
            type: 'websocket',
            error: `WebSocket disconnected: ${reason}${code ? ` (code: ${code})` : ''}${details ? ` - ${details}` : ''}`
          });

          // Clean up connection state
          this.cleanup().catch(error => {
            logger.error('[McpClient] Error during cleanup after WebSocket disconnection:', error);
          });
        });
      }

      // Create MCP client
      this.client = new Client(
        {
          name: `mcp-client-${type}`,
          version: '1.0.0',
        },
        { capabilities: {} },
      );

      // Set up logging notification handler
      this.client.setNotificationHandler(LoggingMessageNotificationSchema, notification => {
        logger.debug(`Server log:`, notification.params.data);
      });

      // Connect client to transport (this will start the transport)
      logger.debug(`Starting MCP client connection to transport...`);

      // Add timeout to prevent hanging
      const connectionTimeout = 30000; // 30 seconds
      const connectionPromise = this.client.connect(transport);
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`MCP client connection timeout after ${connectionTimeout}ms`));
        }, connectionTimeout);
      });

      await Promise.race([connectionPromise, timeoutPromise]);
      logger.debug(`MCP client connected successfully`);

      // Store connection state
      this.activePlugin = plugin;
      this.activeTransport = transport;
      this.isConnectedFlag = true;

      // Persist the streamable-HTTP Mcp-Session-Id so the session can be
      // resumed after a service-worker restart.
      if (type === 'streamable-http' && this.config.sessionKey) {
        const sessionId = (transport as { sessionId?: string }).sessionId;
        if (sessionId) {
          await saveSessionId(this.config.sessionKey, sessionId).catch(error => {
            logger.warn('[McpClient] Failed to persist MCP session id:', error);
          });
        }
      }

      // Clear cache on new connection
      this.clearPrimitivesCache();

      // Start health monitoring
      this.startHealthMonitoring();

      logger.debug(`Successfully connected via ${type}`);
      this.emit('client:connected', { uri, type });
      this.emit('connection:status-changed', {
        isConnected: true,
        type,
        error: undefined,
      });

      // Track successful connection
      analyticsService.trackConnectionChange({
        connection_status: 'connected',
        transport_type: type,
        tools_discovered: 0, // Will be updated after getPrimitives
      }).catch((error: unknown) => {
        logger.warn('[McpClient] Analytics tracking failed:', error);
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error(`Connection failed:`, error);

      // Clean up partial connection state
      await this.cleanup();

      this.emit('client:error', {
        error: error instanceof Error ? error : new Error(errorMessage),
        context: 'connection',
      });
      this.emit('connection:status-changed', {
        isConnected: false,
        type,
        error: errorMessage,
      });

      // Track connection failure
      analyticsService.trackConnectionChange({
        connection_status: 'error',
        transport_type: type,
        error_type: error instanceof Error ? error.name : 'UnknownError',
      }).catch((analyticsError: unknown) => {
        logger.warn('[McpClient] Analytics tracking failed:', analyticsError);
      });

      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (!this.isConnectedFlag) {
      logger.debug('[McpClient] Already disconnected');
      return;
    }

    const currentType = this.activePlugin?.metadata.transportType;
    logger.debug(`Disconnecting from ${currentType || 'unknown'}`);

    if (currentType) {
      this.emit('client:disconnecting', { type: currentType });
    }

    try {
      await this.cleanup();

      // A deliberate disconnect terminates the server-side session (the SDK
      // sends HTTP DELETE with the session id), so stop persisting it.
      if (this.config.sessionKey) {
        await clearSessionId(this.config.sessionKey).catch(error => {
          logger.warn('[McpClient] Failed to clear persisted MCP session id:', error);
        });
      }
      this.resumedFromSavedSession = false;

      logger.debug('[McpClient] Disconnected successfully');

      if (currentType) {
        this.emit('client:disconnected', { type: currentType });
      }
      this.emit('connection:status-changed', {
        isConnected: false,
        type: currentType || null,
      });
    } catch (error) {
      logger.error('[McpClient] Error during disconnect:', error);
      this.emit('client:error', {
        error: error instanceof Error ? error : new Error(String(error)),
        context: 'disconnect',
      });
    }
  }

  private async cleanup(): Promise<void> {
    // Stop health monitoring
    this.stopHealthMonitoring();

    // Close client connection
    if (this.client) {
      try {
        await this.client.close();
      } catch (error) {
        logger.warn('[McpClient] Error closing client:', error);
      }
      this.client = null;
    }

    // Disconnect plugin
    if (this.activePlugin) {
      try {
        await this.activePlugin.disconnect();
      } catch (error) {
        logger.warn('[McpClient] Error disconnecting plugin:', error);
      }
      this.activePlugin = null;
    }

    this.activeTransport = null;
    this.isConnectedFlag = false;
    this.clearPrimitivesCache();
  }

  async callTool(
    toolName: string,
    args: Record<string, any>,
    adapterName?: string,
    options?: import('../types/plugin.js').ToolCallOptions
  ): Promise<any> {
    try {
      return await this.callToolInternal(toolName, args, adapterName, options);
    } catch (error) {
      // If we resumed a stored session that the server no longer knows (it
      // replies 404 per the MCP spec), drop the stale id, reconnect with a
      // fresh initialize, and retry the tool call exactly once.
      if (this.resumedFromSavedSession && this.isSessionExpiredError(error)) {
        logger.warn(`[McpClient] Resumed MCP session was rejected (expired?). Re-initializing session...`);
        this.resumedFromSavedSession = false;
        if (this.config.sessionKey) {
          await clearSessionId(this.config.sessionKey).catch(() => {});
        }
        const request = this.lastConnectionRequest;
        if (request) {
          await this.connect(request);
          return await this.callToolInternal(toolName, args, adapterName, options);
        }
      }
      throw error;
    }
  }

  /** Detect the server rejecting our (resumed) session: HTTP 404 or an explicit session error. */
  private isSessionExpiredError(error: unknown): boolean {
    const err = error as { code?: number | string; message?: string };
    if (err?.code === 404) return true;
    const message = err?.message ?? '';
    return /404|session.*(not found|expired|invalid)|unknown session/i.test(message);
  }

  private async callToolInternal(
    toolName: string,
    args: Record<string, any>,
    adapterName?: string,
    options?: import('../types/plugin.js').ToolCallOptions
  ): Promise<any> {
    if (!this.isConnectedFlag || !this.activePlugin || !this.client) {
      throw new Error('Not connected to any MCP server');
    }

    const startTime = Date.now();
    this.emit('tool:call-started', { toolName, args });

    try {
      logger.debug(`Calling tool: ${toolName}`);
      const result = await this.activePlugin.callTool(this.client, toolName, args, options);

      const duration = Date.now() - startTime;
      this.emit('tool:call-completed', { toolName, result, duration });

      // Track tool execution analytics with enhanced context
      analyticsService.trackToolExecution({
        tool_name: toolName,
        execution_status: 'success',
        execution_duration_ms: duration,
        transport_type: this.activePlugin?.metadata.transportType || 'unknown',
        adapter_name: adapterName, // Pass adapter name from content script
      }).catch((error: unknown) => {
        // Don't fail tool execution if analytics fails
        logger.warn('[McpClient] Analytics tracking failed:', error);
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      const toolError = error instanceof Error ? error : new Error(String(error));

      this.emit('tool:call-failed', { toolName, error: toolError, duration });

      // Track failed tool execution analytics with enhanced context
      analyticsService.trackToolExecution({
        tool_name: toolName,
        execution_status: 'error',
        execution_duration_ms: duration,
        transport_type: this.activePlugin?.metadata.transportType || 'unknown',
        error_type: toolError.name || 'UnknownError',
        adapter_name: adapterName, // Pass adapter name from content script
      }).catch((analyticsError: unknown) => {
        // Don't fail tool execution if analytics fails
        logger.warn('[McpClient] Analytics tracking failed:', analyticsError);
      });

      // Check if connection is still healthy after error
      if (!(await this.isHealthy())) {
        this.isConnectedFlag = false;
        this.emit('connection:status-changed', {
          isConnected: false,
          type: this.activePlugin?.metadata.transportType || null,
          error: 'Connection lost during tool call',
        });
      }

      throw toolError;
    }
  }

  async getPrompt(name: string, args?: Record<string, unknown>): Promise<unknown> {
    if (!this.isConnectedFlag || !this.activePlugin || !this.client) {
      throw new Error('Not connected to any MCP server');
    }

    logger.debug(`[McpClient] Getting prompt: ${name}`);

    if (typeof this.activePlugin.getPrompt !== 'function') {
      throw new Error('Active transport plugin does not support prompts');
    }

    try {
      const result = await this.activePlugin.getPrompt(this.client, name, args);
      logger.debug(`[McpClient] Prompt retrieved: ${name}`);
      return result;
    } catch (error) {
      logger.error(`[McpClient] Failed to get prompt: ${name}`, error);
      throw error;
    }
  }

  async getPrimitives(forceRefresh: boolean = false): Promise<PrimitivesResponse> {
    if (!this.isConnectedFlag || !this.activePlugin || !this.client) {
      throw new Error('Not connected to any MCP server');
    }

    // Check cache first
    if (!forceRefresh && this.primitivesCache && this.isCacheValid()) {
      logger.debug('[McpClient] Returning cached primitives');
      return this.primitivesCache;
    }

    try {
      logger.debug('[McpClient] Fetching primitives from server...');
      const primitives = await this.activePlugin.getPrimitives(this.client);

      // Normalize tools
      const tools = this.normalizeTools(primitives.filter(p => p.type === 'tool') as Primitive[]);
      const resources = primitives.filter(p => p.type === 'resource').map(p => p.value);
      const prompts = primitives.filter(p => p.type === 'prompt').map(p => p.value);

      const response: PrimitivesResponse = {
        tools,
        resources,
        prompts,
        timestamp: Date.now(),
      };

      // Cache the response
      this.primitivesCache = response;
      this.primitivesCacheTime = Date.now();

      // Emit tools update event
      this.emit('tools:list-updated', {
        tools,
        type: this.activePlugin.metadata.transportType,
      });

      // Update connection tracking with tools count (only if this is the first time discovering tools)
      // This prevents duplicate connection events when tools are refreshed
      if (this.primitivesCache === null || this.primitivesCache.tools.length === 0) {
        analyticsService.trackConnectionChange({
          connection_status: 'connected',
          transport_type: this.activePlugin.metadata.transportType,
          tools_discovered: tools.length,
        }).catch((error: unknown) => {
          logger.warn('[McpClient] Analytics tracking failed:', error);
        });
      }

      logger.debug(
        `Retrieved ${tools.length} tools, ${resources.length} resources, ${prompts.length} prompts`,
      );
      return response;
    } catch (error) {
      logger.error('[McpClient] Failed to get primitives:', error);

      // Check if connection is still healthy after error
      if (!(await this.isHealthy())) {
        this.isConnectedFlag = false;
        this.emit('connection:status-changed', {
          isConnected: false,
          type: this.activePlugin?.metadata.transportType || null,
          error: 'Connection lost while getting primitives',
        });
      }

      throw error;
    }
  }

  private normalizeTools(toolPrimitives: Primitive[]): NormalizedTool[] {
    return toolPrimitives.map(p => {
      const tool = p.value;
      return {
        name: tool.name,
        description: tool.description || '',
        input_schema: tool.inputSchema || tool.input_schema || {},
        schema: tool.inputSchema
          ? JSON.stringify(tool.inputSchema)
          : tool.input_schema
            ? JSON.stringify(tool.input_schema)
            : '{}',
        ...(tool.uri && { uri: tool.uri }),
        ...(tool.arguments && { arguments: tool.arguments }),
      };
    });
  }

  private clearPrimitivesCache(): void {
    this.primitivesCache = null;
    this.primitivesCacheTime = 0;
  }

  private isCacheValid(): boolean {
    return Date.now() - this.primitivesCacheTime < this.CACHE_TTL;
  }

  async isHealthy(): Promise<boolean> {
    if (!this.isConnectedFlag || !this.activePlugin) {
      return false;
    }

    try {
      return await this.activePlugin.isHealthy();
    } catch (error) {
      logger.warn('[McpClient] Health check failed:', error);
      return false;
    }
  }

  isConnected(): boolean {
    return this.isConnectedFlag && this.activePlugin?.isConnected() === true;
  }

  getConnectionInfo(): {
    isConnected: boolean;
    type: TransportType | null;
    uri: string | null;
    pluginInfo: unknown;
  } {
    return {
      isConnected: this.isConnectedFlag,
      type: this.activePlugin?.metadata.transportType || null,
      uri: null, // Could store this if needed
      pluginInfo: this.activePlugin?.metadata || null,
    };
  }

  getAvailableTransports(): TransportType[] {
    return this.registry.listAvailable();
  }

  async switchTransport(request: ConnectionRequest): Promise<void> {
    const currentType = this.activePlugin?.metadata.transportType || null;

    if (currentType === request.type) {
      logger.debug(`Already using ${request.type}, reconnecting...`);
    } else {
      logger.debug(`Switching from ${currentType} to ${request.type}`);
      this.emit('client:plugin-switched', { from: currentType, to: request.type });
    }

    await this.connect(request);
  }

  private startHealthMonitoring(): void {
    const interval = this.config.global.healthCheckInterval;
    if (interval <= 0) return;

    this.healthCheckTimer = setInterval(async () => {
      if (!this.isConnectedFlag) {
        this.stopHealthMonitoring();
        return;
      }

      try {
        const healthy = await this.isHealthy();
        const type = this.activePlugin?.metadata.transportType || null;

        if (type) {
          this.emit('connection:health-check', {
            healthy,
            type,
            timestamp: Date.now(),
          });
        }

        if (!healthy) {
          logger.warn(`Health check failed for ${type}`);
          this.isConnectedFlag = false;
          this.emit('connection:status-changed', {
            isConnected: false,
            type,
            error: 'Health check failed',
          });
        }
      } catch (error) {
        logger.error('[McpClient] Health check error:', error);
      }
    }, interval);
  }

  private stopHealthMonitoring(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  getConfig(): ClientConfig {
    return { ...this.config };
  }

  updateConfig(newConfig: Partial<ClientConfig>): void {
    this.config = {
      ...this.config,
      ...newConfig,
      global: {
        ...this.config.global,
        ...newConfig.global,
      },
      plugins: {
        ...this.config.plugins,
        ...newConfig.plugins,
      },
    };

    logger.debug('[McpClient] Configuration updated');
  }
}
