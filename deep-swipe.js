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

    // DEBUG: Log actual chat state at very start (before any modifications)
    console.log('[DEEP_SWIPE_START] ========== FUNCTION START ==========');
    for (let i = 0; i < chat.length; i++) {
        console.log(`[DEEP_SWIPE_START] chat[${i}]: mes="${chat[i]?.mes?.substring(0, 30)}" is_user=${chat[i]?.is_user}`);
    }
    console.log('[DEEP_SWIPE_START] ========== END START STATE ==========');
    
    // CRITICAL FIX: Reload chat from server to ensure clean state
    // This prevents using corrupted data from previous runs
    console.log('[DEEP_SWIPE_START] Reloading chat from server to ensure clean state...');
    try {
        await context.reloadCurrentChat();
        console.log('[DEEP_SWIPE_START] Chat reloaded successfully');
    } catch (reloadError) {
        console.error('[DEEP_SWIPE_START] Failed to reload chat:', reloadError);
    }
    
    // Log state after reload
    console.log('[DEEP_SWIPE_START] Chat state after reload:');
    for (let i = 0; i < chat.length; i++) {
        console.log(`[DEEP_SWIPE_START] chat[${i}]: mes="${chat[i]?.mes?.substring(0, 30)}"`);
    }
    
    // CRITICAL FIX: Save complete chat backup before any modifications
    // This ensures we have a clean state to restore from if stop occurs
    chatBackupBeforeGeneration = JSON.parse(JSON.stringify(chat));
    chatBackupTimestamp = Date.now();
    console.log('[DEEP_SWIPE_START] Complete chat backup saved, length:', chatBackupBeforeGeneration.length);
    // If messageId+1 exists but has empty content, SillyTavern corrupted it
    if (chat[messageId + 1] && chat[messageId + 1].mes === '' && chat[messageId + 1].is_user) {
        console.error('[DEEP_SWIPE_START] CORRUPTION DETECTED! chat[messageId+1] is empty but should have content');
        console.error('[DEEP_SWIPE_START] Attempting to reload chat from server...');
        try {
            // Force reload current chat to get clean state
            await context.reloadCurrentChat();
            console.log('[DEEP_SWIPE_START] Chat reloaded successfully');
            // Log state after reload
            console.log('[DEEP_SWIPE_START] Chat state after reload:');
            for (let i = 0; i < chat.length; i++) {
                console.log(`[DEEP_SWIPE_START] chat[${i}]: mes="${chat[i]?.mes?.substring(0, 30)}"`);
            }
        } catch (reloadError) {
            console.error('[DEEP_SWIPE_START] Failed to reload chat:', reloadError);
        }
    }

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

    // CRITICAL FIX: Capture ALL data in ONE synchronous operation
    // SillyTavern modifies chat asynchronously, so we must capture everything immediately
    // CRITICAL: Deep clone everything to prevent SillyTavern from corrupting our captured data
    const chatSnapshot = JSON.parse(JSON.stringify(chat));
    const capturedTargetMessage = JSON.parse(JSON.stringify(chat[messageId]));
    // Deep clone the messages after target - slice() only does shallow copy!
    const capturedMessagesAfter = chatSnapshot.slice(messageId + 1).map(msg => JSON.parse(JSON.stringify(msg)));
    
    // IMMEDIATE CHECK: Log what we actually captured
    console.log('[DEEP_SWIPE_CAPTURE] ========== CAPTURED DATA ==========');
    for (let i = 0; i < chatSnapshot.length; i++) {
        console.log(`[DEEP_SWIPE_CAPTURE] chatSnapshot[${i}]: mes="${chatSnapshot[i]?.mes?.substring(0, 30)}"`);
    }
    console.log('[DEEP_SWIPE_CAPTURE] capturedMessagesAfter length:', capturedMessagesAfter.length);
    capturedMessagesAfter.forEach((msg, i) => {
        console.log(`[DEEP_SWIPE_CAPTURE] capturedMessagesAfter[${i}]: mes="${msg.mes?.substring(0, 30)}"`);
    });
    console.log('[DEEP_SWIPE_CAPTURE] ========== END CAPTURED DATA ==========');
    
    console.log('[Deep Swipe] Starting generation:', {
        isUserMessage,
        messageId,
        chatLength: chat.length,
        capturedMessages: capturedMessagesAfter.length
    });
    
    // DEBUG: Log captured messages
    console.log('[Deep Swipe] Captured messages after messageId:', capturedMessagesAfter.length);
    capturedMessagesAfter.forEach((msg, i) => {
        console.log(`[Deep Swipe]   Captured [${i}]: mes="${msg.mes?.substring(0, 30)}" is_user=${msg.is_user}`);
    });
    
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
        console.log('[Deep-Swipe-Cleanup] === STARTING ABORT CLEANUP ===');
        console.log('[Deep-Swipe-Cleanup] Initial state - messageId:', messageId, 'isUserMessage:', isUserMessage, 'chat.length:', chat.length);
        
        if (abortCleanupDone) {
            console.log('[Deep-Swipe-Cleanup] Cleanup already done, returning');
            return;
        }
        abortCleanupDone = true;
        
        // Remove event listeners
        eventSource.removeListener(event_types.STREAM_REASONING_DONE, reasoningEventHandler);
        eventSource.removeListener(event_types.GENERATION_STOPPED, abortHandler);
        console.log('[Deep-Swipe-Cleanup] Event listeners removed');
        
        // CRITICAL: First, find and remove temp message and any dangling messages after it
        let tempMessageIndex = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]?.extra?.isDeepSwipeTemp) {
                tempMessageIndex = i;
                break;
            }
        }
        console.log('[Deep-Swipe-Cleanup] Temp message index found:', tempMessageIndex);
        
        // Truncate chat to remove temp and dangling messages
        // If temp found, truncate to temp index. Otherwise, truncate based on message type
        if (tempMessageIndex !== -1) {
            console.log('[Deep-Swipe-Cleanup] Truncating chat to temp message index:', tempMessageIndex);
            chat.length = tempMessageIndex;
        } else {
            // No temp message found - truncate to proper position based on message type
            if (isUserMessage) {
                // User swipes: truncate to after target (messageId + 1)
                console.log('[Deep-Swipe-Cleanup] No temp found, truncating to messageId + 1:', messageId + 1);
                chat.length = messageId + 1;
            } else {
                // Assistant swipes: truncate to before target (messageId)
                console.log('[Deep-Swipe-Cleanup] No temp found, truncating to messageId:', messageId);
                chat.length = messageId;
            }
        }
        console.log('[Deep-Swipe-Cleanup] After temp/dangling removal - chat.length:', chat.length);
        
        // CRITICAL FIX: Use module-level backup for COMPLETE chat restoration
        // The backup was saved before any generation started, so it's guaranteed clean
        console.log('[Deep-Swipe-Cleanup] About to restore chat - current length:', chat.length);
        
        if (chatBackupBeforeGeneration && chatBackupBeforeGeneration.length >= chat.length) {
            console.log('[Deep-Swipe-Cleanup] Using module-level backup for COMPLETE restoration');
            // COMPLETELY replace the chat array with the backup
            chat.length = 0; // Clear current chat
            chat.push(...JSON.parse(JSON.stringify(chatBackupBeforeGeneration))); // Push clean backup
            console.log('[Deep-Swipe-Cleanup] Complete chat restored from backup, length:', chat.length);
        } else {
            console.log('[Deep-Swipe-Cleanup] Backup not available or invalid, using fallback restoration');
            // Fallback to piece-by-piece restoration
            const restoredMessages = capturedMessagesAfter.map(msg => JSON.parse(JSON.stringify(msg)));
            
            if (isUserMessage) {
                chat.push(...restoredMessages);
            } else {
                const restoredTarget = JSON.parse(JSON.stringify(capturedTargetMessage));
                restoredTarget.swipes.pop();
                restoredTarget.swipe_id = Math.max(0, restoredTarget.swipes.length - 1);
                restoredTarget.mes = restoredTarget.swipes[restoredTarget.swipe_id];
                chat.push(restoredTarget);
                chat.push(...restoredMessages);
            }
        }
        console.log('[Deep-Swipe-Cleanup] After chat restore - chat.length:', chat.length);
        console.log('[Deep-Swipe-Cleanup] Restored messages content:');
        for (let i = 0; i < chat.length; i++) {
            console.log(`[Deep-Swipe-Cleanup]   chat[${i}]: mes="${chat[i]?.mes?.substring(0, 30)}" is_user=${chat[i]?.is_user} name="${chat[i]?.name}" extra=${JSON.stringify(chat[i]?.extra)?.substring(0, 50)}`);
        }
        
        // CRITICAL: Remove only stale/dangling DOM elements
        // Don't remove valid messages - let addOneMessage handle re-rendering
        const staleElements = document.querySelectorAll('.mes[mesid^="stale-"]');
        console.log('[Deep-Swipe-Cleanup] Removing', staleElements.length, 'stale DOM elements');
        staleElements.forEach(el => {
            console.log('[Deep-Swipe-Cleanup] Removing stale element:', el.getAttribute('mesid'));
            el.remove();
        });
        
        // Check chat array after stale element removal
        console.log('[Deep-Swipe-Cleanup] Chat array after stale removal:');
        for (let i = 0; i < chat.length; i++) {
            console.log(`[Deep-Swipe-Cleanup]   [${i}] mes="${chat[i]?.mes?.substring(0, 20)}..."`);
        }
        
        // Clean up UI
        if (waitingToast) {
            $(waitingToast).remove();
        }
        console.log('[Deep-Swipe-Cleanup] After toast removal - chat[2]:', chat[2]?.mes?.substring(0, 20));
        
        if (mesElement) {
            mesElement.classList.remove('deep-swipe-loading');
        }
        console.log('[Deep-Swipe-Cleanup] After class removal - chat[2]:', chat[2]?.mes?.substring(0, 20));
        
        // Remove overlay - inline the logic to avoid importing ui.js (which loads config.js -> script.js)
        console.log('[Deep-Swipe-Cleanup] About to remove overlay - chat[2]:', chat[2]?.mes?.substring(0, 20));
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
        console.log('[Deep-Swipe-Cleanup] After overlay removal - chat[2]:', chat[2]?.mes?.substring(0, 20));
        console.log('[Deep-Swipe-Cleanup] Overlay removed');
        
        // Check chat array after overlay removal
        console.log('[Deep-Swipe-Cleanup] Chat array after overlay removal:');
        for (let i = 0; i < chat.length; i++) {
            console.log(`[Deep-Swipe-Cleanup]   [${i}] mes="${chat[i]?.mes?.substring(0, 20)}..."`);
        }
        
        // CRITICAL: Use printMessages to fully re-render the chat after cleanup
        // This is the most reliable way to ensure DOM matches chat array
        console.log('[Deep-Swipe-Cleanup] === FULL CHAT RE-RENDER ===');
        console.log('[Deep-Swipe-Cleanup] About to call printMessages with chat.length:', chat.length);
        
        // Clear the chat element first to prevent duplicates
        const chatElement = document.getElementById('chat');
        if (chatElement) {
            console.log('[Deep-Swipe-Cleanup] Clearing chat element');
            chatElement.innerHTML = '';
        }
        
        // Verify chat array content before printMessages
        console.log('[Deep-Swipe-Cleanup] Chat array before printMessages:');
        for (let i = 0; i < chat.length; i++) {
            console.log(`[Deep-Swipe-Cleanup]   [${i}] mes="${chat[i]?.mes?.substring(0, 20)}..." is_user=${chat[i]?.is_user}`);
        }
        
        // Call printMessages to re-render entire chat
        await context.printMessages();
        
        console.log('[Deep-Swipe-Cleanup] printMessages complete');
        
        // Debug: Check all mes elements after cleanup
        const allMesAfter = document.querySelectorAll('.mes[mesid]');
        console.log('[Deep-Swipe-Cleanup] All .mes elements after cleanup:', allMesAfter.length);
        allMesAfter.forEach(el => {
            const mesid = el.getAttribute('mesid');
            const mesTextEl = el.querySelector('.mes_text');
            const text = mesTextEl?.textContent?.substring(0, 50);
            const html = mesTextEl?.innerHTML?.substring(0, 50);
            console.log('[Deep-Swipe-Cleanup]   mesid:', mesid, '- text:', text, '- html:', html);
        });
        
        // CRITICAL: Log final state before function returns
        console.log('[DEEP_SWIPE_CLEANUP_END] ========== CLEANUP END ==========');
        for (let i = 0; i < chat.length; i++) {
            console.log(`[DEEP_SWIPE_CLEANUP_END] chat[${i}]: mes="${chat[i]?.mes?.substring(0, 30)}"`);
        }
        console.log('[DEEP_SWIPE_CLEANUP_END] ========== END CLEANUP STATE ==========');
        
        // Clear the backup after successful cleanup
        chatBackupBeforeGeneration = null;
        chatBackupTimestamp = null;
        
        // CRITICAL FIX: Save chat immediately to prevent auto-save from loading stale data
        console.log('[Deep-Swipe-Cleanup] Saving chat to prevent corruption from auto-save...');
        try {
            await context.saveChat();
            console.log('[Deep-Swipe-Cleanup] Chat saved successfully');
        } catch (saveError) {
            console.error('[Deep-Swipe-Cleanup] Error saving chat:', saveError);
        }
        
        // Log state after save
        console.log('[Deep-Swipe-Cleanup] CHAT STATE after save:');
        for (let i = 0; i < chat.length; i++) {
            console.log(`[Deep-Swipe-Cleanup]   chat[${i}]: mes="${chat[i]?.mes?.substring(0, 30)}"`);
        }
        
        console.log('[Deep-Swipe-Cleanup] === ABORT CLEANUP COMPLETE ===');
        toastr.warning('Deep Swipe generation was stopped.', 'Deep Swipe');
    };
    
    const abortHandler = () => {
        console.log('[Deep-Swipe-Cleanup] abortHandler called - isOurGeneration:', isOurGeneration, 'abortCleanupDone:', abortCleanupDone);
        generationAborted = true;
        // Run cleanup if this is a Deep Swipe generation (regardless of which stop button was clicked)
        // isOurGeneration is set to true at generation start, so cleanup runs for ANY stop
        if (!isOurGeneration) {
            console.log('[Deep-Swipe-Cleanup] Not a Deep Swipe generation, skipping cleanup');
            return;
        }
        // Trigger cleanup immediately when generation stops
        console.log('[Deep-Swipe-Cleanup] Triggering performAbortCleanup');
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
                console.log('[Deep-Swipe-Cleanup] === STOP BUTTON CLICKED ===');
                // Mark that we intentionally stopped our own generation
                isOurGeneration = true;
                
                // Calculate which mesid will have the dangling message
                // For user swipes: chat truncated to messageId+1, temp added at messageId+1, assistant at messageId+2
                // For assistant swipes: chat truncated to messageId, temp added at messageId, assistant at messageId+1
                console.log('[Deep-Swipe-Cleanup] Current chat.length before stop:', chat.length);
                
                // Debug: Log current DOM state
                const allMesBefore = document.querySelectorAll('.mes[mesid]');
                console.log('[Deep-Swipe-Cleanup] DOM elements before stop:', allMesBefore.length);
                allMesBefore.forEach(el => {
                    const mesid = el.getAttribute('mesid');
                    const isUser = el.classList.contains('mes_user');
                    console.log('[Deep-Swipe-Cleanup]   mesid:', mesid, 'is_user:', isUser);
                });
                
                // Stop generation - this triggers GENERATION_STOPPED which calls abortHandler
                console.log('[Deep-Swipe-Cleanup] Calling stopGeneration()...');
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
            console.log('[Deep Swipe] User swipe: generation complete');
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

        console.log('[Deep Swipe] After Generate(), chat length:', chat.length);
        
        // DEBUG: Check DOM state after generation
        const staleEl = document.querySelector('.mes[mesid="stale-151"]');
        const newEl = document.querySelector('.mes[mesid="151"]');
        const allMes = document.querySelectorAll('#chat .mes');
        console.log('[Deep Swipe] DOM state after Generate:', {
            stale151Exists: !!staleEl,
            stale151Mes: staleEl?.querySelector('.mes_text')?.textContent?.substring(0, 30),
            new151Exists: !!newEl,
            new151Mes: newEl?.querySelector('.mes_text')?.textContent?.substring(0, 30),
            totalMesElements: allMes.length,
            lastMesId: allMes[allMes.length - 1]?.getAttribute('mesid'),
            lastMesContent: allMes[allMes.length - 1]?.querySelector('.mes_text')?.textContent?.substring(0, 30)
        });
        
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

        // CRITICAL FIX: Remove orphaned DOM elements for both user and assistant swipes
        // The element was created at the end, but we removed messages from chat array
        // So we need to find and remove elements where mesid >= current chat.length
        console.log('[Deep Swipe] Removing orphaned DOM elements');
        const orphanedElements = document.querySelectorAll(`#chat .mes`);
        orphanedElements.forEach(el => {
            const mesId = parseInt(el.getAttribute('mesid'), 10);
            if (!isNaN(mesId) && mesId >= chat.length) {
                console.log('[Deep Swipe] Removing orphaned element at mesid', mesId);
                el.remove();
            }
        });
        
        // Find and remove temp messages
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]?.extra?.isDeepSwipeTemp) {
                console.log(`[Deep Swipe] Removing temp message at index ${i}`);
                chat.splice(i, 1);
            }
        }
        
        console.log('[Deep Swipe] After removing temp and assistant, chat length:', chat.length, 'capturedMessagesAfter length:', capturedMessagesAfter.length);
        console.log('[Deep Swipe] originalTargetMessage exists:', !!originalTargetMessage, 'isUserMessage:', isUserMessage);

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
        console.log('[Deep Swipe] Updated originalTargetMessage to restored copy:', originalTargetMessage?.mes?.substring(0, 30));

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
                    console.log(`[Deep Swipe] Removing orphaned DOM element for mesid ${mesId}`);
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
            
            // DEBUG: Log chat[messageId+1] before swipe storage
            console.log('[Deep Swipe] BEFORE swipe storage - chat[messageId+1]:', chat[messageId + 1]?.mes?.substring(0, 30));
            
            // DEBUG: Log message identity to catch reference issues
            console.log('[Deep Swipe] Storing swipe:', {
                isUserMessage,
                messageId,
                newSwipeIndex,
                targetMessageId: actualTargetMessage === message,
                originalTargetMatch: actualTargetMessage === originalTargetMessage,
                chatLength: chat.length,
                targetName: actualTargetMessage.name,
                targetMes: actualTargetMessage.mes?.substring(0, 30),
                chatAtMessageId: isUserMessage ? chat[messageId]?.mes?.substring(0, 30) : 'N/A (assistant)',
                originalTargetMes: originalTargetMessage?.mes?.substring(0, 30),
                actualSwipesLength: actualTargetMessage.swipes?.length,
                chatAtMessageIdSwipes: isUserMessage ? chat[messageId]?.swipes?.length : 'N/A',
                chat0Name: chat[0]?.name,
                chat0Mes: chat[0]?.mes?.substring(0, 30),
                chat0Swipes: chat[0]?.swipes?.length
            });
            
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
            
            // DEBUG: Log chat[messageId+1] after swipe storage
            console.log('[Deep Swipe] AFTER swipe storage - chat[messageId+1]:', chat[messageId + 1]?.mes?.substring(0, 30));

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
            
            // DEBUG: Verify where the swipe was stored
            console.log('[Deep Swipe] After storing swipe:', {
                newSwipeIndex,
                actualTargetSwipes: actualTargetMessage.swipes?.length,
                actualTargetMes: actualTargetMessage.mes?.substring(0, 30),
                chatAtMessageIdSwipes: chat[messageId]?.swipes?.length,
                chatAtMessageIdMes: chat[messageId]?.mes?.substring(0, 30),
                chatAtMessageIdPlus1Swipes: chat[messageId + 1]?.swipes?.length,
                chatAtMessageIdPlus1Mes: chat[messageId + 1]?.mes?.substring(0, 30),
                targetMatchesChat: actualTargetMessage === chat[messageId],
                targetMatchesMessageIdPlus1: actualTargetMessage === chat[messageId + 1],
                swipe6Content: actualTargetMessage.swipes?.[6]?.substring(0, 30),
                swipe5Content: actualTargetMessage.swipes?.[5]?.substring(0, 30)
            });
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

            // DEBUG: Check DOM state before addOneMessage
            const allElements151 = document.querySelectorAll('.mes[mesid="151"], .mes[mesid="stale-151"]');
            console.log('[Deep Swipe] Before addOneMessage, all 151 elements:', allElements151.length);
            allElements151.forEach((el, i) => {
                console.log(`  Element ${i}: mesid=${el.getAttribute('mesid')}, content=${el.querySelector('.mes_text')?.textContent?.substring(0, 30)}`);
            });
            
            const domElBefore = document.querySelector(`.mes[mesid="${messageId}"]`);
            console.log('[Deep Swipe] Before addOneMessage:', {
                messageId,
                domElExists: !!domElBefore,
                domElContent: domElBefore?.querySelector('.mes_text')?.textContent?.substring(0, 30),
                targetMessageContent: targetMessage.mes?.substring(0, 30)
            });

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
