import fs from 'fs';
import path from 'path';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { pipeline } from 'stream/promises';

/**
 * Service for content moderation using Llama Guard model
 * Downloads model from S3 and caches in /tmp for Railway deployment
 */
export class ModerationService {
  private model: any;
  private confidenceThreshold: number;
  private modelPath: string = '/tmp/llama-guard';
  private s3Client: S3Client;
  private isInitialized: boolean = false;

  constructor() {
    this.confidenceThreshold = parseFloat(
      process.env.MODERATION_CONFIDENCE_THRESHOLD || '0.75'
    );

    // Initialize S3 client
    const awsRegion = process.env.AWS_REGION || 'us-east-1';
    const awsConfig: any = {
      region: awsRegion,
    };

    // Use explicit credentials if provided, otherwise use IAM role
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      awsConfig.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      };
    }

    this.s3Client = new S3Client(awsConfig);
  }

  /**
   * Initialize the moderation service (download model if needed)
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    try {
      // Check if model exists in /tmp cache (survives between requests, not deploys)
      if (fs.existsSync(this.modelPath)) {
        console.log('[Moderation] Loading cached model from /tmp');
        this.model = await this.loadModelFromDisk(this.modelPath);
        this.isInitialized = true;
        console.log('[Moderation] Model loaded from cache successfully');
        return;
      }

      // Download from S3
      console.log('[Moderation] Model not in cache, downloading from S3...');
      const startTime = Date.now();
      await this.downloadModelFromS3();
      const downloadTime = Date.now() - startTime;
      console.log(`[Moderation] Model downloaded in ${downloadTime}ms`);

      this.model = await this.loadModelFromDisk(this.modelPath);
      this.isInitialized = true;
      console.log('[Moderation] Model loaded successfully');
    } catch (error) {
      console.error('[Moderation] Failed to initialize model:', error);
      // Fail closed: reject messages if model can't load
      throw new Error('MODERATION_INITIALIZATION_FAILED');
    }
  }

  /**
   * Download model from S3 to /tmp
   */
  private async downloadModelFromS3(): Promise<void> {
    const bucket = process.env.LLAMA_GUARD_S3_BUCKET;
    const key = process.env.LLAMA_GUARD_S3_KEY;

    if (!bucket || !key) {
      throw new Error(
        'S3 bucket and key must be configured (LLAMA_GUARD_S3_BUCKET, LLAMA_GUARD_S3_KEY)'
      );
    }

    try {
      const command = new GetObjectCommand({ Bucket: bucket, Key: key });
      const response = await this.s3Client.send(command);

      if (!response.Body) {
        throw new Error('Empty response from S3');
      }

      // Create /tmp directory if it doesn't exist
      const dir = path.dirname(this.modelPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Stream to file to avoid memory issues with large models
      const writeStream = fs.createWriteStream(this.modelPath);
      await pipeline(response.Body as any, writeStream);

      console.log(`[Moderation] Model downloaded to ${this.modelPath}`);
    } catch (error) {
      console.error('[Moderation] S3 download error:', error);
      throw new Error('Failed to download model from S3');
    }
  }

  /**
   * Load model from disk
   * Note: Actual model loading depends on the ML framework being used
   * This is a placeholder that should be replaced with real implementation
   */
  private async loadModelFromDisk(modelPath: string): Promise<any> {
    console.log(`[Moderation] Loading model from ${modelPath}`);

    // TODO: Replace with actual model loading using chosen ML framework
    // Examples:
    // - @xenova/transformers for ONNX models
    // - onnxruntime-node for ONNX Runtime
    // - node-llama-cpp for GGUF models
    //
    // For Llama Guard GGUF model:
    // const { LlamaModel, LlamaContext } = require('node-llama-cpp');
    // const model = new LlamaModel({ modelPath });
    // const context = new LlamaContext({ model });
    // return { model, context };

    // Placeholder: Return mock model
    return {
      loaded: true,
      path: modelPath,
      framework: 'placeholder',
    };
  }

  /**
   * Check if a message is appropriate using content moderation
   */
  async checkMessage(
    text: string
  ): Promise<{ isAppropriate: boolean; confidence: number }> {
    if (!this.isInitialized) {
      throw new Error('MODERATION_NOT_INITIALIZED');
    }

    // Basic validation
    if (!text || text.trim().length === 0) {
      return { isAppropriate: false, confidence: 1.0 };
    }

    try {
      // TODO: Replace with actual model inference
      // Example for Llama Guard:
      // const prompt = `[INST] <<SYS>>
      // You are a content moderation system. Classify the following message as safe or unsafe.
      // <</SYS>>
      // 
      // Message: ${text}
      // [/INST]`;
      // 
      // const result = await this.model.context.evaluate(prompt);
      // const classification = parseModelOutput(result);
      // 
      // return {
      //   isAppropriate: classification.label === 'safe',
      //   confidence: classification.confidence
      // };

      // Placeholder implementation: Basic content filtering
      const inappropriate = [
        /\b(spam|scam)\b/i,
        /\b(hate|racist)\b/i,
        /\b(threat|kill)\b/i,
      ];

      const hasInappropriate = inappropriate.some((pattern) =>
        pattern.test(text)
      );

      return {
        isAppropriate: !hasInappropriate,
        confidence: hasInappropriate ? 0.9 : 0.95,
      };
    } catch (error) {
      console.error('[Moderation] Error checking message:', error);
      // Fail closed: reject on error
      return { isAppropriate: false, confidence: 0.0 };
    }
  }

  /**
   * Get health status of moderation service
   */
  getHealthStatus(): {
    initialized: boolean;
    modelPath: string;
    confidenceThreshold: number;
  } {
    return {
      initialized: this.isInitialized,
      modelPath: this.modelPath,
      confidenceThreshold: this.confidenceThreshold,
    };
  }

  /**
   * Check if service is ready
   */
  isReady(): boolean {
    return this.isInitialized;
  }
}

// Export singleton instance
export const moderationService = new ModerationService();
