import { BaseAdapterPlugin } from './base.adapter';
import type { AdapterCapability, PluginContext } from '../plugin-types';
import { createLogger } from '@extension/shared/lib/logger';

/**
 * Doubao Adapter for https://www.doubao.com/chat/
 *
 * This adapter provides specialized functionality for interacting with Doubao's
 * chat interface, including text insertion, form submission, and file attachment capabilities.
 */

const logger = createLogger('DoubaoAdapter');

export class DoubaoAdapter extends BaseAdapterPlugin {
  readonly name = 'DoubaoAdapter';
  readonly version = '1.0.0';
  readonly hostnames = ['doubao.com', 'www.doubao.com'];
  readonly capabilities: AdapterCapability[] = [
    'text-insertion',
    'form-submission',
    'file-attachment',
    'dom-manipulation'
  ];

  // CSS selectors for Doubao's UI elements
  // Updated based on actual HTML analysis of www.doubao.com
  private readonly selectors = {
    // Primary chat input selectors - found as textarea with specific class
    CHAT_INPUT: 'textarea.semi-input-textarea, div[contenteditable="true"][role="textbox"]',
    // Submit button selectors - found as button with send-btn-wrapper or flow-end-msg-send id
    SUBMIT_BUTTON: 'button#flow-end-msg-send, .send-btn-wrapper button, button[aria-label="发送"], button[aria-label="Send"], button.send-btn, button.semi-button-primary, button[type="submit"]',
    // File upload related selectors - based on observed class names
    FILE_UPLOAD_BUTTON: 'button.upload-button, button.attach-button',
    FILE_INPUT: 'input[type="file"]',
    // Main panel and container selectors
    MAIN_PANEL: '.chat-container, .main-chat-panel, .conversation-container',
    // Drop zones for file attachment
    DROP_ZONE: 'textarea.semi-input-textarea, div[contenteditable="true"]',
    // Button insertion points (for MCP popover) - placing at the top toolbar area
    BUTTON_INSERTION_CONTAINER: '.shrink-0.empty\:hidden.z-2.pl-2.flex.items-center.overflow-hidden.min-w-0.flex-1.overflow-hidden, .flex.items-center.gap-2, [class*="shrink-0 empty:hidden"], header > div:first-child',
  };

  private lastUrl: string = '';
  private urlCheckInterval: NodeJS.Timeout | null = null;
  private mcpPopoverContainer: HTMLElement | null = null;
  private mutationObserver: MutationObserver | null = null;

  constructor() {
    super();
    logger.debug('DoubaoAdapter instance created');
  }

  async initialize(context: PluginContext): Promise<void> {
    if (this.currentStatus === 'initializing' || this.currentStatus === 'active') {
      this.context?.logger.warn('DoubaoAdapter already initialized or active, skipping');
      return;
    }

    await super.initialize(context);
    this.context.logger.debug('Initializing DoubaoAdapter...');

    this.lastUrl = window.location.href;
    this.setupUrlTracking();
  }

  async activate(): Promise<void> {
    if (this.currentStatus === 'active') {
      this.context?.logger.warn('DoubaoAdapter already active, skipping');
      return;
    }

    await super.activate();
    this.context.logger.debug('Activating DoubaoAdapter...');

    this.setupDOMObservers();
    this.setupUIIntegration();

    this.context.eventBus.emit('adapter:activated', {
      pluginName: this.name,
      timestamp: Date.now()
    });
  }

  async deactivate(): Promise<void> {
    if (this.currentStatus === 'inactive' || this.currentStatus === 'disabled') {
      this.context?.logger.warn('DoubaoAdapter already inactive, skipping');
      return;
    }

    await super.deactivate();
    this.context.logger.debug('Deactivating DoubaoAdapter...');

    this.cleanupUIIntegration();
    this.cleanupDOMObservers();
  }

  async cleanup(): Promise<void> {
    await super.cleanup();
    this.context.logger.debug('Cleaning up DoubaoAdapter...');

    if (this.urlCheckInterval) {
      clearInterval(this.urlCheckInterval);
      this.urlCheckInterval = null;
    }

    this.cleanupUIIntegration();
    this.cleanupDOMObservers();
  }

