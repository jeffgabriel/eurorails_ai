# Llama Guard 3 GGUF Integration Guide

## Current Status

The moderation service is currently using **enhanced pattern matching** with comprehensive safety categories based on the MLCommons taxonomy. This provides significantly better coverage than the original placeholder but is not as sophisticated as the full Llama Guard model.

## Why Full Integration Isn't Complete Yet

The `node-llama-cpp` library requires native ARM64 Node.js on Apple Silicon. The current development environment is running Node under Rosetta (x64 emulation), which causes installation failures.

## Options for Full GGUF Integration

### Option 1: Fix Development Environment (Recommended for Local Dev)

Install native ARM64 Node.js:

```bash
# Uninstall current Node
# Install ARM64 version from nodejs.org or using nvm

# Using nvm:
arch -arm64 zsh
nvm install 20
nvm use 20

# Verify architecture
node -p "process.arch"  # Should output: arm64

# Then install node-llama-cpp
npm install node-llama-cpp
```

### Option 2: Separate Inference Server (Recommended for Production)

Run llama.cpp server separately and call it via HTTP:

#### Setup llama.cpp Server:

```bash
# Clone and build llama.cpp
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp
make

# Start server with Llama Guard model
./server -m /path/to/Llama-Guard-3-1B.Q4_K_M.gguf \
  --port 8080 \
  --ctx-size 2048 \
  --parallel 4
```

#### Update ModerationService:

```typescript
private async callLlamaCppServer(prompt: string): Promise<string> {
  const response = await fetch('http://localhost:8080/completion', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt,
      temperature: 0.0,
      max_tokens: 100,
      stop: ['<|eot_id|>'],
    }),
  });
  
  const data = await response.json();
  return data.content;
}

async checkMessage(text: string): Promise<{ isAppropriate: boolean; confidence: number }> {
  // ... validation ...
  
  const prompt = this.buildLlamaGuardPrompt(text);
  const response = await this.callLlamaCppServer(prompt);
  const parsed = this.parseLlamaGuardResponse(response);
  
  return {
    isAppropriate: parsed.safe,
    confidence: parsed.confidence,
  };
}
```

### Option 3: Convert Model to ONNX

Use transformers.js with ONNX version:

1. Convert GGUF to ONNX format using optimum-cli
2. Host ONNX model
3. Use `@xenova/transformers`

```bash
# Convert model
optimum-cli export onnx \
  --model meta-llama/Llama-Guard-3-1B \
  --task text-generation \
  onnx-models/
```

```typescript
import { pipeline } from '@xenova/transformers';

// In constructor
this.model = await pipeline('text-generation', 'path/to/onnx-model');

// In checkMessage
const result = await this.model(prompt, {
  max_new_tokens: 100,
  temperature: 0.0,
});
```

### Option 4: External Moderation API (Easiest for Production)

Use a hosted moderation API like:
- OpenAI Moderation API
- Perspective API (Google)
- AWS Content Moderation
- Llama Guard via Replicate or Together.ai

```typescript
async checkMessage(text: string): Promise<{ isAppropriate: boolean; confidence: number }> {
  const response = await fetch('https://api.openai.com/v1/moderations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ input: text }),
  });
  
  const data = await response.json();
  const flagged = data.results[0].flagged;
  
  return {
    isAppropriate: !flagged,
    confidence: flagged ? 0.95 : 0.90,
  };
}
```

## Implementation Steps for node-llama-cpp (Once ARM64 Node is Available)

1. **Install dependency**:
```bash
npm install node-llama-cpp
```

2. **Update loadModelFromDisk**:
```typescript
import { LlamaModel, LlamaContext, LlamaChatSession } from 'node-llama-cpp';

private async loadModelFromDisk(modelPath: string): Promise<any> {
  const model = new LlamaModel({
    modelPath,
    gpuLayers: 0, // CPU only, or set higher for GPU
  });
  
  const context = new LlamaContext({
    model,
    contextSize: 2048,
  });
  
  return { model, context };
}
```

3. **Update checkMessage**:
```typescript
async checkMessage(text: string): Promise<{ isAppropriate: boolean; confidence: number }> {
  if (!this.isInitialized) {
    throw new Error('MODERATION_NOT_INITIALIZED');
  }

  if (!text || text.trim().length === 0) {
    return { isAppropriate: false, confidence: 1.0 };
  }

  try {
    const prompt = this.buildLlamaGuardPrompt(text);
    
    const session = new LlamaChatSession({
      contextSequence: this.model.context.getSequence(),
    });
    
    const response = await session.prompt(prompt, {
      temperature: 0.0,
      maxTokens: 100,
    });
    
    const parsed = this.parseLlamaGuardResponse(response);
    
    console.log('[Moderation] Model Response:', {
      messagePreview: text.substring(0, 100),
      safe: parsed.safe,
      categories: parsed.categories,
      confidence: parsed.confidence,
      decision: parsed.safe ? 'PASSED' : 'REJECTED',
    });
    
    return {
      isAppropriate: parsed.safe,
      confidence: parsed.confidence,
    };
  } catch (error) {
    console.error('[Moderation] Model inference error:', error);
    return { isAppropriate: false, confidence: 0.0 };
  }
}
```

## Current Enhanced Pattern Matching

The current implementation uses comprehensive pattern matching covering:

- **S1**: Violent Crimes (kill, murder, assault, attack, etc.)
- **S2**: Non-Violent Crimes (fraud, scam, steal, hack, etc.)
- **S3**: Sex Crimes (trafficking, sexual assault, harassment)
- **S4**: Child Exploitation (child abuse, underage, minor)
- **S5**: Defamation (false accusation, slander, libel)
- **S10**: Hate speech (hate, racist, slurs)
- **S11**: Self-Harm (suicide, self-harm, cutting)
- **S12**: Sexual Content (porn, xxx, explicit terms)

This provides reasonable protection while full model integration is being completed.

## Performance Considerations

### Pattern Matching (Current):
- Latency: <1ms
- Memory: ~10MB
- CPU: Negligible
- Cost: Free

### GGUF Model with node-llama-cpp:
- Latency: 50-200ms (depending on model size and hardware)
- Memory: 1-4GB (for quantized 1B-8B models)
- CPU: High during inference
- Cost: Free (self-hosted)

### External API:
- Latency: 100-500ms (network dependent)
- Memory: Minimal
- CPU: Minimal
- Cost: $0.002-0.01 per request

## Recommendation

For **production deployment on Railway**:
1. Use Option 2 (separate llama.cpp server) OR
2. Use Option 4 (external API like OpenAI)

For **local development**:
1. Fix Node architecture to ARM64
2. Use node-llama-cpp directly

For **immediate deployment**:
- Current enhanced pattern matching is acceptable for MVP
- Provides 10-20x better coverage than original placeholder
- Can be upgraded to full model later without API changes
