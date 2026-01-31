import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import { RedisClient } from './services/redisClient.js';
import { FileStorage } from './services/storage/fileStorage.js';
import { VectorDB } from './services/storage/vectorDB.js';
import { LangGraphAgent } from './services/agent/langGraphAgent.js';
import { SocketHandler } from './handlers/socketHandler.js';
import { ConvexService } from './services/convexClient.js';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CORS_ORIGIN || ['http://localhost:3001', 'http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true
  },
  maxHttpBufferSize: 100 * 1024 * 1024 // 100MB for file uploads
});

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));

// Health check endpoint - simple for demo
app.get('/health', async (req, res) => {
  try {
    const activeRooms = await redisClient.getActiveRoomCount();
    
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      activeMeetings: activeRooms
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      message: error.message 
    });
  }
});

// API: Create new space
app.post('/api/space/create', (req, res) => {
  const spaceId = uuidv4();
  console.log(`Space created: ${spaceId}`);
  res.json({ spaceId, created: new Date().toISOString() });
});

// Serve space page for any /space/:id route
app.get('/space/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/space.html'));
});

// Initialize services
const redisClient = new RedisClient(
  process.env.REDIS_HOST || 'localhost',
  parseInt(process.env.REDIS_PORT || '6379')
);

const fileStorage = new FileStorage();
const vectorDB = new VectorDB(redisClient);
const convexService = new ConvexService();

// Initialize LangGraph Agent
const agent = new LangGraphAgent(redisClient, fileStorage, vectorDB, io);

// Setup Socket.io handlers
const socketHandler = new SocketHandler(io, redisClient, agent, convexService);
socketHandler.setupHandlers();

const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
  try {
    await redisClient.connect();
    await fileStorage.init();
    console.log(`Polyphony.live server running on port ${PORT}`);
    console.log(`Redis connected to ${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`);
    console.log(`LangGraph Agent ready (hierarchical canvas mode)`);
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await redisClient.disconnect();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
