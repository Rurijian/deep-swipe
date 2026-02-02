/**
 * Deep Swipe Extension
 *
 * Allows swiping (regenerating) any message in chat history, not just the last one.
 *
 * @author Rurijian
 * @version 1.2.0
 * @license MIT
 */

import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, Generate, saveChatConditional, deleteMessage, deleteSwipe, eventSource, event_types, streamingProcessor } from "../../../../script.js";
import { oai_settings } from "../../../../scripts/openai.js";
import { updateReasoningUI, ReasoningType, parseReasoningFromString } from "../../../../scripts/reasoning.js";

const EXTENSION_NAME = 'deep-swipe';
const extensionFolderPath = `scripts/extensions/third-party/${EXTENSION_NAME}`;

// Default impersonation prompt
const DEFAULT_IMPERSONATION_PROMPT = "NEW DIRECTION: Impersonate your next reply as if you were {{user}}, in {{user}}'s voice, using the subsequent text as a guide of what to then embellish: {{input}}";

// Default settings - all features enabled by default, user swipes ON
const defaultSettings = {
    enabled: true,
    swipeNavigation: true,
    userSwipes: true,
    impersonationPrompt: DEFAULT_IMPERSONATION_PROMPT,
};

// Track if buttons have been initialized
let buttonsInitialized = false;

/**
 * Load extension settings
 */
function loadSettings() {
    extension_settings[EXTENSION_NAME] = extension_settings[EXTENSION_NAME] || {};

    if (Object.keys(extension_settings[EXTENSION_NAME]).length === 0) {
        Object.assign(extension_settings[EXTENSION_NAME], defaultSettings);
    }

    const enabledCheckbox = document.getElementById('deep_swipe_enabled');
    if (enabledCheckbox) {
        enabledCheckbox.checked = extension_settings[EXTENSION_NAME].enabled;
    }

    const swipeNavCheckbox = document.getElementById('deep_swipe_swipe_navigation');
    if (swipeNavCheckbox) {
        swipeNavCheckbox.checked = extension_settings[EXTENSION_NAME].swipeNavigation;
    }

    const userSwipesCheckbox = document.getElementById('deep_swipe_user_swipes');
    if (userSwipesCheckbox) {
        userSwipesCheckbox.checked = extension_settings[EXTENSION_NAME].userSwipes;
    }

    const impersonationPromptTextarea = document.getElementById('deep_swipe_impersonation_prompt');
    if (impersonationPromptTextarea) {
        impersonationPromptTextarea.value = extension_settings[EXTENSION_NAME].impersonationPrompt || '';
    }
}

/**
 * Validates if a message ID is valid
 */
function isValidMessageId(messageId, chat) {
    return typeof messageId === 'number' &&
           !isNaN(messageId) &&
           messageId >= 0 &&
           messageId < chat.length;
}

/**
 * Checks if a message can be swiped
 */
function isMessageSwipeable(message) {
    // Allow user messages if userSwipes setting is enabled
    if (message.is_user && !extension_settings[EXTENSION_NAME]?.userSwipes) return false;
    if (message.is_system) return false;
    if (message.extra?.isSmallSys) return false;
    if (message.extra?.swipeable === false) return false;
    return true;
}

/**
 * Format swipe counter like "2/5"
 */
function formatSwipeCounter(current, total) {
    if (!total || total <= 0) return '';
    return `${current + 1}/${total}`;
}

/**
 * Navigate to the previous swipe on a message
 */
/**
 * Sync reasoning data from swipe_info to message extra
 * @param {object} message - The message object
 * @param {number} swipeId - The swipe ID to sync from
 */
function syncReasoningFromSwipeInfo(message, swipeId) {
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
}

/**
 * Navigate to the previous swipe on a message
 */
async function dswipeBack(args, messageId) {
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
    } catch (error) {
        chat.push(...messagesToRestore);
        console.error(`[${EXTENSION_NAME}] Error:`, error);
        return 'Navigation failed';
    }
}

/**
 * Generate a new swipe for a message
 */
async function dswipeForward(args, messageId) {
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
        if (message.is_user && extension_settings[EXTENSION_NAME]?.impersonationPrompt) {
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

        if (extension_settings[EXTENSION_NAME]?.swipeNavigation) {
            setTimeout(() => {
                addSwipeNavigationToMessage(messageId);
                updateMessageSwipeUI(messageId);
            }, 100);
        }

        // Save the chat to persist the new swipe
        await saveChatConditional();

        toastr.success(`Generated new swipe for message #${messageId}`, 'Deep Swipe');
        return `Generated new swipe`;

    } catch (error) {
        chat.push(...messagesToRestore);
        console.error(`[${EXTENSION_NAME}] Error:`, error);
        toastr.error(`Failed to generate swipe: ${error.message}`, 'Deep Swipe');
        return 'Generation failed';
    }
}

