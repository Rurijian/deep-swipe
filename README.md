# DEEP SWIPE              

A SillyTavern extension that allows you to swipe (regenerate) any message in your chat history, not just the last one. Clone the native swipe experience for every message!

![Alt text](Deep%20Swipe.png "Deep Swiping!")

## Features

- **Deep Swipe**: Generate new swipes anywhere in the context! User or Assistant! It doesn't matter! Swipe everything!!
- **Deep Impersonate for User Messages**: Generate alternative user messages using a customizable impersonation prompt. Swipe old log with new based chinese models! Change the past, but lazily! *DIRECTORMAXXING*
- **Deep Regenerate for Assistant Messages**: Regenerate any AI response, not just the last one! Fix that one awkward reply from 20 messages ago!
- **Navigation Chevrons**: Browse through existing swipes with left/right arrows on each message, just like native, but more!
- **Swipe Counters**: See swipe count (e.g., "2/5") on each message, just like native, but more!
- **Beautiful Polish**: Fade-in/fade-out overlays, spinning throbbers, completion messages, and pulsing border highlights! It's fancy!
- **Non-destructive**: Uses a truncate-generate-restore pattern that preserves your chat history
- **Smart DOM Handling**: Prevents message hijacking with clever mesid invalidation tricks! Tech wizardry!


**⚠️WARNING⚠️ Deep Swipes high up in the context will break cache hits!**

**⚠️EXTENSION CONFLICTS⚠️**
Deep Swipe is **INCOMPATIBLE** with Prompt Inspector. Due to the way both extensions interact with the generation process:
- **Deep Swipe will REFUSE to generate** while Prompt Inspector's "Inspect Prompts" feature is enabled
- You must disable Prompt Inspector (click "Stop Inspecting" in the wand menu) before using Deep Swipe generation
- Navigating between existing swipes still works while PI is enabled

This is a hard compatibility limit - the extensions fundamentally conflict in how they handle generation state.

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
- **Enable Deep Swipes on assistant messages**: Allow regenerating any AI response
- **Impersonation Prompt**: Customizable prompt for generating user message swipes
  - Use `{{user}}` for the user name
  - Use `{{input}}` for the original message content
  - Default: `NEW DIRECTION: Could you re-write/improve my last reply as if you were me? Just post the reply.`
- **Assistant Impersonation Prompt**: Optional custom prompt for assistant swipes
- **Auto-advance to latest swipe**: Automatically switch to newly generated swipes

### Deep Impersonate (User Message Swipes)

When enabled, user messages can be swiped to generate alternative versions. The extension uses a guided impersonation approach:

1. The current user message is used as input
2. The impersonation prompt guides the AI to rewrite/improve as the user
3. The AI generates an alternative response following the prompt's guidance
4. The new response is saved as a swipe

This is useful for:
- Exploring different ways to express the same idea
- Adjusting tone or style of user messages
- Creating variations for branching storylines
- Fixing that one reply you wish you worded better

### Deep Regenerate (Assistant Message Swipes)

When enabled, any assistant message can be regenerated, not just the last one:

1. The target message is preserved with a beautiful overlay showing current content
2. A temp message triggers generation at the bottom of context
3. The AI generates a fresh response
4. The new response is captured and saved as a new swipe
5. Fancy animations show completion!

This is useful for:
- Fixing awkward responses buried in the chat history
- Exploring different AI personalities mid-conversation
- Creating alternative story branches


## How It Works

Deep Swipe uses a sophisticated "truncate-generate-restore" pattern:

1. **Save**: Messages after the target are temporarily saved
2. **Overlay**: An overlay shows the current content during generation
3. **Truncate**: Chat is truncated to isolate the target context
4. **Generate**: A new swipe is generated at the bottom of context (like user swipes!)
5. **Capture**: The generated response is captured as a new swipe
6. **Restore**: The saved messages are re-inserted into the chat
7. **Polish**: Fancy animations and border highlights guide your eyes!!!
8. **Refresh**: The UI is updated to show the new swipe

For user messages, the extension uses guided impersonation with a customizable prompt.
For assistant messages, the overlay lets you "read while generating" - based


MIT License 

## Credits

Created by Rurijian for SillyTavern
Version 1.3.0 - Now with extra polish!
