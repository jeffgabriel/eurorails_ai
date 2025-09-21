#!/usr/bin/env node

/**
 * Manual Integration Test Script
 * Tests real client-server communication outside of Jest
 * 
 * Usage: node scripts/test-integration.js
 */

// Use built-in fetch (Node.js 18+)

const API_BASE_URL = 'http://localhost:3001';

async function testHealthEndpoint() {
  console.log('🔍 Testing health endpoint...');
  try {
    const response = await fetch(`${API_BASE_URL}/api/lobby/health`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': '123e4567-e89b-12d3-a456-426614174000'
      }
    });
    
    const data = await response.json();
    console.log('✅ Health endpoint:', data);
    return data.message === 'Lobby service is healthy';
  } catch (error) {
    console.error('❌ Health endpoint failed:', error.message);
    return false;
  }
}

async function testCreateGame() {
  console.log('🔍 Testing create game...');
  try {
    const response = await fetch(`${API_BASE_URL}/api/lobby/games`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': '123e4567-e89b-12d3-a456-426614174000'
      },
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

async function testJoinGame(gameId, joinCode) {
  console.log('🔍 Testing join game...');
  try {
    const response = await fetch(`${API_BASE_URL}/api/lobby/games/join`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': '123e4567-e89b-12d3-a456-426614174001'
      },
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

async function testGetGame(gameId) {
  console.log('🔍 Testing get game...');
  try {
    const response = await fetch(`${API_BASE_URL}/api/lobby/games/${gameId}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': '123e4567-e89b-12d3-a456-426614174000'
      }
    });
    
    const data = await response.json();
    console.log('✅ Get game:', data);
    return data.success && data.data && data.data.id === gameId;
  } catch (error) {
    console.error('❌ Get game failed:', error.message);
    return false;
  }
}

async function testGetPlayers(gameId) {
  console.log('🔍 Testing get players...');
  try {
    const response = await fetch(`${API_BASE_URL}/api/lobby/games/${gameId}/players`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'x-user-id': '123e4567-e89b-12d3-a456-426614174000'
      }
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
  
  // Test create game
  results.createGame = await testCreateGame();
  console.log('');
  
  if (!results.createGame) {
    console.log('❌ Create game failed. Stopping tests.');
    return;
  }
  
  // Test join game (we'll need to create a game first)
  console.log('🔍 Creating game for join test...');
  const createResponse = await fetch(`${API_BASE_URL}/api/lobby/games`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-user-id': '123e4567-e89b-12d3-a456-426614174000'
    },
    body: JSON.stringify({ isPublic: true, maxPlayers: 4 })
  });
  
  const createData = await createResponse.json();
  if (createData.success) {
    const gameId = createData.data.id;
    const joinCode = createData.data.joinCode;
    
    results.joinGame = await testJoinGame(gameId, joinCode);
    console.log('');
    
    results.getGame = await testGetGame(gameId);
    console.log('');
    
    results.getPlayers = await testGetPlayers(gameId);
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
