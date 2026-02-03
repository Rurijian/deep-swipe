/**
 * Deep Swipe Extension
 *
 * Allows swiping (regenerating) any message in chat history, not just the last one.
 *
 * @author Rurijian
 * @version 1.2.0
 * @license MIT
 */

import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, deleteMessage, deleteSwipe } from '../../../../script.js';
import { updateReasoningUI } from '../../../../scripts/reasoning.js';

// Import modules
import {
    EXTENSION_NAME,
    extensionFolderPath,
    DEFAULT_IMPERSONATION_PROMPT,
    defaultSettings,
    loadSettings,
    setButtonsInitialized,
    getSettings,
    updateSetting
} from './config.js';

import {
    isValidMessageId,
    isMessageSwipeable,
    formatSwipeCounter,
    syncReasoningFromSwipeInfo,
    canDeleteSwipe,
    trackEditMessage,
    clearEditMessage,
    isAnyMessageBeingEdited,
    getSwipeIndexForDelete,
    getCurrentEditMessageId,
    ensureSwipes,
    log,
    error
} from './utils.js';

import {
    setSwipeFunctions,
    shouldAddUiComponents,
    addSwipeNavigationToMessage,
    updateMessageSwipeUI,
    removeAllDeepSwipeUI,
    addUiToAllMessages,
    onMessageRendered,
    onMessageUpdated,
    setupMutationObservers
} from './ui.js';

import {
    dswipeBack,
    dswipeForward
} from './swipe-assistant.js';

import {
    generateUserMessageSwipe,
    handleUserSwipeBack
} from './swipe-user.js';

import {
    registerSlashCommands,
    handleDeleteClick
} from './commands.js';

// Re-export for external use
export { getSwipeIndexForDelete as getDeleteSwipeIndex };
export { getCurrentEditMessageId };

/**
 * Initialize UI components
 */
function initializeUi() {
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

    // Set up MutationObservers for dynamic message handling
    setupMutationObservers(context, handleDeleteClick);

    setButtonsInitialized();
}

/**
 * Handle enable/disable toggle
 * @param {Event} event - The change event
 */
function onEnabledChange(event) {
    const value = Boolean(event.target.checked);
    updateSetting('enabled', value);

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
 * @param {Event} event - The change event
 */
function onSwipeNavigationChange(event) {
    const value = Boolean(event.target.checked);
    updateSetting('swipeNavigation', value);

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
 * @param {Event} event - The change event
 */
function onUserSwipesChange(event) {
    const value = Boolean(event.target.checked);
    updateSetting('userSwipes', value);

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
        const settings = getSettings();
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
 * @param {Event} event - The input event
 */
function onImpersonationPromptChange(event) {
    const value = event.target.value;
    updateSetting('impersonationPrompt', value);
}

/**
 * Handle reset prompt button click
 */
function onResetPromptClick() {
    const textarea = document.getElementById('deep_swipe_impersonation_prompt');
    if (textarea) {
        textarea.value = DEFAULT_IMPERSONATION_PROMPT;
        updateSetting('impersonationPrompt', DEFAULT_IMPERSONATION_PROMPT);
        toastr.info('Impersonation prompt reset to default', 'Deep Swipe');
    }
}

/**
 * Initialize the extension
 */
jQuery(async () => {
    try {
        // Set up swipe functions for UI module
        setSwipeFunctions(dswipeBack, dswipeForward);

        const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
        $('#extensions_settings').append(settingsHtml);

        document.getElementById('deep_swipe_enabled')?.addEventListener('change', onEnabledChange);
        document.getElementById('deep_swipe_swipe_navigation')?.addEventListener('change', onSwipeNavigationChange);
        document.getElementById('deep_swipe_user_swipes')?.addEventListener('change', onUserSwipesChange);
        document.getElementById('deep_swipe_impersonation_prompt')?.addEventListener('input', onImpersonationPromptChange);
        document.getElementById('deep_swipe_reset_prompt')?.addEventListener('click', onResetPromptClick);

        loadSettings();
        await registerSlashCommands(dswipeBack, dswipeForward);

        // Try multiple times to add UI as messages may render at different times
        setTimeout(() => {
            initializeUi();
            addUiToAllMessages();
        }, 1000);

        // Additional attempts to catch late-rendered messages
        setTimeout(() => addUiToAllMessages(), 2000);
        setTimeout(() => addUiToAllMessages(), 3500);

        log('Extension initialized successfully');
    } catch (err) {
        error('Failed to initialize:', err);
    }
});
