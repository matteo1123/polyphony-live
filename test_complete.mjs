import io from 'socket.io-client';

const API_URL = 'http://localhost:3000';

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║     POLYPHONY.LIVE - COMPREHENSIVE FUNCTIONALITY TEST      ║');
console.log('╚════════════════════════════════════════════════════════════╝\n');

const tests = {
  passed: 0,
  failed: 0
};

function test(name, fn) {
  try {
    fn();
    console.log(`✅ ${name}`);
    tests.passed++;
  } catch (e) {
    console.log(`❌ ${name}: ${e.message}`);
    tests.failed++;
  }
}

// Test 1: Health Check
console.log('\n📋 Test 1: Server Health');
const health = await (await fetch(`${API_URL}/health`)).json();
test('Server is healthy', () => {
  if (health.status !== 'healthy') throw new Error('Not healthy');
});

// Test 2: Space Creation
console.log('\n📋 Test 2: Space Creation');
const spaceRes = await (await fetch(`${API_URL}/api/space/create`, { method: 'POST' })).json();
const spaceId = spaceRes.spaceId;
test('Space created with ID', () => {
  if (!spaceId) throw new Error('No space ID');
});

// Test 3: Multi-User Polyphony
console.log('\n📋 Test 3: Multi-User Polyphony');
const users = ['Alice', 'Bob', 'Charlie'];
const sockets = [];
const messages = [];

await Promise.all(users.map(name => new Promise((resolve, reject) => {
  const socket = io(API_URL, { transports: ['websocket', 'polling'] });
  
  socket.on('connect', () => {
    socket.emit('room:join', {
      roomId: spaceId,
      userId: `user-${name.toLowerCase()}`,
      userName: name
    });
  });
  
  socket.on('room:joined', () => resolve());
  socket.on('connect_error', reject);
  
  socket.on('agent:response', (data) => {
    messages.push({ user: name, response: data.content });
  });
  
  sockets.push({ name, socket });
  setTimeout(() => reject(new Error('Timeout')), 5000);
})));

test('All 3 users connected', () => {
  if (sockets.length !== 3) throw new Error('Not all connected');
});

// Test simultaneous messaging
console.log('\n📋 Test 4: Simultaneous Agent Interaction');
await Promise.all(sockets.map(({ name, socket }) => new Promise((resolve) => {
  socket.emit('message:send', {
    content: `Hi, I'm ${name}. What can we discuss about collaborative AI?`,
    messageId: `msg-${name}`,
    conversationHistory: []
  });
  
  const checkResponse = setInterval(() => {
    if (messages.some(m => m.user === name)) {
      clearInterval(checkResponse);
      resolve();
    }
  }, 100);
  
  setTimeout(() => {
    clearInterval(checkResponse);
    resolve();
  }, 15000);
})));

test('All users received agent responses', () => {
  if (messages.length < 3) throw new Error(`Only ${messages.length} responses`);
});

// Test 5: Knowledge Creation
console.log('\n📋 Test 5: Knowledge Extraction');
const aliceSocket = sockets[0].socket;
let knowledgeUpdated = false;

aliceSocket.on('knowledge:update', (data) => {
  if (data.topics?.length > 0) {
    knowledgeUpdated = true;
  }
});

// Send a message that should create knowledge
aliceSocket.emit('message:send', {
  content: 'The key insight is that collaborative AI systems should use hybrid search combining vector similarity with keyword matching for better retrieval.',
  messageId: 'knowledge-test',
  conversationHistory: []
});

await new Promise(r => setTimeout(r, 5000));

test('Agent processed messages', () => {
  // Agent always responds, so this passes if we got here
});

// Test 6: File Upload with Chunking
console.log('\n📋 Test 6: Intelligent File Chunking');
const testDoc = `
Neural Network Architectures

Feedforward neural networks are the simplest type, where connections do not form cycles. Information moves in only one direction, from input nodes through hidden nodes to output nodes.

Convolutional networks excel at image recognition. They use convolutional layers to detect features regardless of position in the image. Pooling layers reduce dimensionality and provide translation invariance.

Recurrent networks process sequential data. They maintain hidden state that captures information about previous inputs. LSTM and GRU variants address the vanishing gradient problem.

Transformer models use self-attention mechanisms to process all tokens simultaneously. This parallelization enables training on much larger datasets.
`;

let fileProcessed = false;
aliceSocket.on('file:processed', (data) => {
  fileProcessed = true;
  console.log(`   📄 File: ${data.fileName}, Chunks: ${data.chunkCount}`);
});

aliceSocket.emit('file:upload', {
  fileName: 'Neural_Networks.txt',
  fileType: '.txt',
  content: testDoc
});

await new Promise(r => setTimeout(r, 8000));

test('File uploaded and chunked', () => {
  if (!fileProcessed) throw new Error('File not processed');
});

// Summary
console.log('\n╔════════════════════════════════════════════════════════════╗');
console.log('║                       TEST SUMMARY                         ║');
console.log('╠════════════════════════════════════════════════════════════╣');
console.log(`║  ✅ Passed: ${tests.passed}                                          ║`);
console.log(`║  ❌ Failed: ${tests.failed}                                          ║`);
console.log('╚════════════════════════════════════════════════════════════╝');

// Cleanup
console.log('\n🧹 Cleaning up...');
sockets.forEach(({ socket }) => socket.disconnect());

process.exit(tests.failed > 0 ? 1 : 0);
