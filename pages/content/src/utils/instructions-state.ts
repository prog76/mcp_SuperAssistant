/**
 * 系统提示词（Instructions）全局共享状态。
 *
 * InstructionManager 生成 instructions 后写入这里；mcpPopover、compaction.service 等
 * 非 React 模块也能读取当前系统提示词（如压缩新会话时携带）。
 * 独立成模块以避免从 React 组件导入引发的循环依赖。
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
