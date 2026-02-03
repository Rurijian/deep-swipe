/**
 * Deep Swipe Extension - User Swipe Module
 *
 * Handles swipe generation and navigation for user messages using guided impersonation.
 *
 * @author Rurijian
 * @version 1.2.0
 * @license MIT
 */

import { getContext } from '../../../extensions.js';
import { Generate, eventSource, event_types } from '../../../../script.js';
import { updateReasoningUI, ReasoningType } from '../../../../scripts/reasoning.js';
import { getSettings, EXTENSION_NAME } from './config.js';
import { syncReasoningFromSwipeInfo, error } from './utils.js';
import { updateMessageSwipeUI } from './ui.js';

/**
 * Handle navigating back on a user message
 * Uses manual swipe handling since SillyTavern blocks native user message swipes
 *
 * @param {Object} message - The message object
 * @param {number} messageId - The message ID
 * @param {number} targetSwipeId - The target swipe ID to navigate to
 * @param {Array} messagesToRestore - Messages to restore after the operation
 */
export async function handleUserSwipeBack(message, messageId, targetSwipeId, messagesToRestore) {
    const context = getContext();
    const chat = context.chat;

    // Manually update swipe_id
    message.swipe_id = targetSwipeId;

    // Load text from the new swipe
    message.mes = message.swipes[targetSwipeId];

    // Sync reasoning data from swipe_info
    syncReasoningFromSwipeInfo(message, targetSwipeId);

    // Restore hidden messages
    chat.push(...messagesToRestore);

    // Re-render the message with new swipe
    context.addOneMessage(message, {
        type: 'swipe',
        forceId: messageId,
        scroll: false,
        showSwipes: true
    });

    // Update UI including reasoning
    updateMessageSwipeUI(messageId);
    updateReasoningUI(messageId, { reset: true });
}

/**
 * Generate a new swipe for a user message using guided impersonation
 * NEW APPROACH: Generate assistant message with streaming, capture reasoning,
 * then copy to user message swipe
 *
 * @param {Object} message - The message object to generate a swipe for
 * @param {number} messageId - The message ID
 * @param {Object} context - The SillyTavern context
 */
