import io from 'socket.io-client';

const API_URL = 'http://localhost:3000';

console.log('Testing Large File Upload (500-page PDF simulation)...\n');

// Generate a "large" document (50K+ characters to trigger large file handler)
const generateLargeDoc = () => {
  const sections = [
    'Introduction', 'Background', 'Methodology', 'Literature Review', 
    'Data Analysis', 'Results', 'Discussion', 'Conclusion',
    'Future Work', 'References', 'Appendix A', 'Appendix B'
  ];
  
  let content = 'EXECUTIVE SUMMARY\n\n';
  content += 'This is a comprehensive research document covering multiple domains. '.repeat(50);
  content += '\n\n';
  
  for (let i = 0; i < sections.length; i++) {
    content += `\n\n${sections[i].toUpperCase()}\n\n`;
    content += `Section ${i + 1}: Detailed analysis of ${sections[i].toLowerCase()}. `.repeat(100);
    content += '\n\n';
    
    // Add subsections
    for (let j = 1; j <= 5; j++) {
      content += `Subsection ${i}.${j}\n`;
      content += 'Detailed discussion of specific aspects and findings. '.repeat(30);
      content += '\n\n';
    }
  }
  
  return content;
};

const largeDoc = generateLargeDoc();
console.log(`Generated document: ${largeDoc.length.toLocaleString()} characters`);
console.log(`Estimated tokens: ${Math.ceil(largeDoc.length / 4).toLocaleString()}`);
console.log(`Estimated chunks: ${Math.ceil(largeDoc.length / 4 / 512)}\n`);

const socket = io(API_URL, { transports: ['websocket', 'polling'] });

socket.on('connect', () => {
  console.log('✅ Connected');
  socket.emit('room:join', {
    roomId: 'large-file-test-' + Date.now(),
    userId: 'test-user',
    userName: 'Large File Tester'
  });
});

socket.on('room:joined', (data) => {
  console.log('✅ Joined room:', data.roomId);
  console.log('\n📤 Uploading large document...\n');
  
  const startTime = Date.now();
  socket.startTime = startTime;
  
  socket.emit('file:upload', {
    fileName: 'Large_Research_Document.txt',
    fileType: '.txt',
    content: largeDoc
  });
});

socket.on('file:processing', (data) => {
  console.log('⏳ Processing:', data.fileName);
});

socket.on('file:progress', (data) => {
  const elapsed = ((Date.now() - socket.startTime) / 1000).toFixed(1);
  if (data.status === 'analyzing') {
    console.log(`📊 [${elapsed}s] Analyzing: ${data.totalChunks} chunks total`);
    console.log(`   - Embedding ${data.embeddingNow} chunks now`);
    console.log(`   - ${data.lazyChunks} chunks will be lazy-loaded`);
  } else if (data.status === 'embedding') {
    const pct = Math.round((data.current / data.total) * 100);
    console.log(`🔮 [${elapsed}s] Embedding: ${data.current}/${data.total} (${pct}%)`);
  } else if (data.status === 'complete') {
    console.log(`✅ [${elapsed}s] Complete!`);
    console.log(`   - Total chunks: ${data.totalChunks}`);
    console.log(`   - Embedded now: ${data.embeddedChunks}`);
    console.log(`   - Lazy chunks: ${data.lazyChunks}`);
  }
});

socket.on('file:processed', (data) => {
  console.log('\n📄 File processed event:');
  console.log(`   - Name: ${data.fileName}`);
  console.log(`   - Chunks: ${data.chunkCount}`);
  console.log(`   - Is large file: ${data.isLargeFile}`);
  if (data.isLargeFile) {
    console.log(`   - Embedded: ${data.embeddedChunks}`);
    console.log(`   - Lazy: ${data.lazyChunks}`);
  }
});

socket.on('agent:response', (data) => {
  console.log('\n📨 Agent summary:', data.content.slice(0, 200) + '...');
});

socket.on('knowledge:update', (data) => {
  console.log('\n📚 Knowledge tree updated:', data.topics?.length, 'topics');
  data.topics?.forEach(t => {
    console.log(`   - ${t.title} (${t.badge})`);
  });
  
  if (data.topics?.length > 0) {
    console.log('\n✅ Test complete!');
    socket.disconnect();
    process.exit(0);
  }
});

socket.on('error', (data) => {
  console.log('❌ Error:', data);
});

setTimeout(() => {
  console.log('\n⏱️ Timeout');
  socket.disconnect();
  process.exit(1);
}, 60000);