/**
 * Generate a new swipe for a user message using guided impersonation
 * Now with support for reasoning/thinking traces
 */
async function generateUserMessageSwipe(message, messageId, context) {
    const impersonationPrompt = extension_settings[EXTENSION_NAME]?.impersonationPrompt || '';
    const chat = context.chat;

    if (!impersonationPrompt) {
        await duplicateMessageAsSwipe(message, messageId);
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
    let generatedText = '';

    try {
        // Show ellipsis (...) before generation starts
        if (messageElement) {
            messageElement.textContent = '...';
        }

        // Record generation start time for reasoning duration
        generationStarted = new Date();

        // WORKAROUND: To send the impersonation prompt as a user message instead of system,
        // we temporarily add a user message to the chat, then use quiet generation.
        // The prompt will be included as part of the chat history as a user message.
        const tempUserMessage = {
            name: userName,
            is_user: true,
            mes: fullPrompt,
            send_date: new Date().toISOString(),
            extra: { isSmallSys: true }, // Mark as small system to hide from normal view
        };
        
        // Add temporary message to chat
        chat.push(tempUserMessage);

        const generateOptions = {
            quiet_prompt: '', // Empty since we added our prompt as a user message
        };

        try {
            // Generate using quiet mode - our temp message will be the last user message
            const result = await Generate('quiet', generateOptions);

            // Record generation finish time
            generationFinished = new Date();

            // Remove the temporary message from chat
            chat.pop();

            // Extract the generated text from the result
            if (typeof result === 'string') {
                generatedText = result;
            } else if (result) {
                // Check for common properties that might contain the generated text
                if (typeof result.text === 'string') {
                    generatedText = result.text;
                } else if (typeof result.mes === 'string') {
                    generatedText = result.mes;
                } else if (typeof result.getMessage === 'function') {
                    generatedText = result.getMessage();
                } else if (typeof result.getMessage === 'string') {
                    generatedText = result.getMessage;
                } else if (typeof result.message === 'string') {
                    generatedText = result.message;
                } else if (typeof result.content === 'string') {
                    generatedText = result.content;
                }
            }

            // Parse reasoning from the generated text after generation completes
            // This avoids the infinite loop caused by streaming event listeners
            if (generatedText) {
                const parsedResult = parseReasoningFromString(generatedText, { strict: true });
                if (parsedResult && parsedResult.reasoning) {
                    capturedReasoning = parsedResult.reasoning;
                    // Use the message content without the reasoning block
                    generatedText = parsedResult.content;
                    reasoningDuration = generationFinished.getTime() - generationStarted.getTime();
                    console.debug(`[${EXTENSION_NAME}] Parsed reasoning from impersonation:`, capturedReasoning.substring(0, 50) + '...');
                }
            }
        } catch (error) {
            // Make sure to clean up temp message even on error
            if (chat[chat.length - 1] === tempUserMessage) {
                chat.pop();
            }
            throw error;
        }

        console.log(`[${EXTENSION_NAME}] Before saving - message state:`, {
            is_user: message.is_user,
            name: message.name,
            swipe_id: message.swipe_id,
            swipes_length: message.swipes?.length,
            has_generated_text: !!(generatedText && generatedText.trim()),
        });

        // If we got generated text, use it; otherwise duplicate current
        if (generatedText && generatedText.trim()) {
            const trimmedText = generatedText.trim();
            message.swipes[message.swipe_id] = trimmedText;
            // CRITICAL FIX: Update message.mes to match the new swipe!
            message.mes = trimmedText;

            // Ensure message keeps its user properties
            message.is_user = true;
            if (!message.name || message.name === 'System') {
                const context = getContext();
                message.name = context.name1 || 'User';
            }

            console.log(`[${EXTENSION_NAME}] After setting text - message state:`, {
                is_user: message.is_user,
                name: message.name,
                mes_preview: message.mes?.substring(0, 50) + '...',
            });

            // Create swipe_info entry with reasoning data
            const swipeInfoExtra = {
                ...structuredClone(message.extra || {}),
            };

            // Store reasoning data if captured
            if (capturedReasoning) {
                swipeInfoExtra.reasoning = capturedReasoning;
                swipeInfoExtra.reasoning_duration = reasoningDuration;
                swipeInfoExtra.reasoning_type = ReasoningType.Model;
            }

            // Add swipe_info entry
            message.swipe_info.push({
                send_date: generationFinished ? generationFinished.toISOString() : new Date().toISOString(),
                gen_started: generationStarted,
                gen_finished: generationFinished,
                extra: swipeInfoExtra,
            });

            // Also update current message extra with reasoning for immediate display
            if (capturedReasoning) {
                if (!message.extra) {
                    message.extra = {};
                }
                message.extra.reasoning = capturedReasoning;
                message.extra.reasoning_duration = reasoningDuration;
                message.extra.reasoning_type = ReasoningType.Model;
            }
        } else {
            // Fallback: duplicate current message
            message.swipes[message.swipe_id] = currentText;
            message.mes = currentText;
            
            // Copy swipe_info from current swipe
            const currentSwipeId = message.swipe_id > 0 ? message.swipe_id - 1 : 0;
            message.swipe_info.push(structuredClone(message.swipe_info?.[currentSwipeId] || {
                send_date: new Date().toISOString(),
                gen_started: null,
                gen_finished: null,
                extra: structuredClone(message.extra || {}),
            }));
        }

        // Remove the waiting toast
        if (waitingToast) {
            $(waitingToast).remove();
        }

        // Update reasoning UI if reasoning was captured
        if (capturedReasoning) {
            updateReasoningUI(messageId);
        }

    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Error in guided impersonation:`, error);
        // Remove the waiting toast
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
        throw error;
    }
}

/**
 * Duplicate current message as a new swipe (fallback when no prompt set)
 */
async function duplicateMessageAsSwipe(message, messageId) {
    if (!Array.isArray(message.swipes)) {
        message.swipes = [message.mes];
        message.swipe_id = 0;
    }

    // Add duplicate as new swipe
    message.swipes.push(message.mes);
    message.swipe_id = message.swipes.length - 1;
}

/**
 * Check if message should have UI components
 */
function shouldAddUiComponents(messageElement) {
    const context = getContext();
    const chat = context.chat;
    const messageId = parseInt(messageElement.getAttribute('mesid'), 10);
    
    // Check if this is actually the last message (not just by class)
    // SillyTavern doesn't remove last_mes class from previous messages
    const isLastMessage = messageId === chat.length - 1;
    if (isLastMessage) return false;
    
    if (messageElement.getAttribute('is_system') === 'true') return false;
    
    // Allow user messages if userSwipes setting is enabled
    const isUser = messageElement.getAttribute('is_user') === 'true';
    if (isUser && !extension_settings[EXTENSION_NAME]?.userSwipes) return false;
    
    return true;
}

/**
 * Add swipe navigation (arrows + counter) to message
 */
function addSwipeNavigationToMessage(messageId) {
    const context = getContext();
    const chat = context.chat;
    const message = chat[messageId];

    if (!message) {
        return;
    }

    if (!isMessageSwipeable(message)) {
        return;
    }

    const messageElement = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (!messageElement) {
        return;
    }

    if (!shouldAddUiComponents(messageElement)) {
        return;
    }
    
    // Check if message is being edited - don't add navigation during edit
    if (messageElement.classList.contains('is_editing')) {
        return;
    }

    // Remove existing navigation (only remove elements with our custom deep-swipe classes)
    messageElement.querySelectorAll('.deep-swipe-left').forEach(el => el.remove());
    messageElement.querySelectorAll('.deep-swipe-right').forEach(el => el.remove());
    // Remove swipeRightBlock containers that we added (they have deep-swipe-right inside)
    messageElement.querySelectorAll('.swipeRightBlock').forEach(el => {
        if (el.querySelector('.deep-swipe-right')) {
            el.remove();
        }
    });
    messageElement.querySelectorAll('.deep-swipe-navigation').forEach(el => el.remove());

    // Show navigation for both user and assistant messages
    // But only show counter for user messages (assistant messages have native counter)
    const swipeCount = message.swipes?.length || 1;
    const currentSwipe = Math.min(message.swipe_id || 0, swipeCount - 1);

    const navContainer = document.createElement('div');
    navContainer.className = 'deep-swipe-navigation deep-swipe-nav-container';
    
    // Left arrow (previous) - only create if there's more than 1 swipe
    let leftArrow = null;
    if (swipeCount > 1) {
        leftArrow = document.createElement('div');
        leftArrow.className = 'swipe_left deep-swipe-left fa-solid fa-chevron-left';
        leftArrow.title = 'Previous swipe';
        // Force visibility to override native SillyTavern hiding rules
        leftArrow.style.setProperty('display', 'flex', 'important');
        leftArrow.style.setProperty('opacity', '0.5', 'important');
        leftArrow.style.setProperty('visibility', 'visible', 'important');
        leftArrow.style.setProperty('pointer-events', 'auto', 'important');
        
        leftArrow.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();

        // Check if any message is being edited - disable swipes globally during edit
        if (isAnyMessageBeingEdited()) {
            toastr.warning('Cannot swipe while a message is being edited. Please finish editing first.', 'Deep Swipe');
            return;
        }

        if (!extension_settings[EXTENSION_NAME]?.enabled) {
            return;
        }
        if (leftArrow.classList.contains('disabled')) {
            return;
        }

        await dswipeBack({}, messageId);
    });
    }

    // Right arrow (next/generate) - use native swipe_right class for consistent styling
    const rightArrow = document.createElement('div');
    rightArrow.className = 'swipe_right deep-swipe-right fa-solid fa-chevron-right';
    // Add assistant-swipe-arrow class for assistant messages to position them correctly
    if (!message.is_user) {
        rightArrow.classList.add('assistant-swipe-arrow');
    }
    rightArrow.title = currentSwipe >= swipeCount - 1 ? 'Generate new swipe' : 'Next swipe';
    // Force visibility to override native SillyTavern hiding rules
    rightArrow.style.setProperty('display', 'flex', 'important');
    rightArrow.style.setProperty('opacity', '0.5', 'important');
    rightArrow.style.setProperty('visibility', 'visible', 'important');
    rightArrow.style.setProperty('pointer-events', 'auto', 'important');
    
    rightArrow.addEventListener('click', async (e) => {
        e.stopPropagation();
        e.preventDefault();

        // Check if any message is being edited - disable swipes globally during edit
        if (isAnyMessageBeingEdited()) {
            toastr.warning('Cannot swipe while a message is being edited. Please finish editing first.', 'Deep Swipe');
            return;
        }
        
        if (!extension_settings[EXTENSION_NAME]?.enabled) {
            return;
        }

        const context = getContext();
        const chat = context.chat;
        const msg = chat[messageId];
        
        if (!msg) {
            console.error(`[${EXTENSION_NAME}] Message ${messageId} not found in chat`);
            return;
        }
        
        const currentId = msg.swipe_id || 0;
        const totalSwipes = msg.swipes?.length || 1;

        if (currentId >= totalSwipes - 1) {
            await dswipeForward({}, messageId);
        } else {
            // CRITICAL FIX: Manually handle swipe navigation instead of relying on native swipe.right()
            // The native swipe.right() with forceSwipeId doesn't work reliably - it resets swipe_id to 0
            const targetSwipeId = currentId + 1;
            
            // For user messages, manually update swipe (SillyTavern blocks user message swipes)
            if (msg.is_user) {
                msg.swipe_id = targetSwipeId;
                msg.mes = msg.swipes[targetSwipeId];
                
                // Sync reasoning data from swipe_info
                syncReasoningFromSwipeInfo(msg, targetSwipeId);
            } else {
                // For assistant messages, try native swipe but fallback to manual if it fails
                // SillyTavern only allows swiping the last message.
                // Temporarily hide messages after target to make it the last message.
                const messagesToRestore = chat.slice(messageId + 1);
                chat.length = messageId + 1;
                
                try {
                    await context.swipe.right(null, {
                        message: msg,
                        forceMesId: messageId,
                        forceSwipeId: targetSwipeId
                    });
                    
                    // Restore hidden messages
                    chat.push(...messagesToRestore);
                    
                    // Check if native swipe worked correctly
                    const updatedMsg = chat[messageId];
                    
                    // If native swipe didn't work (swipe_id is wrong), manually fix it
                    if (updatedMsg.swipe_id !== targetSwipeId) {
                        updatedMsg.swipe_id = targetSwipeId;
                        updatedMsg.mes = updatedMsg.swipes[targetSwipeId];
                    }
                    
                    // Re-render the message with the new swipe
                    context.addOneMessage(updatedMsg, {
                        type: 'swipe',
                        forceId: messageId,
                        scroll: false,
                        showSwipes: true
                    });
                    
                    updateMessageSwipeUI(messageId);
                } catch (error) {
                    chat.push(...messagesToRestore);
                    console.error(`[${EXTENSION_NAME}] Error in forward navigation:`, error);
                }
                
                // Return early since we handled assistant messages above
                return;
            }
            
            // For user messages, re-render with the manually updated message
            context.addOneMessage(msg, {
                type: 'swipe',
                forceId: messageId,
                scroll: false,
                showSwipes: true
            });
            
            // Update UI including reasoning
            updateMessageSwipeUI(messageId);
            updateReasoningUI(messageId, { reset: true });
        }
    });

    // Create swipe counter - only for user messages (assistant messages have native counter)
    let counter = null;
    if (message.is_user) {
        counter = document.createElement('div');
        // Use a unique class name to avoid conflicts with native counters
        counter.className = 'swipes-counter deep-swipe-counter';
        counter.textContent = formatSwipeCounter(currentSwipe, swipeCount);
        // Force visibility to override native SillyTavern hiding rules
        counter.style.setProperty('display', 'flex', 'important');
        // Don't set opacity inline - let CSS control it (0.3 for greyed-out look)
        counter.style.setProperty('visibility', 'visible', 'important');
        counter.style.setProperty('pointer-events', 'auto', 'important');
    }

    // Right block container - use native swipeRightBlock class for consistent styling
    const rightBlock = document.createElement('div');
    rightBlock.className = 'swipeRightBlock flex-container flexFlowColumn flexNoGap';
    rightBlock.appendChild(rightArrow);
    if (counter) {
        rightBlock.appendChild(counter);
    }
    // Force visibility to override native SillyTavern hiding rules
    rightBlock.style.setProperty('display', 'flex', 'important');
    rightBlock.style.setProperty('visibility', 'visible', 'important');
    rightBlock.style.setProperty('pointer-events', 'auto', 'important');

    // Insert into message like native swipe buttons
    const mesBlock = messageElement.querySelector('.mes_block');
    
    if (mesBlock) {
        // Insert left arrow before mes_block (like native swipe_left) - only if it exists
        if (leftArrow) {
            mesBlock.insertAdjacentElement('beforebegin', leftArrow);
        }
        
        // For assistant messages, insert right arrow before native swipeRightBlock (to avoid overlap)
        // For user messages, insert right block after mes_block (like native)
        if (!message.is_user) {
            // Assistant message: insert right arrow directly, before native swipeRightBlock
            const nativeSwipeRightBlock = messageElement.querySelector('.swipeRightBlock');
            if (nativeSwipeRightBlock) {
                nativeSwipeRightBlock.insertAdjacentElement('beforebegin', rightArrow);
            } else {
                // Fallback: insert after mes_block
                mesBlock.insertAdjacentElement('afterend', rightArrow);
            }
        } else {
            // User message: insert right block after mes_block (like native)
            mesBlock.insertAdjacentElement('afterend', rightBlock);
        }
    } else {
        // Fallback: use container approach
        if (leftArrow) {
            navContainer.appendChild(leftArrow);
        }
        navContainer.appendChild(rightBlock);
        messageElement.appendChild(navContainer);
    }
}

/**
 * Update swipe UI for a message (counter, arrow states)
 */
function updateMessageSwipeUI(messageId) {
    const context = getContext();
    const chat = context.chat;
    const message = chat[messageId];

    if (!message) return;

    const messageElement = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (!messageElement) return;

    const swipeCount = message.swipes?.length || 0;
    const currentId = message.swipe_id || 0;

    // Update counter - use the correct class name (swipes-counter, not deep-swipe-counter)
    // Update ALL counters found (there may be multiple due to DOM structure)
    const counters = messageElement.querySelectorAll('.swipes-counter');
    counters.forEach((counter) => {
        counter.textContent = formatSwipeCounter(currentId, swipeCount);
    });
 
    // Update right arrow tooltip based on position
    const rightArrow = messageElement.querySelector('.deep-swipe-right');
    if (rightArrow) {
        rightArrow.title = currentId >= swipeCount - 1 ? 'Generate new swipe' : 'Next swipe';
    }

    // Update left arrow visibility based on swipe count
    const leftArrow = messageElement.querySelector('.deep-swipe-left');
    if (leftArrow) {
        if (swipeCount <= 1) {
            // Disable left arrow if there's only 1 swipe
            leftArrow.style.cursor = 'not-allowed';
            leftArrow.style.opacity = '0.3';
            leftArrow.style.pointerEvents = 'none';
            // Ensure visibility is maintained even when disabled
            leftArrow.style.setProperty('display', 'flex', 'important');
            leftArrow.style.setProperty('visibility', 'visible', 'important');
        } else {
            // Enable left arrow if there's more than 1 swipe
            leftArrow.style.cursor = 'pointer';
            leftArrow.style.opacity = '1';
            leftArrow.style.pointerEvents = 'auto';
            // Ensure visibility is maintained
            leftArrow.style.setProperty('display', 'flex', 'important');
            leftArrow.style.setProperty('visibility', 'visible', 'important');
        }
    }
}

/**
 * Store the current message ID being edited for delete swipe functionality
 */
let currentEditMessageId = null;

/**
 * Check if a message has multiple swipes and can delete swipe
 */
function canDeleteSwipe(messageId) {
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
 */
function trackEditMessage(messageId) {
    currentEditMessageId = messageId;
}

/**
 * Clear tracked edit message
 */
function clearEditMessage() {
    currentEditMessageId = null;
}

/**
 * Check if any message is currently being edited
 * This is used to disable swipes globally while editing
 */
function isAnyMessageBeingEdited() {
    // Check for edit textarea presence which indicates edit mode
    const editTextareas = document.querySelectorAll('.mes .edit_textarea');
    return editTextareas.length > 0;
}

/**
 * Get the current swipe index for delete confirmation popup
 * This is used by the event interceptor to pass swipe info to deleteMessage
 */
function getSwipeIndexForDelete() {
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
 * Remove all deep swipe UI components
 */
function removeAllDeepSwipeUI() {
    document.querySelectorAll('.deep-swipe-navigation').forEach(nav => nav.remove());
    // Only remove elements with our custom deep-swipe classes, not native swipe elements
    document.querySelectorAll('.deep-swipe-left').forEach(el => el.remove());
    document.querySelectorAll('.deep-swipe-right').forEach(el => el.remove());
    // Remove swipe counters that were added by our extension (they're inside swipeRightBlock)
    // Note: We can't easily distinguish our counters from native ones, so we let the
    // addSwipeNavigationToMessage function handle removal of existing UI before adding new
}

/**
 * Add UI to all messages with retry
 */
function addUiToAllMessages(retryCount = 0) {
    const settings = extension_settings[EXTENSION_NAME];
    if (!settings?.enabled) return;

    const context = getContext();
    const chat = context.chat;

    if (!chat || chat.length === 0) {
        if (retryCount < 10) {
            setTimeout(() => addUiToAllMessages(retryCount + 1), 500);
        }
        return;
    }

    let addedCount = 0;
    chat.forEach((message, index) => {
        if (settings.swipeNavigation) {
            const messageElement = document.querySelector(`.mes[mesid="${index}"]`);
            if (messageElement) {
                addSwipeNavigationToMessage(index);
                addedCount++;
            }
        }
    });

    // Retry if not all messages were processed
    if (addedCount < chat.length && retryCount < 10) {
        setTimeout(() => addUiToAllMessages(retryCount + 1), 500);
    }
}

/**
 * Handle message rendered event
 */
function onMessageRendered(messageId) {
    const settings = extension_settings[EXTENSION_NAME];
    if (!settings?.enabled) return;

    if (settings.swipeNavigation) {
        addSwipeNavigationToMessage(messageId);
    }
}

/**
 * Handle message updated (swipe changed)
 */
function onMessageUpdated(messageId) {
    const settings = extension_settings[EXTENSION_NAME];
    if (!settings?.enabled) return;

    // Refresh the swipe navigation UI
    if (settings.swipeNavigation) {
        addSwipeNavigationToMessage(messageId);
        updateMessageSwipeUI(messageId);
    }
}

/**
 * Register slash commands
 */
async function registerSlashCommands() {
    try {
        const { SlashCommand } = await import('/scripts/slash-commands/SlashCommand.js');
        const { SlashCommandParser } = await import('/scripts/slash-commands/SlashCommandParser.js');
        const { ARGUMENT_TYPE, SlashCommandArgument } = await import('/scripts/slash-commands/SlashCommandArgument.js');

        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'dswipe',
            helpString: 'Deep Swipe - Generate or navigate swipes. Usage: /dswipe back|forward [messageId]',
            returns: 'string',
            aliases: ['ds'],
            splitUnnamedArgument: true,
            splitUnnamedArgumentCount: 2,
            unnamedArgumentList: [
                new SlashCommandArgument('action', ARGUMENT_TYPE.STRING, false, 'Action: "back" or "forward"', ['back', 'forward']),
                new SlashCommandArgument('messageId', ARGUMENT_TYPE.NUMBER, true, 'Message ID'),
            ],
            callback: async (args, action, messageId) => {
                if (!extension_settings[EXTENSION_NAME]?.enabled) {
                    toastr.warning('Deep Swipe is disabled.', 'Deep Swipe');
                    return 'Extension disabled';
                }

                const id = parseInt(messageId, 10);
                if (isNaN(id)) {
                    toastr.error('Message ID must be a valid number', 'Deep Swipe');
                    return 'Invalid message ID';
                }

                if (action === 'back') {
                    return await dswipeBack(args, id);
                } else if (action === 'forward') {
                    return await dswipeForward(args, id);
                } else {
                    toastr.error('Action must be "back" or "forward"', 'Deep Swipe');
                    return 'Invalid action';
                }
            },
        }));

        // Register delete swipe command
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'ddelswipe',
            helpString: 'Deep Swipe - Delete the current swipe from a message. Usage: /ddelswipe [messageId]',
            returns: 'string',
            aliases: ['dds'],
            unnamedArgumentList: [
                new SlashCommandArgument('messageId', ARGUMENT_TYPE.NUMBER, true, 'Message ID (defaults to last message)'),
            ],
            callback: async (args, messageId) => {
                if (!extension_settings[EXTENSION_NAME]?.enabled) {
                    toastr.warning('Deep Swipe is disabled.', 'Deep Swipe');
                    return 'Extension disabled';
                }

                const context = getContext();
                const chat = context.chat;
                let id;

                if (messageId === undefined || messageId === null) {
                    // Default to last message
                    id = chat.length - 1;
                } else {
                    id = parseInt(messageId, 10);
                }

                if (isNaN(id) || id < 0 || id >= chat.length) {
                    toastr.error('Message ID must be a valid number', 'Deep Swipe');
                    return 'Invalid message ID';
                }

                // Get the context to access the chat
                const delCtx = getContext();
                const delChat = delCtx.chat;

                if (!isValidMessageId(id, delChat)) {
                    toastr.error('Invalid message ID', 'Deep Swipe');
                    return 'Invalid message ID';
                }

                const message = delChat[id];
                if (!Array.isArray(message.swipes) || message.swipes.length <= 1) {
                    toastr.warning('No swipes available to delete for this message.', 'Deep Swipe');
                    return 'No swipes to delete';
                }

                const swipeIndex = message.swipe_id ?? 0;
                await deleteSwipe(swipeIndex, id);
                return `Deleted swipe ${swipeIndex + 1} from message ${id}`;
            },
        }));

    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to register slash commands:`, error);
    }
}

