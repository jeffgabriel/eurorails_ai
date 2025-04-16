#Intro
This is a test project for building with AI tools. Pretty much everything in this repo was coded by prompting the AI tools, including the rest of this readme. The current result is functional (but very much incomplete) and with little to no attempt to refactor other than what I've asked the AI tools to do.

# Eurorails Digital

A digital implementation of the Eurorails board game using modern web technologies.

## Tech Stack

- **Frontend:**
  - TypeScript
  - Phaser.js
  - HTML5 Canvas
  - Webpack

- **Backend:**
  - Node.js
  - Fastify
  - Socket.IO
  - PostgreSQL

## Prerequisites

- Node.js (v14 or higher)
- PostgreSQL (v12 or higher)
- npm (v6 or higher)

## Setup

1. Clone the repository:
```bash
git clone <repository-url>
cd eurorails_ai
```

2. Install dependencies:
```bash
npm install
```

3. Create a PostgreSQL database:
```bash
createdb eurorails
```

4. Configure environment variables:
- Copy `.env.example` to `.env`
- Update the values according to your environment

## Development

Run the development server:
```bash
npm run dev
```

This will start:
- Frontend development server at http://localhost:3000
- Backend server at http://localhost:8080

## Building for Production

Build the application:
```bash
npm run build
```

Start the production server:
```bash
npm start
```

## Project Structure

```
src/
├── client/          # Frontend code
│   ├── components/  # Game components
│   ├── scenes/      # Phaser scenes
│   └── assets/      # Game assets
├── server/          # Backend code
│   ├── routes/      # API routes
│   ├── services/    # Business logic
│   └── db/          # Database operations
└── shared/          # Shared code
    ├── types/       # TypeScript types
    └── utils/       # Utility functions
```

## License

ISC 