export async function generateUserMessageSwipe(message, messageId, context) {
    const settings = getSettings();
    const impersonationPrompt = settings?.impersonationPrompt || '';
    const chat = context.chat;

    if (!impersonationPrompt) {
        toastr.warning('Please configure an impersonation prompt first to generate user message swipes.', 'Deep Swipe');
        return;
    }

    // Initialize swipes array and swipe_info if needed
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

    // Get current swipe text
    const currentText = message.mes;
    const userName = context.name1 || 'User';

    // Build the full prompt: prefix + original message
    const fullPrompt = impersonationPrompt
        .replace(/\{\{user\}\}/g, userName)
        .replace(/\{\{input\}\}/g, currentText);

    // Get the message element to show ellipsis
    const messageElement = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);

    // Show waiting toast
    const waitingToast = toastr.info('Generating Deep Swipe...', 'Deep Swipe', { timeOut: 0, extendedTimeOut: 0 });

    // Add placeholder for new swipe
    message.swipes.push('');
    message.swipe_id = message.swipes.length - 1;

    // Variables to capture reasoning data
    let capturedReasoning = '';
    let reasoningDuration = null;
    let generationStarted = null;
    let generationFinished = null;

    // Set up event listener to capture reasoning from streaming
    let streamingReasoningData = null;
    const reasoningEventHandler = (reasoning, duration, msgId, state) => {
        console.log(`[${EXTENSION_NAME}] STREAM_REASONING_DONE event fired!`);
        console.log(`[${EXTENSION_NAME}]   reasoning length:`, reasoning?.length || 0);
        console.log(`[${EXTENSION_NAME}]   duration:`, duration);
        streamingReasoningData = { reasoning, duration, state };
    };
    eventSource.on(event_types.STREAM_REASONING_DONE, reasoningEventHandler);

    // Save original messages after target BEFORE any modifications
    const originalMessagesAfter = chat.slice(messageId + 1);

    try {
        // Show ellipsis before generation starts
        if (messageElement) {
            messageElement.textContent = '...';
        }

        generationStarted = new Date();

        // Truncate chat to target message (make it the last one)
        // This ensures Generate() creates an assistant message right after
        chat.length = messageId + 1;

        // Add the impersonation prompt as a user message
        const tempUserMessage = {
            name: userName,
            is_user: true,
            mes: fullPrompt,
            send_date: new Date().toISOString(),
            extra: { isSmallSys: true },
        };
        chat.push(tempUserMessage);

        // Generate assistant message (normal mode with streaming)
        // This fires STREAM_REASONING_DONE and captures reasoning
        await Generate('normal', {
            automatic_trigger: true,
        });

        generationFinished = new Date();

        // Get the generated assistant message (should be the last one)
        const assistantMessage = chat[chat.length - 1];

        if (!assistantMessage || assistantMessage.is_user) {
            throw new Error('No assistant message generated');
        }

        // Capture text and reasoning from assistant message
        const generatedText = assistantMessage.mes;

        // Try to get reasoning from event first, then from message extra
        if (streamingReasoningData?.reasoning) {
            capturedReasoning = streamingReasoningData.reasoning;
            reasoningDuration = streamingReasoningData.duration;
            console.log(`[${EXTENSION_NAME}] Captured reasoning from stream event`);
        } else if (assistantMessage.extra?.reasoning) {
            capturedReasoning = assistantMessage.extra.reasoning;
            reasoningDuration = assistantMessage.extra.reasoning_duration;
            console.log(`[${EXTENSION_NAME}] Captured reasoning from message extra`);
        }

        // Remove the assistant message (we only wanted its content)
        chat.pop();

        // Remove the temp user message
        chat.pop();

        // Restore hidden messages
        chat.push(...originalMessagesAfter);

        // Hide the assistant message element that Generate() added
        const lastMesElement = document.querySelector('#chat .mes:last-child');
        if (lastMesElement) {
            lastMesElement.style.display = 'none';
        }

        // Remove event listener
        eventSource.removeListener(event_types.STREAM_REASONING_DONE, reasoningEventHandler);

        // Store the generated text as a swipe
        if (generatedText && generatedText.trim()) {
            const trimmedText = generatedText.trim();
            message.swipes[message.swipe_id] = trimmedText;
            message.mes = trimmedText;

            // Ensure message keeps its user properties
            message.is_user = true;
            if (!message.name || message.name === 'System') {
                message.name = context.name1 || 'User';
            }

            // Create swipe_info entry with reasoning data
            const swipeInfoExtra = {
                ...structuredClone(message.extra || {}),
            };

            if (capturedReasoning) {
                swipeInfoExtra.reasoning = capturedReasoning;
                swipeInfoExtra.reasoning_duration = reasoningDuration;
                swipeInfoExtra.reasoning_type = ReasoningType.Model;
                console.log(`[${EXTENSION_NAME}] Stored reasoning in swipe:`, capturedReasoning.substring(0, 50) + '...');
            }

            message.swipe_info.push({
                send_date: generationFinished.toISOString(),
                gen_started: generationStarted,
                gen_finished: generationFinished,
                extra: swipeInfoExtra,
            });

            // Update current message extra with reasoning for immediate display
            if (capturedReasoning) {
                if (!message.extra) message.extra = {};
                message.extra.reasoning = capturedReasoning;
                message.extra.reasoning_duration = reasoningDuration;
                message.extra.reasoning_type = ReasoningType.Model;
            }
        } else {
            throw new Error('Generation failed: no text received');
        }

        // Remove waiting toast
        if (waitingToast) {
            $(waitingToast).remove();
        }

        // Update reasoning UI
        if (capturedReasoning) {
            updateReasoningUI(messageId);
        }

    } catch (err) {
        error('Error in guided impersonation:', err);

        // Cleanup: restore chat state
        chat.length = messageId + 1;
        chat.push(...originalMessagesAfter);

        // Remove event listener
        eventSource.removeListener(event_types.STREAM_REASONING_DONE, reasoningEventHandler);

        // Remove waiting toast
        if (waitingToast) {
            $(waitingToast).remove();
        }
        // Revert swipe
        message.swipes.pop();
        message.swipe_info?.pop();
        message.swipe_id = Math.max(0, message.swipes.length - 1);
        // Restore original message text in UI
        if (messageElement) {
            messageElement.textContent = currentText;
        }
        throw err;
    }
}
