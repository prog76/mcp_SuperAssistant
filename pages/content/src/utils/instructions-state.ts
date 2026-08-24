/**
 * Globally shared state for the system prompt (Instructions).
 *
 * InstructionManager writes generated instructions here; non-React modules such as mcpPopover
 * and compaction.service can read the current system prompt (e.g. to carry it into a compacted new conversation).
 * Standalone module to avoid circular dependencies from React component imports.
 */
import { createLogger } from '@extension/shared/lib/logger';

const logger = createLogger('InstructionsState');

export const instructionsState = {
  instructions: '',
  updating: false, // Flag to prevent circular updates

  setInstructions: (newInstructions: string) => {
    // Don't update if the value hasn't changed
    if (instructionsState.instructions === newInstructions) {
      return;
    }

    // Prevent recursive updates
    if (instructionsState.updating) {
      logger.warn('[InstructionsState] Prevented recursive update');
      return;
    }

    // Set flag to prevent circular updates
    instructionsState.updating = true;
    instructionsState.instructions = newInstructions;

    logger.debug(`Broadcasting instruction update to ${instructionsState.listeners.length} listeners`);

    // Call all registered listeners when instructions change
    try {
      instructionsState.listeners.forEach((listener, index) => {
        try {
          listener(newInstructions);
        } catch (error) {
          logger.error(`Error in listener ${index}:`, error);
        }
      });
    } finally {
      // Reset flag immediately after all listeners have been called
      instructionsState.updating = false;
    }
  },

  listeners: [] as ((instructions: string) => void)[],

  subscribe: (listener: (instructions: string) => void) => {
    instructionsState.listeners.push(listener);
    logger.debug(`Listener subscribed (total: ${instructionsState.listeners.length})`);
    // Return unsubscribe function
    return () => {
      const index = instructionsState.listeners.indexOf(listener);
      if (index !== -1) {
        instructionsState.listeners.splice(index, 1);
        logger.debug(`Listener unsubscribed (total: ${instructionsState.listeners.length})`);
      }
    };
  },
};
