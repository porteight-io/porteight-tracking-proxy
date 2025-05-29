import Redis from 'ioredis';

export class DragonflyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DragonflyError';
  }
}

class DragonflyClient {
  private redis: Redis;
  private isConnected: boolean = false;

  constructor() {
    const dragonflyUrl = process.env.DRAGONFLY_URL || 'redis://localhost:6379';
    
    this.redis = new Redis(dragonflyUrl, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });

    this.redis.on('connect', () => {
      console.log('Connected to DragonflyDB');
      this.isConnected = true;
    });

    this.redis.on('error', (error) => {
      console.error('DragonflyDB connection error:', error);
      this.isConnected = false;
    });

    this.redis.on('close', () => {
      console.log('DragonflyDB connection closed');
      this.isConnected = false;
    });
  }

  /**
   * Get cached token by userId
   */
  async getToken(userId: string): Promise<string | null> {
    try {
      const cacheKey = `tinybird_token:${userId}`;
      const token = await this.redis.get(cacheKey);
      
      if (token) {
        console.log(`Cache hit for user ${userId}`);
        return token;
      }
      
      console.log(`Cache miss for user ${userId}`);
      return null;
    } catch (error) {
      console.error('Error getting token from cache:', error);
      throw new DragonflyError(`Failed to get token from cache: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Store token with TTL (default 1 hour)
   */
  async setToken(userId: string, token: string, ttlInSeconds: number = 3600): Promise<void> {
    try {
      const cacheKey = `tinybird_token:${userId}`;
      await this.redis.setex(cacheKey, ttlInSeconds, token);
      console.log(`Token cached for user ${userId} with TTL ${ttlInSeconds} seconds`);
    } catch (error) {
      console.error('Error setting token in cache:', error);
      throw new DragonflyError(`Failed to set token in cache: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Delete token from cache
   */
  async deleteToken(userId: string): Promise<void> {
    try {
      const cacheKey = `tinybird_token:${userId}`;
      await this.redis.del(cacheKey);
      console.log(`Token deleted from cache for user ${userId}`);
    } catch (error) {
      console.error('Error deleting token from cache:', error);
      throw new DragonflyError(`Failed to delete token from cache: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Check if connected to DragonflyDB
   */
  isReady(): boolean {
    return this.isConnected && this.redis.status === 'ready';
  }

  /**
   * Close the connection
   */
  async disconnect(): Promise<void> {
    try {
      await this.redis.quit();
      console.log('DragonflyDB connection closed gracefully');
    } catch (error) {
      console.error('Error closing DragonflyDB connection:', error);
    }
  }

  /**
   * Get connection status
   */
  getStatus(): string {
    return this.redis.status;
  }
}

// Create singleton instance
export const dragonflyClient = new DragonflyClient(); 