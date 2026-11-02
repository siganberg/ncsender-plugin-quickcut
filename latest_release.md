## What's Changed

### ✨ New Features
- Pointed Arch and Arc Slot have their own icons in the sidebar, so you can find them without digging through a menu
- The simplest shapes come first in the sidebar, with related shapes side by side

### 🔧 Improvements
- A field with a problem gets a red border and a red bubble that floats over it, so the layout no longer jumps; the message also shows beside Generate, and tapping it goes to the field
- The error bubble never moves the cursor while you type, and stays until the field is fixed

### 🐛 Bug Fixes
- Switching to Ellipse or Arch could take many seconds (close to a minute on a Raspberry Pi) with an Outer cut, depth passes and a pattern on; it now takes a moment, with the same results