  async insertText(text: string, options?: { targetElement?: HTMLElement }): Promise<boolean> {
    this.context.logger.debug(`Inserting text into Doubao chat input: ${text.substring(0, 50)}...`);

    let targetElement: HTMLElement | null = null;

    if (options?.targetElement) {
      targetElement = options.targetElement;
    } else {
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
      this.context.logger.error('Could not find Doubao chat input element');
      return false;
    }

    try {
      if (targetElement instanceof HTMLTextAreaElement || targetElement instanceof HTMLInputElement) {
        targetElement.value = text;
        targetElement.dispatchEvent(new Event('input', { bubbles: true }));
        targetElement.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (this.isContentEditableElement(targetElement)) {
        targetElement.textContent = text;
        targetElement.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        (targetElement as any).value = text;
        targetElement.dispatchEvent(new Event('input', { bubbles: true }));
      }

      this.context.logger.debug('Text inserted successfully');
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.context.logger.error(`Error inserting text: ${errorMessage}`);
      return false;
    }
  }

  async submitForm(options?: { formElement?: HTMLFormElement }): Promise<boolean> {
    this.context.logger.debug('Attempting to submit Doubao chat input');

    let submitButton: HTMLButtonElement | null = null;
    const selectors = this.selectors.SUBMIT_BUTTON.split(', ');

    for (const selector of selectors) {
      const elements = document.querySelectorAll(selector.trim());
      for (const element of elements) {
        if (element instanceof HTMLButtonElement || element instanceof HTMLElement) {
          const isDisabled = element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true';
          const isVisible = (element as HTMLElement).offsetParent !== null;
          
          if (!isDisabled && isVisible) {
            submitButton = element as HTMLButtonElement;
            this.context.logger.debug(`Found active submit button using selector: ${selector.trim()}`);
            break;
          }
        }
      }
      if (submitButton) break;
    }

    if (!submitButton) {
      const chatInput = document.querySelector(this.selectors.CHAT_INPUT) as HTMLElement;
      if (chatInput) {
        const container = chatInput.closest('form, .chat-input-area, .input-container');
        if (container) {
          const possibleButtons = container.querySelectorAll('button, .send-button, .submit-btn');
          for (const btn of possibleButtons) {
            const isDisabled = btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true';
            const isVisible = (btn as HTMLElement).offsetParent !== null;
            const hasSendIcon = btn.querySelector('svg') !== null || 
                               btn.textContent?.toLowerCase().includes('send') ||
                               btn.getAttribute('aria-label')?.toLowerCase().includes('发送');
            
            if (!isDisabled && isVisible && (hasSendIcon || btn.tagName === 'BUTTON')) {
              submitButton = btn as HTMLButtonElement;
              this.context.logger.debug('Found submit button via container search');
              break;
            }
          }
        }
      }
    }

    if (submitButton) {
      try {
        const isDisabled = submitButton.disabled ||
          submitButton.getAttribute('disabled') !== null ||
          submitButton.getAttribute('aria-disabled') === 'true' ||
          submitButton.classList.contains('disabled');

        if (isDisabled) {
          this.context.logger.warn('Doubao submit button is disabled, falling back to Enter key');
          return this.submitWithEnterKey();
        }

        const rect = submitButton.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
          this.context.logger.warn('Doubao submit button is not visible, falling back to Enter key');
          return this.submitWithEnterKey();
        }

        const clickEvent = new MouseEvent('click', {
          view: window,
          bubbles: true,
          cancelable: true
        });
        submitButton.dispatchEvent(clickEvent);
        submitButton.click();

        this.context.logger.debug('Doubao chat input submitted successfully via button click');
        return true;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.context.logger.error(`Error clicking submit button: ${errorMessage}, falling back to Enter key`);
        return this.submitWithEnterKey();
      }
    } else {
      this.context.logger.warn('Could not find Doubao submit button, falling back to Enter key');
      return this.submitWithEnterKey();
    }
  }

