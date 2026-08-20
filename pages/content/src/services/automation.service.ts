/**
 * Automation Service for MCP SuperAssistant
 *
 * This service handles the automation features (auto insert, auto submit, auto execute)
 * that were previously part of the legacy adapter system. It integrates with the new
 * Zustand architecture and plugin-based adapter system.
 *
 * Features:
 * - Auto Insert: Automatically insert function execution results into the current page
 * - Auto Submit: Automatically submit forms after auto-insertion
 * - Auto Execute: Log when tool execution is completed (extensible for future features)
 *
 * The service listens for 'mcp:tool-execution-complete' events and performs actions
 * based on the current automation state from the user preferences store.
 */

import { eventBus } from '../events/event-bus';
import { createLogger } from '@extension/shared/lib/logger';

// Store references for accessing state outside React components

const logger = createLogger('AutomationService');

let storeRefs: {
  getUserPreferences: (() => Promise<any>) | null;
  getCurrentAdapterState: (() => Promise<any>) | null;
  addNotification: ((notification: any) => Promise<string>) | null;
} = {
  getUserPreferences: null,
  getCurrentAdapterState: null,
  addNotification: null,
};

// Initialize store access functions
async function initializeStoreAccess() {
  try {
    // Store the store access functions for later use
    storeRefs.getUserPreferences = async () => {
      // Import dynamically to avoid circular dependencies
      const { useUIStore } = await import('../stores/ui.store');
      return useUIStore.getState().preferences;
    };

    storeRefs.getCurrentAdapterState = async () => {
      // Import dynamically to avoid circular dependencies
      const { useAdapterStore } = await import('../stores/adapter.store');
      const adapterState = useAdapterStore.getState();
      const activeAdapterRegistration = adapterState.getActiveAdapter();

      const plugin = activeAdapterRegistration?.plugin;

      return {
        plugin,
        // Bind methods to maintain proper 'this' context
        insertText: plugin?.insertText ? plugin.insertText.bind(plugin) : null,
        attachFile: plugin?.attachFile ? plugin.attachFile.bind(plugin) : null,
        submitForm: plugin?.submitForm ? plugin.submitForm.bind(plugin) : null,
        isSubmitButtonEnabled: plugin?.isSubmitButtonEnabled ? plugin.isSubmitButtonEnabled.bind(plugin) : null,
        isReady: !!plugin &&
                activeAdapterRegistration?.status === 'active' &&
                !adapterState.lastAdapterError
      };
    };

    storeRefs.addNotification = async (notification: any) => {
      const { useUIStore } = await import('../stores/ui.store');
      return useUIStore.getState().addNotification(notification);
    };

    logger.debug('[AutomationService] Store access functions initialized');
  } catch (error) {
    logger.error('[AutomationService] Error initializing store access:', error);
  }
}

// Type definitions for automation events
export interface ToolExecutionCompleteDetail {
  result?: string;
  isError?: boolean;
  isFileAttachment?: boolean;
  file?: File;
  fileName?: string;
  confirmationText?: string;
  skipAutoInsertCheck?: boolean;
  callId?: string;
  functionName?: string;
  success?: boolean;
}

export interface AutomationState {
  autoInsert: boolean;
  autoSubmit: boolean;
  autoExecute: boolean;
  autoInsertDelay: number;
  autoSubmitDelay: number;
  autoExecuteDelay: number;
  autoSubmitIterationTimeout: number;
}

/**
 * Automation Service Class
 * Handles all automation logic for MCP tool execution results
 *
 * Algorithm:
 * 1. When LLM starts responding, render_prescript counts function_call blocks
 *    and calls onIterationStarted(count)
 * 2. Each tool result (mcp:tool-execution-complete) increments success or error counter
 * 3. When success+error >= total OR timeout fires → evaluate
 * 4. If any success → try to submit (check send button ready, then click)
 * 5. If no success → notify user
 * 6. Reset all counters after decision
 */
export class AutomationService {
  private static instance: AutomationService | null = null;
  private isInitialized = false;
  private eventListener: ((event: Event) => void) | null = null;
  private storeUnsubscribe: (() => void) | null = null;

  // === New counter-based iteration tracking ===
  private iterationGeneration: number = 0; // Incremented on each onIterationStarted to prevent stale resets
  private iterationCounter: number = 0; // Total function_call blocks detected
  private successCount: number = 0; // Successful tool executions
  private errorCount: number = 0; // Failed tool executions
  private iterationTimer: ReturnType<typeof setTimeout> | null = null;
  private timerExpired: boolean = false;
  private submitted: boolean = false; // Guard against double-submit
  private iterationActive: boolean = false; // True while we're tracking an iteration

