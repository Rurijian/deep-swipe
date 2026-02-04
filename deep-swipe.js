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
import { Generate, eventSource, event_types, cancelDebouncedChatSave, saveChatConditional, stopGeneration } from '../../../../script.js';
import { updateReasoningUI, ReasoningType } from '../../../../scripts/reasoning.js';
import { getSettings, EXTENSION_NAME } from './config.js';
import { syncReasoningFromSwipeInfo, error, isValidMessageId } from './utils.js';
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
    // Note: addOneMessage already called updateReasoningUI, so we don't need to call it again
    // Calling it with reset:true would clear the reasoning we just synced!
}

/**
 * Generate a new swipe for a message (user or assistant) using guided generation
 * NEW APPROACH: Generate assistant message with streaming, capture reasoning,
 * then copy to message swipe
 *
 * @param {Object} message - The message object to generate a swipe for
 * @param {number} messageId - The message ID
 * @param {Object} context - The SillyTavern context
 * @param {boolean} isUserMessage - Whether this is a user message (true) or assistant (false)
 */
export async function generateMessageSwipe(message, messageId, context, isUserMessage = true) {
    // Check if Prompt Inspector is enabled - BLOCK generation if so
    const promptInspectorEnabled = localStorage.getItem('promptInspectorEnabled') === 'true';
    if (promptInspectorEnabled) {
        toastr.error(
            'Deep Swipe generation is disabled while Prompt Inspector is enabled.\n\n' +
            'Please disable Prompt Inspector (click "Stop Inspecting" in the wand menu) to use Deep Swipe generation.',
            'Deep Swipe Blocked',
            { timeOut: 0, extendedTimeOut: 0, closeButton: true }
        );
        return;
    }

    const settings = getSettings();
    const impersonationPrompt = settings?.impersonationPrompt || '';
    const chat = context.chat;

    if (isUserMessage && !impersonationPrompt) {
        toastr.warning('Please configure an impersonation prompt first to generate user message swipes.', 'Deep Swipe');
        return;
    }

    // Track if this specific Deep Swipe generation is active
    let isOurGeneration = false;

    // CRITICAL: Capture ALL original data BEFORE any truncation or modifications
    // For assistant swipes, truncation removes the target, so we MUST capture first
    const currentText = message.mes;
    
    // SAFETY: Fix corrupt swipe data if swipe_id is out of bounds
    if (message.swipe_id >= message.swipes?.length) {
        console.warn(`[${EXTENSION_NAME}] Fixing corrupt swipe_id: ${message.swipe_id} >= ${message.swipes?.length}, resetting to 0`);
        message.swipe_id = 0;
    }
    const originalSwipeId = message.swipe_id || 0;
    
    // Store complete original message state for restoration (especially for assistant swipes)
    const originalMessageState = {
        text: message.mes,
        swipeId: message.swipe_id || 0,
        swipes: message.swipes ? [...message.swipes] : [message.mes],
        swipe_info: message.swipe_info ? structuredClone(message.swipe_info) : [],
        extra: structuredClone(message.extra || {}),
        name: message.name,
        is_user: message.is_user
    };
    
    // Initialize swipes array and swipe_info if needed on the local message
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

    // Get the target message (for assistant swipes, this will become stale after truncation)
    const targetMessage = isUserMessage ? message : chat[messageId];

    // Store original swipe info for keepSwipeVisible mode
    // For assistant swipes, we MUST use originalMessageState since the message gets replaced
    const originalSwipeText = isUserMessage 
        ? (message.swipes?.[originalSwipeId] || currentText)
        : originalMessageState.swipes[originalSwipeId] || currentText;
        
    const originalSwipeExtra = isUserMessage
        ? (message.swipe_info?.[originalSwipeId]?.extra
            ? structuredClone(message.swipe_info[originalSwipeId].extra)
            : structuredClone(message.extra || {}))
        : (originalMessageState.swipe_info[originalSwipeId]?.extra
            ? structuredClone(originalMessageState.swipe_info[originalSwipeId].extra)
            : structuredClone(originalMessageState.extra));
    
    const userName = context.name1 || 'User';
    const charName = context.name2 || 'Assistant';

    // Build the full prompt based on message type
    let fullPrompt;
    if (isUserMessage) {
        // User message: use impersonation prompt
        fullPrompt = impersonationPrompt
            .replace(/\{\{user\}\}/g, userName)
            .replace(/\{\{input\}\}/g, currentText);
    }
    // Note: Assistant swipes don't need a fullPrompt - they truncate and regenerate naturally

    // Get the message element to show ellipsis (or not if keepSwipeVisible is enabled)
    const messageElement = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
    const mesElement = document.querySelector(`.mes[mesid="${messageId}"]`);

    // Show waiting toast
    const waitingToast = toastr.info('Generating Deep Swipe...', 'Deep Swipe', { timeOut: 0, extendedTimeOut: 0 });

    // For USER swipes: Add placeholder now (message won't change)
    // For ASSISTANT swipes: Add placeholder now too (both use same flow now)
    let newSwipeIndex;
    if (isUserMessage) {
        // CRITICAL FIX: Store a unique identifier for the target message
        // The array index becomes invalid after cleanup/restore operations
        // because the chat array gets completely rebuilt
        const targetMessageObject = message; // Keep reference to original object
        
        if (!Array.isArray(targetMessageObject.swipes)) {
            targetMessageObject.swipes = [targetMessageObject.mes];
            targetMessageObject.swipe_id = 0;
        }
        targetMessageObject.swipes.push('');
        newSwipeIndex = targetMessageObject.swipes.length - 1;
        targetMessageObject.swipe_id = newSwipeIndex;
        
    } else {
        // ASSISTANT swipes: Also need to initialize newSwipeIndex
        const targetMessageObject = chat[messageId];
        
        if (!Array.isArray(targetMessageObject.swipes)) {
            targetMessageObject.swipes = [targetMessageObject.mes];
            targetMessageObject.swipe_id = 0;
        }
        targetMessageObject.swipes.push('');
        newSwipeIndex = targetMessageObject.swipes.length - 1;
        targetMessageObject.swipe_id = newSwipeIndex;
    }

    // Variables to capture reasoning data
    let capturedReasoning = '';
    let reasoningDuration = null;
    let generationStarted = null;
    let generationFinished = null;

    // Save original messages after target BEFORE any modifications
    const originalMessagesAfter = chat.slice(messageId + 1);
    // For assistant swipes: also save the target message since we truncate to remove it
    const originalTargetMessage = !isUserMessage ? chat[messageId] : null;

    // Set up event listener to capture reasoning from streaming
    let streamingReasoningData = null;
    const reasoningEventHandler = (reasoning, duration, msgId, state) => {
        streamingReasoningData = { reasoning, duration, state };
    };
    eventSource.on(event_types.STREAM_REASONING_DONE, reasoningEventHandler);

    // Set up abort detection for graceful handling of stopped generations
    let generationAborted = false;
    let abortCleanupDone = false;
    
    // Shared cleanup function for when generation is stopped
    const performAbortCleanup = async () => {
        if (abortCleanupDone) return;
        abortCleanupDone = true;
        
        // Remove event listeners
        eventSource.removeListener(event_types.STREAM_REASONING_DONE, reasoningEventHandler);
        eventSource.removeListener(event_types.GENERATION_STOPPED, abortHandler);
        
        // Revert swipe data BEFORE restoring chat (we still have the message reference)
        const targetMessage = isUserMessage ? message : originalTargetMessage;
        if (targetMessage) {
            // Remove the empty swipe we added for generation
            if (targetMessage.swipes.length > 0) {
                targetMessage.swipes.pop();
            }
            if (targetMessage.swipe_info && targetMessage.swipe_info.length > 0) {
                targetMessage.swipe_info.pop();
            }
            // Reset to previous swipe
            targetMessage.swipe_id = Math.max(0, targetMessage.swipes.length - 1);
            // Restore the original text
            targetMessage.mes = targetMessage.swipes[targetMessage.swipe_id] || currentText;
        }
        
        // CRITICAL: Restore chat array - truncate and rebuild
        if (isUserMessage) {
            // User swipes: truncate to messageId + 1 (keep target), then restore messages after
            chat.length = messageId + 1;
            chat.push(...originalMessagesAfter);
        } else {
            // Assistant swipes: truncate to messageId (target was removed), restore target + messages after
            chat.length = messageId;
            if (originalTargetMessage) {
                chat.push(originalTargetMessage);
            }
            chat.push(...originalMessagesAfter);
        }
        
        // CRITICAL: Remove only stale/dangling DOM elements
        // Don't remove valid messages - let addOneMessage handle re-rendering
        document.querySelectorAll('.mes[mesid^="stale-"]').forEach(el => {
            el.remove();
        });
        
        // Clean up UI
        if (waitingToast) {
            $(waitingToast).remove();
        }
        if (mesElement) {
            mesElement.classList.remove('deep-swipe-loading');
        }
        
        // Remove overlay
        const { removeSwipeOverlay } = await import('./ui.js');
        removeSwipeOverlay(messageId);
        
        // Re-render the target message to restore its UI state
        if (targetMessage) {
            context.addOneMessage(targetMessage, {
                type: 'swipe',
                forceId: messageId,
                scroll: false,
                showSwipes: true
            });
        }
        
        toastr.warning('Deep Swipe generation was stopped.', 'Deep Swipe');
    };
    
    const abortHandler = () => {
        generationAborted = true;
        // Only run cleanup if this is our generation being stopped
        if (!isOurGeneration) {
            return;
        }
        // Trigger cleanup immediately when generation stops
        performAbortCleanup();
    };
    eventSource.once(event_types.GENERATION_STOPPED, abortHandler);

    try {
        // Always keep swipe visible during generation (Deep Swipe default behavior)
        if (mesElement) {
            mesElement.classList.add('deep-swipe-loading');
        }

        generationStarted = new Date();

        // Cancel any pending chat save to prevent temp messages from being saved
        cancelDebouncedChatSave();

        // Check auto-advance setting early
        const shouldAutoAdvance = settings?.autoAdvanceToLatest ?? false;

        // Create overlay for "read while generating" experience (for both user and assistant)
        // This shows the current swipe content during generation
        const { createSwipeOverlay } = await import('./ui.js');
        createSwipeOverlay(messageId, message, {
            showThrobber: true,
            onComplete: null,
            onStop: () => {
                // Mark that we intentionally stopped our own generation
                isOurGeneration = true;
                // Stop generation when user clicks the stop button
                // This triggers GENERATION_STOPPED which calls abortHandler
                stopGeneration();
            }
        });

        if (isUserMessage) {
            // USER MESSAGE: Truncate to target, add temp user message, then generate
            chat.length = messageId + 1;
            
            // CRITICAL: Invalidate stale DOM elements' mesid so Generate() can't find them
            // Generate() looks for elements by mesid, so we add a prefix to make them unfindable
            for (let i = messageId + 1; i < 100; i++) {
                const el = document.querySelector(`.mes[mesid="${i}"]`);
                if (el) {
                    el.setAttribute('mesid', `stale-${i}`);
                } else {
                    break;
                }
            }

            const tempUserMessage = {
                name: userName,
                is_user: true,
                mes: fullPrompt,
                send_date: new Date().toISOString(),
                extra: { isSmallSys: true, isDeepSwipeTemp: true },
            };
            chat.push(tempUserMessage);

            // Generate assistant response to the impersonation prompt
            await Generate('normal', {
                automatic_trigger: true,
            });
        } else {
            // ASSISTANT MESSAGE: Regenerate like a native swipe
            // - Remove the target assistant message from chat context
            // - Find the last user message before it
            // - Truncate to that user message (context before the target)
            // - Generate creates a new response
            // - Capture that response as a new swipe on the target
            
            // Find the last user message before the target (to set proper context)
            let lastUserMessageId = -1;
            for (let i = messageId - 1; i >= 0; i--) {
                if (chat[i].is_user) {
                    lastUserMessageId = i;
                    break;
                }
            }
            
            // Truncate to just before the target message
            // This removes the target from context so Generate() creates a new response
            chat.length = messageId;
            
            // CRITICAL: Invalidate stale DOM elements' mesid for removed messages
            for (let i = messageId; i < 100; i++) {
                const el = document.querySelector(`.mes[mesid="${i}"]`);
                if (el) {
                    el.setAttribute('mesid', `stale-${i}`);
                } else {
                    break;
                }
            }
            
            console.log('[Deep Swipe] Assistant swipe: calling Generate() after truncating to', chat.length);
            // Generate assistant response (continues from the last message before target)
            await Generate('normal', {
                automatic_trigger: true,
            });
            console.log('[Deep Swipe] Assistant swipe: Generate() completed');
        }

        generationFinished = new Date();

        // Check if generation was aborted by the user
        if (generationAborted) {
            // Cleanup was already done by abortHandler, just remove event listener
            eventSource.removeListener(event_types.STREAM_REASONING_DONE, reasoningEventHandler);
            return;
        }

        // IMMEDIATE CLEANUP: Remove temp messages RIGHT after Generate() returns
        // This is critical to prevent any saves that might trigger after generation

        console.log('[Deep Swipe] After Generate(), chat length:', chat.length);
        
        // Get the generated assistant message BEFORE any cleanup
        // Both user and assistant swipes now generate at the bottom (last message)
        const assistantMessage = chat[chat.length - 1];
        console.log('[Deep Swipe] Assistant message:', assistantMessage?.mes?.substring(0, 50));

        if (!assistantMessage || assistantMessage.is_user) {
            console.error('[Deep Swipe] No assistant message generated! Last message:', chat[chat.length - 1]);
            throw new Error('No assistant message generated');
        }

        // Capture text and reasoning from assistant message BEFORE cleanup
        const generatedText = assistantMessage.mes;
        const assistantReasoning = assistantMessage.extra?.reasoning;
        const assistantReasoningDuration = assistantMessage.extra?.reasoning_duration;

        // CRITICAL: Cancel any pending saves immediately after generation
        // Other event handlers (like reasoning auto-parse) may have triggered saves
        cancelDebouncedChatSave();

        // Remove the generated assistant message from the end
        // (Both user and assistant swipes now generate at the bottom)
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i] === assistantMessage) {
                chat.splice(i, 1);
                break;
            }
        }

        // Find and remove temp messages
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]?.extra?.isDeepSwipeTemp) {
                chat.splice(i, 1);
            }
        }

        // Try to get reasoning from stream event first (more reliable during streaming)
        if (streamingReasoningData?.reasoning) {
            capturedReasoning = streamingReasoningData.reasoning;
            reasoningDuration = streamingReasoningData.duration;
        }
        // Fall back to captured reasoning from assistant message if no stream data
        else if (assistantReasoning) {
            capturedReasoning = assistantReasoning;
            reasoningDuration = assistantReasoningDuration;
        }

        // Restore hidden messages FIRST (before restoring mesid attributes)
        // User swipes: truncate to messageId + 1, insert after target
        // Assistant swipes: truncate to messageId (removed target), need to re-insert target then messages after
        if (isUserMessage) {
            // User swipes: insert messages after target
            chat.splice(messageId + 1, 0, ...originalMessagesAfter);
        } else {
            // Assistant swipes: re-insert target message, then messages after it
            if (originalTargetMessage) {
                chat.splice(messageId, 0, originalTargetMessage);
            }
            chat.splice(messageId + 1, 0, ...originalMessagesAfter);
        }

        // Restore the mesid attributes after restoring messages
        // For user swipes: restore from messageId + 1
        // For assistant swipes: restore from messageId (since target was removed and re-inserted)
        const restoreStartIndex = isUserMessage ? messageId + 1 : messageId;
        for (let i = restoreStartIndex; i < 100; i++) {
            const el = document.querySelector(`.mes[mesid="stale-${i}"]`);
            if (el) {
                el.setAttribute('mesid', `${i}`);
            } else {
                break;
            }
        }

        // CRITICAL: Cancel saves after restoring chat state
        cancelDebouncedChatSave();

        // EMERGENCY CLEANUP: If temp message somehow persisted, remove it now
        const tempIndexAfter = chat.findIndex(m => m.extra?.isDeepSwipeTemp);
        if (tempIndexAfter !== -1) {
            chat.splice(tempIndexAfter, 1);
        }

        // Remove event listener
        eventSource.removeListener(event_types.STREAM_REASONING_DONE, reasoningEventHandler);

        // Store the generated text as a swipe
        if (generatedText && generatedText.trim()) {
            const trimmedText = generatedText.trim();

            // CRITICAL FIX: For USER swipes, use the original 'message' parameter directly
            // The 'message' parameter maintains object identity throughout the operation
            // chat[messageId] becomes invalid after array cleanup/restore operations
            // For assistant swipes: chat[messageId] is still valid since we didn't truncate it
            const actualTargetMessage = isUserMessage ? message : chat[messageId];
            
            if (!actualTargetMessage) {
                throw new Error(`Target message not found at index ${messageId}`);
            }
            
            const wasUserMessage = actualTargetMessage.is_user;
            
            // Ensure the target message has swipe_info array
            if (!Array.isArray(actualTargetMessage.swipe_info)) {
                actualTargetMessage.swipe_info = actualTargetMessage.swipes.map(() => ({
                    send_date: actualTargetMessage.send_date,
                    gen_started: actualTargetMessage.gen_started,
                    gen_finished: actualTargetMessage.gen_finished,
                    extra: structuredClone(actualTargetMessage.extra || {}),
                }));
            }

            // Store the new swipe content
            actualTargetMessage.swipes[newSwipeIndex] = trimmedText;

            // Keep the original swipe content in message.mes (Deep Swipe always keeps visible)
            // The new swipe is stored in message.swipes[newSwipeIndex]

            // Ensure message keeps its original properties
            actualTargetMessage.is_user = wasUserMessage;
            if (wasUserMessage) {
                if (!actualTargetMessage.name || actualTargetMessage.name === 'System') {
                    actualTargetMessage.name = context.name1 || 'User';
                }
            } else {
                if (!actualTargetMessage.name || actualTargetMessage.name === 'System') {
                    actualTargetMessage.name = context.name2 || 'Assistant';
                }
            }

            // Create swipe_info entry with reasoning data
            const swipeInfoExtra = {
                ...structuredClone(actualTargetMessage.extra || {}),
            };

            if (capturedReasoning) {
                swipeInfoExtra.reasoning = capturedReasoning;
                swipeInfoExtra.reasoning_duration = reasoningDuration;
                swipeInfoExtra.reasoning_type = ReasoningType.Model;
            }

            actualTargetMessage.swipe_info.push({
                send_date: generationFinished.toISOString(),
                gen_started: generationStarted,
                gen_finished: generationFinished,
                extra: swipeInfoExtra,
            });

            // NOTE: We DON'T update message.extra.reasoning because we're staying on the
            // original swipe (Deep Swipe always keeps swipe visible). The new swipe's
            // reasoning is stored in swipe_info[newSwipeIndex].extra via the push above.
        } else {
            throw new Error('Generation failed: no text received');
        }

        // Remove waiting toast
        if (waitingToast) {
            $(waitingToast).remove();
        }

        // Remove loading indicator
        if (mesElement) {
            mesElement.classList.remove('deep-swipe-loading');
        }

        // Import UI functions for completion handling
        const {
            completeSwipeOverlay,
            fadeOutAndRemoveSwipeOverlay,
            highlightLatestSwipeMessage,
            removeSwipeOverlay
        } = await import('./ui.js');

        // Mark overlay as complete and show completion message
        // For auto-advance: fade out after delay
        // For non-auto-advance: keep showing completion message until user switches swipes
        completeSwipeOverlay(messageId, {
            autoFadeOut: shouldAutoAdvance,
            fadeDelay: 1200
        });

        // If not auto-advancing, remove overlay immediately (completion message was shown)
        // The actual message will show the new swipe content
        if (!shouldAutoAdvance) {
            // Remove overlay after a brief delay to show completion message
            setTimeout(() => {
                removeSwipeOverlay(messageId);
            }, 1500);
        }

        // Add faint border highlight to the message with the latest swipe
        // This helps users locate the message after generation
        // Highlight stays until user clicks, then fades away
        highlightLatestSwipeMessage(messageId);

        if (shouldAutoAdvance) {
            // Auto-advance: show the newly generated swipe (latest)
            // CRITICAL: Use the same reference we stored the swipe to
            // For assistant swipes, use originalTargetMessage since chat[messageId] was truncated
            const targetMessage = isUserMessage ? message : (originalTargetMessage || chat[messageId]);
            targetMessage.swipe_id = newSwipeIndex;
            // Use targetMessage.swipes (not message.swipes) - especially important for assistant swipes
            targetMessage.mes = targetMessage.swipes[newSwipeIndex];
            
            // Set extra from the new swipe's info
            const newSwipeInfo = targetMessage.swipe_info[newSwipeIndex];
            if (newSwipeInfo?.extra) {
                targetMessage.extra = structuredClone(newSwipeInfo.extra);
            }
            
            const { updateMessageSwipeUI, addSwipeNavigationToMessage } = await import('./ui.js');

            // CRITICAL: Remove the dangling assistant message element from DOM
            // The Generate() function added this element, but we removed the message from chat array
            // We need to remove it from DOM before re-rendering to avoid duplicates
            const messageElements = document.querySelectorAll('#chat .mes');
            if (messageElements.length > chat.length) {
                // The last element is the dangling assistant message
                const danglingElement = messageElements[messageElements.length - 1];
                if (danglingElement) {
                    danglingElement.remove();
                }
            }

            // Re-render to show the new swipe
            context.addOneMessage(targetMessage, {
                type: 'swipe',
                forceId: messageId,
                scroll: false,
                showSwipes: true
            });
            
            // Update UI counter and navigation
            updateMessageSwipeUI(messageId);
            addSwipeNavigationToMessage(messageId);
            
            // Update reasoning UI for the new swipe
            if (newSwipeInfo?.extra?.reasoning) {
                setTimeout(() => {
                    updateReasoningUI(messageId);
                }, 100);
            }
        } else {
            // Default: stay on original swipe (Deep Swipe behavior - read while generating)
            // The new swipe is stored in message.swipes[newSwipeIndex]
            // Restore the original swipe for display purposes
            // CRITICAL: Use the same message reference we stored the swipe to
            // For assistant swipes, use originalTargetMessage since chat[messageId] was truncated
            const targetMessage = isUserMessage ? message : (originalTargetMessage || chat[messageId]);
            targetMessage.swipe_id = originalSwipeId;
            targetMessage.mes = originalSwipeText;
            
            // Restore original extra data with reasoning
            if (originalSwipeExtra) {
                targetMessage.extra = originalSwipeExtra;
            }

            const { updateMessageSwipeUI, addSwipeNavigationToMessage } = await import('./ui.js');
            const { syncReasoningFromSwipeInfo } = await import('./utils.js');
            
            // CRITICAL: Remove the dangling assistant message element from DOM
            // The Generate() function added this element, but we removed/replaced the message from chat array
            // We need to remove it from DOM before re-rendering to avoid duplicates
            const messageElements = document.querySelectorAll('#chat .mes');
            if (messageElements.length > chat.length) {
                // The last element is the dangling assistant message
                const danglingElement = messageElements[messageElements.length - 1];
                if (danglingElement) {
                    danglingElement.remove();
                }
            }

            // Sync reasoning from swipe_info to message.extra before rendering
            // This ensures updateReasoningUI finds the correct reasoning
            syncReasoningFromSwipeInfo(targetMessage, originalSwipeId);

            // Re-render to show original swipe with proper reasoning
            context.addOneMessage(targetMessage, {
                type: 'swipe',
                forceId: messageId,
                scroll: false,
                showSwipes: true
            });

            // Update UI counter and navigation
            updateMessageSwipeUI(messageId);
            addSwipeNavigationToMessage(messageId);
            
            // Update reasoning UI to show original swipe's reasoning
            // Delay slightly to let DOM settle after addOneMessage
            setTimeout(() => {
                updateReasoningUI(messageId);
            }, 100);
        }

        // OVERWRITE any save that might have happened during generation
        // This ensures the chat is saved WITHOUT the temp messages
        await saveChatConditional();

        // Clean up event listeners on successful completion
        eventSource.removeListener(event_types.GENERATION_STOPPED, abortHandler);

    } catch (err) {
        error('Error in guided impersonation:', err);

        // Only run cleanup if this is our generation that failed
        // (not if Prompt Inspector or another extension stopped it)
        if (!isOurGeneration) {
            // External stop detected - chat may be in an inconsistent state
            // Do minimal cleanup only and warn the user
            eventSource.removeListener(event_types.STREAM_REASONING_DONE, reasoningEventHandler);
            eventSource.removeListener(event_types.GENERATION_STOPPED, abortHandler);
            if (waitingToast) {
                $(waitingToast).remove();
            }
            if (mesElement) {
                mesElement.classList.remove('deep-swipe-loading');
            }
            const { removeSwipeOverlay } = await import('./ui.js');
            removeSwipeOverlay(messageId);
            
            // Warn user about potential corruption
            toastr.error('Generation was cancelled by another extension. Chat may be in an inconsistent state. Please refresh if you notice issues.', 'Deep Swipe Warning');
            throw err;
        }

        // Use shared cleanup if not already done by abort handler
        if (!abortCleanupDone) {
            // Remove event listeners
            eventSource.removeListener(event_types.STREAM_REASONING_DONE, reasoningEventHandler);
            eventSource.removeListener(event_types.GENERATION_STOPPED, abortHandler);
            
            // Cleanup: restore chat state
            if (isUserMessage) {
                // User swipes: restore to messageId + 1
                chat.length = messageId + 1;
                chat.splice(messageId + 1, 0, ...originalMessagesAfter);
            } else {
                // Assistant swipes: restore target message and messages after
                chat.length = messageId;
                if (originalTargetMessage) {
                    chat.push(originalTargetMessage);
                }
                chat.splice(messageId + 1, 0, ...originalMessagesAfter);
            }
            
            // Restore mesid attributes
            const restoreStartIndex = isUserMessage ? messageId + 1 : messageId;
            for (let i = restoreStartIndex; i < 100; i++) {
                const el = document.querySelector(`.mes[mesid="stale-${i}"]`);
                if (el) {
                    el.setAttribute('mesid', `${i}`);
                } else {
                    break;
                }
            }

            // Remove waiting toast
            if (waitingToast) {
                $(waitingToast).remove();
            }

            // Remove loading indicator
            if (mesElement) {
                mesElement.classList.remove('deep-swipe-loading');
            }
            
            // Remove overlay
            const { removeSwipeOverlay } = await import('./ui.js');
            removeSwipeOverlay(messageId);

            // Revert swipe - use appropriate message reference
            const revertTarget = isUserMessage ? message : (originalTargetMessage || chat[messageId]);
            if (revertTarget) {
                revertTarget.swipes.pop();
                revertTarget.swipe_info?.pop();
                revertTarget.swipe_id = Math.max(0, revertTarget.swipes.length - 1);
            }
            // Restore original message text in UI
            if (messageElement) {
                messageElement.textContent = currentText;
            }
            
            // Re-render to restore original state
            context.addOneMessage(revertTarget, {
                type: 'swipe',
                forceId: messageId,
                scroll: false,
                showSwipes: true
            });
        }
        throw err;
    }
}