  private async submitWithEnterKey(): Promise<boolean> {
    try {
      const chatInput = document.querySelector(this.selectors.CHAT_INPUT) as HTMLElement;
      if (!chatInput) {
        return false;
      }

      chatInput.focus();

      const enterEvents = ['keydown', 'keypress', 'keyup'];
      for (const eventType of enterEvents) {
        chatInput.dispatchEvent(
          new KeyboardEvent(eventType, {
            key: 'Enter',
            code: 'Enter',
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          }),
        );
      }

      const form = chatInput.closest('form') as HTMLFormElement;
      if (form) {
        form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true }));
      }

      this.context.logger.debug('Doubao chat input submitted successfully via Enter key');
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.context.logger.error(`Error submitting with Enter key: ${errorMessage}`);
      return false;
    }
  }

  async attachFile(file: File, options?: { inputElement?: HTMLInputElement }): Promise<boolean> {
    this.context.logger.debug(`Attempting to attach file: ${file.name}`);

    try {
      if (!file || file.size === 0) {
        return false;
      }

      if (!this.supportsFileUpload()) {
        return false;
      }

      let fileInput: HTMLInputElement | null = null;
      const selectors = this.selectors.FILE_INPUT.split(', ');
      for (const selector of selectors) {
        fileInput = document.querySelector(selector.trim()) as HTMLInputElement;
        if (fileInput) {
          this.context.logger.debug(`Found file input using selector: ${selector.trim()}`);
          break;
        }
      }

      if (fileInput) {
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fileInput.files = dataTransfer.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }

      const success = await this.attachFileViaDragDrop(file);
      if (success) {
        return true;
      }

      return false;
    } catch (error) {
      this.context.logger.error(`Error attaching file: ${error}`);
      return false;
    }
  }

  private async attachFileViaDragDrop(file: File): Promise<boolean> {
    try {
      const dropZoneSelectors = [
        this.selectors.DROP_ZONE,
        '.chat-input-area',
        '.input-container',
        'textarea',
        '[contenteditable="true"]'
      ];

      let dropTarget: HTMLElement | null = null;
      for (const selector of dropZoneSelectors) {
        dropTarget = document.querySelector(selector) as HTMLElement;
        if (dropTarget) {
          this.context.logger.debug(`Found drop target using selector: ${selector}`);
          break;
        }
      }

      if (!dropTarget) {
        return false;
      }

      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);

      const dragEnterEvent = new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer });
      const dragOverEvent = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer });
      const dropEvent = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer });

      const preventDefaultHandler = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
      };

      dropTarget.addEventListener('dragenter', preventDefaultHandler, { once: true });
      dropTarget.addEventListener('dragover', preventDefaultHandler, { once: true });
      dropTarget.addEventListener('drop', preventDefaultHandler, { once: true });

      dropTarget.dispatchEvent(dragEnterEvent);
      await new Promise(resolve => setTimeout(resolve, 50));
      dropTarget.dispatchEvent(dragOverEvent);
      await new Promise(resolve => setTimeout(resolve, 50));
      dropTarget.dispatchEvent(dropEvent);

      return true;
    } catch (error) {
      this.context.logger.debug(`Drag-drop method failed: ${error}`);
      return false;
    }
  }

  isSupported(): boolean {
    const currentHost = window.location.hostname;
    const currentUrl = window.location.href;

    this.context.logger.debug(`Checking if Doubao adapter supports: ${currentUrl}`);

    const isDoubaoHost = this.hostnames.some(hostname => currentHost.includes(hostname));

    if (!isDoubaoHost) {
      return false;
    }

    const supportedPatterns = [
      /^https:\/\/(?:www\.)?doubao\.com\/chat\/.*/,
    ];

    const isSupported = supportedPatterns.some(pattern => pattern.test(currentUrl));

    if (isSupported) {
      this.context.logger.debug(`Doubao adapter supports current page: ${currentUrl}`);
    }

    return isSupported;
  }

  supportsFileUpload(): boolean {
    const fileInputSelectors = this.selectors.FILE_INPUT.split(', ');
    for (const selector of fileInputSelectors) {
      const fileInput = document.querySelector(selector.trim());
      if (fileInput) {
        return true;
      }
    }

    const uploadButtonSelectors = this.selectors.FILE_UPLOAD_BUTTON.split(', ');
    for (const selector of uploadButtonSelectors) {
      const uploadButton = document.querySelector(selector.trim());
      if (uploadButton) {
        return true;
      }
    }

    return false;
  }

  private setupUrlTracking(): void {
    if (!this.urlCheckInterval) {
      this.urlCheckInterval = setInterval(() => {
        const currentUrl = window.location.href;
        if (currentUrl !== this.lastUrl) {
          this.context.logger.debug(`URL changed from ${this.lastUrl} to ${currentUrl}`);

          if (this.onPageChanged) {
            this.onPageChanged(currentUrl, this.lastUrl);
          }

          this.lastUrl = currentUrl;
        }
      }, 1000);
    }
  }

  private setupDOMObservers(): void {
    this.mutationObserver = new MutationObserver(mutations => {
      let shouldReinject = false;

      mutations.forEach(mutation => {
        if (mutation.type === 'childList') {
          if (!document.getElementById('mcp-popover-container')) {
            shouldReinject = true;
          }
        }
      });

      if (shouldReinject) {
        const insertionPoint = this.findButtonInsertionPoint();
        if (insertionPoint) {
          this.context.logger.debug('MCP popover removed, attempting to re-inject');
          this.setupUIIntegration();
        }
      }
    });

    this.mutationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  private cleanupDOMObservers(): void {
    if (this.mutationObserver) {
      this.mutationObserver.disconnect();
      this.mutationObserver = null;
    }
  }

  private setupUIIntegration(): void {
    this.context.logger.debug('Setting up UI integration for Doubao adapter');

    this.waitForPageReady()
      .then(() => {
        this.injectMCPPopoverWithRetry();
      })
      .catch(error => {
        this.context.logger.warn('Failed to wait for page ready:', error);
      });
  }

  private cleanupUIIntegration(): void {
    const popoverContainer = document.getElementById('mcp-popover-container');
    if (popoverContainer) {
      popoverContainer.remove();
    }

    this.mcpPopoverContainer = null;
  }

  private async waitForPageReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const maxAttempts = 5;

      const checkReady = () => {
        attempts++;
        const insertionPoint = this.findButtonInsertionPoint();
        if (insertionPoint) {
          this.context.logger.debug('Page ready for MCP popover injection');
          resolve();
        } else if (attempts >= maxAttempts) {
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

      if (document.getElementById('mcp-popover-container')) {
        this.context.logger.debug('MCP popover already exists');
        return;
      }

      const insertionPoint = this.findButtonInsertionPoint();
      if (insertionPoint) {
        this.injectMCPPopover(insertionPoint);
      } else if (attempt < maxRetries) {
        setTimeout(() => attemptInjection(attempt + 1), 1000);
      } else {
        this.context.logger.warn('Failed to inject MCP popover after maximum retries');
      }
    };

    attemptInjection(1);
  }

  private findButtonInsertionPoint(): { container: Element; insertAfter: Element | null; insertBefore?: Element | null } | null {
    this.context.logger.debug('=== Starting findButtonInsertionPoint ===');
    
    // Log all potential containers for debugging
    const containerSelectors = this.selectors.BUTTON_INSERTION_CONTAINER.split(', ');
    this.context.logger.debug(`Checking ${containerSelectors.length} selectors: ${JSON.stringify(containerSelectors)}`);
    
    for (let i = 0; i < containerSelectors.length; i++) {
      const selector = containerSelectors[i].trim();
      this.context.logger.debug(`[${i}] Trying selector: "${selector}"`);
      
      try {
        const container = document.querySelector(selector);
        if (container) {
          this.context.logger.debug(`✓✓✓ Found container with selector ${i}: "${selector}"`);
          this.context.logger.debug(`  Container: <${container.tagName.toLowerCase()}> class="${container.className}"`);
          this.context.logger.debug(`  Children count: ${container.children.length}`);
          
          // Look for the first button or element that typically starts the toolbar
          const firstButton = container.querySelector('button, [role="button"], .skill-bar-button');
          if (firstButton) {
            this.context.logger.debug(`  Found first button: <${firstButton.tagName.toLowerCase()}> class="${firstButton.className}"`);
            this.context.logger.debug('  ✓ Will insert MCP button BEFORE this button');
            return { container, insertAfter: null, insertBefore: firstButton };
          }
          
          // If no button found, insert at the beginning of the container
          this.context.logger.debug('  No button found in container, inserting at container beginning');
          this.context.logger.debug(`  First child: ${container.firstChild ? container.firstChild.nodeName : 'null'}`);
          return { container, insertAfter: null, insertBefore: container.firstChild };
        } else {
          this.context.logger.debug(`[${i}] No container found for selector: "${selector}"`);
        }
      } catch (error) {
        this.context.logger.error(`Error with selector ${selector}:`, error);
      }
    }

    // Fallback: Look for any top-level toolbar or header
    this.context.logger.debug('No container found with main selectors, trying fallback selectors...');
    const fallbackSelectors = ['header > div', '.header', '.navbar', '[class*="header"]', '[class*="toolbar"]', '[class*="top-bar"]'];
    for (const selector of fallbackSelectors) {
      const headerToolbar = document.querySelector(selector);
      if (headerToolbar) {
        this.context.logger.debug(`Found fallback container with selector: ${selector}`);
        this.context.logger.debug(`  Container: <${headerToolbar.tagName.toLowerCase()}> class="${headerToolbar.className}"`);
        const firstChild = headerToolbar.firstElementChild;
        return { container: headerToolbar, insertAfter: null, insertBefore: firstChild };
      }
    }

    // Final fallback: Create a floating button at top right
    this.context.logger.debug('WARNING: No suitable container found! Creating floating button at top right');
    let topContainer = document.getElementById('mcp-top-container');
    if (!topContainer) {
      topContainer = document.createElement('div');
      topContainer.id = 'mcp-top-container';
      topContainer.style.position = 'fixed';
      topContainer.style.top = '12px';
      topContainer.style.right = '12px';
      topContainer.style.zIndex = '10000';
      topContainer.style.backgroundColor = 'white';
      topContainer.style.borderRadius = '8px';
      topContainer.style.boxShadow = '0 2px 8px rgba(0,0,0,0.15)';
      topContainer.style.padding = '4px';
      document.body.appendChild(topContainer);
      this.context.logger.debug('Created floating container at top-right corner');
    }
    
    return { container: topContainer, insertAfter: null, insertBefore: topContainer.firstChild };
  }

  private injectMCPPopover(insertionPoint: { container: Element; insertAfter: Element | null; insertBefore?: Element | null }): void {
    this.context.logger.debug('Injecting MCP popover into Doubao interface');

    try {
      if (document.getElementById('mcp-popover-container')) {
        return;
      }

      const reactContainer = document.createElement('div');
      reactContainer.id = 'mcp-popover-container';
      reactContainer.style.display = 'inline-flex';
      reactContainer.style.margin = '0 8px 0 0';

      const { container, insertAfter, insertBefore } = insertionPoint;

      if (insertBefore && insertBefore.parentNode === container) {
        container.insertBefore(reactContainer, insertBefore);
      } else if (insertAfter && insertAfter.parentNode === container) {
        container.insertBefore(reactContainer, insertAfter.nextSibling);
      } else {
        container.appendChild(reactContainer);
      }

      this.mcpPopoverContainer = reactContainer;
      this.renderMCPPopover(reactContainer);

      this.context.logger.debug('MCP popover injected successfully');
    } catch (error) {
      this.context.logger.error('Failed to inject MCP popover:', error);
    }
  }

  private renderMCPPopover(container: HTMLElement): void {
    this.context.logger.debug('Rendering MCP popover');

    try {
      import('react')
        .then(React => {
          import('react-dom/client')
            .then(ReactDOM => {
              import('../../components/mcpPopover/mcpPopover')
                .then(({ MCPPopover }) => {
                  const toggleStateManager = this.createToggleStateManager();

                  const root = ReactDOM.createRoot(container);
                  root.render(
                    React.createElement(MCPPopover, {
                      toggleStateManager: toggleStateManager,
                      adapterName: this.name,
                    }),
                  );

                  this.context.logger.debug('MCP popover rendered successfully');
                })
                .catch(error => {
                  this.context.logger.error('Failed to import MCPPopover component:', error);
                });
            })
            .catch(error => {
              this.context.logger.error('Failed to import ReactDOM:', error);
            });
        })
        .catch(error => {
          this.context.logger.error('Failed to import React:', error);
        });
    } catch (error) {
      this.context.logger.error('Failed to render MCP popover:', error);
    }
  }

  private createToggleStateManager() {
    const context = this.context;
    const adapterName = this.name;

    const stateManager = {
      getState: () => {
        try {
          const uiState = context.stores.ui;
          const mcpEnabled = uiState?.mcpEnabled ?? false;
          const autoSubmitEnabled = uiState?.preferences?.autoSubmit ?? false;

          return {
            mcpEnabled: mcpEnabled,
            autoInsert: autoSubmitEnabled,
            autoSubmit: autoSubmitEnabled,
            autoExecute: false,
          };
        } catch (error) {
          context.logger.error('Error getting toggle state:', error);
          return {
            mcpEnabled: false,
            autoInsert: false,
            autoSubmit: false,
            autoExecute: false,
          };
        }
      },

      setMCPEnabled: (enabled: boolean) => {
        context.logger.debug(`Setting MCP ${enabled ? 'enabled' : 'disabled'}`);

        try {
          if (context.stores.ui?.setMCPEnabled) {
            context.stores.ui.setMCPEnabled(enabled, 'mcp-popover-toggle');
          }

          const sidebarManager = (window as any).activeSidebarManager;
          if (sidebarManager) {
            if (enabled) {
              sidebarManager.show().catch((error: any) => {
                context.logger.error('Error showing sidebar:', error);
              });
            } else {
              sidebarManager.hide().catch((error: any) => {
                context.logger.error('Error hiding sidebar:', error);
              });
            }
          }
        } catch (error) {
          context.logger.error('Error in setMCPEnabled:', error);
        }

        stateManager.updateUI();
      },

      setAutoInsert: (enabled: boolean) => {
        if (context.stores.ui?.updatePreferences) {
          context.stores.ui.updatePreferences({ autoSubmit: enabled });
        }
        stateManager.updateUI();
      },

      setAutoSubmit: (enabled: boolean) => {
        if (context.stores.ui?.updatePreferences) {
          context.stores.ui.updatePreferences({ autoSubmit: enabled });
        }
        stateManager.updateUI();
      },

      setAutoExecute: (enabled: boolean) => {
        stateManager.updateUI();
      },

      updateUI: () => {
        const popoverContainer = document.getElementById('mcp-popover-container');
        if (popoverContainer) {
          const currentState = stateManager.getState();
          const event = new CustomEvent('mcp:update-toggle-state', {
            detail: { toggleState: currentState },
          });
          popoverContainer.dispatchEvent(event);
        }
      },
    };

    return stateManager;
  }

  private isContentEditableElement(element: HTMLElement): boolean {
    return (
      element.isContentEditable ||
      element.getAttribute('contenteditable') === 'true' ||
      element.hasAttribute('contenteditable')
    );
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

  private generateCallId(): string {
    return `doubao-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  onPageChanged?(url: string, oldUrl?: string): void {
    this.context.logger.debug(`Doubao page changed: from ${oldUrl || 'N/A'} to ${url}`);

    this.lastUrl = url;

    const stillSupported = this.isSupported();
    if (stillSupported) {
      setTimeout(() => {
        this.setupUIIntegration();
      }, 1000);
    }
  }

  onHostChanged?(newHost: string, oldHost?: string): void {
    this.context.logger.debug(`Doubao host changed: from ${oldHost || 'N/A'} to ${newHost}`);

    const stillSupported = this.isSupported();
    if (!stillSupported) {
      this.context.eventBus.emit('adapter:deactivated', {
        pluginName: this.name,
        timestamp: Date.now(),
      });
    } else {
      this.setupUIIntegration();
    }
  }
}