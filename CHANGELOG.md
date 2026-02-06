# Changelog

All notable changes to the Deep Swipe extension will be documented in this file.

## [1.5.0] - 2026-02-06

### Safety & Reliability

This release focuses on **graceful recovery from stop commands** and preventing data corruption when stopping generation mid-swipe.

#### Fixed
- **Critical Fix**: Resolved message corruption that occurred when stopping a swipe generation
  - Messages below the swipe target would occasionally become empty after stopping
  - This was caused by SillyTavern's save functions modifying the chat array during serialization
  
#### Safety Features
- **Defensive Copy-Pattern**: Implemented deep copy and restore pattern around all save operations
  - Creates deep copy of chat before each save operation
  - Detects if save corrupted the chat (empty message content)
  - Automatically restores from backup copy if corruption detected
  
- **Auto-save Race Condition Prevention**:
  - Cancels pending auto-save operations at cleanup start
  - Uses `chat.splice()` instead of `chat.length=0` for proper array reference preservation
  - Double-save strategy with corruption checks after each save
  
- **Module-level Backup Management**:
  - Clears backup after successful completion to prevent stale data
  - Timestamp tracking to detect concurrent generations

#### Technical Details
The corruption was caused by `saveChatConditional()` and `context.saveChat()` modifying the chat array in place during serialization. The fix implements a defensive pattern that:
1. Creates a deep copy: `JSON.parse(JSON.stringify(chat))`
2. Performs the save operation
3. Checks if messages were corrupted (became empty)
4. Restores from the copy if corruption is detected

This ensures that even if SillyTavern's save functions corrupt the chat during serialization, the correct data is immediately restored before the user continues.

## [1.4.0] - Previous Version

- Previous stable release with basic swipe functionality

---

**Note**: This extension is designed to gracefully handle interruptions. If you experience any issues after stopping a generation, simply refresh the chat - your data is now protected by multiple safety mechanisms.