  // Private constructor for singleton pattern
  private constructor() {}

  /**
   * Get the singleton instance of AutomationService
   */
  public static getInstance(): AutomationService {
    if (!AutomationService.instance) {
      AutomationService.instance = new AutomationService();
    }
    return AutomationService.instance;
  }

  /**
   * Initialize the automation service
   */
  public async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.debug('[AutomationService] Already initialized, skipping');
      return;
    }

    // Initialize store access functions
    await initializeStoreAccess();

    // Keep window.__mcpAutomationState in sync with preference changes so
    // render_prescript always reads fresh values (covers persist rehydrate
    // and user toggles after startup)
    this.setupStoreSubscription();

    // Set up event listener for tool execution completion
    this.setupToolExecutionListener();

    // Listen for MCP state changes to update automation availability
    this.setupMCPStateListener();

    // Expose initial automation state to window for render_prescript access
    await this.exposeAutomationStateToWindow();

    this.isInitialized = true;
    logger.debug('[AutomationService] Automation service initialized successfully');
  }

  /**
   * Clean up the automation service
   */
  public cleanup(): void {
    if (!this.isInitialized) {
      return;
    }

    logger.debug('[AutomationService] Cleaning up automation service');

    // Remove DOM event listener
    if (this.eventListener) {
      document.removeEventListener('mcp:tool-execution-complete', this.eventListener);
      this.eventListener = null;
    }

    this.disarmTimer();
    this.resetCounters();

    // Unsubscribe from the UI store
    if (this.storeUnsubscribe) {
      this.storeUnsubscribe();
      this.storeUnsubscribe = null;
    }

    this.isInitialized = false;
    logger.debug('[AutomationService] Automation service cleaned up');
  }

  // ================================================================
  // Public API - called by render_prescript and external code
  // ================================================================

  /**
   * Called when LLM starts responding and function_call blocks are detected.
   * @param count Number of function_call blocks in the LLM response
   */
  public onIterationStarted(count: number): void {
    if (!this.isInitialized) {
      console.warn('[AutomationService] Not initialized, ignoring iteration start');
      return;
    }

    // Bump generation so any in-flight evaluate/trySubmit from a previous
    // iteration cannot accidentally reset this iteration's state.
    this.iterationGeneration++;

    // Reset any previous iteration state
    this.resetCounters();
    this.disarmTimer();
    this.submitted = false;
    this.timerExpired = false;

    this.iterationCounter = count;
    this.iterationActive = true;

    console.log(`[AutomationService] Iteration started: ${count} function_call blocks detected`);

    if (count === 0) {
      // No tools to execute, nothing to do
      console.log('[AutomationService] Zero function_call blocks, nothing to track');
      this.iterationActive = false;
      return;
    }

    // Arm the timeout timer
    this.armTimer();
  }

  /**
   * Called when a tool execution result is received (from mcp:tool-execution-complete event)
   */
  private onToolResult(success: boolean): void {
    if (!this.iterationActive || this.submitted) return;

    if (success) {
      this.successCount++;
    } else {
      this.errorCount++;
    }

    console.log(
      `[AutomationService] Tool result: success=${success}, progress=${this.successCount + this.errorCount}/${this.iterationCounter}`,
    );

    this.evaluate();
  }

  /**
   * Evaluate whether to submit or notify
   */
  private async evaluate(): Promise<void> {
    if (this.submitted || !this.iterationActive) return;

    const allDone = this.successCount + this.errorCount >= this.iterationCounter;

    if (!allDone && !this.timerExpired) {
      // Still waiting for more results
      return;
    }

    // Decision time
    this.submitted = true;
    this.disarmTimer();

    // Capture the generation that initiated this decision so we don't
    // reset state if a newer iteration has already started.
    const generation = this.iterationGeneration;

    if (this.successCount > 0) {
      // At least one success → try to submit
      console.log(`[AutomationService] Decision: submit (${this.successCount} success, ${this.errorCount} errors)`);
      await this.trySubmit();
    } else {
      // No successes at all → notify
      console.warn(`[AutomationService] Decision: notify (${this.errorCount} errors, 0 successes)`);
      await this.notifyNoSuccess();
    }

    // Only reset if this is still the active generation.
    if (this.iterationGeneration === generation) {
      this.resetCounters();
    }
  }

  /**
   * Try to submit the form
   */
  private async trySubmit(): Promise<void> {
    try {
      const automationState = await this.getAutomationState();
      if (!automationState) return;

      // Apply autoSubmitDelay
      if (automationState.autoSubmitDelay > 0) {
        console.log(`[AutomationService] Waiting ${automationState.autoSubmitDelay}s before submit`);
        await new Promise(resolve => setTimeout(resolve, automationState.autoSubmitDelay * 1000));
      }

      const adapterState = storeRefs.getCurrentAdapterState ? await storeRefs.getCurrentAdapterState() : null;

      if (!adapterState?.submitForm) {
        console.error('[AutomationService] No submitForm method available on adapter');
        await this.notifyWorkflowStopped(
          'adapter_not_supported',
          'Auto-submit is enabled but the adapter does not support form submission.',
        );
        return;
      }

      // Check if send button is ready
      const isButtonReady = adapterState.isSubmitButtonEnabled
        ? await adapterState.isSubmitButtonEnabled()
        : true; // If no check method, assume ready

      if (isButtonReady) {
        const success = await adapterState.submitForm();
        if (success) {
          console.log('[AutomationService] Autosubmit successful');
        } else {
          console.error('[AutomationService] Autosubmit failed');
          await this.notifyWorkflowStopped('submit_failed', 'Auto-submit failed. Please submit manually.');
        }
      } else {
        // Send button not ready yet - wait a bit more (up to 5s total from now)
        console.log('[AutomationService] Send button not ready, waiting 2s...');
        await new Promise(resolve => setTimeout(resolve, 2000));

        const isReadyNow = adapterState.isSubmitButtonEnabled ? await adapterState.isSubmitButtonEnabled() : true;

        if (isReadyNow) {
          const success = await adapterState.submitForm();
          if (success) {
            console.log('[AutomationService] Autosubmit successful (after wait)');
          } else {
            console.error('[AutomationService] Autosubmit failed (after wait)');
            await this.notifyWorkflowStopped('submit_failed', 'Auto-submit failed. Please submit manually.');
          }
        } else {
          console.warn('[AutomationService] Send button still not ready after wait');
          await this.notifyWorkflowStopped(
            'button_not_ready',
            'Results inserted but send button is not ready. Please submit manually.',
          );
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[AutomationService] Error during autosubmit:', errorMessage);
      await this.notifyWorkflowStopped('submit_error', `Auto-submit error: ${errorMessage}`);
    }
  }

  // ================================================================
  // Event listeners
  // ================================================================

  /**
   * Subscribe to the UI store so window.__mcpAutomationState is refreshed
   * whenever preferences change (user toggles a switch, persisted state is
   * rehydrated, etc.). render_prescript reads this window global to decide
   * whether to auto-execute tool blocks.
   */
  private setupStoreSubscription(): void {
    if (this.storeUnsubscribe) return;

    import('../stores/ui.store')
      .then(({ useUIStore }) => {
        this.storeUnsubscribe = useUIStore.subscribe(() => {
          this.exposeAutomationStateToWindow();
        });
        logger.debug('[AutomationService] UI store subscription registered');
      })
      .catch(error => {
        logger.error('[AutomationService] Failed to subscribe to UI store:', error);
      });
  }

  /**
   * Set up the main event listener for tool execution completion
   */
  private setupToolExecutionListener(): void {
    // Remove existing listener if any
    if (this.eventListener) {
      document.removeEventListener('mcp:tool-execution-complete', this.eventListener);
    }

    // Create new event listener
    this.eventListener = (event: Event) => {
      this.handleToolExecutionComplete(event as CustomEvent<ToolExecutionCompleteDetail>);
    };

    // Add event listener to document
    document.addEventListener('mcp:tool-execution-complete', this.eventListener);
    logger.debug('[AutomationService] Tool execution event listener registered');
  }

  /**
   * Set up listener for MCP state changes
   */
  private setupMCPStateListener(): void {
    // Listen for MCP connection state changes via the event bus
    eventBus.on('connection:status-changed', ({ status }) => {
      logger.debug('[AutomationService] MCP connection status changed:', status);
      // Could add logic here to disable automation when MCP is disconnected
    });
  }

  /**
   * Main handler for tool execution completion events
   */
  private async handleToolExecutionComplete(event: CustomEvent<ToolExecutionCompleteDetail>): Promise<void> {
    if (!event.detail) {
      logger.warn('[AutomationService] Tool execution complete event received without detail');
      return;
    }

    const detail = event.detail;
    console.log(
      '[AutomationService] Tool execution complete event received:',
      JSON.stringify({
        callId: detail.callId,
        functionName: detail.functionName,
        hasResult: !!detail.result,
        isFileAttachment: detail.isFileAttachment,
        skipAutoInsertCheck: detail.skipAutoInsertCheck,
        success: detail.success,
      }),
    );

    try {
      const automationState = await this.getAutomationState();
      if (!automationState) {
        logger.debug('[AutomationService] Could not get automation state, skipping automation');
        return;
      }

      await this.exposeAutomationStateToWindow();

      // Handle Auto Insert
      const shouldAutoInsert = automationState.autoInsert && !detail.skipAutoInsertCheck;
      if (shouldAutoInsert) {
        await this.handleAutoInsert(detail);
      }

      // Track result for autosubmit counter
      // Only count events that are NOT skipAutoInsertCheck (those are manual insertions or duplicate file attachment events)
      if (!detail.skipAutoInsertCheck) {
        const isSuccess = detail.success !== undefined ? detail.success : true;
        this.onToolResult(isSuccess);
      }
    } catch (error) {
      logger.error('[AutomationService] Error handling tool execution complete:', error);
    }
  }

  // ================================================================
  // Timer management
  // ================================================================

  private armTimer(): void {
    this.disarmTimer();
    this.timerExpired = false;

    const preferencesPromise = storeRefs.getUserPreferences
      ? storeRefs.getUserPreferences().then(p => p?.autoSubmitIterationTimeout || 60)
      : Promise.resolve(60);

    preferencesPromise.then(timeoutSeconds => {
      this.iterationTimer = setTimeout(() => {
        console.log(`[AutomationService] Iteration timer expired after ${timeoutSeconds}s`);
        this.timerExpired = true;
        this.evaluate();
      }, timeoutSeconds * 1000);

      console.log(`[AutomationService] Timer armed for ${timeoutSeconds}s`);
    });
  }

  private disarmTimer(): void {
    if (this.iterationTimer) {
      clearTimeout(this.iterationTimer);
      this.iterationTimer = null;
    }
  }

  // ================================================================
  // Counter management
  // ================================================================

  private resetCounters(): void {
    this.iterationCounter = 0;
    this.successCount = 0;
    this.errorCount = 0;
    this.iterationActive = false;
    this.submitted = false;
    this.timerExpired = false;
  }

  // ================================================================
  // Notifications
  // ================================================================

  private async notifyNoSuccess(): Promise<void> {
    const message =
      this.errorCount > 0
        ? `All ${this.errorCount} tool call(s) failed. Please check your MCP connection and try again.`
        : 'No tool results were received. Please check your MCP connection.';

    if (storeRefs.addNotification) {
      try {
        await storeRefs.addNotification({
          type: 'warning',
          title: 'Autosend Skipped',
          message,
          duration: 8000,
        });
      } catch (error) {
        logger.error('[AutomationService] Failed to add notification:', error);
      }
    }

    console.warn('[AutomationService] No successful tool results:', message);
  }

  private async notifyWorkflowStopped(reason: string, message: string): Promise<void> {
    if (storeRefs.addNotification) {
      try {
        await storeRefs.addNotification({
          type: 'warning',
          title: 'Workflow Stopped',
          message,
          duration: 10000,
        });
      } catch (error) {
        logger.error('[AutomationService] Failed to add workflow stopped notification:', error);
      }
    }

    console.warn(`[AutomationService] Workflow stopped (${reason}):`, message);
  }

  // ================================================================
  // State helpers
  // ================================================================

  /**
   * Get current automation state from user preferences store
   */
  private async getAutomationState(): Promise<AutomationState | null> {
    try {
      // Access the user preferences using the store reference
      if (!storeRefs.getUserPreferences) {
        logger.error('[AutomationService] Store access not initialized');
        return null;
      }

      const preferences = await storeRefs.getUserPreferences();

      // Extract automation settings from preferences
      return {
        autoInsert: preferences.autoInsert || false,
        autoSubmit: preferences.autoSubmit || false,
        autoExecute: preferences.autoExecute || false,
        autoInsertDelay: preferences.autoInsertDelay || 0,
        autoSubmitDelay: preferences.autoSubmitDelay || 0,
        autoExecuteDelay: preferences.autoExecuteDelay || 0,
        autoSubmitIterationTimeout: preferences.autoSubmitIterationTimeout || 60,
      };
    } catch (error) {
      logger.error('[AutomationService] Error getting automation state:', error);
      return null;
    }
  }

  /**
   * Handle Auto Insert functionality
   * Inserts text or attaches files based on the execution result
   */
  private async handleAutoInsert(detail: ToolExecutionCompleteDetail): Promise<boolean> {
    const preferences = await storeRefs.getUserPreferences?.();
    const delay = preferences?.autoInsertDelay || 0;

    if (delay > 0) {
      logger.debug(`Auto Insert: Waiting ${delay} seconds before insertion`);
      await new Promise(resolve => setTimeout(resolve, delay * 1000));
    }

    if (detail.skipAutoInsertCheck) {
      return false;
    }

    try {
      if (!storeRefs.getCurrentAdapterState) {
        logger.error('[AutomationService] Adapter store access not initialized');
        return false;
      }

      const { plugin: activePlugin, insertText, attachFile, isReady } = await storeRefs.getCurrentAdapterState();

      if (!isReady || !activePlugin) {
        logger.warn('[AutomationService] No active adapter available for auto insert');
        return false;
      }

      if (detail.isFileAttachment && detail.file && attachFile) {
        const success = await attachFile(detail.file);
        if (success && detail.confirmationText && insertText) {
          setTimeout(async () => {
            try {
              await insertText(detail.confirmationText!);
            } catch (error) {
              logger.error('[AutomationService] Error inserting confirmation text:', error);
            }
          }, 100);
        }
        return success;
      } else if (detail.result && insertText) {
        return await insertText(detail.result);
      } else {
        logger.warn('[AutomationService] No valid insertion method found for auto insert');
        return false;
      }
    } catch (error) {
      logger.error('[AutomationService] Error during auto insert:', error);
      return false;
    }
  }

  /**
   * Check if automation service is initialized
   */
  public isServiceInitialized(): boolean {
    return this.isInitialized;
  }

  /**
   * Get current automation state (public method for external access)
   */
  public async getCurrentAutomationState(): Promise<AutomationState | null> {
    return await this.getAutomationState();
  }

  /**
   * Force trigger automation for testing/debugging purposes
   */
  public async triggerTestAutomation(detail: ToolExecutionCompleteDetail): Promise<void> {
    logger.debug('[AutomationService] Triggering test automation');
    await this.handleToolExecutionComplete(new CustomEvent('mcp:tool-execution-complete', { detail }));
  }

  /**
   * Expose current automation state to window object for access by render_prescript
   */
  private async exposeAutomationStateToWindow(): Promise<void> {
    try {
      const automationState = await this.getAutomationState();
      if (automationState) {
        (window as any).__mcpAutomationState = automationState;
      }
    } catch (error) {
      logger.error('[AutomationService] Error exposing automation state to window:', error);
    }
  }

  /**
   * Update automation state on window object when preferences change
   */
  public async updateAutomationStateOnWindow(): Promise<void> {
    await this.exposeAutomationStateToWindow();
  }
}

// Export singleton instance
export const automationService = AutomationService.getInstance();

// Export initialization function for easy setup
export async function initializeAutomationService(): Promise<void> {
  await automationService.initialize();
  // Expose on window for access by render_prescript (mutationObserver)
  (window as any).automationService = automationService;
}

// Export cleanup function
export function cleanupAutomationService(): void {
  (window as any).automationService = undefined;
  automationService.cleanup();
}

// Default export for convenience
export default automationService;

// Development utilities
if (typeof window !== 'undefined' && typeof import.meta !== 'undefined' && (import.meta as any).env?.DEV) {
  (window as any).__automationService = {
    service: automationService,
    getState: async () => await automationService.getCurrentAutomationState(),
    testAutoInsert: async (text: string) => {
      return automationService.triggerTestAutomation({
        result: text,
        isFileAttachment: false,
        skipAutoInsertCheck: false,
      });
    },
    testAutoSubmit: async () => {
      return automationService.triggerTestAutomation({
        result: 'Test result for auto submit',
        isFileAttachment: false,
        skipAutoInsertCheck: true,
      });
    },
    testFileAttachment: async (fileName: string = 'test.txt', content: string = 'Test file content') => {
      const file = new File([content], fileName, { type: 'text/plain' });
      return automationService.triggerTestAutomation({
        isFileAttachment: true,
        file,
        fileName,
        confirmationText: `File ${fileName} attached successfully`,
        skipAutoInsertCheck: false,
      });
    },
  };

  logger.debug('[AutomationService] Debug utilities exposed on window.__automationService');
}
