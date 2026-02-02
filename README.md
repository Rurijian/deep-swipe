# DEEP SWIPE              

A SillyTavern extension that allows you to swipe (regenerate) any message in your chat history, not just the last one. Clone the native swipe experience for every message!

![Alt text](Deep%20Swipe.png "Deep Swiping!")

## Features

- **Deep Swipe**: Generate new swipes anywhere in the context! User or Assistant! It doesn't matter! Swipe everything!!
- **Deep Impersonate for User Messages**: Generate alternative user messages using a customizable impersonation prompt. Swipe old log with new based chinese models! Change the past, but lazily! *DIRECTORMAXXING*
- **Navigation Chevrons**: Browse through existing swipes with left/right arrows on each message, just like native, but more!
- **Swipe Counters**: See swipe count (e.g., "2/5") on each message, just like native, but more!
- **Non-destructive**: Uses a truncate-generate-restore pattern that preserves your chat history


**⚠️WARNING⚠️ Deep Swipes high up in the context will break cache hits!**

## But who cares, Based Swipe-Fiend!

## Installation

1. Copy https://github.com/Rurijian/Deep-Swipe into extensions/install extensions (top-right button) as all-users
2. Refresh Sillytavern maybe? It's probably fine though
3. The extension will be available immediately

## Usage

### Finding Message IDs

If you want to use the slash commands, I recommend you turn on message IDs so you can see which number you want to Deep Swipe. But, you probably already know this, if you're using slash commands.  Use the built-in `/messages` command.

## But you're not using any of this! Just hit the little chevron arrows!

### Examples

Deep Swipe provides navigation controls on each message:

#### Navigation Arrows
- **Left arrow** (←): Go to previous swipe
- **Right arrow** (→): Go to next swipe (or generate new if at last)

```
Slash Commands
/dswipe back [id] or /ds back [id]
Function: Navigate to the previous swipe on a message

# Generate a new response for message #3
/dswipe forward 3

# Navigate to previous swipe on message #7
/dswipe back 7

# Using the short alias
/ds forward 10

```
#### Swipe Counter
- Shows current swipe position (e.g., "2/5")
- Available on both AI and user messages

**Note:** Navigation controls are hidden on the last message (which has native swipe buttons) and on system messages.


### Settings

Access the settings in **Extensions > Deep Swipe**:

- **Enable Deep Swipe**: Master toggle for the extension
- **Show Deep Swipe navigation**: Display navigation arrows and counters on messages
- **Enable Deep Swipes on user messages**: Allow swiping user messages (Deep Impersonate)
- **Impersonation Prompt**: Customizable prompt for generating user message swipes
  - Use `{{user}}` for the user name
  - Use `{{input}}` for the original message content
  - Default: `Write a reply as {{user}}, using these themes as a guide: {{input}}`

### Deep Impersonate (User Message Swipes)

When enabled, user messages can be swiped to generate alternative versions. The extension uses a guided impersonation approach:

1. The current user message is used as input
2. The impersonation prompt is processed with `{{user}}` and `{{input}}` placeholders
3. The AI generates an alternative response following the prompt's guidance
4. The new response is saved as a swipe

This is useful for:
- Exploring different ways to express the same idea
- Adjusting tone or style of user messages
- Creating variations for branching storylines


## How It Works

Deep Swipe uses a "truncate-generate-restore" pattern:

1. **Save**: Messages after the target are temporarily saved
2. **Truncate**: Chat is truncated to make the target message the last one
3. **Generate**: A new swipe is generated using SillyTavern's existing swipe infrastructure
4. **Restore**: The saved messages are appended back to the chat
5. **Refresh**: The UI is updated to show the new swipe

For user messages, the extension uses a guided impersonation approach with a customizable prompt to generate alternatives.


MIT License 

## Credits

Created by Rurijian for SillyTavern
