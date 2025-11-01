# EuroRails AI Architecture

## Overview

EuroRails AI is a multi-player railroad building game built with Phaser.js and Node.js. The architecture emphasizes clear separation between shared game state and per-player operations to support turn-based multiplayer gameplay.

**Related Documentation**:
- [TURN_MANAGEMENT_PLAN.md](./TURN_MANAGEMENT_PLAN.md) - Multi-player turn management implementation plan
- [TURN_MANAGEMENT_ARCHITECTURE_REVIEW.md](./TURN_MANAGEMENT_ARCHITECTURE_REVIEW.md) - Detailed architecture review
- [PLAYER_STATE_IMPLEMENTATION_SUMMARY.md](./PLAYER_STATE_IMPLEMENTATION_SUMMARY.md) - Implementation summary

## Component Architecture

The EuroRails AI game follows a component-based architecture to manage complexity and separate concerns. The main components are:

### Client-Side Components

1. **Scenes**
   - `GameScene`: Main game scene, orchestrates all other components
   - `SetupScene`: Handles game creation and player setup
   - `SettingsScene`: Manages game settings and player editing

2. **Components**
   - `MapRenderer`: Manages the game grid, terrain rendering, and point calculations
   - `TrackDrawingManager`: Handles track building, validation, and visualization
   - `UIManager`: Manages UI elements such as player info and controls
   - `CameraController`: Handles camera movement, zooming, and state persistence

3. **Services**
   - `GameStateService`: Manages **shared game state** (turn management, game status, read-only access)
   - `PlayerStateService`: Manages **local player operations** (money, position, loads, demand cards)
   - `LoadService`: Manages load availability and distribution
   - `TrackService`: Manages track network storage and retrieval

### Server-Side Services

1. **Database Services**
   - `playerService`: Player CRUD operations and authentication
   - `trackService`: Track network storage and retrieval
   - `gameService`: Game state management and camera state
   - `demandDeckService`: Demand card deck management

2. **Shared Services**
   - `TrackNetworkService`: Graph representation and pathfinding algorithms
   - `TrackBuildingService`: Track building validation and cost calculation
   - `IdService`: ID generation for game entities

## Multi-Player Architecture

### State Separation

The architecture separates **shared game state** from **per-player state**:

**Shared State** (GameStateService):
- Turn management (`currentPlayerIndex`)
- Game status (setup, active, completed)
- Read-only player list access
- Global game settings

**Per-Player State** (PlayerStateService):
- Local player identification via `userId`
- Money, position, loads management
- Demand card operations
- Player-specific updates

**Visual State** (All players see):
- Track networks (via TrackService)
- Player positions on map
- Train sprites
- Load availability in cities

**Private State** (Local player only):
- Demand cards in hand
- Camera view state (per-player in Phase 2)
- Local game view preferences

### Local Player Identification

Each client identifies its local player through:
1. **Primary**: Match `userId` from localStorage auth against players
2. **Fallback**: Single-player games use first player as local player
3. **Security**: All state updates validate local player identity

## Data Flow

1. User interacts with the UI (managed by `UIManager`)
2. Events are routed to appropriate components:
   - Map interactions → `MapRenderer`
   - Track building → `TrackDrawingManager`
   - Camera control → `CameraController`
3. State changes are processed by appropriate service:
   - **Shared state** (turns, status) → `GameStateService`
   - **Local player actions** → `PlayerStateService`
   - **Track operations** → `TrackService`
4. State is persisted to the server via API calls
5. Updates are rendered by the respective components
6. **Multi-player sync**: Shared state changes propagate to all clients

## Design Decisions

- **Component Separation**: Each component has a specific responsibility
- **Stateful Services**: Services maintain their own state to reduce coupling
- **Event-Driven Communication**: Components communicate via callbacks and events
- **Client-Server Architecture**: Game state is validated both client-side and server-side
- **Type Safety**: Strong TypeScript typing throughout the codebase
- **Multi-Player State Separation**: Clear boundaries between shared and per-player state
- **Security by Design**: Local player validation ensures only authenticated player can modify their state
- **Backward Compatibility**: Fallback mechanisms support legacy games without userId

## Future Improvements

- **Per-Player Camera State**: Each player maintains independent view settings
- **Turn-Based Interaction Controls**: UI elements enable/disable based on active player
- **Real-Time Multi-Player Sync**: Socket.IO integration for live updates
- **Spectator Mode**: Allow viewing games without being a player
- **Load Balancing**: Optimize for games with 6+ simultaneous players
- **Performance**: Optimized rendering for large maps with many players
- **Testing**: Comprehensive unit and integration tests for multiplayer scenarios