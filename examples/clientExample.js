// Example Client Usage for Polyphony.live
// This demonstrates how to connect and interact with the Polyphony server

import io from 'socket.io-client';

const SOCKET_SERVER = 'http://localhost:3000';

// Initialize socket connection
const socket = io(SOCKET_SERVER, {
  reconnection: true,
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  reconnectionAttempts: 5
});

// Room configuration
const roomConfig = {
  roomId: 'room-' + Date.now(),
  userId: 'user-' + Math.random().toString(36).substr(2, 9),
  userMetadata: {
    name: 'Alice',
    avatar: 'https://example.com/avatar.jpg'
  }
};

// Connection lifecycle
socket.on('connect', () => {
  console.log('✅ Connected to Polyphony server');
  
  // Join room on successful connection
  socket.emit('room:join', roomConfig);
});

socket.on('disconnect', () => {
  console.log('❌ Disconnected from server');
});

socket.on('connect_error', (error) => {
  console.error('Connection error:', error);
});

// Room events
socket.on('room:joined', (data) => {
  console.log('✅ Joined room:', data);
  // Send first thought
  socket.emit('thought:stream', {
    content: 'This is my opening thought for the collaboration!',
    type: 'text',
    metadata: { source: 'initial' }
  });
});

socket.on('room:user_joined', (data) => {
  console.log('👤 User joined:', data.userId);
  console.log(`Active users: ${data.activeUserCount}`);
});

socket.on('room:user_left', (data) => {
  console.log('👋 User left:', data.userId);
  console.log(`Active users: ${data.activeUserCount}`);
});

socket.on('room:final_summary', (data) => {
  console.log('📝 Final Summary Generated:');
  console.log(data.markdown);
  // Offer download to user
  downloadMarkdown(data.markdown, `polyphony-${roomConfig.roomId}.md`);
});

// Thought events
socket.on('thought:received', (data) => {
  console.log(`💭 New thought from ${data.userId}:`, data.content);
});

// Synthesis events
socket.on('synthesis:update', (data) => {
  console.log('🧠 Hive Agent Synthesis:');
  console.log('Summary:', data.summary);
  console.log('Contributors:', data.contributors.length);
  if (data.conflicts.length > 0) {
    console.log('Conflicts detected:', data.conflicts);
  }
  if (data.insights.length > 0) {
    console.log('Insights:', data.insights);
  }
});

// Error handling
socket.on('error', (error) => {
  console.error('Server error:', error);
});

// Helper: Send a thought
function streamThought(content, type = 'text') {
  socket.emit('thought:stream', {
    content,
    type,
    metadata: {
      source: 'user-input',
      timestamp: Date.now()
    }
  });
}

// Helper: Heartbeat to keep connection alive
function sendHeartbeat() {
  socket.emit('heartbeat', { timestamp: Date.now() });
}

// Heartbeat interval - send every 30 seconds
setInterval(sendHeartbeat, 30000);

// Helper: Download markdown as file
function downloadMarkdown(markdown, filename) {
  const element = document.createElement('a');
  element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(markdown));
  element.setAttribute('download', filename);
  element.style.display = 'none';
  document.body.appendChild(element);
  element.click();
  document.body.removeChild(element);
}

// Example: Simulate continuous thought streaming
function startThoughtStream() {
  const thoughts = [
    'I think we should focus on user experience first',
    'Latency is critical for real-time collaboration',
    'We need robust error handling',
    'The vector search should be fast and accurate'
  ];

  let index = 0;
  const streamInterval = setInterval(() => {
    if (index < thoughts.length) {
      streamThought(thoughts[index], 'text');
      index++;
    } else {
      clearInterval(streamInterval);
    }
  }, 2000);
}

// Export for use in other modules
export { socket, streamThought, sendHeartbeat, downloadMarkdown, startThoughtStream };
