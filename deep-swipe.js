/**
 * Deep Swipe Extension - User Swipe Module
 *
 * Handles swipe generation and navigation for user messages using guided impersonation.
 *
 * @author Rurijian
 * @version 1.5.4
 * @license MIT
 */

import { getContext } from '../../../extensions.js';
import { Generate, eventSource, event_types, cancelDebouncedChatSave, saveChatConditional, stopGeneration } from '../../../../script.js';
import { updateReasoningUI, ReasoningType } from '../../../../scripts/reasoning.js';
import { getSettings, EXTENSION_NAME, DEFAULT_ASSISTANT_PROMPT } from './config.js';
import { syncReasoningFromSwipeInfo, error, isValidMessageId } from './utils.js';
import { updateMessageSwipeUI } from './ui.js';

// Module-level variable to store complete chat backup before generation
// This ensures we have a clean state to restore from if corruption occurs
let chatBackupBeforeGeneration = null;
let chatBackupTimestamp = null;

/**
 * Get the current API and model information for swipe storage
 * This ensures model icons display correctly when navigating swipes
 * @returns {{api: string, model: string}} The current API and model
 */
async function getCurrentApiAndModel() {
    // Import getGeneratingApi and getGeneratingModel dynamically to avoid circular dependencies
    const { getGeneratingApi, getGeneratingModel } = await import('../../../../script.js');
    
    // Use getGeneratingApi() to get the actual API source (e.g., 'moonshot', 'claude', 'openrouter')
    // instead of main_api which would just return 'openai' for all OpenAI-compatible APIs
    const api = getGeneratingApi();
    const model = getGeneratingModel() || 'unknown';
    
    return { api, model };
}

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

    // Track if this is a Deep Swipe generation (for cleanup on stop)
    // Set to true at generation start so cleanup runs for ANY stop (overlay button or SillyTavern stop)
    let isOurGeneration = true;

    // CRITICAL FIX: Save complete chat backup before any modifications
    // This ensures we have a clean state to restore from if stop occurs
    chatBackupBeforeGeneration = JSON.parse(JSON.stringify(chat));
    chatBackupTimestamp = Date.now();

    // UI PREVENTION: Hide "Show more messages" button during generation
    // Inject CSS to hide the button completely - this works regardless of event handling
    let showMoreBlocked = true;
    const styleId = 'deep-swipe-hide-show-more';
    
    // Create style element to hide the button
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = `
            #show_more_messages {
                display: none !important;
                visibility: hidden !important;
                pointer-events: none !important;
            }
        `;
        document.head.appendChild(style);
    }

    // If messageId+1 exists but has empty content, SillyTavern corrupted it
    if (chat[messageId + 1] && chat[messageId + 1].mes === '' && chat[messageId + 1].is_user) {
        try {
            // Force reload current chat to get clean state
            await context.reloadCurrentChat();
        } catch (reloadError) {
            console.error('[Deep Swipe] Failed to reload chat:', reloadError);
        }
    }

    // CRITICAL: Capture ALL original data BEFORE any truncation or modifications
    // For assistant swipes, truncation removes the target, so we MUST capture first
    const currentText = message.mes;
    
    // SAFETY: Fix corrupt swipe data if swipe_id is out of bounds
    if (message.swipe_id >= message.swipes?.length) {
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

    // CRITICAL FIX: Capture ALL data in ONE synchronous operation
    // SillyTavern modifies chat asynchronously, so we must capture everything immediately
    // CRITICAL: Deep clone everything to prevent SillyTavern from corrupting our captured data
    const chatSnapshot = JSON.parse(JSON.stringify(chat));
    const capturedTargetMessage = JSON.parse(JSON.stringify(chat[messageId]));
    // Deep clone the messages after target - slice() only does shallow copy!
    const capturedMessagesAfter = chatSnapshot.slice(messageId + 1).map(msg => JSON.parse(JSON.stringify(msg)));
    
    
    // For USER swipes: Add placeholder now (message won't change)
    // For ASSISTANT swipes: Add placeholder now too (both use same flow now)
    let newSwipeIndex;
    
    // Initialize swipes on the working copy (not the original)
    if (!Array.isArray(capturedTargetMessage.swipes)) {
        capturedTargetMessage.swipes = [capturedTargetMessage.mes];
        capturedTargetMessage.swipe_id = 0;
    }
    // Add placeholder for the new swipe
    capturedTargetMessage.swipes.push('');
    newSwipeIndex = capturedTargetMessage.swipes.length - 1;
    // CRITICAL: Do NOT update swipe_id here - keep showing original swipe during generation
    
    // Variables to capture reasoning data
    let capturedReasoning = '';
    let reasoningDuration = null;
    let generationStarted = null;
    let generationFinished = null;
    
    // Keep reference to original target message for swipe updates during generation
    // But use capturedTargetMessage for cleanup restoration
    // NOTE: Using let so we can update it after restoration to point to the new object
    let originalTargetMessage = chat[messageId];

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
        if (abortCleanupDone) {
            return;
        }
        abortCleanupDone = true;
        
        // CRITICAL FIX: Cancel auto-save BEFORE any restoration to prevent race condition
        cancelDebouncedChatSave();
        
        // Remove event listeners
        eventSource.removeListener(event_types.STREAM_REASONING_DONE, reasoningEventHandler);
        eventSource.removeListener(event_types.GENERATION_STOPPED, abortHandler);
        
        // Stop server generation
        stopGeneration();
        
        // SIMPLE APPROACH: Just restore the entire chat from backup

        if (chatBackupBeforeGeneration) {
            // Create a fresh copy to ensure no reference issues
            const backupCopy = JSON.parse(JSON.stringify(chatBackupBeforeGeneration));

            // CRITICAL FIX: Use splice instead of length=0 + push to preserve array reference
            // and ensure deep copy of each element
            chat.splice(0, chat.length, ...backupCopy);
        } else {
            console.error('[Deep-Swipe-Cleanup] No backup available!');
        }

        // Don't remove valid messages - let addOneMessage handle re-rendering
        const staleElements = document.querySelectorAll('.mes[mesid^="stale-"]');
        staleElements.forEach(el => {
            el.remove();
        });

        // Clean up UI
        if (waitingToast) {
            $(waitingToast).remove();
        }

        if (mesElement) {
            mesElement.classList.remove('deep-swipe-loading');
        }

        // Remove overlay - inline the logic to avoid importing ui.js (which loads config.js -> script.js)
        const overlayById = document.getElementById(`deep-swipe-overlay-${messageId}`);
        if (overlayById) {
            overlayById.remove();
        }
        if (window._deepSwipeOverlayPopups?.[messageId]) {
            const overlayData = window._deepSwipeOverlayPopups[messageId];
            const overlay = overlayData.element || overlayData;
            if (overlay._cleanupScroll) {
                overlay._cleanupScroll();
            }
            overlay.remove();
            delete window._deepSwipeOverlayPopups[messageId];
        }

        // UI PREVENTION CLEANUP: Remove the CSS that hides the button
        showMoreBlocked = false;
        const styleEl = document.getElementById(styleId);
        if (styleEl) {
            styleEl.remove();
        }

        // CRITICAL: Use printMessages to fully re-render the chat after cleanup
        // This is the most reliable way to ensure DOM matches chat array

        // Clear the chat element first to prevent duplicates
        const chatElement = document.getElementById('chat');
        if (chatElement) {
            chatElement.innerHTML = '';
        }

        // Call printMessages to re-render entire chat
        await context.printMessages();

        // CRITICAL FIX: Ensure the chat array reference is maintained
        // Some SillyTavern internals may hold the reference, so we need to ensure
        // the array itself is not replaced

        // CRITICAL: Save chat to prevent auto-save from loading stale data
        
        try {
            // CRITICAL FIX: Cancel any pending auto-save right before saving
            cancelDebouncedChatSave();

            // CRITICAL FIX: Create a deep copy of chat before saving to prevent save function from corrupting original
            const chatCopyBeforeSave = JSON.parse(JSON.stringify(chat));

            // Use saveChatConditional which is the proper way to save in SillyTavern
            await saveChatConditional();

            // CRITICAL FIX: If save corrupted the chat (ANY change to content), restore from our copy
            // Check ALL messages, not just index 2, as corruption can happen at any index
            let corruptionDetected = false;
            for (let i = 0; i < chat.length; i++) {
                if (chat[i]?.mes !== chatCopyBeforeSave[i]?.mes) {
                    console.error(`[Deep-Swipe-Cleanup-DIAG] SAVE CORRUPTED CHAT at index ${i}! Content changed from "` +
                        chatCopyBeforeSave[i]?.mes?.substring(0, 30) + '" to "' + chat[i]?.mes?.substring(0, 30) + '"');
                    corruptionDetected = true;
                    break;
                }
            }
            if (corruptionDetected) {
                console.error('[Deep-Swipe-Cleanup-DIAG] Restoring from copy...');
                chat.splice(0, chat.length, ...chatCopyBeforeSave);
            }

            // CRITICAL FIX: Cancel any auto-save that may have been queued during our save
            // and save again to ensure our state "wins"
            cancelDebouncedChatSave();

            // CRITICAL FIX: Wait a tick and save again to overwrite any late auto-saves
            // This ensures that even if an auto-save was queued, our second save will overwrite it
            await new Promise(resolve => setTimeout(resolve, 100));
            cancelDebouncedChatSave();

            // CRITICAL FIX: Create another deep copy before second save
            const chatCopyBeforeSecondSave = JSON.parse(JSON.stringify(chat));
            await saveChatConditional();

            // CRITICAL FIX: Check and restore if second save corrupted chat (ANY content change)
            // Check ALL messages for corruption, not just index 2
            let secondCorruptionDetected = false;
            for (let i = 0; i < chat.length; i++) {
                if (chat[i]?.mes !== chatCopyBeforeSecondSave[i]?.mes) {
                    console.error(`[Deep-Swipe-Cleanup-DIAG] SECOND SAVE CORRUPTED CHAT at index ${i}! Content changed from "` +
                        chatCopyBeforeSecondSave[i]?.mes?.substring(0, 30) + '" to "' + chat[i]?.mes?.substring(0, 30) + '"');
                    secondCorruptionDetected = true;
                    break;
                }
            }
            if (secondCorruptionDetected) {
                console.error('[Deep-Swipe-Cleanup-DIAG] Restoring from second copy...');
                chat.splice(0, chat.length, ...chatCopyBeforeSecondSave);
            }
        } catch (e) {
            console.error('[Deep-Swipe-Cleanup] Error saving chat:', e);
        }

        chatBackupBeforeGeneration = null;
        chatBackupTimestamp = null;

        // CRITICAL FIX: Cancel auto-save one more time to ensure no pending saves with corrupted data
        cancelDebouncedChatSave();

        // CRITICAL FIX: Save chat immediately to prevent auto-save from loading stale data
        try {
            // CRITICAL FIX: Create deep copy before final save and restore if corrupted
            const chatCopyBeforeFinalSave = JSON.parse(JSON.stringify(chat));
            await context.saveChat();

            // CRITICAL FIX: Check and restore if final save corrupted chat (ANY content change)
            // Check ALL messages for corruption, not just index 2
            let finalCorruptionDetected = false;
            for (let i = 0; i < chat.length; i++) {
                if (chat[i]?.mes !== chatCopyBeforeFinalSave[i]?.mes) {
                    console.error(`[Deep-Swipe-Cleanup-DIAG] FINAL SAVE CORRUPTED CHAT at index ${i}! Content changed from "` +
                        chatCopyBeforeFinalSave[i]?.mes?.substring(0, 30) + '" to "' + chat[i]?.mes?.substring(0, 30) + '"');
                    finalCorruptionDetected = true;
                    break;
                }
            }
            if (finalCorruptionDetected) {
                console.error('[Deep-Swipe-Cleanup-DIAG] Restoring from final copy...');
                chat.splice(0, chat.length, ...chatCopyBeforeFinalSave);
            }
        } catch (saveError) {
            console.error('[Deep-Swipe-Cleanup] Error saving chat:', saveError);
        }

        toastr.warning('Deep Swipe generation was stopped.', 'Deep Swipe');
    };
    
    const abortHandler = () => {
        generationAborted = true;
        // Run cleanup if this is a Deep Swipe generation (regardless of which stop button was clicked)
        // isOurGeneration is set to true at generation start, so cleanup runs for ANY stop
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
        // CRITICAL: Must create overlay BEFORE any truncation/modification to show previous swipe
        const { createSwipeOverlay } = await import('./ui.js');
        
        // For assistant swipes, capture the CURRENT swipe content BEFORE any changes
        // The overlay clones the DOM, so we need to create it before truncation
        const overlayMessage = isUserMessage ? message : {
            ...message,
            mes: originalMessageState.swipes[originalSwipeId] || message.mes,
            swipe_id: originalSwipeId,
            extra: originalMessageState.swipe_info[originalSwipeId]?.extra
                ? { ...message.extra, ...originalMessageState.swipe_info[originalSwipeId].extra }
                : message.extra
        };
        
        createSwipeOverlay(messageId, overlayMessage, {
            showThrobber: true,
            onComplete: null,
            onStop: () => {
                // Mark that we intentionally stopped our own generation
                isOurGeneration = true;

                // Stop generation - this triggers GENERATION_STOPPED which calls abortHandler
                stopGeneration();
            }
        });

        if (isUserMessage) {
            // USER MESSAGE: Truncate chat to target, add temp message, generate
            // CRITICAL: Must truncate chat array so model only sees context up to target
            
            // Truncate chat to just after target message
            chat.length = messageId + 1;
            
            // Mark elements after target as stale so Generate() doesn't find them
            for (let i = messageId + 1; i < 1000; i++) {
                const el = document.querySelector(`.mes[mesid="${i}"]`);
                if (el) {
                    el.setAttribute('mesid', `stale-${i}`);
                } else {
                    break;
                }
            }
            
            // Append temp user message (now at position messageId+1)
            const tempUserMessage = {
                name: userName,
                is_user: true,
                mes: fullPrompt,
                send_date: new Date().toISOString(),
                extra: { isSmallSys: true, isDeepSwipeTemp: true },
            };
            chat.push(tempUserMessage);
            
            // Generate with truncated context
            await Generate('normal', {
                automatic_trigger: true,
            });
        } else {
            // ASSISTANT MESSAGE: Truncate chat to just before target
            // The model should only see context UP TO the target message
            
            // Truncate chat to just before target message (remove target and everything after)
            chat.length = messageId;
            
            // Mark target and messages after as stale so Generate() doesn't find them
            for (let i = messageId; i < 1000; i++) {
                const el = document.querySelector(`.mes[mesid="${i}"]`);
                if (el) {
                    el.setAttribute('mesid', `stale-${i}`);
                } else {
                    break;
                }
            }
            
            // Append temp user message (now at position messageId)
            const assistantPrompt = settings?.assistantPrompt || DEFAULT_ASSISTANT_PROMPT;
            const tempContextMessage = {
                name: userName,
                is_user: true,
                mes: assistantPrompt,
                send_date: new Date().toISOString(),
                extra: { isSmallSys: true, isDeepSwipeTemp: true },
            };
            chat.push(tempContextMessage);
            
            // Generate with truncated context (only sees messages before target)
            await Generate('normal', {
                automatic_trigger: true,
            });
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

        // Get the generated assistant message BEFORE any cleanup
        // Both user and assistant swipes now generate at the bottom (last message)
        const assistantMessage = chat[chat.length - 1];

        if (!assistantMessage || assistantMessage.is_user) {
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

        // CRITICAL FIX: Remove orphaned DOM elements for both user and assistant swipes
        // The element was created at the end, but we removed messages from chat array
        // So we need to find and remove elements where mesid >= current chat.length
        const orphanedElements = document.querySelectorAll(`#chat .mes`);
        orphanedElements.forEach(el => {
            const mesId = parseInt(el.getAttribute('mesid'), 10);
            if (!isNaN(mesId) && mesId >= chat.length) {
                el.remove();
            }
        });

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

        // CRITICAL: Restore the chat array after truncation
        // We truncated the chat during generation, now restore the original messages
        // CRITICAL FIX: Use captured copies, never the original references
        if (isUserMessage) {
            // User swipes: insert messages after target (target was kept at messageId)
            const restoredMessages = capturedMessagesAfter.map(msg => JSON.parse(JSON.stringify(msg)));
            chat.splice(messageId + 1, 0, ...restoredMessages);
        } else {
            // Assistant swipes: re-insert target and messages after it
            // Use captured copy, not originalTargetMessage reference
            const restoredTarget = JSON.parse(JSON.stringify(capturedTargetMessage));
            chat.splice(messageId, 0, restoredTarget);
            
            const restoredMessages = capturedMessagesAfter.map(msg => JSON.parse(JSON.stringify(msg)));
            chat.splice(messageId + 1, 0, ...restoredMessages);
        }
        
        // CRITICAL FIX: Update originalTargetMessage to point to the restored object
        // The old reference points to the original which SillyTavern may have corrupted
        originalTargetMessage = chat[messageId];

        // Restore the mesid attributes after restoring messages
        // Both user and assistant swipes: restore ALL stale elements by their stale- prefix
        document.querySelectorAll('.mes[mesid^="stale-"]').forEach(el => {
            const staleId = el.getAttribute('mesid');
            const originalId = staleId.replace('stale-', '');
            el.setAttribute('mesid', originalId);
        });

        // CRITICAL: Cancel saves after restoring chat state
        cancelDebouncedChatSave();

        // EMERGENCY CLEANUP: If temp message somehow persisted, remove it now
        const tempIndexAfter = chat.findIndex(m => m.extra?.isDeepSwipeTemp);
        if (tempIndexAfter !== -1) {
            chat.splice(tempIndexAfter, 1);
        }

        // CRITICAL: Remove orphaned DOM elements without full chat reload
        // After array cleanup and message restoration, any DOM element with mesid >= chat.length is orphaned
        // (these were the temp message and generated assistant message)
        const chatElement = document.getElementById('chat');
        if (chatElement) {
            const messageElements = chatElement.querySelectorAll('.mes');
            messageElements.forEach(el => {
                const mesId = parseInt(el.getAttribute('mesid'), 10);
                // Remove if mesId is >= current chat length (orphaned element)
                // AND the element's message no longer exists in chat
                if (!isNaN(mesId) && mesId >= chat.length) {
                    el.remove();
                }
            });
        }

        // Remove event listener
        eventSource.removeListener(event_types.STREAM_REASONING_DONE, reasoningEventHandler);

        // Store the generated text as a swipe
        if (generatedText && generatedText.trim()) {
            const trimmedText = generatedText.trim();

            // CRITICAL FIX: Use chat[messageId] which is our restored copy
            // NOT originalTargetMessage which is a reference to SillyTavern's internal object
            const actualTargetMessage = chat[messageId];

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

            // Get current API and model for the swipe info (needed for model icon display)
            const { api: currentApi, model: currentModel } = await getCurrentApiAndModel();

            // Create swipe_info entry with reasoning data
            const swipeInfoExtra = {
                ...structuredClone(actualTargetMessage.extra || {}),
            };

            // Store API and model for model icon display when navigating swipes
            swipeInfoExtra.api = currentApi;
            swipeInfoExtra.model = currentModel;

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
            removeSwipeOverlay,
            removeInlineSwipeOverlay
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
        
        // Clean up the inline swipe overlay DOM element if it exists
        removeInlineSwipeOverlay(messageId);

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
        
        // CRITICAL FIX: Clear the backup on successful completion
        // This prevents the backup from being used if a new generation starts
        chatBackupBeforeGeneration = null;
        chatBackupTimestamp = null;
        
        // UI PREVENTION CLEANUP: Remove the CSS that hides the button on success
        showMoreBlocked = false;
        const styleElSuccess = document.getElementById(styleId);
        if (styleElSuccess) {
            styleElSuccess.remove();
        }

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
            
            // UI PREVENTION CLEANUP: Remove the CSS that hides the button
            showMoreBlocked = false;
            const styleElExternal = document.getElementById(styleId);
            if (styleElExternal) {
                styleElExternal.remove();
            }
            
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
                // Restore from captured copies
                const restoredMessages = capturedMessagesAfter.map(msg => JSON.parse(JSON.stringify(msg)));
                chat.splice(messageId + 1, 0, ...restoredMessages);
            } else {
                // Assistant swipes: restore target message and messages after
                chat.length = messageId;
                if (originalTargetMessage) {
                    chat.push(originalTargetMessage);
                }
                // Restore from captured copies
                const restoredMessages = capturedMessagesAfter.map(msg => JSON.parse(JSON.stringify(msg)));
                chat.splice(messageId + 1, 0, ...restoredMessages);
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
            
            // UI PREVENTION CLEANUP: Restore original showMoreMessages function
            showMoreBlocked = false;
            if (originalShowMoreMessages) {
                window.showMoreMessages = originalShowMoreMessages;
            }
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

    // For user messages, manually update swipe (same as UI button)
    if (message.is_user) {
        message.swipe_id = targetSwipeId;
        message.mes = message.swipes[targetSwipeId];
        syncReasoningFromSwipeInfo(message, targetSwipeId);
        
        context.addOneMessage(message, {
            type: 'swipe',
            forceId: messageId,
            scroll: false,
            showSwipes: true
        });
        
        updateMessageSwipeUI(messageId);
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
        
        // Check if native swipe worked correctly
        const updatedMsg = chat[messageId];
        if (updatedMsg.swipe_id !== targetSwipeId) {
            updatedMsg.swipe_id = targetSwipeId;
            updatedMsg.mes = updatedMsg.swipes[targetSwipeId];
        }
        
        // Sync reasoning from swipe_info
        syncReasoningFromSwipeInfo(updatedMsg, targetSwipeId);

        context.addOneMessage(updatedMsg, {
            type: 'swipe',
            forceId: messageId,
            scroll: false,
            showSwipes: true
        });
        
        updateMessageSwipeUI(messageId);

        return `Navigated to swipe ${updatedMsg.swipe_id + 1}/${updatedMsg.swipes.length}`;
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

    // Check if there are existing swipes to navigate forward to
    const currentSwipeId = message.swipe_id || 0;
    const totalSwipes = message.swipes?.length || 1;
    
    // If we're not at the last swipe, navigate forward instead of generating
    if (currentSwipeId < totalSwipes - 1) {
        const targetSwipeId = currentSwipeId + 1;
        
        // For user messages, manually update swipe (same as UI button)
        if (message.is_user) {
            message.swipe_id = targetSwipeId;
            message.mes = message.swipes[targetSwipeId];
            syncReasoningFromSwipeInfo(message, targetSwipeId);
            
            context.addOneMessage(message, {
                type: 'swipe',
                forceId: messageId,
                scroll: false,
                showSwipes: true
            });
            
            updateMessageSwipeUI(messageId);
            return `Navigated to swipe ${message.swipe_id + 1}/${message.swipes.length}`;
        }
        
        // For assistant messages, use native swipe
        const messagesToRestore = chat.slice(messageId + 1);
        chat.length = messageId + 1;

        try {
            await context.swipe.right(null, {
                message: message,
                forceMesId: messageId,
                forceSwipeId: targetSwipeId
            });

            chat.push(...messagesToRestore);
            
            // Check if native swipe worked correctly
            const updatedMsg = chat[messageId];
            if (updatedMsg.swipe_id !== targetSwipeId) {
                updatedMsg.swipe_id = targetSwipeId;
                updatedMsg.mes = updatedMsg.swipes[targetSwipeId];
            }
            
            // Sync reasoning from swipe_info
            syncReasoningFromSwipeInfo(updatedMsg, targetSwipeId);

            context.addOneMessage(updatedMsg, {
                type: 'swipe',
                forceId: messageId,
                scroll: false,
                showSwipes: true
            });
            
            updateMessageSwipeUI(messageId);

            return `Navigated to swipe ${updatedMsg.swipe_id + 1}/${updatedMsg.swipes.length}`;
        } catch (err) {
            chat.push(...messagesToRestore);
            throw err;
        }
    }
    
    // No more swipes to navigate to - generate a new one
    if (message.is_user) {
        await generateMessageSwipe(message, messageId, context);
        return 'Generated new swipe';
    }

    await generateMessageSwipe(message, messageId, context, false);
    return 'Generated new swipe';
}