/**
 * Navigate to the previous swipe on a message
 * @param {Object} args - Command arguments
 * @param {number} messageId - The message ID to navigate back on
 * @returns {Promise<string>} Result message
 */
export async function dswipeBack(args, messageId) {
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

    // For user messages, use manual handling
    if (message.is_user) {
        const messagesToRestore = chat.slice(messageId + 1);
        chat.length = messageId + 1;
        await handleUserSwipeBack(message, messageId, targetSwipeId, messagesToRestore);
        return `Navigated to swipe ${message.swipe_id + 1}/${message.swipes.length}`;
    }

    // For assistant messages, use native swipe
    const messagesToRestore = chat.slice(messageId + 1);
    chat.length = messageId + 1;

    try {
        await context.swipe.left(null, {
            message: message,
            forceMesId: messageId,
            forceSwipeId: targetSwipeId
        });

        chat.push(...messagesToRestore);

        context.addOneMessage(message, {
            type: 'swipe',
            forceId: messageId,
            scroll: false,
            showSwipes: true
        });

        return `Navigated to swipe ${message.swipe_id + 1}/${message.swipes.length}`;
    } catch (err) {
        chat.push(...messagesToRestore);
        throw err;
    }
}

/**
 * Generate a new swipe for a message
 * @param {Object} args - Command arguments
 * @param {number} messageId - The message ID to generate a swipe for
 * @returns {Promise<string>} Result message
 */
export async function dswipeForward(args, messageId) {
    const context = getContext();
    const chat = context.chat;

    if (!isValidMessageId(messageId, chat)) {
        toastr.error(`Invalid message ID: ${messageId}`, 'Deep Swipe');
        return 'Invalid message ID';
    }

    const message = chat[messageId];
    const settings = getSettings();

    if (message.is_user) {
        // User message: use deep swipe generation
        await generateMessageSwipe(message, messageId, context);
        return 'Generated new swipe';
    }

    // Assistant message: use deep swipe generation for non-last messages
    // Native swipe only works on the last message
    if (messageId !== chat.length - 1) {
        // Use our generateMessageSwipe function
        await generateMessageSwipe(message, messageId, context, false);
        return 'Generated new swipe';
    }
    
    // For the last assistant message, we could use native swipe
    // But let's use generateMessageSwipe for consistency
    await generateMessageSwipe(message, messageId, context, false);
    return 'Generated new swipe';
}
