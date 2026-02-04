# Deep Swipe - Agent Notes

> This file is for AI agents working on the Deep Swipe extension. It documents the codebase structure, key concepts, and important implementation details.

## Overview

Deep Swipe is a SillyTavern extension that allows users to swipe (regenerate) any message in chat history, not just the last one. It supports both user messages (impersonation) and assistant messages (regeneration).

## File Structure

```
Deep-Swipe/
├── manifest.json          # Extension manifest (entry point)
├── index.js               # Main entry point, initializes extension
├── config.js              # Settings, constants, configuration
├── deep-swipe.js          # Core swipe generation logic
├── ui.js                  # UI components, overlays, DOM manipulation
├── utils.js               # Utility functions (validation, formatting)
├── commands.js            # Slash command definitions
├── style.css              # All styling
├── settings.html          # Settings panel HTML
├── README.md              # User documentation
└── Deep Swipe.png         # Screenshot for README
```

## Key Concepts

### 1. Message Swiping Flow

**User Swipes (Impersonation):**
1. Truncate chat to target message (keep target)
2. Add temp user message with impersonation prompt
3. Generate assistant response
4. Capture response as new user message swipe
5. Restore chat array

**Assistant Swipes (Regeneration):**
1. Truncate chat to BEFORE target message (remove target from context)
2. Generate new assistant response
3. Capture response as new swipe on original target
4. Restore chat array with re-inserted target

### 2. The "Stale Element" Pattern

To prevent SillyTavern's `Generate()` from finding and updating the wrong DOM elements, we mark elements as "stale" before generation:

```javascript
// Mark DOM elements as stale by prefixing mesid
el.setAttribute('mesid', `stale-${i}`);

// Later, restore them
el.setAttribute('mesid', `${i}`);
```

This is critical because `Generate()` looks for elements by `mesid` to update content during streaming.

### 3. Overlay System ("Read While Generating")

The overlay allows users to read the previous swipe while a new one generates:

- Created in `ui.js::createSwipeOverlay()`
- Uses `position: fixed` and appends to `document.body`
- This prevents the overlay from being lost when DOM elements are replaced
- Contains: cloned message content, throbber, stop button

### 4. Chat Array Manipulation

**Critical:** Always work with chat array references carefully:

```javascript
// For user swipes - target stays in array
chat.length = messageId + 1;

// For assistant swipes - target removed, later restored
chat.length = messageId;
// ... generate ...
chat.splice(messageId, 0, originalTargetMessage); // restore
```

### 5. Message State Preservation

Always capture original state BEFORE any modifications:

```javascript
const originalMessageState = {
    text: message.mes,
    swipeId: message.swipe_id,
    swipes: [...message.swipes],
    swipe_info: structuredClone(message.swipe_info),
    extra: structuredClone(message.extra),
};
```

## Important Code Sections

### Entry Point (`index.js`)

- `initializeExtension()` - Main initialization
- Event listener setup
- Settings migration

### Generation Logic (`deep-swipe.js`)

**Key function:** `generateMessageSwipe(message, messageId, context, isUserMessage)`

- Lines 67-800: Main generation function
- Lines 218-285: `performAbortCleanup()` - handles stop/cancel
- Lines 287-295: `abortHandler()` - GENERATION_STOPPED event handler
- Lines 312-338: Overlay creation (before truncation)

**Critical for assistant swipes:**
- Mark stale elements with `data-deep-swipe-target` attribute (line 392)
- This helps track the element even after mesid changes

### UI Components (`ui.js`)

**Key functions:**

- `createSwipeOverlay(messageId, message, options)` - Lines 473-568
  - Uses `position: fixed` for stability
  - Appends to `document.body`
  - Includes throbber and stop button

- `addSwipeNavigationToMessage(messageId)` - Lines 130-466
  - Adds left/right arrow buttons
  - Handles swipe navigation logic

- `highlightLatestSwipeMessage(messageId)` - Lines 711-751
  - Adds pulsing border highlight
  - Auto-fades after 10 seconds

### Utilities (`utils.js`)

- `isValidMessageId()` - Validate message IDs
- `isMessageSwipeable()` - Check if message can be swiped
- `syncReasoningFromSwipeInfo()` - Sync reasoning data between swipes
- `ensureSwipes()` - Initialize swipe arrays if missing

## Common Issues & Solutions

### 1. "Generate overwrites wrong message"

**Cause:** DOM elements not marked stale before generation.

**Fix:** Ensure `mesid` is changed to `stale-${i}` for all elements after the target.

### 2. "Overlay disappears during generation"

**Cause:** Overlay attached to message element that gets replaced.

**Fix:** Overlay uses `position: fixed` and appends to `document.body`.

### 3. "Assistant swipe shows empty content in overlay"

**Cause:** Overlay created after truncation, showing empty/new content.

**Fix:** Construct `overlayMessage` with original swipe content BEFORE truncation:

```javascript
const overlayMessage = {
    ...message,
    mes: originalMessageState.swipes[originalSwipeId],
    // ...
};
```

### 4. "Chat gets corrupted after abort"

**Cause:** Cleanup order wrong or DOM elements not properly restored.

**Fix:** `performAbortCleanup()` must:
1. Revert swipe data on message object
2. Restore chat array (truncate + rebuild)
3. Clean up DOM (remove stale elements)

## Extension Conflicts

**Prompt Inspector (PI):**
- Deep Swipe is INCOMPATIBLE with PI's "Inspect Prompts" feature
- PI modifies generation state in ways that conflict with DS's cleanup
- DS checks `localStorage.getItem('promptInspectorEnabled')` and refuses to generate if PI is active

## Settings

All settings stored in `extension_settings.deep_swipe`:

- `enabled` - Master toggle
- `showNavigation` - Show swipe arrows
- `enableUserSwipes` - Allow user message swipes
- `enableAssistantSwipes` - Allow assistant message swipes
- `impersonationPrompt` - Custom prompt for user swipes
- `autoAdvanceToLatest` - Auto-switch to new swipes

## Testing Checklist

When making changes, test:

1. **User swipe generation** - Does it generate and save correctly?
2. **Assistant swipe generation** - Does it regenerate and save correctly?
3. **Stop button** - Does it abort cleanly without corrupting chat?
4. **Overlay visibility** - Does it show previous content during generation?
5. **Swipe navigation** - Can you browse existing swipes?
6. **Reasoning sync** - Does reasoning data persist across swipes?
7. **Extension conflicts** - Does it detect and block when PI is enabled?

## Version History

- **1.4.0** - Read While Generating overlay, auto-fading highlights, PI blocking
- **1.3.x** - Assistant swipe fixes, stop button, abort handling
- **1.2.x** - Initial stable release

## Quick Reference

**Message structure:**
```javascript
message = {
    mes: "message text",
    swipes: ["text1", "text2"],
    swipe_id: 0,
    swipe_info: [{extra: {}, reasoning: "..."}],
    is_user: false,
    name: "Character"
}
```

**Context object:**
```javascript
context = {
    chat: [...],        // Array of messages
    name1: "User",      // User name
    name2: "Assistant", // Character name
    addOneMessage: fn,  // Render message
    swipe: {left, right} // Native swipe functions
}
```

## Questions?

If you're an AI agent and something isn't clear, check:
1. The inline code comments
2. The README.md for user-facing docs
3. GitHub issues: https://github.com/Rurijian/Deep-Swipe/issues
