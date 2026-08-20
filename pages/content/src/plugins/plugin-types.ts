import type { DetectedTool } from '../types/stores';
export type { DetectedTool };
// EventMap, EventCallback, UnsubscribeFunction will be imported from '../../events/index.ts'
// which exports them from '../../events/event-types.ts'
import type { EventMap, TypedEventCallback, UnsubscribeFunction } from '../events';

// Interface for the EventBus that will be part of PluginContext
// This defines the contract the plugin expects from an event bus.
export interface PluginEventBus {
  emit<K extends keyof EventMap>(event: K, data: EventMap[K]): void;
  on<K extends keyof EventMap>(event: K, callback: TypedEventCallback<K>): UnsubscribeFunction;
  once<K extends keyof EventMap>(event: K, callback: TypedEventCallback<K>): UnsubscribeFunction;
  off<K extends keyof EventMap>(event: K, callback: TypedEventCallback<K>): void;
  getListenerCount?(event: keyof EventMap): number; // Optional: for debugging or advanced use
  removeAllListeners?(event?: keyof EventMap): void; // Optional: for cleanup
}

export type AdapterCapability =
  | 'text-insertion'
  | 'form-submission'
  | 'file-attachment'
  | 'url-navigation'
  | 'element-selection'
  | 'screenshot-capture'
  | 'dom-manipulation'
  | 'conversation-read'      // 读取当前会话全文（上下文压缩/多智能体）
  | 'conversation-create';   // 新建会话

export type PluginType =
  | 'sidebar'
  | 'website-adapter'
  | 'core-ui'
  | 'extension';

export interface PluginContext {
  eventBus: PluginEventBus; // Use the defined PluginEventBus interface
  stores: {
    // These 'any' types are placeholders as per original spec.
    // In a fully typed system, these would be specific store instances or slices.
    app: any;
    connection: any;
    tool: any;
    ui: any;
    adapter: any;
    config: any; // Added config store
  };
  utils: PluginUtils;
  chrome: {
    runtime: typeof chrome.runtime;
    storage: typeof chrome.storage;
    tabs?: typeof chrome.tabs;
  };
  logger: {
    debug: (...args: any[]) => void;
    info: (...args: any[]) => void;
    warn: (...args: any[]) => void;
    error: (...args: any[]) => void;
  };
  // Add a way to get the plugin's own configuration
  getConfig?: <T extends Record<string, any>>() => T | undefined;
  cleanupFunctions?: (() => void)[]; // Added for plugin cleanup management
}

export interface PluginUtils {
  createElement: <K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, any>, children?: (Node | string)[]) => HTMLElementTagNameMap[K];
  waitForElement: (selector: string, timeout?: number, root?: Document | Element) => Promise<HTMLElement | null>;
  injectCSS: (css: string, id?: string) => HTMLStyleElement;
  observeChanges: (targetNode: Node, callback: MutationCallback, options: MutationObserverInit) => MutationObserver;
  debounce: <T extends (...args: any[]) => any>(func: T, delay: number) => T;
  throttle: <T extends (...args: any[]) => any>(func: T, delay: number) => T;
  getUniqueId: (prefix?: string) => string;
}

/**
 * 会话中的一条消息（纯文本，HTML 已剥离）。
 * 用于上下文压缩的 readConversation / 多智能体的 readLastResponse。
 */
export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;           // 纯文本（HTML 已剥离，代码块保留 markdown 围栏）
  timestamp?: number;
  messageId?: string;        // 平台原生消息 id，用于去重/续读
}

/**
 * AI 回复载荷（多模态：文本 + 代码块 + 文件链接）。
 */
export interface ResponsePayload {
  text: string;
  codeBlocks?: { lang: string; code: string }[];
  fileLinks?: string[];
  rawHtml?: string;
}

export interface AdapterPlugin {
  readonly name: string;
  readonly version: string;
  readonly type?: PluginType; // Made optional for backward compatibility
  readonly hostnames: (string | RegExp)[];
  readonly capabilities: AdapterCapability[];

  // Lifecycle methods
  initialize(context: PluginContext): Promise<void>;
  activate(): Promise<void>;
  deactivate(): Promise<void>;
  cleanup(): Promise<void>;

  // Core functionality
  insertText?(text: string, options?: { targetElement?: HTMLElement }): Promise<boolean>;
  submitForm?(options?: { formElement?: HTMLFormElement }): Promise<boolean>;
  attachFile?(file: File, options?: { inputElement?: HTMLInputElement }): Promise<boolean>;
  isSubmitButtonEnabled?(): Promise<boolean>;

  // Optional capabilities
  captureScreenshot?(): Promise<string>;
  selectElement?(selector: string): Promise<HTMLElement | null>;
  navigateToUrl?(url: string): Promise<boolean>;
  executeScript?<T>(script: string | (() => T)): Promise<T | null>;

  // Conversation capabilities (上下文压缩 / 多智能体协作)
  readConversation?(): Promise<ConversationMessage[] | null>;
  newConversation?(): Promise<boolean>;
  readLastResponse?(): Promise<ResponsePayload | null>;
  waitForResponse?(timeoutMs: number): Promise<boolean>;

  // 会话模式：读取/恢复当前平台会话模式（如 DeepSeek 快速/专家/识图）
  getConversationMode?(): Promise<string | null>;
  setConversationMode?(mode: string): Promise<boolean>;

  // Utility methods
  isSupported(): boolean | Promise<boolean>;
  getStatus(): 'active' | 'inactive' | 'error' | 'initializing' | 'disabled' | 'pending';

  // Event handlers
  onToolDetected?(tools: DetectedTool[]): void;
  onPageChanged?(url: string, oldUrl?: string): void;
  onHostChanged?(newHost: string, oldHost?: string): void;
}

export interface AdapterConfig {
  id: string; // Unique identifier for the adapter configuration
  name: string; // Display name for the adapter configuration
  description: string; // Description of the adapter
  version: string; // Version of the adapter configuration or the adapter it's for
  enabled: boolean;
  priority: number;
  settings?: Record<string, any>;
  customSelectors?: Record<string, string>;
  features?: Partial<Record<AdapterCapability, boolean>>;
}

export interface PluginRegistration {
  plugin: AdapterPlugin;
  config: AdapterConfig;
  readonly registeredAt: number;
  lastUsedAt?: number;
  instance?: AdapterPlugin; // Stores the initialized instance
  status?: 'registered' | 'initialized' | 'active' | 'inactive' | 'error' | 'disabled' | 'pending_activation';
  error?: string | Error | null;
}