/**
 * Initialize UI components
 */
function initializeUi() {
    if (buttonsInitialized) return;

    const context = getContext();
    if (!context.eventSource || !context.eventTypes) {
        setTimeout(initializeUi, 1000);
        return;
    }

    // Use makeLast to ensure our handlers run AFTER SillyTavern's rendering
    // This prevents navigation elements from being removed when messages are updated
    context.eventSource.makeLast(context.eventTypes.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    context.eventSource.makeLast(context.eventTypes.USER_MESSAGE_RENDERED, onMessageRendered);
    context.eventSource.makeLast(context.eventTypes.MESSAGE_UPDATED, onMessageUpdated);
    context.eventSource.makeLast(context.eventTypes.MESSAGE_SWIPED, onMessageUpdated);
    context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => {
        setTimeout(() => addUiToAllMessages(), 500);
    });

    // Set up MutationObserver to catch messages as soon as they appear in DOM
    // and detect when messages lose 'last_mes' class (former last message)
    const chatElement = document.getElementById('chat');
    if (chatElement) {
        const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'childList') {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType === Node.ELEMENT_NODE && node.classList?.contains('mes')) {
                            const mesId = node.getAttribute('mesid');
                            if (mesId) {
                                setTimeout(() => addSwipeNavigationToMessage(parseInt(mesId, 10)), 100);
                            }
                        }
                    }
                }
                // Detect when a message loses 'last_mes' class - it needs our buttons now
                if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                    const target = mutation.target;
                    if (target.classList?.contains('mes') && !target.classList.contains('last_mes')) {
                        const mesId = target.getAttribute('mesid');
                        if (mesId && !target.querySelector('.deep-swipe-right')) {
                            setTimeout(() => addSwipeNavigationToMessage(parseInt(mesId, 10)), 100);
                        }
                    }
                }
            }
        });
        
        observer.observe(chatElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

        // Monitor for edit mode changes - track which message is being edited
        const editObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
                    const target = mutation.target;
                    if (target.classList?.contains('mes')) {
                        const mesId = target.getAttribute('mesid');
                        if (mesId) {
                            const messageId = parseInt(mesId, 10);
                            if (target.classList.contains('is_editing')) {
                                // Message entered edit mode - track it
                                trackEditMessage(messageId);
                            } else if (currentEditMessageId === messageId) {
                                // Message exited edit mode - clear tracking only if it's the same message
                                clearEditMessage();
                            }
                        }
                    }
                }
            }
        });

        editObserver.observe(chatElement, { subtree: true, attributes: true, attributeFilter: ['class'] });

        // Also track when edit mode is entered via the edit button click
        // This ensures we catch the message ID before the class is added
        $(document).on('click', '.mes_edit', function() {
            const mesElement = $(this).closest('.mes');
            const mesId = mesElement.attr('mesid');
            if (mesId) {
                const messageId = parseInt(mesId, 10);
                trackEditMessage(messageId);
            }
        });
    }

    // Intercept delete button clicks to enable swipe deletion for messages
    // Native SillyTavern only allows swipe deletion for the last assistant message
    // Use capturing phase to intercept BEFORE the native handler
    document.addEventListener('click', async function (e) {
        // Check if the clicked element is the delete button
        const deleteButton = e.target.closest('.mes_edit_delete');
        if (!deleteButton) return;

        // Check if deep swipe is enabled
        if (!extension_settings[EXTENSION_NAME]?.enabled) return;

        // Get the message ID from the DOM - find the parent .mes element
        const mesElement = deleteButton.closest('.mes');
        if (!mesElement) return;

        const mesIdAttr = mesElement.getAttribute('mesid');
        if (!mesIdAttr) return;

        const messageId = parseInt(mesIdAttr, 10);
        if (isNaN(messageId)) return;

        const context = getContext();
        const chat = context.chat;

        // Check if this is a valid message
        if (!isValidMessageId(messageId, chat)) return;

        const message = chat[messageId];
        const isLastMessage = messageId === chat.length - 1;

        // For user messages: handle if user swipes feature is enabled
        if (message.is_user) {
            if (!extension_settings[EXTENSION_NAME]?.userSwipes) return;
        } else {
            // For assistant messages: only handle if it's NOT the last message
            // (last message is handled natively by SillyTavern)
            if (isLastMessage) return;
        }

        // Check if there are multiple swipes to delete
        if (!Array.isArray(message.swipes) || message.swipes.length <= 1) return;

        const swipeIndex = message.swipe_id ?? 0;

        // This is a message with multiple swipes - handle it ourselves
        // Stop the native handler by preventing default and stopping propagation
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        try {
            // Call deleteMessage with the swipe index, requesting confirmation
            // This will show the popup with "Delete Swipe" and "Delete Message" buttons
            await deleteMessage(messageId, swipeIndex, true);

            // Update tracking
            clearEditMessage();
        } catch (error) {
            console.error(`[${EXTENSION_NAME}] Error in delete handler:`, error);
        }

        return false;
    }, true); // Use capturing phase

    buttonsInitialized = true;
}

