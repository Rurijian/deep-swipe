/**
 * Deep Swipe Extension - Configuration Module
 *
 * Contains constants, default settings, and settings management.
 *
 * @author Rurijian
 * @version 1.2.0
 * @license MIT
 */

import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

/**
 * Extension name identifier
 * @constant {string}
 */
export const EXTENSION_NAME = 'deep-swipe';

/**
 * Path to the extension folder
 * @constant {string}
 */
export const extensionFolderPath = `scripts/extensions/third-party/${EXTENSION_NAME}`;

/**
 * Default impersonation prompt for user message swipes
 * @constant {string}
 */
export const DEFAULT_IMPERSONATION_PROMPT = "NEW DIRECTION: Impersonate your next reply as if you were {{user}}, in {{user}}'s voice, using the subsequent text as a guide of what to then embellish: {{input}}";

/**
 * Default settings for the extension
 * @constant {Object}
 */
export const defaultSettings = {
    enabled: true,
    swipeNavigation: true,
    userSwipes: true,
    impersonationPrompt: DEFAULT_IMPERSONATION_PROMPT,
};

/**
 * Track if buttons have been initialized
 * @type {boolean}
 */
export let buttonsInitialized = false;

/**
 * Mark buttons as initialized
 */
export function setButtonsInitialized() {
    buttonsInitialized = true;
}

/**
 * Load extension settings from storage and update UI elements
 */
export function loadSettings() {
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
 * Get current extension settings
 * @returns {Object} The current extension settings
 */
export function getSettings() {
    return extension_settings[EXTENSION_NAME] || { ...defaultSettings };
}

/**
 * Update a specific setting value
 * @param {string} key - The setting key to update
 * @param {*} value - The new value
 */
export function updateSetting(key, value) {
    if (!extension_settings[EXTENSION_NAME]) {
        extension_settings[EXTENSION_NAME] = { ...defaultSettings };
    }
    extension_settings[EXTENSION_NAME][key] = value;
    saveSettingsDebounced();
}
