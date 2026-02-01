# Deep Swipe

A SillyTavern extension that allows you to swipe (regenerate) any message in your chat history, not just the last one. Clone the native swipe experience for every message!

## Features

- **Deep Swipe for AI Messages**: Generate new responses for historical AI messages anywhere in your chat
- **Deep Impersonate for User Messages**: Generate alternative user messages using a customizable impersonation prompt
- **Navigation Arrows**: Browse through existing swipes with left/right arrows on each message
- **Swipe Counters**: See swipe count (e.g., "2/5") on each message
- **Non-destructive**: Uses a truncate-generate-restore pattern that preserves your chat history
- **Configurable Settings**: Multiple toggles to customize the extension behavior

## ⚠️ WARNING: Cache Hits

**Doing Deep Swipes high up in the context will break cache hits!**

When you perform a Deep Swipe on a message early in your chat history, the context changes. Any cached responses that were generated based on the previous context will be invalidated. This means:

- Subsequent message generations will not benefit from cache hits
- You may experience slower generation times until new cache entries are built
- The AI may generate different responses than it would have with the original context

**Recommendation**: Use Deep Swipes sparingly on messages near the beginning of long conversations, or be prepared for the performance impact.

## Installation

1. Copy the `deep-swipe` folder to `public/scripts/extensions/third-party/`
2. Restart SillyTavern or reload extensions
3. The extension will be available immediately

## Usage

### Finding Message IDs

Before using Deep Swipe, you need to know the message ID. Use the built-in `/messages` command:

```
/messages 0-10
```

This will show messages 0-10 with their IDs, content preview, and author.

### Slash Commands

#### `/dswipe back [id]` or `/ds back [id]`
Navigate to the previous swipe on a message.

```
/dswipe back 5
```

#### `/dswipe forward [id]` or `/ds forward [id]`
Generate a new swipe for a message.

```
/dswipe forward 5
```

### UI Controls

Deep Swipe provides navigation controls on each message:

#### Navigation Arrows
- **Left arrow** (←): Go to previous swipe
- **Right arrow** (→): Go to next swipe (or generate new if at last)

#### Swipe Counter
- Shows current swipe position (e.g., "2/5")
- Available on both AI and user messages

**Note:** Navigation controls are hidden on the last message (which has native swipe buttons) and on system messages.

### Examples

```
# Generate a new response for message #3
/dswipe forward 3

# Navigate to previous swipe on message #7
/dswipe back 7

# Using the short alias
/ds forward 10
```

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

## Visual Preview

```
[AI Message Text]

    [←]  [2/5]  [→]     ← Swipe Navigation

[Message Actions:  ↻  🗑️  ✏️  ...]  ← Generate Button (↻)
```

## How It Works

Deep Swipe uses a "truncate-generate-restore" pattern:

1. **Save**: Messages after the target are temporarily saved
2. **Truncate**: Chat is truncated to make the target message the last one
3. **Generate**: A new swipe is generated using SillyTavern's existing swipe infrastructure
4. **Restore**: The saved messages are appended back to the chat
5. **Refresh**: The UI is updated to show the new swipe

For user messages, the extension uses a guided impersonation approach with a customizable prompt to generate alternatives.

This approach leverages SillyTavern's proven swipe generation system while extending it to any message in history.

## Limitations

- **Context Window**: The generated response may differ from the original because the AI sees a different context (only messages up to the target)
- **System Messages**: Cannot swipe system messages or small system messages
- **Last Message**: Deep Swipe UI is hidden on the last message (native swipe buttons exist there)
- **Cache Hits**: Deep Swipes high in the context will invalidate cache hits (see WARNING above)

## Future Enhancements

- [ ] Keyboard shortcuts for quick navigation
- [ ] Visual swipe preview on hover
- [ ] Batch swipe operations
- [ ] Swipe comparison view

## Changelog

### v1.1.0
- Added swipe navigation (left/right arrows) to each message
- Added swipe counter display (e.g., "2/5") to each message
- Separate toggles for generate button vs navigation controls
- Improved CSS styling for navigation elements

### v1.0.0
- Initial release
- Slash commands for back/forward swiping
- Generate button on each message
- Settings UI with enable/disable toggle

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT License - feel free to use and modify as needed.

## Credits

Created by Rurijian for the SillyTavern community.
