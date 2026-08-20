import { BaseAdapterPlugin } from './base.adapter';
import type { AdapterCapability, PluginContext, ConversationMessage, ResponsePayload } from '../plugin-types';
import { createLogger } from '@extension/shared/lib/logger';

/**
 * DeepSeek Adapter for DeepSeek Chat (chat.deepseek.com)
 *
 * This adapter provides specialized functionality for interacting with DeepSeek's
 * chat interface, including text insertion, form submission, and file attachment capabilities.
 *
 * Migrated from the legacy adapter system to the new plugin architecture.
 * Maintains compatibility with existing functionality while integrating with Zustand stores.
 */

const logger = createLogger('DeepSeekAdapter');

export class DeepSeekAdapter extends BaseAdapterPlugin {
  readonly name = 'DeepSeekAdapter';
  readonly version = '2.0.0'; // Incremented for new architecture
  readonly hostnames = ['chat.deepseek.com'];
  readonly capabilities: AdapterCapability[] = [
    'text-insertion',
    'form-submission',
    'file-attachment',
    'dom-manipulation',
    'conversation-read',
    'conversation-create'
  ];

  // CSS selectors for DeepSeek's UI elements
  // Updated selectors based on current DeepSeek interface (chat.deepseek.com)
  private readonly selectors = {
    // Primary chat input selector - includes Chinese-locale placeholders (jcleng fix)
    CHAT_INPUT: 'textarea[name="search"], textarea[placeholder*="给 DeepSeek 发送消息"], textarea[placeholder*="Message DeepSeek"], textarea.ds-scroll-area, textarea:not([type="hidden"])',
    // Submit button selectors (multiple fallbacks), from hqzqaq/huquanzhi_a fork (b0c7856).
    // NOTE: DeepSeek's send button is a div[role="button"] with NO aria-label,
    // identified by the ds- design-system circular button classes inside the
    // input area (.bf38813a = right-side button group of the input toolbar).
    SUBMIT_BUTTON: '.bf38813a div[role="button"].ds-button--circle, .ec4f5d61 div[role="button"].ds-button--circle, div[role="button"].ds-button--circle, button[aria-label*="Send"], button[data-testid="send-button"], button.send-button',
    // File upload related selectors
    FILE_UPLOAD_BUTTON: 'button[aria-label*="attach"], button[aria-label*="file"], input[type="file"]',
    FILE_INPUT: 'input[type="file"]',
    // Main panel and container selectors
    MAIN_PANEL: '.chat-container, .main-content, .conversation-container, .chat-interface',
    // Drop zones for file attachment
    DROP_ZONE: '.chat-input-container, .input-area, .message-input, .chat-input, .file-drop-area',
    // File preview elements
    FILE_PREVIEW: '.file-preview, .attachment-preview, .uploaded-file',
    // Button insertion points (for MCP popover) - DeepSeek specific
    BUTTON_INSERTION_CONTAINER: '.ec4f5d61, .chat-input-actions, .input-actions, .actions-wrapper',
    // Alternative insertion points
    FALLBACK_INSERTION: '.input-area, .chat-input-container, ._24fad49, .bf38813a, .aaff8b8f',
    // Conversation reading selectors.
    // NOTE: reuses the battle-tested selectors from render_prescript/src/core/config.ts
    // (user message div._9663006 / assistant .ds-markdown.ds-assistant-message-main-content /
    // thinking .ds-think-content). data-message-author-role is a ChatGPT attribute, NOT DeepSeek.
    MESSAGE_USER: 'div._9663006',
    MESSAGE_ASSISTANT: '.ds-markdown.ds-assistant-message-main-content',
    MESSAGE_THINKING: '.ds-think-content',
    // New chat button (SPA click preferred over full page navigation)
    NEW_CHAT_BUTTON: 'button[aria-label*="New chat" i], button[aria-label*="新建" i], [data-testid="new-chat-button"]',
    // Mode toggle chips。实测（2026-08）：
    // - 新建会话页：div[role=radio][data-model-type]（default=快速 / expert=专家 / vision=识图），aria-checked 标记激活
    // - 会话内：标题栏徽章 span 文本「专家模式/快速模式/识图模式」
    MODE_TOGGLE: 'button, [role="button"], [role="radio"], [class*="toggle"]'
  };

  // URL patterns for navigation tracking
  private lastUrl: string = '';
  private urlCheckInterval: NodeJS.Timeout | null = null;

  // State management integration
  private mcpPopoverContainer: HTMLElement | null = null;
  private mutationObserver: MutationObserver | null = null;
  private popoverCheckInterval: NodeJS.Timeout | null = null;

  // DeepSeek-specific button styling to match native design system
  private readonly deepseekButtonStyles = `
    /* DeepSeek MCP Button Styling - matches native ds-atom-button */
    .mcp-ds-button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      position: relative;
      padding: 0 12px;
      height: 34px;
      border-radius: 17px;
      background-color: var(--dsw-alias-bg-secondary, #f5f5f5);
      border: 1px solid transparent;
      cursor: pointer;
      transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
      font-family: inherit;
      font-size: 14px;
      font-weight: 500;
      color: var(--dsw-alias-label-primary, #0f1115);
      white-space: nowrap;
      user-select: none;
      -webkit-user-select: none;
      outline: none;
      box-sizing: border-box;
      vertical-align: middle;
      margin-left: 8px;
    }

    .mcp-ds-button:hover {
      background-color: var(--dsw-alias-bg-tertiary, #e8e8e8);
      transform: translateY(-1px);
    }

    .mcp-ds-button:active {
      transform: translateY(0);
      background-color: var(--dsw-alias-bg-quaternary, #d8d8d8);
    }

    .mcp-ds-button:focus-visible {
      outline: 2px solid var(--dsw-alias-border-focus, #4a9eff);
      outline-offset: 2px;
    }

    .mcp-ds-button.mcp-button-active {
      background-color: var(--dsw-alias-bg-brand-secondary, #e8f0fe);
      color: var(--dsw-alias-label-brand, #1a73e8);
      border-color: var(--dsw-alias-border-brand, #1a73e8);
    }

    .mcp-ds-button.mcp-button-active:hover {
      background-color: var(--dsw-alias-bg-brand-tertiary, #d2e3fc);
    }

    .mcp-ds-button-content {
      display: inline-flex;
      align-items: center;
      gap: 6px;
    }

    .mcp-ds-button-icon {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      flex-shrink: 0;
    }

    .mcp-ds-button-text {
      font-size: 14px;
      font-weight: 500;
      line-height: 1;
    }

    /* Dark mode support */
    @media (prefers-color-scheme: dark) {
      .mcp-ds-button {
        background-color: var(--dsw-alias-bg-secondary-dark, #2a2a2a);
        color: var(--dsw-alias-label-primary-dark, #e8eaed);
      }

      .mcp-ds-button:hover {
        background-color: var(--dsw-alias-bg-tertiary-dark, #3a3a3a);
      }

      .mcp-ds-button:active {
        background-color: var(--dsw-alias-bg-quaternary-dark, #4a4a4a);
      }

      .mcp-ds-button.mcp-button-active {
        background-color: var(--dsw-alias-bg-brand-secondary-dark, #1a3a5a);
        color: var(--dsw-alias-label-brand-dark, #8ab4f8);
        border-color: var(--dsw-alias-border-brand-dark, #8ab4f8);
      }

      .mcp-ds-button.mcp-button-active:hover {
        background-color: var(--dsw-alias-bg-brand-tertiary-dark, #2a4a6a);
      }
    }
  `;

  // Setup state tracking
  private storeEventListenersSetup: boolean = false;
  private domObserversSetup: boolean = false;
  private uiIntegrationSetup: boolean = false;

