#!/usr/bin/env node

// Ensure Node.js 18+ for built-in fetch
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error('This script requires Node.js 18 or higher. Detected version: ' + process.version);
  process.exit(1);
}

/**
 * Manual Integration Test Script
 * Tests real client-server communication outside of Jest
 * 
 * Usage: node scripts/test-integration.js
 */

// Use built-in fetch (Node.js 18+)

const API_BASE_URL = 'http://localhost:3001';

// Lobby write endpoints take identity from the JWT only, so register two
// throwaway users and send their Bearer tokens.
async function registerTestUser(label) {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const response = await fetch(`${API_BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: `it_${label}_${suffix}`,
      email: `it_${label}_${suffix}@example.com`,
      password: 'IntegrationTest1',
      confirmPassword: 'IntegrationTest1'
    })
  });
  const data = await response.json();
  if (!response.ok || !data.data || !data.data.token) {
    throw new Error(`Failed to register test user ${label}: ${JSON.stringify(data)}`);
  }
  return data.data.token;
}

function authHeaders(token) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`
  };
}

async function testHealthEndpoint() {
  console.log('🔍 Testing health endpoint...');
  try {
    const response = await fetch(`${API_BASE_URL}/api/lobby/health`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    
    const data = await response.json();
    console.log('✅ Health endpoint:', data);
    return data.message === 'Lobby service is healthy';
  } catch (error) {
    console.error('❌ Health endpoint failed:', error.message);
    return false;
  }
}

async function testCreateGame(token) {
  console.log('🔍 Testing create game...');
  try {
    const response = await fetch(`${API_BASE_URL}/api/lobby/games`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ isPublic: true, maxPlayers: 4 })
    });
    
    const data = await response.json();
    console.log('✅ Create game:', data);
    return data.success && data.data && data.data.id;
  } catch (error) {
    console.error('❌ Create game failed:', error.message);
    return false;
  }
}

async function testJoinGame(gameId, joinCode, token) {
  console.log('🔍 Testing join game...');
  try {
    const response = await fetch(`${API_BASE_URL}/api/lobby/games/join`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ joinCode })
    });
    
    const data = await response.json();
    console.log('✅ Join game:', data);
    return data.success && data.data && data.data.id === gameId;
  } catch (error) {
    console.error('❌ Join game failed:', error.message);
    return false;
  }
}

async function testGetGame(gameId, token) {
  console.log('🔍 Testing get game...');
  try {
    const response = await fetch(`${API_BASE_URL}/api/lobby/games/${gameId}`, {
      method: 'GET',
      headers: authHeaders(token)
    });
    
    const data = await response.json();
    console.log('✅ Get game:', data);
    return data.success && data.data && data.data.id === gameId;
  } catch (error) {
    console.error('❌ Get game failed:', error.message);
    return false;
  }
}

async function testGetPlayers(gameId, token) {
  console.log('🔍 Testing get players...');
  try {
    const response = await fetch(`${API_BASE_URL}/api/lobby/games/${gameId}/players`, {
      method: 'GET',
      headers: authHeaders(token)
    });
    
    const data = await response.json();
    console.log('✅ Get players:', data);
    return data.success && Array.isArray(data.data);
  } catch (error) {
    console.error('❌ Get players failed:', error.message);
    return false;
  }
}

async function runIntegrationTests() {
  console.log('🚀 Starting Integration Tests...\n');
  
  const results = {
    health: false,
    createGame: false,
    joinGame: false,
    getGame: false,
    getPlayers: false
  };
  
  // Test health endpoint
  results.health = await testHealthEndpoint();
  console.log('');
  
  if (!results.health) {
    console.log('❌ Health check failed. Make sure server is running on port 3001');
    return;
  }
  
  let creatorToken;
  let joinerToken;
  try {
    creatorToken = await registerTestUser('creator');
    joinerToken = await registerTestUser('joiner');
  } catch (error) {
    console.error('❌', error.message);
    process.exit(1);
  }

  // Test create game
  results.createGame = await testCreateGame(creatorToken);
  console.log('');
  
  if (!results.createGame) {
    console.log('❌ Create game failed. Stopping tests.');
    return;
  }
  
  // Test join game (we'll need to create a game first)
  console.log('🔍 Creating game for join test...');
  const createResponse = await fetch(`${API_BASE_URL}/api/lobby/games`, {
    method: 'POST',
    headers: authHeaders(creatorToken),
    body: JSON.stringify({ isPublic: true, maxPlayers: 4 })
  });
  
  const createData = await createResponse.json();
  if (createData.success) {
    const gameId = createData.data.id;
    const joinCode = createData.data.joinCode;
    
    results.joinGame = await testJoinGame(gameId, joinCode, joinerToken);
    console.log('');
    
    results.getGame = await testGetGame(gameId, creatorToken);
    console.log('');
    
    results.getPlayers = await testGetPlayers(gameId, creatorToken);
    console.log('');
  }
  
  // Summary
  console.log('📊 Integration Test Results:');
  console.log('============================');
  console.log(`Health Check: ${results.health ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Create Game:  ${results.createGame ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Join Game:    ${results.joinGame ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Get Game:     ${results.getGame ? '✅ PASS' : '❌ FAIL'}`);
  console.log(`Get Players:  ${results.getPlayers ? '✅ PASS' : '❌ FAIL'}`);
  
  const allPassed = Object.values(results).every(result => result);
  console.log(`\nOverall: ${allPassed ? '✅ ALL TESTS PASSED' : '❌ SOME TESTS FAILED'}`);
  
  process.exit(allPassed ? 0 : 1);
}

// Check if server is running
fetch(`${API_BASE_URL}/api/lobby/health`)
  .then(() => runIntegrationTests())
  .catch(() => {
    console.error('❌ Server not running on port 3001. Please start the server first.');
    process.exit(1);
  });
