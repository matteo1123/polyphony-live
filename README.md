# Polyphony.live

> An ephemeral, multi-agent "Hive Mind" for real-time team collaboration where all participants can speak/input simultaneously, and a central AI agent synthesizes the "Collective Memory" in real-time.

## 🎯 Objective

Polyphony.live enables teams to collaborate in real-time with a shared AI consciousness. Every participant's thoughts are instantly captured, semantically analyzed, and synthesized into collective insights. When the session ends, the shared memory vanishes—leaving behind only a curated export.

## 🏗️ Architecture

### Core Stack
- **Infrastructure**: Docker + Hetzner
- **Backend**: Node.js 20+ with Express
- **Real-time**: Socket.io for bidirectional WebSocket communication
- **Memory/Brain**: Redis Stack (with vector search via RedisVL)
- **Orchestration**: LangGraph (for Hive Agent logic)
- **Frontend**: React (coming soon)

### Data Flow

```
User Input (React)
    ↓
Socket.io Listener (Node.js)
    ↓
Redis Vector Store + Embeddings
    ↓
Hive Agent Synthesis (LangGraph)
    ↓
Broadcast Insights via WebSocket
    ↓
Room Cleanup on Last User Exit
```

## 🚀 Quick Start

### Prerequisites
- Docker & Docker Compose
- Node.js 20+ (for local development)
- Git

### Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd polyphony-live
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment**
   ```bash
   cp env.example .env
   # Edit .env with your configuration
   ```

4. **Start the stack**
   ```bash
   docker-compose up
   ```

   This will start:
   - Redis Stack (port 6379, UI on 8001)
   - Node.js server (port 3000)

5. **Verify it's running**
   ```bash
   curl http://localhost:3000/health
   ```

### Development Mode

With hot-reload:
```bash
npm run dev
```

### Docker Commands

```bash
# Start services
docker-compose up

# Stop services
docker-compose down

# View logs
docker-compose logs -f

# Just start Redis
npm run redis:start

# Start only the server
npm start
```

## 📡 WebSocket Events

### Client → Server

#### `room:join`
Join a collaboration room.
```javascript
socket.emit('room:join', {
  roomId: 'room-123',
  userId: 'user-456',
  userMetadata: { name: 'Alice' }
});
```

#### `thought:stream`
Send a thought snippet (text or audio).
```javascript
socket.emit('thought:stream', {
  content: 'This is my thought...',
  type: 'text', // or 'audio'
  metadata: { source: 'voice' }
});
```

#### `heartbeat`
Keep your connection alive.
```javascript
socket.emit('heartbeat', {});
```

### Server → Client

#### `room:joined`
Confirmation that you've joined a room.
```javascript
{
  roomId,
  userId,
  timestamp,
  activeUserCount,
  message
}
```

#### `room:user_joined`
Another user joined the room.
```javascript
{
  userId,
  timestamp,
  activeUsers,
  activeUserCount
}
```

#### `thought:received`
A new thought was received.
```javascript
{
  thoughtId,
  userId,
  content,
  type,
  timestamp,
  metadata
}
```

#### `synthesis:update`
Hive Agent synthesized new insights.
```javascript
{
  timestamp,
  contributors,
  summary,
  conflicts,
  insights
}
```

#### `room:final_summary`
Room is closing, final summary available.
```javascript
{
  timestamp,
  markdown,
  message
}
```

## 🧠 Core Services

### RedisClient (`src/services/redisClient.js`)
Handles all Redis operations:
- Storing ephemeral thoughts with TTL
- Managing active users per room
- Room cleanup and persistence

### HiveAgent (`src/services/hiveAgent.js`)
The AI orchestrator:
- Runs synthesis loop every 3 seconds
- Detects semantic relationships between thoughts
- Generates insights and conflict detection
- Manages room lifecycle

### SocketHandler (`src/handlers/socketHandler.js`)
WebSocket event routing:
- Room join/leave
- Thought streaming
- Heartbeat management
- Disconnect cleanup

## 🔄 Ephemeral State Logic

### Room Lifecycle

1. **Creation**: Room created on first user join
2. **Active**: Room persists while `activeUsers > 0`
3. **Synthesis**: Every 3 seconds, Hive Agent processes thoughts
4. **Vanishing**: Last user disconnects → cleanup triggered
5. **Export**: Final markdown summary generated before data wipe

### Time-To-Live (TTL)

- **Thoughts**: 1 hour (configurable)
- **User Sessions**: 5 minutes (auto-refresh via heartbeat)
- **Room Data**: Deleted when last user leaves

## 📝 Environment Variables

```bash
# Server
PORT=3000
NODE_ENV=development

# Redis
REDIS_HOST=redis
REDIS_PORT=6379

# CORS
CORS_ORIGIN=http://localhost:3000,http://localhost:3001

# API Keys (for embeddings)
OPENAI_API_KEY=sk-...
COHERE_API_KEY=...

# Synthesis
SYNTHESIS_INTERVAL_MS=3000
THOUGHT_TTL_SECONDS=3600
```

## 🛣️ Roadmap

- [ ] Redis Vector Search integration with RedisVL
- [ ] LangGraph for Hive Agent orchestration
- [ ] OpenAI/Cohere embedding generation
- [ ] React frontend with real-time UI
- [ ] Audio/speech-to-text support
- [ ] Conflict detection & resolution
- [ ] Advanced insight generation
- [ ] Markdown export functionality
- [ ] Multi-room scaling
- [ ] Hetzner deployment configuration

## 🧪 Testing

```bash
# Run tests (coming soon)
npm test

# With coverage
npm run test:coverage
```

## 📚 API Documentation

Full API documentation available at `http://localhost:8001` (Redis Stack UI)

For Socket.io events, see [WebSocket Events](#-websocket-events) above.

## 🔐 Security

- CORS enabled (configurable)
- Socket.io authentication ready (to be implemented)
- Redis connection only from Docker network in production
- Graceful shutdown on SIGTERM

## 🤝 Contributing

Contributions welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Submit a pull request

## 📄 License

MIT