/**
 * Deep Swipe Extension - UI Module
 *
 * DOM manipulation and swipe navigation UI components.
 *
 * @author Rurijian
 * @version 1.2.0
 * @license MIT
 */

import { getContext } from '../../../extensions.js';
import { EXTENSION_NAME, getSettings } from './config.js';
import {
    isValidMessageId,
    isMessageSwipeable,
    formatSwipeCounter,
    syncReasoningFromSwipeInfo,
    isAnyMessageBeingEdited,
    getCurrentEditMessageId,
    trackEditMessage,
    clearEditMessage,
    log,
    error
} from './utils.js';

// Forward declarations for functions that will be set by the main module
let dswipeBackFn = null;
let dswipeForwardFn = null;

/**
 * Set the swipe navigation functions from the main module
 * @param {Function} backFn - The dswipeBack function
 * @param {Function} forwardFn - The dswipeForward function
 */
export function setSwipeFunctions(backFn, forwardFn) {
    dswipeBackFn = backFn;
    dswipeForwardFn = forwardFn;
}

/**
 * Check if message should have UI components
 * @param {Element} messageElement - The message DOM element
 * @returns {boolean} True if UI components should be added
 */
export function shouldAddUiComponents(messageElement) {
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
    const settings = getSettings();
    if (isUser && !settings?.userSwipes) return false;

    return true;
}

/**
 * Update swipe UI for a message (counter, arrow states)
 * @param {number} messageId - The message ID to update
 */
export function updateMessageSwipeUI(messageId) {
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
 * Add swipe navigation (arrows + counter) to message
 * @param {number} messageId - The message ID to add navigation to
 */
export function addSwipeNavigationToMessage(messageId) {
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

            const settings = getSettings();
            if (!settings?.enabled) {
                return;
            }
            if (leftArrow.classList.contains('disabled')) {
                return;
            }

            if (dswipeBackFn) {
                await dswipeBackFn({}, messageId);
            }
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

        const settings = getSettings();
        if (!settings?.enabled) {
            return;
        }

        const ctx = getContext();
        const currentChat = ctx.chat;
        const msg = currentChat[messageId];

        if (!msg) {
            error(`Message ${messageId} not found in chat`);
            return;
        }

        const currentId = msg.swipe_id || 0;
        const totalSwipes = msg.swipes?.length || 1;

        if (currentId >= totalSwipes - 1) {
            if (dswipeForwardFn) {
                await dswipeForwardFn({}, messageId);
            }
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
                const messagesToRestore = currentChat.slice(messageId + 1);
                currentChat.length = messageId + 1;

                try {
                    await ctx.swipe.right(null, {
                        message: msg,
                        forceMesId: messageId,
                        forceSwipeId: targetSwipeId
                    });

                    // Restore hidden messages
                    currentChat.push(...messagesToRestore);

                    // Check if native swipe worked correctly
                    const updatedMsg = currentChat[messageId];

                    // If native swipe didn't work (swipe_id is wrong), manually fix it
                    if (updatedMsg.swipe_id !== targetSwipeId) {
                        updatedMsg.swipe_id = targetSwipeId;
                        updatedMsg.mes = updatedMsg.swipes[targetSwipeId];
                    }

                    // Re-render the message with the new swipe
                    ctx.addOneMessage(updatedMsg, {
                        type: 'swipe',
                        forceId: messageId,
                        scroll: false,
                        showSwipes: true
                    });

                    updateMessageSwipeUI(messageId);
                } catch (err) {
                    currentChat.push(...messagesToRestore);
                    error('Error in forward navigation:', err);
                }

                // Return early since we handled assistant messages above
                return;
            }

            // For user messages, re-render with the manually updated message
            ctx.addOneMessage(msg, {
                type: 'swipe',
                forceId: messageId,
                scroll: false,
                showSwipes: true
            });

            // Update UI including reasoning
            updateMessageSwipeUI(messageId);
            const { updateReasoningUI } = await import('../../../../scripts/reasoning.js');
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
 * Remove all deep swipe UI components
 */
export function removeAllDeepSwipeUI() {
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
 * @param {number} [retryCount=0] - Current retry count
 */
export function addUiToAllMessages(retryCount = 0) {
    const settings = getSettings();
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
 * @param {number} messageId - The rendered message ID
 */
export function onMessageRendered(messageId) {
    const settings = getSettings();
    if (!settings?.enabled) return;

    if (settings.swipeNavigation) {
        addSwipeNavigationToMessage(messageId);
    }
}

/**
 * Handle message updated (swipe changed)
 * @param {number} messageId - The updated message ID
 */
export function onMessageUpdated(messageId) {
    const settings = getSettings();
    if (!settings?.enabled) return;

    // Refresh the swipe navigation UI
    if (settings.swipeNavigation) {
        addSwipeNavigationToMessage(messageId);
        updateMessageSwipeUI(messageId);
    }
}

/**
 * Setup MutationObservers for dynamic message handling
 * @param {Object} context - The SillyTavern context
 * @param {Function} onDeleteClick - Handler for delete button clicks
 */
export function setupMutationObservers(context, onDeleteClick) {
    const chatElement = document.getElementById('chat');
    if (!chatElement) return;

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
                        } else if (getCurrentEditMessageId() === messageId) {
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

    // Intercept delete button clicks to enable swipe deletion for messages
    // Native SillyTavern only allows swipe deletion for the last assistant message
    // Use capturing phase to intercept BEFORE the native handler
    document.addEventListener('click', onDeleteClick, true);

    return observer;
}
