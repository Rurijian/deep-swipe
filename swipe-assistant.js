/**
 * Deep Swipe Extension - Assistant Swipe Module
 *
 * Handles swipe generation and navigation for assistant messages.
 *
 * @author Rurijian
 * @version 1.2.0
 * @license MIT
 */

import { getContext } from '../../../extensions.js';
import { saveChatConditional } from '../../../../script.js';
import { getSettings, EXTENSION_NAME } from './config.js';
import {
    isValidMessageId,
    isMessageSwipeable,
    isAnyMessageBeingEdited,
    error
} from './utils.js';
import { addSwipeNavigationToMessage, updateMessageSwipeUI } from './ui.js';

/**
 * Navigate to the previous swipe on an assistant message
 * @param {Object} args - Command arguments
 * @param {number} messageId - The message ID to navigate back on
 * @returns {Promise<string>} Result message
 */
export async function dswipeBack(args, messageId) {
    // Check if any message is being edited
    if (isAnyMessageBeingEdited()) {
        toastr.warning('Cannot swipe while a message is being edited. Please finish editing first.', 'Deep Swipe');
        return 'Cannot swipe while editing';
    }

    const context = getContext();
    const chat = context.chat;

    if (!isValidMessageId(messageId, chat)) {
        toastr.error(`Invalid message ID: ${messageId}`, 'Deep Swipe');
        return 'Invalid message ID';
    }

    const message = chat[messageId];

    if (!Array.isArray(message.swipes) || message.swipes.length <= 1) {
        return 'No swipes to navigate';
    }

    const currentId = message.swipe_id || 0;
    const targetSwipeId = Math.max(0, currentId - 1);

    // SillyTavern only allows swiping the last message.
    // Temporarily hide messages after target to make it the last message.
    const messagesToRestore = chat.slice(messageId + 1);
    chat.length = messageId + 1;

    try {
        // For user messages, SillyTavern blocks native swipe, so we handle it manually
        if (message.is_user) {
            // Import user swipe handler for user messages
            const { handleUserSwipeBack } = await import('./swipe-user.js');
            await handleUserSwipeBack(message, messageId, targetSwipeId, messagesToRestore);
            return `Navigated to swipe ${message.swipe_id + 1}/${message.swipes.length}`;
        } else {
            // For assistant messages, use native swipe
            await context.swipe.left(null, {
                message: message,
                forceMesId: messageId,
                forceSwipeId: targetSwipeId
            });

            // Restore hidden messages
            chat.push(...messagesToRestore);

            // Re-render the message with new swipe
            context.addOneMessage(message, {
                type: 'swipe',
                forceId: messageId,
                scroll: false,
                showSwipes: true
            });

            // Update UI
            updateMessageSwipeUI(messageId);

            return `Navigated to swipe ${message.swipe_id + 1}/${message.swipes.length}`;
        }
    } catch (err) {
        chat.push(...messagesToRestore);
        error('Error:', err);
        return 'Navigation failed';
    }
}

/**
 * Generate a new swipe for a message (assistant or user)
 * @param {Object} args - Command arguments
 * @param {number} messageId - The message ID to generate a swipe for
 * @returns {Promise<string>} Result message
 */
export async function dswipeForward(args, messageId) {
    // Check if any message is being edited
    if (isAnyMessageBeingEdited()) {
        toastr.warning('Cannot swipe while a message is being edited. Please finish editing first.', 'Deep Swipe');
        return 'Cannot swipe while editing';
    }

    const context = getContext();
    const chat = context.chat;

    if (!isValidMessageId(messageId, chat)) {
        toastr.error(`Invalid message ID: ${messageId}`, 'Deep Swipe');
        return 'Invalid message ID';
    }

    const message = chat[messageId];

    if (!isMessageSwipeable(message)) {
        const reason = message.is_user ? 'User messages' :
                      message.is_system ? 'System messages' :
                      message.extra?.isSmallSys ? 'Small system messages' :
                      'This message';
        toastr.error(`${reason} cannot be swiped.`, 'Deep Swipe');
        return 'Message not swipeable';
    }

    const messagesToRestore = chat.slice(messageId + 1);
    chat.length = messageId + 1;

    if (messagesToRestore.length > 0) {
        toastr.info(`Temporarily hiding ${messagesToRestore.length} message(s)...`, 'Deep Swipe');
    }

    try {
        // Check if this is a user message that needs guided impersonation
        const settings = getSettings();
        if (message.is_user && settings?.impersonationPrompt) {
            const { generateUserMessageSwipe } = await import('./swipe-user.js');
            await generateUserMessageSwipe(message, messageId, context);
        } else {
            await context.swipe.right(null, { message, forceMesId: messageId });
        }

        chat.push(...messagesToRestore);

        // CRITICAL FIX: Get the UPDATED message from chat array after generation/swipe
        // The 'message' variable might be stale if the generation/swipe modified it
        const updatedMessage = chat[messageId];

        context.addOneMessage(updatedMessage, {
            type: 'swipe',
            forceId: messageId,
            scroll: false,
            showSwipes: true
        });

        if (settings?.swipeNavigation) {
            setTimeout(() => {
                addSwipeNavigationToMessage(messageId);
                updateMessageSwipeUI(messageId);
            }, 100);
        }

        // Save the chat to persist the new swipe
        await saveChatConditional();

        toastr.success(`Generated new swipe for message #${messageId}`, 'Deep Swipe');
        return 'Generated new swipe';

    } catch (err) {
        chat.push(...messagesToRestore);
        error('Error:', err);
        toastr.error(`Failed to generate swipe: ${err.message}`, 'Deep Swipe');
        return 'Generation failed';
    }
}
