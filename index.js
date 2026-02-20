/**
 * Deep Swipe Extension
 *
 * Allows swiping (regenerating) any message in chat history, not just the last one.
 *
 * @author Rurijian
 * @version 1.5.5
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
    DEFAULT_ASSISTANT_PROMPT,
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
    generateMessageSwipe,
    handleUserSwipeBack,
    dswipeBack,
    dswipeForward
} from './deep-swipe.js';

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

    // Listen for reasoning deletion to sync to swipe_info
    // This prevents deleted reasoning from reappearing when swiping
    context.eventSource.on(context.eventTypes.MESSAGE_REASONING_DELETED, (messageId) => {
        const chat = context.chat;
        if (!isValidMessageId(messageId, chat)) return;

        const message = chat[messageId];
        const swipeId = message.swipe_id ?? 0;

        // Ensure swipe_info exists for this swipe
        if (!Array.isArray(message.swipe_info)) {
            message.swipe_info = message.swipes.map(() => ({
                send_date: message.send_date,
                extra: {},
            }));
        }

        // Sync the deletion to swipe_info
        if (message.swipe_info[swipeId]) {
            if (!message.swipe_info[swipeId].extra) {
                message.swipe_info[swipeId].extra = {};
            }
            // Mirror the deletion that reasoning.js performed on message.extra
            message.swipe_info[swipeId].extra.reasoning = '';
            delete message.swipe_info[swipeId].extra.reasoning_type;
            delete message.swipe_info[swipeId].extra.reasoning_duration;

        }
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
 * Handle assistant prompt change
 * @param {Event} event - The input event
 */
function onAssistantPromptChange(event) {
    const value = event.target.value;
    updateSetting('assistantPrompt', value);
}

/**
 * Handle assistant swipes toggle change
 * @param {Event} event - The change event
 */
function onAssistantSwipesChange(event) {
    const value = Boolean(event.target.checked);
    updateSetting('assistantSwipes', value);

    if (value) {
        toastr.success('Assistant message swipes enabled', 'Deep Swipe');
        // Refresh UI to show navigation on assistant messages
        const context = getContext();
        context.chat.forEach((_, index) => addSwipeNavigationToMessage(index));
    } else {
        toastr.info('Assistant message swipes disabled', 'Deep Swipe');
        // Remove navigation from assistant messages
        removeAllDeepSwipeUI();
        // Re-add to user messages only
        const context = getContext();
        const settings = getSettings();
        if (settings?.swipeNavigation && settings?.userSwipes) {
            context.chat.forEach((msg, index) => {
                if (msg.is_user) {
                    addSwipeNavigationToMessage(index);
                }
            });
        }
    }
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
 * Handle reset assistant prompt button click
 */
function onResetAssistantPromptClick() {
    const textarea = document.getElementById('deep_swipe_assistant_prompt');
    if (textarea) {
        textarea.value = DEFAULT_ASSISTANT_PROMPT;
        updateSetting('assistantPrompt', DEFAULT_ASSISTANT_PROMPT);
        toastr.info('Assistant prompt reset to default', 'Deep Swipe');
    }
}

/**
 * Handle auto-advance toggle change
 * @param {Event} event - The change event
 */
function onAutoAdvanceChange(event) {
    const value = Boolean(event.target.checked);
    updateSetting('autoAdvanceToLatest', value);

    if (value) {
        toastr.info('Auto-advance to latest swipe enabled', 'Deep Swipe');
    } else {
        toastr.info('Auto-advance to latest swipe disabled', 'Deep Swipe');
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
        document.getElementById('deep_swipe_assistant_swipes')?.addEventListener('change', onAssistantSwipesChange);
        document.getElementById('deep_swipe_auto_advance')?.addEventListener('change', onAutoAdvanceChange);
        document.getElementById('deep_swipe_impersonation_prompt')?.addEventListener('input', onImpersonationPromptChange);
        document.getElementById('deep_swipe_reset_prompt')?.addEventListener('click', onResetPromptClick);
        document.getElementById('deep_swipe_assistant_prompt')?.addEventListener('input', onAssistantPromptChange);
        document.getElementById('deep_swipe_reset_assistant_prompt')?.addEventListener('click', onResetAssistantPromptClick);

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
