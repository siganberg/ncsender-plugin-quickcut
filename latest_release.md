## What's Changed

### ✨ New Features
- Pattern Angle: the Stock button offers the stock's Long side and Short side from Spoilboard Toolbox, with the side the pattern's longer way should follow listed first. Picking one fills Angle and turns Rotate shapes on. An older Spoilboard Toolbox still gets the single button

### 🐛 Bug Fixes
- Hops between cuts stay under Safe Z and the top of Z travel. With Z0 set close under them (stock near the top of Z), the 5 mm hop went past the soft limit and the machine stopped with ALARM:2. Hops are lowered only for the loaded tool, since another tool's length isn't known until it's loaded; the note beside Generate says when hops are lowered (mind clamps and screws), or when there's no room
- Programs are plain ASCII: header comments said 0° and Circle × 15, which some controllers and senders mishandle. They now say 0 deg and Circle x 15, and accented letters in a tool name lose their accents
