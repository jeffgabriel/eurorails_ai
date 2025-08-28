import React from 'react';

export default function App() {
  return (
    <div style={{ padding: '20px', fontFamily: 'Arial, sans-serif' }}>
      <h1>EuroRails AI - Integration Test</h1>
      <p>This is a test to verify the basic React integration is working.</p>
      <div style={{ marginTop: '20px' }}>
        <button 
          onClick={() => alert('React is working!')}
          style={{ 
            padding: '10px 20px', 
            fontSize: '16px', 
            backgroundColor: '#007bff', 
            color: 'white', 
            border: 'none', 
            borderRadius: '5px',
            cursor: 'pointer'
          }}
        >
          Test React
        </button>
      </div>
      
      <div style={{ marginTop: '40px', padding: '20px', border: '1px solid #ccc', borderRadius: '5px' }}>
        <h2>Integration Status</h2>
        <ul>
          <li>✅ Basic React app working</li>
          <li>✅ Webpack build working</li>
          <li>✅ Dev server running</li>
          <li>🔄 Lobby components ready for integration</li>
          <li>⏳ Game client integration pending</li>
        </ul>
      </div>
    </div>
  );
}
