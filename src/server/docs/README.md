# Lobby API Documentation

This directory contains comprehensive documentation for the Lobby API.

## Files

### 📖 [API_DOCUMENTATION.md](./API_DOCUMENTATION.md)
Complete API documentation with:
- Endpoint descriptions
- Request/response examples
- Error codes and handling
- Data models
- cURL examples
- Testing information

### 🔧 [openapi.yaml](./openapi.yaml)
OpenAPI 3.0 specification for:
- Interactive API documentation
- Code generation
- API testing tools
- Swagger UI integration

## Quick Start

### View Interactive Documentation
1. Copy the contents of `openapi.yaml`
2. Paste into [Swagger Editor](https://editor.swagger.io/)
3. Explore the interactive API documentation

### Test the API
```bash
# Health check
curl http://localhost:3000/api/lobby/health

# Create a game
curl -X POST http://localhost:3000/api/lobby/games \
  -H "Content-Type: application/json" \
  -H "x-user-id: 123e4567-e89b-12d3-a456-426614174000" \
  -d '{"isPublic": true, "maxPlayers": 4}'
```

## API Overview

The Lobby API provides 8 endpoints for game management:

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/games` | Create a new game |
| POST | `/games/join` | Join an existing game |
| GET | `/games/:id` | Get game information |
| GET | `/games/:id/players` | Get game players |
| POST | `/games/:id/start` | Start a game |
| POST | `/games/:id/leave` | Leave a game |
| POST | `/players/presence` | Update player presence |
| GET | `/health` | Health check |

## Authentication

Currently uses header-based user identification:
```bash
x-user-id: 123e4567-e89b-12d3-a456-426614174000
```

## Error Handling

All endpoints return consistent error responses:
```json
{
  "error": "ERROR_CODE",
  "message": "Human-readable message",
  "details": "Additional details"
}
```

## Testing

The API includes comprehensive test coverage:
- **219 total tests** across all components
- **Unit tests** for service layer
- **Integration tests** for API workflows
- **HTTP tests** for actual endpoints

Run tests:
```bash
npm test
```

## Development

### Adding New Endpoints
1. Add route to `src/server/routes/lobbyRoutes.ts`
2. Update OpenAPI specification
3. Add tests
4. Update documentation

### Error Codes
Add new error codes to:
- `src/server/services/lobbyService.ts` (error classes)
- `openapi.yaml` (error response schema)
- `API_DOCUMENTATION.md` (error codes section)

## Support

For questions or issues:
- Check the [API Documentation](./API_DOCUMENTATION.md)
- Review the [OpenAPI specification](./openapi.yaml)
- Run the test suite for examples
- Create an issue in the repository
