import io from 'socket.io-client';

const TEST_ROOM = 'test-polyphony-' + Date.now();
const API_URL = 'http://localhost:3000';

console.log('Testing Polyphony.live...\n');

// Test 1: Health check
console.log('1. Testing health endpoint...');
try {
  const response = await fetch(`${API_URL}/health`);
  const data = await response.json();
  console.log('   ✅ Health:', data.status);
} catch (e) {
  console.log('   ❌ Health check failed:', e.message);
}

// Test 2: Create space
console.log('\n2. Testing space creation...');
let spaceId;
try {
  const response = await fetch(`${API_URL}/api/space/create`, { method: 'POST' });
  const data = await response.json();
  spaceId = data.spaceId;
  console.log('   ✅ Space created:', spaceId);
} catch (e) {
  console.log('   ❌ Space creation failed:', e.message);
  process.exit(1);
}

// Test 3: Simulate multiple users connecting
console.log('\n3. Testing multi-user connection...');

const users = ['Alice', 'Bob', 'Carol'];
const sockets = [];

for (const userName of users) {
  const socket = io(API_URL, { transports: ['websocket', 'polling'] });
  
  await new Promise((resolve, reject) => {
    socket.on('connect', () => {
      console.log(`   ✅ ${userName} connected (${socket.id})`);
      socket.emit('room:join', {
        roomId: spaceId,
        userId: `user-${userName.toLowerCase()}`,
        userName: userName
      });
    });
    
    socket.on('room:joined', (data) => {
      console.log(`   ✅ ${userName} joined room, users: ${data.activeUserCount}, admin: ${data.isAdmin}`);
      resolve();
    });
    
    socket.on('connect_error', (err) => {
      console.log(`   ❌ ${userName} connection error:`, err.message);
      reject(err);
    });
    
    setTimeout(() => reject(new Error('Timeout')), 5000);
  });
  
  sockets.push({ name: userName, socket });
}

// Test 4: Test simultaneous messaging (the "polyphony")
console.log('\n4. Testing simultaneous messages (polyphony)...');

// All users send messages at roughly the same time
const messagePromises = sockets.map(({ name, socket }) => {
  return new Promise((resolve) => {
    const messageId = `msg-${name}-${Date.now()}`;
    
    socket.on('agent:response', (data) => {
      console.log(`   ✅ ${name} received agent response: "${data.content.slice(0, 60)}..."`);
      resolve({ name, response: data.content });
    });
    
    socket.on('agent:typing', () => {
      console.log(`   ⏳ ${name} sees agent typing...`);
    });
    
    socket.on('agent:done', () => {
      console.log(`   ✓ ${name} agent done`);
    });
    
    // Send message
    setTimeout(() => {
      console.log(`   📤 ${name} sending message...`);
      socket.emit('message:send', {
        content: `Hello from ${name}! I'm contributing to this polyphonic discussion about AI and collaboration.`,
        messageId,
        conversationHistory: []
      });
    }, Math.random() * 500); // Random delay 0-500ms to simulate "talking over each other"
  });
});

// Wait for all responses with timeout
try {
  const responses = await Promise.race([
    Promise.all(messagePromises),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for responses')), 15000))
  ]);
  console.log(`\n   📊 All ${responses.length} users received agent responses`);
} catch (e) {
  console.log('\n   ⚠️  Timeout or error:', e.message);
}

// Test 5: Check canvas updates (shared state)
console.log('\n5. Testing shared canvas updates...');
let canvasReceived = false;
for (const { name, socket } of sockets) {
  socket.on('canvas:update', (data) => {
    if (!canvasReceived) {
      console.log(`   ✅ Canvas update received (via ${name}): ${data.contribution?.type}`);
      canvasReceived = true;
    }
  });
  socket.on('knowledge:update', (data) => {
    console.log(`   ✅ Knowledge update (via ${name}): ${data.topics?.length || 0} topics`);
  });
}

await new Promise(r => setTimeout(r, 3000));

// Cleanup
console.log('\n6. Cleaning up...');
sockets.forEach(({ socket }) => socket.disconnect());

console.log('\n✅ Test complete!');
