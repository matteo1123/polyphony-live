# Quick Start Guide - Polyphony.live

## 🎯 First 5 Minutes

### 1. Start the Stack
```bash
# Install dependencies
npm install

# Start Docker containers
docker-compose up
```

You should see:
- ✅ Redis Stack running on port 6379 (UI on 8001)
- ✅ Node.js server running on port 3000

### 2. Verify Health
```bash
curl http://localhost:3000/health
```

Expected response:
```json
{"status":"healthy","timestamp":"2025-01-23T10:00:00.000Z"}
```

### 3. Connect a Client
Open `examples/clientExample.js` in a new terminal and adapt for your use case, or use this minimal example:

```javascript
import io from 'socket.io-client';

const socket = io('http://localhost:3000');

socket.on('connect', () => {
  socket.emit('room:join', {
    roomId: 'test-room',
    userId: 'user-1',
    userMetadata: { name: 'Alice' }
  });
});

socket.on('room:joined', (data) => {
  console.log('Joined!', data);
  
  // Send a thought
  socket.emit('thought:stream', {
    content: 'Hello from the Hive Mind!',
    type: 'text'
  });
});

socket.on('synthesis:update', (data) => {
  console.log('Synthesis received:', data);
});
```

## 📁 Project Structure

```
polyphony-live/
├── docker-compose.yml        # Redis + Node.js services
├── Dockerfile               # Node.js container config
├── package.json             # Dependencies
├── env.example              # Environment template
├── README.md                # Full documentation
├── src/
│   ├── server.js            # Main Express/Socket.io server
│   ├── services/
│   │   ├── redisClient.js   # Redis operations
│   │   └── hiveAgent.js     # AI synthesis engine
│   └── handlers/
│       └── socketHandler.js # WebSocket event handlers
└── examples/
    └── clientExample.js     # Browser/Node.js client example
```

## 🔌 Core WebSocket API

### Join a Room
```javascript
socket.emit('room:join', {
  roomId: 'collaboration-session-1',
  userId: 'user-123',
  userMetadata: { name: 'Your Name' }
});
```

### Send a Thought
```javascript
socket.emit('thought:stream', {
  content: 'Your thought here...',
  type: 'text',  // or 'audio'
  metadata: { source: 'voice' }
});
```

### Listen for Synthesis Updates
```javascript
socket.on('synthesis:update', (data) => {
  // {
  //   timestamp: 1234567890,
  //   contributors: ['user-1', 'user-2'],
  //   summary: '...',
  //   conflicts: [],
  //   insights: []
  // }
});
```

### Listen for Room Closure
```javascript
socket.on('room:final_summary', (data) => {
  // Download markdown summary of collective memory
  console.log(data.markdown);
});
```

## 🛠️ Development Commands

```bash
# Development with hot reload
npm run dev

# View logs
npm run logs

# Stop all containers
npm run down

# Just Redis
npm run redis:start

# Production start
npm start
```

## 🔄 How It Works

1. **User Joins**: WebSocket connection → room:join event
2. **Stream Thoughts**: Rapid-fire text/audio snippets sent to server
3. **Redis Storage**: Thoughts stored with 1-hour TTL
4. **Synthesis Loop**: Every 3 seconds, Hive Agent processes thoughts
5. **Broadcast**: Insights/summaries pushed back to all clients
6. **Room Cleanup**: Last user disconnects → final summary generated → data wiped

## 📊 Redis Stack UI

Access the Redis Stack UI to inspect stored data:
```
http://localhost:8001
```

You'll see:
- Active rooms: `room-id:active_users`
- Thoughts: `room-id:thoughts` (sorted set)
- User sessions: `room-id:user:user-id`

## 🐛 Troubleshooting

### Docker containers won't start
```bash
# Check logs
docker-compose logs

# Rebuild images
docker-compose down
docker-compose up --build
```

### Can't connect to server
```bash
# Verify server is running
curl http://localhost:3000/health

# Check if port 3000 is in use
lsof -i :3000
```

### Redis connection issues
```bash
# Test Redis connection
redis-cli -h localhost -p 6379 ping
# Expected: PONG

# View Redis keys
redis-cli -h localhost -p 6379 KEYS '*'
```

## 📚 Next Steps

1. **Connect multiple clients** - Test real-time collaboration
2. **Add embeddings** - Integrate OpenAI/Cohere for semantic search
3. **Implement LangGraph** - Replace placeholder synthesis with AI orchestration
4. **Build React frontend** - Create UI for real-time collaboration
5. **Deploy to Hetzner** - Use provided docker-compose for production

## 🚀 Key Features to Implement

- [x] Docker + Redis Stack setup
- [x] Socket.io server with room management
- [x] Ephemeral thought storage with TTL
- [x] Active user tracking
- [x] Basic synthesis loop
- [x] Room cleanup on last disconnect
- [ ] Vector embeddings (OpenAI/Cohere)
- [ ] Advanced conflict detection
- [ ] LangGraph orchestration
- [ ] React frontend
- [ ] Audio/speech-to-text
- [ ] Markdown export

## 💡 Tips

- **Heartbeat**: Send heartbeat every 30s to keep connection alive
- **Room IDs**: Use unique identifiers (UUID recommended)
- **TTL**: Configure `THOUGHT_TTL_SECONDS` in .env
- **Synthesis Interval**: Adjust `SYNTHESIS_INTERVAL_MS` for real-time feel
- **Scaling**: Use Redis Cluster for multi-instance deployments

Happy collaborating! 🧠✨