/**
 * Export the swipe index getter for use by other extensions or native code
 * This allows the delete confirmation popup to show "Delete Swipe" option
 */
export function getDeleteSwipeIndex() {
    return getSwipeIndexForDelete();
}

/**
 * Export the current edit message ID
 */
export function getCurrentEditMessageId() {
    return currentEditMessageId;
}

/**
 * Handle enable/disable toggle
 */
function onEnabledChange(event) {
    const value = Boolean(event.target.checked);
    extension_settings[EXTENSION_NAME].enabled = value;
    saveSettingsDebounced();

    if (value) {
        toastr.success('Deep Swipe enabled', 'Deep Swipe');
        addUiToAllMessages();
    } else {
        toastr.info('Deep Swipe disabled', 'Deep Swipe');
        removeAllDeepSwipeUI();
    }
}

/**
 * Handle swipe navigation toggle
 */
function onSwipeNavigationChange(event) {
    const value = Boolean(event.target.checked);
    extension_settings[EXTENSION_NAME].swipeNavigation = value;
    saveSettingsDebounced();

    if (value) {
        toastr.success('Swipe navigation enabled', 'Deep Swipe');
        const context = getContext();
        context.chat.forEach((_, index) => addSwipeNavigationToMessage(index));
    } else {
        toastr.info('Swipe navigation disabled', 'Deep Swipe');
        // Remove all navigation elements including left/right blocks
        document.querySelectorAll('.deep-swipe-left').forEach(el => el.remove());
        document.querySelectorAll('.deep-swipe-right-block').forEach(el => el.remove());
        document.querySelectorAll('.deep-swipe-navigation').forEach(nav => nav.remove());
    }
}

