# EuroRails AI Architecture

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
   - `GameStateService`: Manages game state and communication with the server

### Server-Side Services

1. **Database Services**
   - `playerService`: Player CRUD operations
   - `trackService`: Track network storage and retrieval
   - `gameService`: Game state management

2. **Shared Services**
   - `TrackNetworkService`: Graph representation and pathfinding algorithms
   - `TrackBuildingService`: Track building validation and cost calculation
   - `IdService`: ID generation for game entities

## Data Flow

1. User interacts with the UI (managed by `UIManager`)
2. Events are routed to appropriate components:
   - Map interactions → `MapRenderer`
   - Track building → `TrackDrawingManager`
   - Camera control → `CameraController`
3. Game state changes are processed by `GameStateService`
4. State is persisted to the server via API calls
5. Updates are rendered by the respective components

## Design Decisions

- **Component Separation**: Each component has a specific responsibility
- **Stateful Services**: Services maintain their own state to reduce coupling
- **Event-Driven Communication**: Components communicate via callbacks and events
- **Client-Server Architecture**: Game state is validated both client-side and server-side
- **Type Safety**: Strong TypeScript typing throughout the codebase

## Future Improvements

- Further separation of UI into standalone scenes
- More comprehensive unit testing for client components
- Optimized rendering for large maps
- Enhanced network protocol for real-time multiplayer support