  // Instance tracking for debugging
  private static instanceCount = 0;
  private instanceId: number;

  constructor() {
    super();
    DeepSeekAdapter.instanceCount++;
    this.instanceId = DeepSeekAdapter.instanceCount;
    logger.debug(`Instance #${this.instanceId} created. Total instances: ${DeepSeekAdapter.instanceCount}`);
  }

  async initialize(context: PluginContext): Promise<void> {
    // Guard against multiple initialization
    if (this.currentStatus === 'initializing' || this.currentStatus === 'active') {
      this.context?.logger.warn(`DeepSeek adapter instance #${this.instanceId} already initialized or active, skipping re-initialization`);
      return;
    }

    await super.initialize(context);
    this.context.logger.debug(`Initializing DeepSeek adapter instance #${this.instanceId}...`);

    // Initialize URL tracking
    this.lastUrl = window.location.href;
    this.setupUrlTracking();

    // Set up event listeners for the new architecture
    this.setupStoreEventListeners();
  }

  async activate(): Promise<void> {
    // Guard against multiple activation
    if (this.currentStatus === 'active') {
      this.context?.logger.warn(`DeepSeek adapter instance #${this.instanceId} already active, skipping re-activation`);
      return;
    }

    await super.activate();
    this.context.logger.debug(`Activating DeepSeek adapter instance #${this.instanceId}...`);

    // Set up DOM observers and UI integration
    this.setupDOMObservers();
    this.setupUIIntegration();

    // Emit activation event for store synchronization
    this.context.eventBus.emit('adapter:activated', {
      pluginName: this.name,
      timestamp: Date.now()
    });
  }

  async deactivate(): Promise<void> {
    // Guard against double deactivation
    if (this.currentStatus === 'inactive' || this.currentStatus === 'disabled') {
      this.context?.logger.warn('DeepSeek adapter already inactive, skipping deactivation');
      return;
    }

    await super.deactivate();
    this.context.logger.debug('Deactivating DeepSeek adapter...');

    // Clean up UI integration
    this.cleanupUIIntegration();
    this.cleanupDOMObservers();

    // Reset setup flags
    this.storeEventListenersSetup = false;
    this.domObserversSetup = false;
    this.uiIntegrationSetup = false;

    // Emit deactivation event
    this.context.eventBus.emit('adapter:deactivated', {
      pluginName: this.name,
      timestamp: Date.now()
    });
  }

  async cleanup(): Promise<void> {
    await super.cleanup();
    this.context.logger.debug('Cleaning up DeepSeek adapter...');

    // Clear URL tracking interval
    if (this.urlCheckInterval) {
      clearInterval(this.urlCheckInterval);
      this.urlCheckInterval = null;
    }

    // Clear popover check interval
    if (this.popoverCheckInterval) {
      clearInterval(this.popoverCheckInterval);
      this.popoverCheckInterval = null;
    }

    // Final cleanup
    this.cleanupUIIntegration();
    this.cleanupDOMObservers();

    // Reset all setup flags
    this.storeEventListenersSetup = false;
    this.domObserversSetup = false;
    this.uiIntegrationSetup = false;
  }

  /**
   * Get the chat input element using the configured selectors
   */
  private getInputElement(): HTMLElement | null {
    const selectors = this.selectors.CHAT_INPUT.split(', ');
    for (const selector of selectors) {
      const element = document.querySelector(selector.trim()) as HTMLElement;
      if (element) {
        this.context.logger.debug(`Found chat input using selector: ${selector.trim()}`);
        return element;
      }
    }
    this.context.logger.warn('Could not find chat input element with any selector');
    return null;
  }

