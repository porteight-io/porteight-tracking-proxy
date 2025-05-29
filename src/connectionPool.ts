import Redis from 'ioredis';

/**
 * Connection pool configuration for high scalability
 */
export interface PoolConfig {
  minConnections: number;
  maxConnections: number;
  idleTimeoutMs: number;
  connectionTimeoutMs: number;
}

/**
 * Redis connection pool for DragonflyDB
 * Manages multiple connections for better concurrency
 */
export class RedisConnectionPool {
  private pool: Redis[];
  private available: Redis[];
  private inUse: Set<Redis>;
  private config: PoolConfig;
  private connectionUrl: string;
  private creating: number = 0;

  constructor(connectionUrl: string, config?: Partial<PoolConfig>) {
    this.connectionUrl = connectionUrl;
    this.config = {
      minConnections: config?.minConnections || 5,
      maxConnections: config?.maxConnections || 50,
      idleTimeoutMs: config?.idleTimeoutMs || 30000,
      connectionTimeoutMs: config?.connectionTimeoutMs || 5000,
    };
    
    this.pool = [];
    this.available = [];
    this.inUse = new Set();
    
    // Initialize minimum connections
    this.initializePool();
  }

  private async initializePool(): Promise<void> {
    const promises = [];
    for (let i = 0; i < this.config.minConnections; i++) {
      promises.push(this.createConnection());
    }
    
    try {
      const connections = await Promise.all(promises);
      connections.forEach(conn => {
        if (conn) {
          this.pool.push(conn);
          this.available.push(conn);
        }
      });
      console.log(`Initialized Redis connection pool with ${this.available.length} connections`);
    } catch (error) {
      console.error('Failed to initialize connection pool:', error);
    }
  }

  private async createConnection(): Promise<Redis | null> {
    try {
      this.creating++;
      const redis = new Redis(this.connectionUrl, {
        maxRetriesPerRequest: 3,
        lazyConnect: false,
        connectTimeout: this.config.connectionTimeoutMs,
        enableReadyCheck: true,
        enableOfflineQueue: false,
      });

      // Set up connection event handlers
      redis.on('error', (error) => {
        console.error('Redis connection error:', error);
        this.removeConnection(redis);
      });

      redis.on('close', () => {
        this.removeConnection(redis);
      });

      // Wait for connection to be ready
      await redis.ping();
      
      return redis;
    } catch (error) {
      console.error('Failed to create Redis connection:', error);
      return null;
    } finally {
      this.creating--;
    }
  }

  private removeConnection(redis: Redis): void {
    // Remove from all collections
    const poolIndex = this.pool.indexOf(redis);
    if (poolIndex > -1) {
      this.pool.splice(poolIndex, 1);
    }
    
    const availableIndex = this.available.indexOf(redis);
    if (availableIndex > -1) {
      this.available.splice(availableIndex, 1);
    }
    
    this.inUse.delete(redis);
    
    // Try to disconnect gracefully
    redis.disconnect();
  }

  async acquire(): Promise<Redis> {
    // If there's an available connection, use it
    if (this.available.length > 0) {
      const conn = this.available.pop()!;
      this.inUse.add(conn);
      return conn;
    }

    // If we can create more connections, do so
    if (this.pool.length + this.creating < this.config.maxConnections) {
      const newConn = await this.createConnection();
      if (newConn) {
        this.pool.push(newConn);
        this.inUse.add(newConn);
        return newConn;
      }
    }

    // Wait for a connection to become available
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (this.available.length > 0) {
          clearInterval(checkInterval);
          const conn = this.available.pop()!;
          this.inUse.add(conn);
          resolve(conn);
        }
      }, 10);

      // Timeout after connectionTimeoutMs
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error('Connection pool timeout - no available connections'));
      }, this.config.connectionTimeoutMs);
    });
  }

  release(redis: Redis): void {
    if (this.inUse.has(redis)) {
      this.inUse.delete(redis);
      
      // Check if connection is still healthy
      redis.ping().then(() => {
        this.available.push(redis);
      }).catch(() => {
        // Connection is unhealthy, remove it
        this.removeConnection(redis);
        
        // Create a new connection if we're below minimum
        if (this.pool.length < this.config.minConnections) {
          this.createConnection().then(conn => {
            if (conn) {
              this.pool.push(conn);
              this.available.push(conn);
            }
          });
        }
      });
    }
  }

  async execute<T>(operation: (redis: Redis) => Promise<T>): Promise<T> {
    const redis = await this.acquire();
    try {
      return await operation(redis);
    } finally {
      this.release(redis);
    }
  }

  async shutdown(): Promise<void> {
    console.log('Shutting down Redis connection pool...');
    
    // Close all connections
    const promises = this.pool.map(redis => redis.quit());
    
    try {
      await Promise.all(promises);
      console.log('Redis connection pool shut down successfully');
    } catch (error) {
      console.error('Error shutting down connection pool:', error);
    }
    
    this.pool = [];
    this.available = [];
    this.inUse.clear();
  }

  getStats() {
    return {
      total: this.pool.length,
      available: this.available.length,
      inUse: this.inUse.size,
      creating: this.creating,
      maxConnections: this.config.maxConnections,
    };
  }
} 