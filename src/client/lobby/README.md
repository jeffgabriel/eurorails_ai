# EuroRails Multiplayer Frontend

A complete multiplayer frontend for the EuroRails railway strategy game, built with React, TypeScript, and Phaser 3.

## 🎮 Features

- **Authentication**: Login and registration with JWT handling
- **Lobby System**: Create and join games with unique join codes
- **Real-time Multiplayer**: Socket.IO integration for live gameplay
- **Interactive Game Board**: Phaser 3-powered canvas for railway visualization
- **Player Management**: Real-time player presence and turn management
- **Responsive Design**: Works on desktop and mobile devices

## 🛠 Tech Stack

- **Frontend**: React 18 + TypeScript
- **Build Tool**: Vite
- **Styling**: Tailwind CSS + shadcn/ui components
- **State Management**: Zustand
- **Real-time**: Socket.IO client
- **Game Engine**: Phaser 3
- **Form Handling**: React Hook Form + Zod validation
- **Routing**: React Router v6

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn
- EuroRails backend server running

### Installation

1. Clone the repository:
```bash
git clone <repository-url>
cd eurorails-frontend
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
```

Edit `.env` with your backend URLs:
```
VITE_API_BASE_URL=http://localhost:3000
VITE_SOCKET_URL=http://localhost:3000
```

4. Start the development server:
```bash
npm run dev
```

5. Open your browser to `http://localhost:3001`

## 📁 Project Structure

```
/src
  /app
    App.tsx                 # Main app component with routing
    Router.tsx              # Route definitions and guards
  /shared
    types.ts                # TypeScript type definitions
    api.ts                  # REST API client wrapper
    socket.ts               # Socket.IO service
  /store
    auth.store.ts           # Authentication state management
    lobby.store.ts          # Lobby state management  
    game.store.ts           # Game state management
  /features
    /auth                   # Login and registration components
    /lobby                  # Game lobby components
    /game                   # Game board and UI components
  /phaser
    scene.ts                # Phaser game scene
    adapters.ts             # Socket event adapters
  /components/ui            # shadcn/ui components
```

## 🎯 Game Flow

1. **Authentication**: Users register or login to access the game
2. **Lobby**: Players can create new games or join existing ones with codes
3. **Waiting Room**: Players wait for others to join before starting
4. **Game**: Real-time multiplayer gameplay with turn-based mechanics
5. **Reconnection**: Automatic reconnection handling for network issues

## 🔗 API Integration

The frontend expects the following backend endpoints:

### Authentication
- `POST /auth/register` - User registration
- `POST /auth/login` - User login
- `GET /me` - Get current user

### Games
- `POST /games` - Create new game
- `POST /games/join` - Join game by code
- `GET /games/:id` - Get game details
- `GET /games/:id/players` - Get game players
- `POST /games/:id/start` - Start game

### Socket Events
- `join` - Join game room
- `state:init` - Initial game state
- `state:patch` - Game state updates
- `presence:update` - Player online/offline
- `turn:change` - Turn changes

## 🧪 Testing

Run unit tests:
```bash
npm run test
```

Run e2e tests:
```bash
npm run e2e
```

## 🏗 Building

Build for production:
```bash
npm run build
```

Preview production build:
```bash
npm run preview
```

## 🔧 Development

### Code Style
- ESLint + Prettier for code formatting
- TypeScript strict mode enabled
- Conventional commits recommended

### State Management
- Zustand stores for reactive state
- Server as source of truth
- Optimistic updates where appropriate

### Performance
- Bundle splitting for vendor libraries
- Tree-shaking for unused code
- Phaser assets loaded on-demand

## 📝 Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `VITE_API_BASE_URL` | Backend API URL | `http://localhost:3000` |
| `VITE_SOCKET_URL` | Socket.IO server URL | `http://localhost:3000` |

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🆘 Support

For issues and questions:
1. Check existing GitHub issues
2. Create a new issue with detailed description
3. Include browser console logs if reporting bugs

---

Built with ❤️ for railway strategy enthusiasts!