  /**
   * Insert text into the DeepSeek chat input field
   * Enhanced with better selector handling and event integration
   */
  async insertText(text: string, options?: { targetElement?: HTMLElement }): Promise<boolean> {
    this.context.logger.debug(`Attempting to insert text into DeepSeek chat input: ${text.substring(0, 50)}${text.length > 50 ? '...' : ''}`);

    let targetElement: HTMLElement | null = null;

    if (options?.targetElement) {
      targetElement = options.targetElement;
    } else {
      // Try multiple selectors for better compatibility
      const selectors = this.selectors.CHAT_INPUT.split(', ');
      for (const selector of selectors) {
        targetElement = document.querySelector(selector.trim()) as HTMLElement;
        if (targetElement) {
          this.context.logger.debug(`Found chat input using selector: ${selector.trim()}`);
          break;
        }
      }
    }

    if (!targetElement) {
      this.context.logger.error('Could not find DeepSeek chat input element');
      this.emitExecutionFailed('insertText', 'Chat input element not found');
      return false;
    }

    try {
      // Focus the input element
      targetElement.focus();

      // Handle different input types
      if (targetElement.tagName === 'TEXTAREA') {
        const textarea = targetElement as HTMLTextAreaElement;
        const currentText = textarea.value;

        // Append the text to the original value on a new line if there's existing content
        const newContent = currentText ? currentText + '\n\n' + text : text;
        textarea.value = newContent;

        // Position cursor at the end
        textarea.selectionStart = textarea.selectionEnd = textarea.value.length;

        // Trigger input event
        textarea.dispatchEvent(new InputEvent('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));

        this.context.logger.debug(`Text inserted into textarea successfully. Original: ${currentText.length}, Added: ${text.length}, Total: ${newContent.length}`);
      } else if (targetElement.getAttribute('contenteditable') === 'true') {
        // Handle contenteditable div
        const currentText = targetElement.textContent || '';

        // Move cursor to the end
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(targetElement);
        range.collapse(false);
        selection?.removeAllRanges();
        selection?.addRange(range);

        // Insert text with proper formatting
        if (currentText && currentText.trim() !== '') {
          document.execCommand('insertText', false, '\n\n');
        }
        document.execCommand('insertText', false, text);

        // Trigger input event for contenteditable
        targetElement.dispatchEvent(new InputEvent('input', { bubbles: true }));
        targetElement.dispatchEvent(new Event('change', { bubbles: true }));

        this.context.logger.debug(`Text inserted into contenteditable successfully`);
      } else {
        // Fallback for other element types
        const originalValue = (targetElement as any).value || targetElement.textContent || '';
        const newContent = originalValue ? originalValue + '\n\n' + text : text;

        if ('value' in targetElement) {
          (targetElement as any).value = newContent;
        } else {
          targetElement.textContent = newContent;
        }

        // Dispatch events
        targetElement.dispatchEvent(new InputEvent('input', { bubbles: true }));
        targetElement.dispatchEvent(new Event('change', { bubbles: true }));

        this.context.logger.debug(`Text inserted using fallback method`);
      }

      // Emit success event to the new event system
      this.emitExecutionCompleted('insertText', { text }, {
        success: true,
        targetElementType: targetElement.tagName,
        insertedLength: text.length
      });

      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.context.logger.error(`Error inserting text into DeepSeek chat input: ${errorMessage}`);
      this.emitExecutionFailed('insertText', errorMessage);
      return false;
    }
  }

  /**
   * Check if the send button is ready (arrow icon) vs still generating (box icon)
   * DeepSeek's send button icon changes shape:
   * - Arrow path (ready to send): starts with "M8.3125" or contains "L14.707" or "V15.0431"
   * - Box path (generating): different path shape
   */
  async isSubmitButtonEnabled(): Promise<boolean> {
    const fileInput = document.querySelector(this.selectors.SUBMIT_BUTTON) as HTMLInputElement;
    if (!fileInput) return false;

    const sendButton = fileInput.nextElementSibling as HTMLElement | null;
    if (!sendButton) return false;

    // Check if button is disabled
    if (sendButton.hasAttribute('disabled') ||
        (sendButton as HTMLButtonElement).disabled === true ||
        sendButton.getAttribute('aria-disabled') === 'true') {
      return false;
    }

    // Check SVG path to determine if it's arrow (ready) or box (generating)
    const svgPath = sendButton.querySelector('svg path');
    if (!svgPath) return false;

    const d = svgPath.getAttribute('d') || '';
    // Arrow icon = ready to send. Box icon = still generating.
    const isArrow = /^M8\.3125/.test(d) || /L14\.707|V15\.0431/.test(d);
    return isArrow;
  }

  /**
   * Submit the current text in the DeepSeek chat input
   * Uses KeyboardEvent on the chat input as the primary submit method
   */
  async submitForm(options?: { formElement?: HTMLFormElement }): Promise<boolean> {
    this.context.logger.debug('Attempting to submit DeepSeek chat input');

    const submitButton = this.findSubmitButton();

    if (!submitButton) {
      this.context.logger.warn('Could not find DeepSeek submit button, trying Enter key press');
      return this.tryEnterKeySubmission();
    }

    try {
      // Check if the button is disabled.
      // div[role="button"] elements expose the disabled state via the
      // ds-button--disabled class instead of the `disabled` property.
      const isDisabled =
        (submitButton as HTMLButtonElement).disabled === true ||
        submitButton.classList.contains('ds-button--disabled');
      if (isDisabled) {
        this.context.logger.warn('DeepSeek submit button is disabled');
        this.emitExecutionFailed('submitForm', 'Submit button is disabled');
        return false;
      }

      // Never click while the model is still generating: the same circular
      // button doubles as the "stop generation" control, and clicking it
      // would abort the in-flight response.
      if (this.isStopButton(submitButton)) {
        this.context.logger.warn('DeepSeek action button is currently the stop button (generation in progress), refusing to click');
        this.emitExecutionFailed('submitForm', 'Generation in progress - refusing to click stop button');
        return false;
      }

      // Check if the button is visible and clickable
      const rect = submitButton.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        this.context.logger.warn('DeepSeek submit button is not visible');
        this.emitExecutionFailed('submitForm', 'Submit button is not visible');
        return false;
      }

      // Click the submit button to send the message
      submitButton.click();

      // Emit success event to the new event system
      this.emitExecutionCompleted('submitForm', {
        formElement: options?.formElement?.tagName || 'unknown'
      }, {
        success: true,
        method: 'submitButton.click',
        buttonSelector: submitButton.className
      });

      this.context.logger.debug('DeepSeek chat input submitted successfully');
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.context.logger.error(`Error submitting DeepSeek chat input: ${errorMessage}`);
      this.emitExecutionFailed('submitForm', errorMessage);
      return false;
    }
  }

  /**
   * Detect whether the circular action button is currently in "stop
   * generation" mode.
   *
   * While the assistant is streaming, DeepSeek swaps the send arrow for a
   * filled square (stop icon). The square icon's SVG path is a single
   * subpath starting with "M2 4.88" - this is a heuristic and may need
   * updating if DeepSeek changes its icon set.
   */
  private isStopButton(button: HTMLElement): boolean {
    try {
      const svgPath = button.querySelector('svg path');
      const d = svgPath?.getAttribute('d')?.trim() || '';
      return d.startsWith('M2 4.88');
    } catch {
      return false;
    }
  }

  /**
   * Try to submit using Enter key press as fallback
   */
  private async tryEnterKeySubmission(): Promise<boolean> {
    try {
      // Find the chat input element
      const chatInput = document.querySelector(this.selectors.CHAT_INPUT.split(', ')[0].trim()) as HTMLElement;
      
      if (!chatInput) {
        this.context.logger.error('Cannot find chat input for Enter key submission');
        this.emitExecutionFailed('submitForm', 'Chat input not found for Enter key submission');
        return false;
      }

      // Create and dispatch Enter key event
      const enterKeyEvent = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      });

      chatInput.focus();
      chatInput.dispatchEvent(enterKeyEvent);

      // Emit success event
      this.emitExecutionCompleted('submitForm', {}, {
        success: true,
        method: 'enterKey',
        fallback: true
      });

      this.context.logger.debug('DeepSeek chat input submitted using Enter key');
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.context.logger.error(`Error submitting DeepSeek chat input via Enter key: ${errorMessage}`);
      this.emitExecutionFailed('submitForm', errorMessage);
      return false;
    }
  }

  /**
   * Find the submit button using multiple selector fallbacks.
   * Shared by submitForm and waitForResponse.
   */
  private findSubmitButton(): HTMLElement | null {
    const selectors = this.selectors.SUBMIT_BUTTON.split(', ');
    for (const selector of selectors) {
      const button = document.querySelector(selector.trim()) as HTMLElement | null;
      if (button) {
        this.context.logger.debug(`Found submit button using selector: ${selector.trim()}`);
        return button;
      }
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Conversation capabilities (上下文压缩 / 多智能体协作)
  // ---------------------------------------------------------------------

  /**
   * Extract message text from a DOM node, best-effort HTML → plain text:
   * - code blocks (`pre`) are preserved as fenced markdown (```lang)
   * - block-level elements become newlines
   * - rendered markdown is NOT reverse-parsed to source markdown (lossy by design)
   */
  private extractConversationText(element: HTMLElement): string {
    const BLOCK_TAGS = new Set([
      'P', 'DIV', 'BR', 'LI', 'PRE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'UL', 'OL', 'TABLE', 'HR', 'BLOCKQUOTE'
    ]);
    const parts: string[] = [];

    const walk = (node: Node, depth: number): void => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent ?? '');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = (node as HTMLElement).tagName;
      if (tag === 'PRE') {
        const langEl = (node as HTMLElement).querySelector('code[class*="language-"]');
        const lang = langEl?.className.match(/language-(\w+)/)?.[1] ?? '';
        const code = ((node as HTMLElement).innerText || (node as HTMLElement).textContent || '').trim();
        parts.push(`\`\`\`${lang}\n${code}\n\`\`\``);
        return;
      }
      if (tag === 'BR') {
        parts.push('\n');
        return;
      }
      for (const child of Array.from(node.childNodes)) {
        walk(child, depth + 1);
      }
      if (BLOCK_TAGS.has(tag) && depth > 0) {
        parts.push('\n');
      }
    };

    walk(element, 0);
    return parts
      .join('')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  /**
   * Read the whole conversation (user + assistant messages) in document order.
   * Reuses the verified DeepSeek selectors from render_prescript config.
   */
  async readConversation(): Promise<ConversationMessage[] | null> {
    this.context.logger.debug('Reading DeepSeek conversation');

    const userEls = Array.from(document.querySelectorAll<HTMLElement>(this.selectors.MESSAGE_USER));
    const assistantEls = Array.from(document.querySelectorAll<HTMLElement>(this.selectors.MESSAGE_ASSISTANT));

    if (userEls.length === 0 && assistantEls.length === 0) {
      this.context.logger.warn('No conversation messages found on DeepSeek page');
      return null;
    }

    // Merge in document order and skip nested duplicates
    const messages: ConversationMessage[] = [];
    const collected: Element[] = [];

    const all = document.querySelectorAll(`${this.selectors.MESSAGE_USER}, ${this.selectors.MESSAGE_ASSISTANT}`);
    all.forEach(el => {
      if (collected.some(anc => anc.contains(el))) return; // nested duplicate
      collected.push(el);
      const isUser = el.matches(this.selectors.MESSAGE_USER);
      messages.push({
        role: isUser ? 'user' : 'assistant',
        content: this.extractConversationText(el as HTMLElement),
        timestamp: Date.now()
      });
    });

    if (messages.length === 0) {
      this.context.logger.warn('DeepSeek conversation parsed to zero messages');
      return null;
    }

    this.context.logger.debug(`Read ${messages.length} messages from DeepSeek conversation`);
    return messages;
  }

  /**
   * Start a new conversation.
   * 优先点击“新建对话”按钮（SPA 无刷新）；找不到时兜底派发 Ctrl+J 快捷键
   * （DeepSeek 支持 Ctrl+J 新建会话）。不做整页导航，避免 content script 中断。
   */
  async newConversation(): Promise<boolean> {
    this.context.logger.debug('Attempting to start a new DeepSeek conversation');

    // 1. 点击“新建对话”按钮
    const newChat = this.findNewChatButton();
    if (newChat) {
      newChat.click();
      this.context.logger.debug('Clicked DeepSeek new chat button');
      await this.sleep(600);
      if (this.isFreshConversation()) return true;
      this.context.logger.warn('New chat button click did not reset the conversation, trying Ctrl+J');
    }

    // 2. 兜底：派发 Ctrl+J 快捷键
    this.dispatchNewChatShortcut();
    await this.sleep(600);
    if (this.isFreshConversation()) return true;

    this.context.logger.warn('Failed to start a new DeepSeek conversation');
    return false;
  }

  /**
   * 判断当前是否为新会话（消息区无用户消息即视为新会话）。
   * 用于校验 newConversation 是否真的重置了会话，避免把续接消息注入旧会话。
   */
  private isFreshConversation(): boolean {
    try {
      return document.querySelectorAll(this.selectors.MESSAGE_USER).length === 0;
    } catch {
      return false;
    }
  }

  /**
   * 查找“新建对话”按钮：先按文本（新建对话/New chat），再按加号图标启发式匹配。
   */
  private findNewChatButton(): HTMLElement | null {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, a, [role="button"]'));

    // 文本匹配（实测 DeepSeek 会话页按钮文案为「开启新对话」，新建页为「新建对话」）
    const byText = candidates.find(el => {
      const t = (el.textContent ?? '').trim();
      return (
        t === '新建对话' ||
        t === '开启新对话' ||
        t === 'New chat' ||
        t.startsWith('新建对话') ||
        t.startsWith('开启新对话') ||
        t.startsWith('New chat')
      );
    });
    if (byText) return byText;

    // 加号图标匹配（heroicons/lucide 风格 plus path）
    const plusPattern = /M1[24]\s*[45]v1[46]|M1[24]\s*[45]h1[46]/;
    const byIcon = candidates.find(el => {
      const d = (el.querySelector('svg path')?.getAttribute('d') ?? '').replace(/\s+/g, '');
      return plusPattern.test(d);
    });
    return byIcon ?? null;
  }

  /**
   * 派发 Ctrl+J 新建会话快捷键。
   */
  private dispatchNewChatShortcut(): void {
    try {
      const input = document.querySelector<HTMLElement>(this.selectors.CHAT_INPUT.split(', ')[0].trim());
      const target = input ?? document.body;
      target.focus();
      const event = new KeyboardEvent('keydown', {
        key: 'j',
        code: 'KeyJ',
        keyCode: 74,
        which: 74,
        ctrlKey: true,
        metaKey: false,
        bubbles: true,
        cancelable: true,
      });
      target.dispatchEvent(event);
    } catch (error) {
      this.context.logger.error('Error dispatching Ctrl+J shortcut:', error);
    }
  }

  /**
   * 读取当前会话模式（快速 fast / 专家 expert / 识图 visual）。未检测到返回 null。
   *
   * 实测（2026-08）：
   * - 会话内：标题栏徽章 span 文本「专家模式/快速模式/识图模式」
   * - 新建会话页：div[role=radio][data-model-type] + aria-checked="true"
   */
  async getConversationMode(): Promise<string | null> {
    // 1. 会话内徽章
    const badge = this.findModeBadge();
    if (badge) {
      this.context.logger.debug(`DeepSeek conversation mode (badge): ${badge}`);
      return badge;
    }

    // 2. 新建页 radio
    const activeRadio = this.findModeRadios().find(t => t.isActive);
    if (activeRadio) {
      this.context.logger.debug(`DeepSeek conversation mode (radio): ${activeRadio.mode}`);
      return activeRadio.mode;
    }

    // 3. 文本启发式兜底
    const activeToggle = this.findModeToggles().find(t => t.isActive);
    if (activeToggle) {
      this.context.logger.debug(`DeepSeek conversation mode (toggle): ${activeToggle.mode}`);
      return activeToggle.mode;
    }

    this.context.logger.debug('No DeepSeek mode indicator found');
    return null;
  }

  /**
   * 恢复指定会话模式（新会话应与旧会话保持一致）。
   * 优先点击新建页 radio（data-model-type），失败时文本匹配兜底。
   */
  async setConversationMode(mode: string): Promise<boolean> {
    // 1. 新建页 radio（default/expert/vision）
    const targetRadio = this.findModeRadios().find(t => t.mode === mode);
    if (targetRadio) {
      if (targetRadio.isActive) return true;
      targetRadio.element.click();
      this.context.logger.debug(`Clicked DeepSeek mode radio: ${mode}`);
      await this.sleep(300);
      return true;
    }

    // 2. 文本匹配兜底
    const targetToggle = this.findModeToggles().find(t => t.mode === mode);
    if (targetToggle) {
      if (targetToggle.isActive) return true;
      targetToggle.element.click();
      this.context.logger.debug(`Clicked DeepSeek mode toggle: ${mode}`);
      await this.sleep(300);
      return true;
    }

    this.context.logger.warn(`DeepSeek mode '${mode}' toggle not found`);
    return false;
  }

  /**
   * 会话内模式徽章识别：标题栏 span 文本「专家模式/快速模式/识图模式」。
   */
  private findModeBadge(): string | null {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>('span, div, a'));
    for (const el of candidates) {
      const t = (el.textContent ?? '').trim();
      if (!t || t.length > 8) continue;
      if (t === '专家模式' || t === '专家') return 'expert';
      if (t === '识图模式' || t === '识图') return 'visual';
      if (t === '快速模式' || t === '快速') return 'fast';
    }
    return null;
  }

  /**
   * 新建会话页模式 radio（div[role=radio][data-model-type]）。
   */
  private findModeRadios(): Array<{ mode: string; element: HTMLElement; isActive: boolean }> {
    const TYPE_TO_MODE: Record<string, string> = { default: 'fast', expert: 'expert', vision: 'visual' };
    return Array.from(document.querySelectorAll<HTMLElement>('[role=radio][data-model-type]')).map(el => ({
      mode: TYPE_TO_MODE[el.getAttribute('data-model-type') ?? ''] ?? (el.getAttribute('data-model-type') ?? ''),
      element: el,
      isActive: el.getAttribute('aria-checked') === 'true',
    }));
  }

  /**
   * 查找模式开关（快速/深度思考-专家/识图）。文本匹配标签，启发式判断 active。
   */
  private findModeToggles(): Array<{ mode: string; element: HTMLElement; isActive: boolean }> {
    const LABEL_PATTERNS: Array<{ mode: string; re: RegExp }> = [
      { mode: 'fast', re: /^(快速|Fast)$/i },
      { mode: 'expert', re: /^(深度思考|专家|DeepThink|R1|Expert)/i },
      { mode: 'visual', re: /^(识图|图像|视觉|Image|Vision)/i },
    ];

    const candidates = Array.from(document.querySelectorAll<HTMLElement>(this.selectors.MODE_TOGGLE));
    const found: Array<{ mode: string; element: HTMLElement; isActive: boolean }> = [];
    for (const el of candidates) {
      const text = (el.textContent ?? '').trim();
      if (!text) continue;
      for (const { mode, re } of LABEL_PATTERNS) {
        if (re.test(text)) {
          found.push({ mode, element: el, isActive: this.isToggleActive(el) });
          break;
        }
      }
    }
    return found;
  }

  /**
   * 判断开关是否处于激活态（aria / 类名启发式）。
   */
  private isToggleActive(el: HTMLElement): boolean {
    if (el.getAttribute('aria-pressed') === 'true') return true;
    if (el.getAttribute('aria-selected') === 'true') return true;
    if (el.getAttribute('aria-checked') === 'true') return true;
    const cls = `${el.className || ''} ${el.parentElement?.className || ''}`;
    return /(^|[\s_-])(active|selected|checked)([\s_-]|$)/i.test(cls);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Read the last assistant response (text + code blocks).
   */
  async readLastResponse(): Promise<ResponsePayload | null> {
    this.context.logger.debug('Reading last DeepSeek assistant response');

    const assistantEls = Array.from(document.querySelectorAll<HTMLElement>(this.selectors.MESSAGE_ASSISTANT));
    if (assistantEls.length === 0) {
      this.context.logger.warn('No assistant messages found');
      return null;
    }

    const last = assistantEls[assistantEls.length - 1];
    const text = this.extractConversationText(last);

    const codeBlocks: { lang: string; code: string }[] = [];
    last.querySelectorAll('pre').forEach(pre => {
      const langEl = pre.querySelector('code[class*="language-"]');
      const lang = langEl?.className.match(/language-(\w+)/)?.[1] ?? '';
      const code = (pre.innerText || pre.textContent || '').trim();
      codeBlocks.push({ lang, code });
    });

    return { text, codeBlocks, rawHtml: last.innerHTML };
  }

  /**
   * Wait until the model finishes generating a response.
   * Stop condition (2 of 2): saw generation start + stop icon gone + no new
   * mutations for 2s. Mirrors the design's "三条件取二" strategy; requires
   * that generation actually started to avoid false-positive on a quiet page.
   */
  async waitForResponse(timeoutMs: number = 60_000): Promise<boolean> {
    this.context.logger.debug(`Waiting for DeepSeek response (timeout ${timeoutMs}ms)`);

    const messageArea = document.querySelector(this.selectors.MAIN_PANEL) ?? document.body;
    let lastMutation = Date.now();
    const observer = new MutationObserver(() => {
      lastMutation = Date.now();
    });
    observer.observe(messageArea, { childList: true, subtree: true, characterData: true });

    let sawGeneration = false;
    const check = (): boolean => {
      const sendButton = this.findSubmitButton();
      const isGenerating = !!sendButton && this.isStopButton(sendButton);
      if (isGenerating) sawGeneration = true;
      const stopIconGone = !sendButton || !isGenerating;
      const idleFor = Date.now() - lastMutation;
      const conditions = [stopIconGone, idleFor > 2_000].filter(Boolean).length;
      return sawGeneration && conditions >= 2;
    };

    const start = Date.now();
    try {
      while (Date.now() - start < timeoutMs) {
        if (check()) {
          this.context.logger.debug('DeepSeek response finished');
          return true;
        }
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      this.context.logger.warn(`Timed out waiting for DeepSeek response after ${timeoutMs}ms`);
      return false;
    } finally {
      observer.disconnect();
    }
  }

  /**
   * Attach a file to the DeepSeek chat input
   * Enhanced with better error handling and integration with new architecture
   */
  /**
   * Attach a file to the DeepSeek chat input
   * Enhanced with better error handling and integration with new architecture
   */
  async attachFile(file: File, options?: { inputElement?: HTMLInputElement }): Promise<boolean> {
    this.context.logger.debug(`Attempting to attach file: ${file.name} (${file.size} bytes, ${file.type})`);

    try {
      // Validate file before attempting attachment
      if (!file || file.size === 0) {
        this.emitExecutionFailed('attachFile', 'Invalid file: file is empty or null');
        return false;
      }

      // Check if file upload is supported on current page
      if (!this.supportsFileUpload()) {
        this.emitExecutionFailed('attachFile', 'File upload not supported on current page');
        return false;
      }

      // Try to find file input element
      let fileInput: HTMLInputElement | null = null;

      if (options?.inputElement) {
        fileInput = options.inputElement;
      } else {
        fileInput = document.querySelector(this.selectors.FILE_INPUT) as HTMLInputElement;
      }

      if (fileInput) {
        // Direct file input method
        const success = await this.attachFileToInput(file, fileInput);
        if (success) {
          this.emitExecutionCompleted('attachFile', {
            fileName: file.name,
            fileType: file.type,
            fileSize: file.size,
            method: 'fileInput'
          }, {
            success: true,
            attachmentMethod: 'direct-input'
          });
          return true;
        }
      }

      // Try drag and drop simulation as fallback
      const dropSuccess = await this.simulateFileDrop(file);
      if (dropSuccess) {
        this.emitExecutionCompleted('attachFile', {
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          method: 'dragDrop'
        }, {
          success: true,
          attachmentMethod: 'drag-drop-simulation'
        });
        return true;
      }

      this.emitExecutionFailed('attachFile', 'All file attachment methods failed');
      return false;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.context.logger.error(`Error attaching file to DeepSeek: ${errorMessage}`);
      this.emitExecutionFailed('attachFile', errorMessage);
      return false;
    }
  }

  /**
   * Attach file directly to file input element
   */
  private async attachFileToInput(file: File, fileInput: HTMLInputElement): Promise<boolean> {
    try {
      // Create DataTransfer object to simulate file selection
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInput.files = dataTransfer.files;

      // Trigger change event
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));

      this.context.logger.debug(`File attached directly to input: ${file.name}`);
      return true;
    } catch (error) {
      this.context.logger.error('Error attaching file to input:', error);
      return false;
    }
  }

  /**
   * Simulate file drop for file attachment
   */
  private async simulateFileDrop(file: File): Promise<boolean> {
    try {
      // Find drop zone
      const dropZones = this.selectors.DROP_ZONE.split(', ');
      let dropZone: Element | null = null;

      for (const selector of dropZones) {
        dropZone = document.querySelector(selector.trim());
        if (dropZone) break;
      }

      if (!dropZone) {
        this.context.logger.warn('No drop zone found for file drop simulation');
        return false;
      }

      // Create drag and drop events
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);

      const dragEnterEvent = new DragEvent('dragenter', {
        bubbles: true,
        dataTransfer: dataTransfer
      });

      const dragOverEvent = new DragEvent('dragover', {
        bubbles: true,
        dataTransfer: dataTransfer
      });

      const dropEvent = new DragEvent('drop', {
        bubbles: true,
        dataTransfer: dataTransfer
      });

      // Dispatch events
      dropZone.dispatchEvent(dragEnterEvent);
      dropZone.dispatchEvent(dragOverEvent);
      dropZone.dispatchEvent(dropEvent);

      this.context.logger.debug(`File drop simulated for: ${file.name}`);
      return true;
    } catch (error) {
      this.context.logger.error('Error simulating file drop:', error);
      return false;
    }
  }

  /**
   * Check if the current page/URL is supported by this adapter
   * Enhanced with better pattern matching and logging
   */
  isSupported(): boolean | Promise<boolean> {
    const currentHost = window.location.hostname;
    const currentUrl = window.location.href;

    this.context.logger.debug(`Checking if DeepSeek adapter supports: ${currentUrl}`);

    // Check hostname first
    const isDeepSeekHost = this.hostnames.some(hostname => {
      if (typeof hostname === 'string') {
        return currentHost.includes(hostname);
      }
      // hostname is RegExp if it's not a string
      return (hostname as RegExp).test(currentHost);
    });

    if (!isDeepSeekHost) {
      this.context.logger.debug(`Host ${currentHost} not supported by DeepSeek adapter`);
      return false;
    }

    // Check if we're on a supported DeepSeek page
    const supportedPatterns = [
      /^https?:\/\/(?:www\.)?chat\.deepseek\.com\/.*/,  // Chat pages
      /^https?:\/\/(?:www\.)?chat\.deepseek\.com$/       // Base chat page
    ];

    const isSupported = supportedPatterns.some(pattern => pattern.test(currentUrl));

    if (isSupported) {
      this.context.logger.debug(`DeepSeek adapter supports current page: ${currentUrl}`);
    } else {
      this.context.logger.debug(`URL pattern not supported: ${currentUrl}`);
    }

    return isSupported;
  }

  /**
   * Check if file upload is supported on the current page
   * Enhanced with multiple selector checking and better detection
   */
  supportsFileUpload(): boolean {
    this.context.logger.debug('Checking file upload support for DeepSeek');

    // Check for drop zones
    const dropZoneSelectors = this.selectors.DROP_ZONE.split(', ');
    for (const selector of dropZoneSelectors) {
      const dropZone = document.querySelector(selector.trim());
      if (dropZone) {
        this.context.logger.debug(`Found drop zone with selector: ${selector.trim()}`);
        return true;
      }
    }

    // Check for file upload buttons
    const uploadButtonSelectors = this.selectors.FILE_UPLOAD_BUTTON.split(', ');
    for (const selector of uploadButtonSelectors) {
      const uploadButton = document.querySelector(selector.trim());
      if (uploadButton) {
        this.context.logger.debug(`Found upload button with selector: ${selector.trim()}`);
        return true;
      }
    }

    // Check for file input elements
    const fileInput = document.querySelector(this.selectors.FILE_INPUT);
    if (fileInput) {
      this.context.logger.debug('Found file input element');
      return true;
    }

    this.context.logger.debug('No file upload support detected');
    return false;
  }

  // Private helper methods

  private setupUrlTracking(): void {
    if (!this.urlCheckInterval) {
      this.urlCheckInterval = setInterval(() => {
        const currentUrl = window.location.href;
        if (currentUrl !== this.lastUrl) {
          this.context.logger.debug(`URL changed from ${this.lastUrl} to ${currentUrl}`);

          // Emit page changed event
          if (this.onPageChanged) {
            this.onPageChanged(currentUrl, this.lastUrl);
          }

          this.lastUrl = currentUrl;
        }
      }, 1000); // Check every second
    }
  }

  // New architecture integration methods

  private setupStoreEventListeners(): void {
    if (this.storeEventListenersSetup) {
      this.context.logger.warn(`Store event listeners already set up for instance #${this.instanceId}, skipping`);
      return;
    }

    this.context.logger.debug(`Setting up store event listeners for DeepSeek adapter instance #${this.instanceId}`);

    // Listen for tool execution events from the store
    this.context.eventBus.on('tool:execution-completed', (data) => {
      this.context.logger.debug('Tool execution completed:', data);
      // Handle auto-actions based on store state
      this.handleToolExecutionCompleted(data);
    });

    // Listen for UI state changes
    this.context.eventBus.on('ui:sidebar-toggle', (data) => {
      this.context.logger.debug('Sidebar toggled:', data);
    });

    this.storeEventListenersSetup = true;
  }

  private setupDOMObservers(): void {
    if (this.domObserversSetup) {
      this.context.logger.warn(`DOM observers already set up for instance #${this.instanceId}, skipping`);
      return;
    }

    this.context.logger.debug(`Setting up DOM observers for DeepSeek adapter instance #${this.instanceId}`);

    // Set up mutation observer to detect page changes and re-inject UI if needed
    this.mutationObserver = new MutationObserver((mutations) => {
      let shouldReinject = false;

      mutations.forEach((mutation) => {
        if (mutation.type === 'childList') {
          // Check if our MCP popover was removed
          if (!document.getElementById('mcp-popover-container')) {
            shouldReinject = true;
          }
        }
      });

      if (shouldReinject) {
        // Only attempt re-injection if we can find an insertion point
        const insertionPoint = this.findButtonInsertionPoint();
        if (insertionPoint) {
          this.context.logger.debug('MCP popover removed, attempting to re-inject');
          this.setupUIIntegration();
        }
      }
    });

    // Start observing
    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });

    this.domObserversSetup = true;
  }

  private setupUIIntegration(): void {
    // Allow multiple calls for UI integration (for re-injection after page changes)
    // but log it for debugging
    if (this.uiIntegrationSetup) {
      this.context.logger.debug(`UI integration already set up for instance #${this.instanceId}, re-injecting for page changes`);
    } else {
      this.context.logger.debug(`Setting up UI integration for DeepSeek adapter instance #${this.instanceId}`);
      this.uiIntegrationSetup = true;
    }

    // Wait for page to be ready, then inject MCP popover
    this.waitForPageReady().then(() => {
      this.injectMCPPopoverWithRetry();
    }).catch((error) => {
      this.context.logger.warn('Failed to wait for page ready:', error);
      // Don't retry if we can't find insertion point
    });

    // Set up periodic check to ensure popover stays injected
    // this.setupPeriodicPopoverCheck();
  }

  private async waitForPageReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 5; // Maximum 10 seconds (20 * 500ms)

      const checkReady = () => {
        attempts++;
        const insertionPoint = this.findButtonInsertionPoint();
        if (insertionPoint) {
          this.context.logger.debug('Page ready for MCP popover injection');
          resolve();
        } else if (attempts >= maxAttempts) {
          this.context.logger.warn('Page ready check timed out - no insertion point found');
          reject(new Error('No insertion point found after maximum attempts'));
        } else {
          setTimeout(checkReady, 500);
        }
      };
      setTimeout(checkReady, 100);
    });
  }

  private injectMCPPopoverWithRetry(maxRetries: number = 5): void {
    const attemptInjection = (attempt: number) => {
      this.context.logger.debug(`Attempting MCP popover injection (attempt ${attempt}/${maxRetries})`);

      // Check if popover already exists
      if (document.getElementById('mcp-popover-container')) {
        this.context.logger.debug('MCP popover already exists');
        return;
      }

      // Find insertion point
      const insertionPoint = this.findButtonInsertionPoint();
      if (insertionPoint) {
        this.injectMCPPopover(insertionPoint);
      } else if (attempt < maxRetries) {
        // Retry after delay
        this.context.logger.debug(`Insertion point not found, retrying in 1 second (attempt ${attempt}/${maxRetries})`);
        setTimeout(() => attemptInjection(attempt + 1), 1000);
      } else {
        this.context.logger.warn('Failed to inject MCP popover after maximum retries');
      }
    };

    attemptInjection(1);
  }

  private setupPeriodicPopoverCheck(): void {
    // Check every 5 seconds if the popover is still there
    if (!this.popoverCheckInterval) {
      this.popoverCheckInterval = setInterval(() => {
        if (!document.getElementById('mcp-popover-container')) {
          // Only attempt re-injection if we can find an insertion point
          const insertionPoint = this.findButtonInsertionPoint();
          if (insertionPoint) {
            this.context.logger.debug('MCP popover missing, attempting to re-inject');
            this.injectMCPPopoverWithRetry(3); // Fewer retries for periodic checks
          }
        }
      }, 5000);
    }
  }

  private cleanupDOMObservers(): void {
    this.context.logger.debug('Cleaning up DOM observers for DeepSeek adapter');

    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }
  }

  private cleanupUIIntegration(): void {
    this.context.logger.debug('Cleaning up UI integration for DeepSeek adapter');

    // Remove MCP popover if it exists
    const popoverContainer = document.getElementById('mcp-popover-container');
    if (popoverContainer) {
      popoverContainer.remove();
    }

    this.mcpPopoverContainer = null;
  }

  private handleToolExecutionCompleted(data: any): void {
    this.context.logger.debug('Handling tool execution completion in DeepSeek adapter:', data);

    // Use the base class method to check if we should handle events
    if (!this.shouldHandleEvents()) {
      this.context.logger.debug('DeepSeek adapter should not handle events, ignoring tool execution event');
      return;
    }

    // Get current UI state from stores to determine auto-actions
    const uiState = this.context.stores.ui;
    if (uiState && data.execution) {
      // Handle auto-insert, auto-submit based on store state
      // This integrates with the new architecture's state management
      this.context.logger.debug('Tool execution handled with new architecture integration');
    }
  }

  private findButtonInsertionPoint(): { container: Element; insertAfter: Element | null } | null {
    this.context.logger.debug('Finding button insertion point for MCP popover');

    // Try DeepSeek-specific button container first (.ec4f5d61)
    const buttonContainer = document.querySelector('.ec4f5d61');
    if (buttonContainer) {
      this.context.logger.debug('Found DeepSeek button container (.ec4f5d61)');

      // Find the attach button container (.bf38813a) - we want to insert BEFORE this
      const attachContainer = buttonContainer.querySelector('.bf38813a');
      if (attachContainer) {
        this.context.logger.debug('Found attach button container, will insert before it');
        // Find the last toggle button (Search button) before the attach container
        const toggleButtons = buttonContainer.querySelectorAll('.ds-toggle-button');
        if (toggleButtons.length > 0) {
          const lastToggleButton = toggleButtons[toggleButtons.length - 1];
          this.context.logger.debug('Will insert after last toggle button (Search)');
          return { container: buttonContainer, insertAfter: lastToggleButton };
        }
        // Fallback: insert at the beginning of container, before attach button
        return { container: buttonContainer, insertAfter: null };
      }

      // Fallback: Look for search button specifically
      const buttons = buttonContainer.querySelectorAll('.ds-button');
      for (const button of Array.from(buttons)) {
        const buttonText = button.textContent?.trim();
        if (buttonText === 'Search') {
          this.context.logger.debug('Found search button, will insert after it');
          return { container: buttonContainer, insertAfter: button };
        }
      }

      // If search button not found, use last button
      const lastButton = buttonContainer.querySelector('.ds-button:last-child');
      if (lastButton) {
        this.context.logger.debug('Using last button as insertion point');
        return { container: buttonContainer, insertAfter: lastButton };
      }
    }

    // Try fallback selectors
    const fallbackSelectors = [
      '._24fad49', // Textarea parent
      '.bf38813a', // File upload container
      '.aaff8b8f', // Chat input area
      '.chat-input-actions',
      '.input-actions',
      '.actions-wrapper'
    ];

    for (const selector of fallbackSelectors) {
      const container = document.querySelector(selector);
      if (container) {
        this.context.logger.debug(`Found fallback insertion point: ${selector}`);
        // For these fallback containers, try to find a suitable insertion point
        if (container.parentElement) {
          return { container: container.parentElement, insertAfter: container };
        } else {
          return { container, insertAfter: null };
        }
      }
    }

    this.context.logger.debug('Could not find suitable insertion point for MCP popover');
    return null;
  }

  private injectMCPPopover(insertionPoint: { container: Element; insertAfter: Element | null }): void {
    this.context.logger.debug('Injecting MCP popover into DeepSeek interface');

    try {
      // Check if popover already exists
      if (document.getElementById('mcp-popover-container')) {
        this.context.logger.debug('MCP popover already exists, skipping injection');
        return;
      }

      // Inject DeepSeek-specific button styles
      if (!document.getElementById('mcp-deepseek-button-styles')) {
        const styleEl = document.createElement('style');
        styleEl.id = 'mcp-deepseek-button-styles';
        styleEl.textContent = this.deepseekButtonStyles;
        document.head.appendChild(styleEl);
        this.context.logger.debug('DeepSeek button styles injected');
      }

      // Create container for the popover
      const reactContainer = document.createElement('div');
      reactContainer.id = 'mcp-popover-container';
      reactContainer.style.display = 'inline-block';
      // Remove margin to let button handle its own spacing

      // Insert at appropriate location.
      // Always insert relative to the anchor element's actual parent so the
      // button lands inline with the toolbar row (next to the toggle
      // buttons, left of the send button). Appending to the outer container
      // instead would drop the button after the whole row - to the right of
      // the send button - breaking the native layout.
      const { container, insertAfter } = insertionPoint;
      if (insertAfter && insertAfter.parentNode) {
        insertAfter.parentNode.insertBefore(reactContainer, insertAfter.nextSibling);
        this.context.logger.debug('Inserted popover container after specified element');
      } else {
        container.appendChild(reactContainer);
        this.context.logger.debug('Appended popover container to container element');
      }

      // Store reference
      this.mcpPopoverContainer = reactContainer;

      // Render the React MCP Popover using the new architecture
      this.renderMCPPopover(reactContainer);

      this.context.logger.debug('MCP popover injected and rendered successfully');
    } catch (error) {
      this.context.logger.error('Failed to inject MCP popover:', error);
    }
  }

  private renderMCPPopover(container: HTMLElement): void {
    this.context.logger.debug('Rendering MCP popover with new architecture integration');

    try {
      // Import React and ReactDOM dynamically to avoid bundling issues
      import('react').then(React => {
        import('react-dom/client').then(ReactDOM => {
          import('../../components/mcpPopover/mcpPopover').then(({ MCPPopover }) => {
            // Create toggle state manager that integrates with new stores
            const toggleStateManager = this.createToggleStateManager();

            // DeepSeek-specific button configuration to match native design
            const adapterButtonConfig = {
              className: 'mcp-ds-button',
              contentClassName: 'mcp-ds-button-content',
              textClassName: 'mcp-ds-button-text',
              iconClassName: 'mcp-ds-button-icon',
              activeClassName: 'mcp-button-active'
            };

            // Create React root and render
            const root = ReactDOM.createRoot(container);
            root.render(
              React.createElement(MCPPopover, {
                toggleStateManager: toggleStateManager,
                adapterButtonConfig: adapterButtonConfig,
                adapterName: 'DeepSeekAdapter'
              })
            );

            this.context.logger.debug('MCP popover rendered successfully with DeepSeek styling');
          }).catch(error => {
            this.context.logger.error('Failed to import MCPPopover component:', error);
          });
        }).catch(error => {
          this.context.logger.error('Failed to import ReactDOM:', error);
        });
      }).catch(error => {
        this.context.logger.error('Failed to import React:', error);
      });
    } catch (error) {
      this.context.logger.error('Failed to render MCP popover:', error);
    }
  }

  private createToggleStateManager() {
    const context = this.context;
    const adapterName = this.name;

    // Create the state manager object
    const stateManager = {
      getState: () => {
        try {
          // Get state from UI store - MCP enabled state should be the persistent MCP toggle state
          const uiState = context.stores.ui;

          // Get the persistent MCP enabled state and other preferences
          const mcpEnabled = uiState?.mcpEnabled ?? false;
          const autoSubmitEnabled = uiState?.preferences?.autoSubmit ?? false;

          context.logger.debug(`Getting MCP toggle state: mcpEnabled=${mcpEnabled}, autoSubmit=${autoSubmitEnabled}`);

          return {
            mcpEnabled: mcpEnabled, // Use the persistent MCP state
            autoInsert: autoSubmitEnabled,
            autoSubmit: autoSubmitEnabled,
            autoExecute: false // Default for now, can be extended
          };
        } catch (error) {
          context.logger.error('Error getting toggle state:', error);
          // Return safe defaults in case of error
          return {
            mcpEnabled: false,
            autoInsert: false,
            autoSubmit: false,
            autoExecute: false
          };
        }
      },

      setMCPEnabled: (enabled: boolean) => {
        context.logger.debug(`Setting MCP ${enabled ? 'enabled' : 'disabled'} - controlling sidebar visibility via MCP state`);

        try {
          // Primary method: Control MCP state through UI store (which will automatically control sidebar)
          if (context.stores.ui?.setMCPEnabled) {
            context.stores.ui.setMCPEnabled(enabled, 'mcp-popover-toggle');
            context.logger.debug(`MCP state set to: ${enabled} via UI store`);
          } else {
            context.logger.warn('UI store setMCPEnabled method not available');

            // Fallback: Control sidebar visibility directly if MCP state setter not available
            if (context.stores.ui?.setSidebarVisibility) {
              context.stores.ui.setSidebarVisibility(enabled, 'mcp-popover-toggle-fallback');
              context.logger.debug(`Sidebar visibility set to: ${enabled} via UI store fallback`);
            }
          }

          // Secondary method: Control through global sidebar manager as additional safeguard
          const sidebarManager = (window as any).activeSidebarManager;
          if (sidebarManager) {
            if (enabled) {
              context.logger.debug('Showing sidebar via activeSidebarManager');
              sidebarManager.show().catch((error: any) => {
                context.logger.error('Error showing sidebar:', error);
              });
            } else {
              context.logger.debug('Hiding sidebar via activeSidebarManager');
              sidebarManager.hide().catch((error: any) => {
                context.logger.error('Error hiding sidebar:', error);
              });
            }
          } else {
            context.logger.warn('activeSidebarManager not available on window - will rely on UI store only');
          }

          context.logger.debug(`MCP toggle completed: MCP ${enabled ? 'enabled' : 'disabled'}, sidebar ${enabled ? 'shown' : 'hidden'}`);
        } catch (error) {
          context.logger.error('Error in setMCPEnabled:', error);
        }

        stateManager.updateUI();
      },

      setAutoInsert: (enabled: boolean) => {
        context.logger.debug(`Setting Auto Insert ${enabled ? 'enabled' : 'disabled'}`);

        // Update preferences through store
        if (context.stores.ui?.updatePreferences) {
          context.stores.ui.updatePreferences({ autoSubmit: enabled });
        }

        stateManager.updateUI();
      },

      setAutoSubmit: (enabled: boolean) => {
        context.logger.debug(`Setting Auto Submit ${enabled ? 'enabled' : 'disabled'}`);

        // Update preferences through store
        if (context.stores.ui?.updatePreferences) {
          context.stores.ui.updatePreferences({ autoSubmit: enabled });
        }

        stateManager.updateUI();
      },

      setAutoExecute: (enabled: boolean) => {
        context.logger.debug(`Setting Auto Execute ${enabled ? 'enabled' : 'disabled'}`);
        // Can be extended to handle auto execute functionality
        stateManager.updateUI();
      },

      updateUI: () => {
        context.logger.debug('Updating MCP popover UI');

        // Dispatch custom event to update the popover
        const popoverContainer = document.getElementById('mcp-popover-container');
        if (popoverContainer) {
          const currentState = stateManager.getState();
          const event = new CustomEvent('mcp:update-toggle-state', {
            detail: { toggleState: currentState }
          });
          popoverContainer.dispatchEvent(event);
        }
      }
    };

    return stateManager;
  }

  /**
   * Public method to manually inject MCP popover (for debugging or external calls)
   */
  public injectMCPPopoverManually(): void {
    this.context.logger.debug('Manual MCP popover injection requested');
    this.injectMCPPopoverWithRetry();
  }

  /**
   * Check if MCP popover is currently injected
   */
  public isMCPPopoverInjected(): boolean {
    return !!document.getElementById('mcp-popover-container');
  }

  private emitExecutionCompleted(toolName: string, parameters: any, result: any): void {
    this.context.eventBus.emit('tool:execution-completed', {
      execution: {
        id: this.generateCallId(),
        toolName,
        parameters,
        result,
        timestamp: Date.now(),
        status: 'success'
      }
    });
  }

  private emitExecutionFailed(toolName: string, error: string): void {
    this.context.eventBus.emit('tool:execution-failed', {
      toolName,
      error,
      callId: this.generateCallId()
    });
  }

  private generateCallId(): string {
    return `deepseek-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  /**
   * Check if the sidebar is properly available after navigation
   */
  private checkAndRestoreSidebar(): void {
    this.context.logger.debug('Checking sidebar state after page navigation');

    try {
      // Check if there's an active sidebar manager
      const activeSidebarManager = (window as any).activeSidebarManager;

      if (!activeSidebarManager) {
        this.context.logger.warn('No active sidebar manager found after navigation');
        return;
      }

      // Sidebar manager exists, just ensure MCP popover connection is working
      this.ensureMCPPopoverConnection();

    } catch (error) {
      this.context.logger.error('Error checking sidebar state after navigation:', error);
    }
  }

  /**
   * Ensure MCP popover is properly connected to the sidebar after navigation
   */
  private ensureMCPPopoverConnection(): void {
    this.context.logger.debug('Ensuring MCP popover connection after navigation');

    try {
      // Check if MCP popover is still injected
      if (!this.isMCPPopoverInjected()) {
        this.context.logger.debug('MCP popover missing after navigation, re-injecting');
        this.injectMCPPopoverWithRetry(3);
      } else {
        this.context.logger.debug('MCP popover is still present after navigation');
      }
    } catch (error) {
      this.context.logger.error('Error ensuring MCP popover connection:', error);
    }
  }

  // Event handlers - Enhanced for new architecture integration
  onPageChanged?(url: string, oldUrl?: string): void {
    this.context.logger.debug(`DeepSeek page changed: from ${oldUrl || 'N/A'} to ${url}`);

    // Update URL tracking
    this.lastUrl = url;

    // Re-check support and re-inject UI if needed
    const stillSupported = this.isSupported();
    if (stillSupported) {
      // Re-setup UI integration after page change
      setTimeout(() => {
        this.setupUIIntegration();
      }, 1000); // Give page time to load

      // Check if sidebar exists and restore it if needed
      setTimeout(() => {
        this.checkAndRestoreSidebar();
      }, 1500); // Additional delay to ensure page is fully loaded
    } else {
      this.context.logger.warn('Page no longer supported after navigation');
    }

    // Emit page change event to stores
    this.context.eventBus.emit('app:site-changed', {
      site: url,
      hostname: window.location.hostname
    });
  }

  onHostChanged?(newHost: string, oldHost?: string): void {
    this.context.logger.debug(`DeepSeek host changed: from ${oldHost || 'N/A'} to ${newHost}`);

    // Re-check if the adapter is still supported
    const stillSupported = this.isSupported();
    if (!stillSupported) {
      this.context.logger.warn('DeepSeek adapter no longer supported on this host/page');
      // Emit deactivation event using available event type
      this.context.eventBus.emit('adapter:deactivated', {
        pluginName: this.name,
        timestamp: Date.now()
      });
    } else {
      // Re-setup for new host
      this.setupUIIntegration();
    }
  }

  onToolDetected?(tools: any[]): void {
    this.context.logger.debug(`Tools detected in DeepSeek adapter:`, tools);

    // Forward to tool store
    tools.forEach(tool => {
      this.context.stores.tool?.addDetectedTool?.(tool);
    });
  }
}