🔧 Phase Goals
Show train cards with load chip visuals.

Allow picking up and dropping off loads graphically.

Reflect game logic changes in the UI.

🖼️ UI Tasks
1. Train Card Component
 Render a train card based on the player's current train type (Freight, Fast Freight, etc.).

 Display train stats: type, speed, capacity.

 Allocate visual slots (holders) for load chips based on capacity.

2. Load Chip Component
 Create reusable UI component for load chips (visual holder + icon overlay).

 Load chip component should support:

Type icon (e.g., cheese, oil).

Status indicator (e.g., carried, available).

Drag or click interaction (if needed).

3. Player Train Display
 Render the current player's train card with attached load chips.

 Optionally, allow toggling between players’ trains for visibility/debug.

🔁 Interaction Tasks
4. Load Pickup
 Show which loads are available at the current city.

 Allow the player to pick up a load by clicking or dragging onto their train card.

 Prevent exceeding load capacity.

5. Load Dropoff
 Allow dropping a load at the current city.

 Visually remove the chip from the train card and either:

Show it at the city (if not returned to tray).

Return it to the load tray.

6. Load Sync with Game State
 Sync visual load chips with the backend logic/state.

 Ensure the load chip display updates after pickups/dropoffs/deliveries.

🔁 Animation & Feedback (Optional Polish)
 Add subtle animation when a load is picked up or dropped.

 Use glow, pulse, or movement to highlight capacity/full or deliverable load status.

🧪 Testing Tasks
 Unit test: train card renders correct number of load holders.

 Integration test: picking up a load updates state and UI.

 Regression test: game logic remains accurate post-UI changes.