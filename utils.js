/**
 * Deep Swipe Extension - Utilities Module
 *
 * Shared helper functions used across the extension.
 *
 * @author Rurijian
 * @version 1.2.0
 * @license MIT
 */

import { getContext } from '../../../extensions.js';
import { getSettings, EXTENSION_NAME } from './config.js';

/**
 * Validates if a message ID is valid for the current chat
 * @param {number} messageId - The message ID to validate
 * @param {Array} chat - The chat array
 * @returns {boolean} True if the message ID is valid
 */
export function isValidMessageId(messageId, chat) {
    return typeof messageId === 'number' &&
           !isNaN(messageId) &&
           messageId >= 0 &&
           messageId < chat.length;
}

/**
 * Checks if a message can be swiped based on its type and settings
 * @param {Object} message - The message object to check
 * @returns {boolean} True if the message is swipeable
 */
export function isMessageSwipeable(message) {
    const settings = getSettings();

    // Allow user messages if userSwipes setting is enabled
    if (message.is_user && !settings?.userSwipes) return false;
    if (message.is_system) return false;
    if (message.extra?.isSmallSys) return false;
    if (message.extra?.swipeable === false) return false;
    return true;
}

/**
 * Format swipe counter like "2/5"
 * @param {number} current - Current swipe index (0-based)
 * @param {number} total - Total number of swipes
 * @returns {string} Formatted counter string
 */
export function formatSwipeCounter(current, total) {
    if (!total || total <= 0) return '';
    return `${current + 1}/${total}`;
}

/**
 * Sync reasoning and model data from swipe_info to message extra
 * @param {Object} message - The message object
 * @param {number} swipeId - The swipe ID to sync from
 */
export function syncReasoningFromSwipeInfo(message, swipeId) {
    if (!message.swipe_info || !message.swipe_info[swipeId]) {
        return;
    }

    const swipeInfo = message.swipe_info[swipeId];
    if (!message.extra) {
        message.extra = {};
    }

    // Sync reasoning data
    if (swipeInfo.extra?.reasoning !== undefined) {
        message.extra.reasoning = swipeInfo.extra.reasoning;
    } else {
        delete message.extra.reasoning;
    }

    if (swipeInfo.extra?.reasoning_duration !== undefined) {
        message.extra.reasoning_duration = swipeInfo.extra.reasoning_duration;
    } else {
        delete message.extra.reasoning_duration;
    }

    if (swipeInfo.extra?.reasoning_type !== undefined) {
        message.extra.reasoning_type = swipeInfo.extra.reasoning_type;
    } else {
        delete message.extra.reasoning_type;
    }

    // Sync API and model data for model icon display
    if (swipeInfo.extra?.api !== undefined) {
        message.extra.api = swipeInfo.extra.api;
    }
    if (swipeInfo.extra?.model !== undefined) {
        message.extra.model = swipeInfo.extra.model;
    }
}

/**
 * Store the current message ID being edited for delete swipe functionality
 * @type {number|null}
 */
let currentEditMessageId = null;

/**
 * Check if a message has multiple swipes and can delete swipe
 * @param {number} messageId - The message ID to check
 * @returns {boolean} True if the swipe can be deleted
 */
export function canDeleteSwipe(messageId) {
    const context = getContext();
    const chat = context.chat;

    if (!isValidMessageId(messageId, chat)) {
        return false;
    }

    const message = chat[messageId];
    return Array.isArray(message.swipes) && message.swipes.length > 1;
}

/**
 * Track which message is being edited to support delete swipe in confirmation popup
 * @param {number} messageId - The message ID being edited
 */
export function trackEditMessage(messageId) {
    currentEditMessageId = messageId;
}

/**
 * Clear tracked edit message
 */
export function clearEditMessage() {
    currentEditMessageId = null;
}

/**
 * Check if any message is currently being edited
 * This is used to disable swipes globally while editing
 * @returns {boolean} True if any message is being edited
 */
export function isAnyMessageBeingEdited() {
    // Check for edit textarea presence which indicates edit mode
    const editTextareas = document.querySelectorAll('.mes .edit_textarea');
    return editTextareas.length > 0;
}

/**
 * Get the current swipe index for delete confirmation popup
 * This is used by the event interceptor to pass swipe info to deleteMessage
 * @returns {number|undefined} The swipe index or undefined
 */
export function getSwipeIndexForDelete() {
    if (currentEditMessageId === null) return undefined;

    const context = getContext();
    const chat = context.chat;

    if (!isValidMessageId(currentEditMessageId, chat)) {
        return undefined;
    }

    const message = chat[currentEditMessageId];

    // Only offer delete swipe for user messages with multiple swipes
    if (!message.is_user || !canDeleteSwipe(currentEditMessageId)) {
        return undefined;
    }

    // Return the current swipe ID for deletion
    return message.swipe_id ?? 0;
}

/**
 * Get the current edit message ID
 * @returns {number|null} The current edit message ID
 */
export function getCurrentEditMessageId() {
    return currentEditMessageId;
}

/**
 * Ensure a message has swipes array and swipe_info initialized
 * @param {Object} message - The message to ensure swipes for
 * @returns {Object} The message with swipes initialized
 */
export function ensureSwipes(message) {
    if (!message || typeof message !== 'object') {
        console.trace(`[${EXTENSION_NAME}] [ensureSwipes] failed. '${message}' is not an object.`);
        return null;
    }
    if (!Array.isArray(message.swipes)) {
        message.swipes = [message.mes];
        message.swipe_id = 0;
    }
    if (!Array.isArray(message.swipe_info)) {
        message.swipe_info = message.swipes.map(() => ({
            send_date: message.send_date,
            gen_started: message.gen_started,
            gen_finished: message.gen_finished,
            extra: structuredClone(message.extra || {}),
        }));
    }
    return message;
}

/**
 * Log a message with the extension prefix
 * @param {string} message - The message to log
 * @param {...any} args - Additional arguments
 */
export function log(message, ...args) {
    console.log(`[${EXTENSION_NAME}] ${message}`, ...args);
}

/**
 * Log an error with the extension prefix
 * @param {string} message - The error message
 * @param {...any} args - Additional arguments
 */
export function error(message, ...args) {
    console.error(`[${EXTENSION_NAME}] ${message}`, ...args);
}
