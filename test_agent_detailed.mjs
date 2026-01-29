import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';

dotenv.config();

const MODEL = 'gemini-2.0-flash';
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_AI_API_KEY);

const tools = [{
  name: 'search_knowledge',
  description: 'Search the knowledge base',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' }
    },
    required: ['query']
  }
}];

const model = genAI.getGenerativeModel({
  model: MODEL,
  tools: [{ functionDeclarations: tools }]
});

console.log('Testing agent with tools...\n');

try {
  const chat = model.startChat();
  console.log('Sending message...');
  
  const result = await chat.sendMessage('What do you know about Paris?');
  console.log('Response received');
  
  const candidate = result.response.candidates?.[0];
  console.log('Candidate:', JSON.stringify(candidate, null, 2).slice(0, 500));
  
  // Check for function calls
  const functionCalls = candidate?.content?.parts?.filter(p => p.functionCall);
  console.log('\nFunction calls found:', functionCalls?.length || 0);
  
  if (functionCalls) {
    console.log('Function calls:', JSON.stringify(functionCalls, null, 2));
  }
  
  // Get text
  const text = result.response.text();
  console.log('\nText response:', text.slice(0, 200));
  
} catch (e) {
  console.error('Error:', e.message);
  console.error(e.stack);
}
