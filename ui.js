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

    const isUser = messageElement.getAttribute('is_user') === 'true';
    const settings = getSettings();

    // Check if swipes are enabled for this message type
    if (isUser) {
        // User messages: check userSwipes setting
        if (!settings?.userSwipes) return false;
    } else {
        // Assistant messages: check assistantSwipes setting (default true)
        if (settings?.assistantSwipes === false) return false;
    }

    return true;
}

/**
 * Update swipe UI for a message (counter, arrow states)
 * @param {number} messageId - The message ID to update
 * @param {number} [forceCurrentId] - Optional. Force a specific current swipe index for the counter (0-based)
 */
export function updateMessageSwipeUI(messageId, forceCurrentId) {
    const context = getContext();
    const chat = context.chat;
    const message = chat[messageId];

    if (!message) return;

    const messageElement = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (!messageElement) return;

    const swipeCount = message.swipes?.length || 0;
    const currentId = forceCurrentId !== undefined ? forceCurrentId : (message.swipe_id || 0);

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
        if (!leftArrow) return; // Safety check
        // Use 'deep-swipe-left' as the primary class, avoid 'swipe_left' to prevent native conflicts
        leftArrow.className = 'deep-swipe-left fa-solid fa-chevron-left';
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

            // Save scroll position to prevent jump, and button position for adjustment
            const scrollContainer = document.querySelector('#chat');
            const savedScrollTop = scrollContainer?.scrollTop || 0;
            const buttonRect = leftArrow.getBoundingClientRect();
            const viewportOffset = buttonRect.top;

            if (dswipeBackFn) {
                await dswipeBackFn({}, messageId);
            }

            // Immediately restore scroll position to counteract any jump from addOneMessage
            // Then fine-tune to keep button in same viewport position
            if (scrollContainer) {
                scrollContainer.scrollTop = savedScrollTop;
                requestAnimationFrame(() => {
                    const newButton = document.querySelector(`.mes[mesid="${messageId}"] .deep-swipe-left`);
                    if (newButton) {
                        const newRect = newButton.getBoundingClientRect();
                        const scrollDelta = newRect.top - viewportOffset;
                        scrollContainer.scrollTop += scrollDelta;
                    }
                });
            }
        });
    }

    // Right arrow (next/generate) - use native swipe_right class for consistent styling
    const rightArrow = document.createElement('div');
    if (!rightArrow) return; // Safety check
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

        // Save button position relative to viewport to keep it in same spot after swipe
        const buttonRect = rightArrow.getBoundingClientRect();
        const viewportOffset = buttonRect.top;

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
            // GENERATE NEW SWIPE: Check for Prompt Inspector first
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
            
            // Overlay creation moved to generateMessageSwipe in deep-swipe.js
            // This ensures overlay is created at the right time with proper throbber/stop button
            
            if (dswipeForwardFn) {
                await dswipeForwardFn({}, messageId);
            }
        } else {
            // CRITICAL FIX: Manually handle swipe navigation instead of relying on native swipe.right()
            // The native swipe.right() with forceSwipeId doesn't work reliably - it resets swipe_id to 0
            const targetSwipeId = currentId + 1;
            
            // Save scroll position BEFORE any operations to prevent jump
            const scrollContainer = document.querySelector('#chat');
            const savedScrollTop = scrollContainer?.scrollTop || 0;

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

                    // Sync reasoning data from swipe_info
                    syncReasoningFromSwipeInfo(updatedMsg, targetSwipeId);

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
                // Restore scroll position to counteract jump, then fine-tune
                if (scrollContainer) {
                    scrollContainer.scrollTop = savedScrollTop;
                    requestAnimationFrame(() => {
                        const newButton = document.querySelector(`.mes[mesid="${messageId}"] .deep-swipe-right`);
                        if (newButton) {
                            const newRect = newButton.getBoundingClientRect();
                            const scrollDelta = newRect.top - viewportOffset;
                            scrollContainer.scrollTop += scrollDelta;
                        }
                    });
                }
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
            // Note: addOneMessage already called updateReasoningUI, so we don't need to call it again
            // Calling it with reset:true would clear the reasoning we just synced!

            // Restore scroll position to counteract jump from addOneMessage, then fine-tune
            if (scrollContainer) {
                scrollContainer.scrollTop = savedScrollTop;
                requestAnimationFrame(() => {
                    const newButton = document.querySelector(`.mes[mesid="${messageId}"] .deep-swipe-right`);
                    if (newButton) {
                        const newRect = newButton.getBoundingClientRect();
                        const scrollDelta = newRect.top - viewportOffset;
                        scrollContainer.scrollTop += scrollDelta;
                    }
                });
            }
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
        // Insert left arrow OUTSIDE mes_block, positioned at bottom left near avatar
        if (leftArrow) {
            // Add class for positioning
            leftArrow.classList.add('deep-swipe-left-outer');
            // Insert left arrow before mes_block (as a sibling, not inside mes_block)
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
 * Create a swipe overlay for "read while generating" feature
 * This creates an overlay OUTSIDE the chat container that survives re-renders
 * @param {number} messageId - The message ID
 * @param {Object} message - The message object
 */
export function createSwipeOverlay(messageId, message, options = {}) {
    const { showThrobber = true, onComplete = null, onStop = null } = options;
    
    // Get message element
    const mesElement = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (!mesElement) return null;
    
    // Remove any existing overlay first
    removeSwipeOverlay(messageId);
    
    // CLONE the entire message element for perfect styling match
    const clone = mesElement.cloneNode(true);
    
    // Remove interactive elements from clone
    clone.querySelectorAll('.deep-swipe-left, .deep-swipe-right, .swipe_right, .swipe_left, .swipes-counter').forEach(el => el.remove());
    // Remove buttons but preserve reasoning-related buttons (mes_edit_add_reasoning)
    clone.querySelectorAll('button, [role="button"], a, input, textarea, select').forEach(el => {
        // Keep reasoning buttons to prevent reasoning.js errors
        if (el.classList.contains('mes_edit_add_reasoning') ||
            el.classList.contains('mes_reasoning_header') ||
            el.closest('.mes_reasoning')) {
            // For reasoning buttons, disable interaction but keep visible
            el.style.pointerEvents = 'none';
            return;
        }
        el.remove();
    });
    
    // Ensure clone and all its children don't capture clicks
    // The overlay has pointer-events: none, but we need to make sure children don't block either
    clone.style.pointerEvents = 'none';
    clone.querySelectorAll('*').forEach(el => {
        // Some elements like SVGs don't have a style property, skip them
        if (el.style) {
            el.style.pointerEvents = 'none';
        }
    });
    
    // Create wrapper for positioning
    const overlay = document.createElement('div');
    overlay.id = `deep-swipe-overlay-${messageId}`;
    overlay.className = 'deep-swipe-clone-overlay';
    
    // Add throbber/loading spinner if requested
    if (showThrobber) {
        const throbber = document.createElement('div');
        throbber.className = 'deep-swipe-throbber';
        throbber.id = `deep-swipe-throbber-${messageId}`;
        overlay.appendChild(throbber);
        
        // Add stop generation button next to throbber (bottom right)
        const stopButton = document.createElement('button');
        stopButton.className = 'deep-swipe-stop-button';
        stopButton.id = `deep-swipe-stop-${messageId}`;
        stopButton.innerHTML = '<i class="fa-solid fa-stop"></i> Stop';
        stopButton.title = 'Stop generation and revert';
        stopButton.addEventListener('click', (e) => {
            e.stopPropagation();
            e.preventDefault();
            if (onStop) {
                onStop();
            }
        });
        overlay.appendChild(stopButton);
    }
    
    // Add the cloned message
    overlay.appendChild(clone);
    
    // Use FIXED positioning relative to viewport initially
    // But update position on scroll to simulate scrolling with content
    const mesRect = mesElement.getBoundingClientRect();
    
    overlay.style.cssText = `
        position: fixed;
        left: ${mesRect.left}px;
        top: ${mesRect.top}px;
        width: ${mesRect.width}px;
        height: ${mesRect.height}px;
        z-index: 10000;
        pointer-events: none;
        overflow: hidden;
    `;
    
    // Append to body so it's not affected by DOM changes in chat
    document.body.appendChild(overlay);
    
    // Add scroll listener to update overlay position as chat scrolls
    const chatElement = document.getElementById('chat');
    const updateOverlayPosition = () => {
        const newMesRect = mesElement.getBoundingClientRect();
        overlay.style.left = `${newMesRect.left}px`;
        overlay.style.top = `${newMesRect.top}px`;
        overlay.style.width = `${newMesRect.width}px`;
        overlay.style.height = `${newMesRect.height}px`;
    };
    
    chatElement.addEventListener('scroll', updateOverlayPosition);
    
    // Store cleanup function for when overlay is removed
    overlay._cleanupScroll = () => {
        chatElement.removeEventListener('scroll', updateOverlayPosition);
    };
    
    // Store reference with options
    if (!window._deepSwipeOverlayPopups) {
        window._deepSwipeOverlayPopups = {};
    }
    
    window._deepSwipeOverlayPopups[messageId] = {
        element: overlay,
        onComplete: onComplete,
        isComplete: false
    };
    
    return overlay;
}

/**
 * Mark the swipe overlay as complete (generation finished)
 * Shows completion message and optionally fades out
 * @param {number} messageId - The message ID
 * @param {Object} options - Completion options
 * @param {boolean} options.autoFadeOut - Whether to auto-fade out after showing completion
 * @param {number} options.fadeDelay - Delay before fading out (ms)
 */
export function completeSwipeOverlay(messageId, options = {}) {
    const { autoFadeOut = false, fadeDelay = 1500 } = options;
    
    const overlayData = window._deepSwipeOverlayPopups?.[messageId];
    if (!overlayData || overlayData.isComplete) return;
    
    const overlay = overlayData.element;
    if (!overlay) return;
    
    overlayData.isComplete = true;
    overlay.classList.add('complete');
    
    // Remove throbber
    const throbber = overlay.querySelector(`#deep-swipe-throbber-${messageId}`);
    if (throbber) {
        throbber.remove();
    }
    
    // Add completion message
    const completionMsg = document.createElement('div');
    completionMsg.className = 'deep-swipe-completion-message';
    completionMsg.textContent = 'Next Swipe Generation Complete';
    overlay.appendChild(completionMsg);
    
    // Call onComplete callback if provided
    if (typeof overlayData.onComplete === 'function') {
        overlayData.onComplete();
    }
    
    // Auto fade out if requested
    if (autoFadeOut) {
        setTimeout(() => {
            fadeOutAndRemoveSwipeOverlay(messageId);
        }, fadeDelay);
    }
}

/**
 * Fade out and remove the swipe overlay
 * @param {number} messageId - The message ID
 * @param {number} fadeDuration - Duration of fade animation (ms)
 */
export function fadeOutAndRemoveSwipeOverlay(messageId, fadeDuration = 500) {
    const overlayData = window._deepSwipeOverlayPopups?.[messageId];
    if (!overlayData) return;
    
    const overlay = overlayData.element;
    if (!overlay) {
        delete window._deepSwipeOverlayPopups[messageId];
        return;
    }
    
    // Add fade-out class to trigger animation
    overlay.classList.add('fade-out');
    
    // Remove after animation completes
    setTimeout(() => {
        removeSwipeOverlay(messageId);
    }, fadeDuration);
}

/**
 * Remove swipe overlay popup
 * @param {number} messageId - The message ID
 */
export function removeSwipeOverlay(messageId) {
    const overlayData = window._deepSwipeOverlayPopups?.[messageId];
    if (overlayData) {
        const overlay = overlayData.element || overlayData;
        
        // Legacy cleanup for old overlays
        if (overlay._cleanupScroll) {
            overlay._cleanupScroll();
        }
        
        overlay.remove();
        delete window._deepSwipeOverlayPopups[messageId];
    }
    // Also try by ID
    const overlayById = document.getElementById(`deep-swipe-overlay-${messageId}`);
    if (overlayById) {
        if (overlayById._cleanupScroll) {
            overlayById._cleanupScroll();
        }
        overlayById.remove();
    }
}

/**
 * Remove the inline swipe overlay (the one inside the message for "read while generating")
 * @param {number} messageId - The message ID
 */
export function removeInlineSwipeOverlay(messageId) {
    const mesElement = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (mesElement) {
        const overlay = mesElement.querySelector('.deep-swipe-overlay');
        if (overlay) {
            overlay.remove();
        }
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
 * Add faint border highlight to message containing the latest swipe
 * This helps users locate the message after generation completes
 * Stays until user clicks, then fades out gracefully
 * @param {number} messageId - The message ID to highlight
 */
export function highlightLatestSwipeMessage(messageId) {
    // Remove any existing highlights first
    removeLatestSwipeHighlight();
    
    // Add highlight to the target message
    const mesElement = document.querySelector(`.mes[mesid="${messageId}"]`);
    if (!mesElement) return;
    
    mesElement.classList.add('deep-swipe-latest-swipe');
    
    // Auto-remove highlight after animation completes (10s)
    const autoRemoveTimeout = setTimeout(() => {
        mesElement.classList.remove('deep-swipe-latest-swipe', 'fading-out');
        if (mesElement._deepSwipeHighlightHandler) {
            mesElement.removeEventListener('click', mesElement._deepSwipeHighlightHandler);
            delete mesElement._deepSwipeHighlightHandler;
        }
    }, 10000);
    
    // Add click handler to fade out early (optional)
    const clickHandler = () => {
        clearTimeout(autoRemoveTimeout);
        // Add fading-out class to trigger CSS transition
        mesElement.classList.add('fading-out');
        
        // Remove classes after fade animation completes
        setTimeout(() => {
            mesElement.classList.remove('deep-swipe-latest-swipe', 'fading-out');
        }, 500);
        
        // Remove this event listener
        mesElement.removeEventListener('click', clickHandler);
    };
    
    // Store handler reference so we can clean it up if needed
    mesElement._deepSwipeHighlightHandler = clickHandler;
    mesElement.addEventListener('click', clickHandler);
}

/**
 * Remove the highlight from the latest swipe message
 */
export function removeLatestSwipeHighlight() {
    document.querySelectorAll('.deep-swipe-latest-swipe').forEach(el => {
        // Remove click handler if it exists
        if (el._deepSwipeHighlightHandler) {
            el.removeEventListener('click', el._deepSwipeHighlightHandler);
            delete el._deepSwipeHighlightHandler;
        }
        el.classList.remove('deep-swipe-latest-swipe', 'fading-out');
    });
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

    // NOTE: The swipe overlay for "read while generating" is handled by createSwipeOverlay()
    // which creates a fixed-position clone outside the chat. This survives DOM changes
    // and works for both user and assistant swipes. No additional overlay injection needed.
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
                            const messageId = parseInt(mesId, 10);
                            setTimeout(() => addSwipeNavigationToMessage(messageId), 100);
                            
                            // NOTE: Overlay injection is not needed here.
                            // createSwipeOverlay() creates a fixed-position clone that survives DOM changes.
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