/**
 * Handle user swipes toggle
 */
function onUserSwipesChange(event) {
    const value = Boolean(event.target.checked);
    extension_settings[EXTENSION_NAME].userSwipes = value;
    saveSettingsDebounced();

    if (value) {
        toastr.success('User message swipes enabled', 'Deep Swipe');
        // Refresh UI to show navigation on user messages
        const context = getContext();
        context.chat.forEach((_, index) => addSwipeNavigationToMessage(index));
    } else {
        toastr.info('User message swipes disabled', 'Deep Swipe');
        // Remove navigation from user messages
        removeAllDeepSwipeUI();
        // Re-add to AI messages only
        const context = getContext();
        const settings = extension_settings[EXTENSION_NAME];
        if (settings?.swipeNavigation) {
            context.chat.forEach((msg, index) => {
                if (!msg.is_user) {
                    addSwipeNavigationToMessage(index);
                }
            });
        }
    }
}

/**
 * Handle impersonation prompt change
 */
function onImpersonationPromptChange(event) {
    const value = event.target.value;
    extension_settings[EXTENSION_NAME].impersonationPrompt = value;
    saveSettingsDebounced();
}

/**
 * Handle reset prompt button click
 */
function onResetPromptClick() {
    const textarea = document.getElementById('deep_swipe_impersonation_prompt');
    if (textarea) {
        textarea.value = DEFAULT_IMPERSONATION_PROMPT;
        extension_settings[EXTENSION_NAME].impersonationPrompt = DEFAULT_IMPERSONATION_PROMPT;
        saveSettingsDebounced();
        toastr.info('Impersonation prompt reset to default', 'Deep Swipe');
    }
}

/**
 * Initialize the extension
 */
jQuery(async () => {
    try {
        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensions_settings').append(settingsHtml);

        document.getElementById('deep_swipe_enabled')?.addEventListener('change', onEnabledChange);
        document.getElementById('deep_swipe_swipe_navigation')?.addEventListener('change', onSwipeNavigationChange);
        document.getElementById('deep_swipe_user_swipes')?.addEventListener('change', onUserSwipesChange);
        document.getElementById('deep_swipe_impersonation_prompt')?.addEventListener('input', onImpersonationPromptChange);
        document.getElementById('deep_swipe_reset_prompt')?.addEventListener('click', onResetPromptClick);

        loadSettings();
        await registerSlashCommands();

        // Try multiple times to add UI as messages may render at different times
        setTimeout(() => {
            initializeUi();
            addUiToAllMessages();
        }, 1000);

        // Additional attempts to catch late-rendered messages
        setTimeout(() => addUiToAllMessages(), 2000);
        setTimeout(() => addUiToAllMessages(), 3500);
    } catch (error) {
        console.error(`[${EXTENSION_NAME}] Failed to initialize:`, error);
    }
});
