/**
 * Deep Swipe Extension - Commands Module
 *
 * Slash command definitions for the extension.
 *
 * @author Rurijian
 * @version 1.2.0
 * @license MIT
 */

import { getContext } from '../../../extensions.js';
import { deleteSwipe, deleteMessage } from '../../../../script.js';
import { getSettings, EXTENSION_NAME } from './config.js';
import { isValidMessageId, canDeleteSwipe, clearEditMessage } from './utils.js';

/**
 * Register slash commands for Deep Swipe
 * @param {Function} dswipeBack - The dswipeBack function
 * @param {Function} dswipeForward - The dswipeForward function
 */
export async function registerSlashCommands(dswipeBack, dswipeForward) {
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
                const settings = getSettings();
                if (!settings?.enabled) {
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
                const settings = getSettings();
                if (!settings?.enabled) {
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
 * Handle delete button click events to enable swipe deletion
 * Intercepts delete button clicks for messages with multiple swipes
 *
 * @param {Event} e - The click event
 */
export async function handleDeleteClick(e) {
    // Check if the clicked element is the delete button
    const deleteButton = e.target.closest('.mes_edit_delete');
    if (!deleteButton) return;

    // Check if deep swipe is enabled
    const settings = getSettings();
    if (!settings?.enabled) return;

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
        if (!settings?.userSwipes) return;
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
}
