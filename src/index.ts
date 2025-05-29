import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { compress } from 'hono/compress';
import dotenv from 'dotenv';
import axios from 'axios';
import { authMiddleware, AuthUser } from './auth.js';
import { dragonflyClient, DragonflyError } from './dragonfly.js';
import { generateTinybirdToken, TinybirdError } from './tinybird.js';
import { metrics, MetricNames } from './metrics.js';
import { RedisConnectionPool } from './connectionPool.js';

// Load environment variables
dotenv.config();

// Initialize connection pool for better scalability
const redisPool = new RedisConnectionPool(
  process.env.DRAGONFLY_URL || 'redis://localhost:6379',
  {
    minConnections: parseInt(process.env.REDIS_MIN_CONNECTIONS || '5'),
    maxConnections: parseInt(process.env.REDIS_MAX_CONNECTIONS || '50'),
  }
);

const app = new Hono();

// Add CORS middleware with credentials support for cookie-based auth
app.use('*', cors({
  origin: (origin) => {
    // Allow requests from specific origins or all origins in development
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [];
    
    if (process.env.NODE_ENV === 'development') {
      return origin || '*'; // Allow all origins in development
    }
    
    if (!origin) return origin; // Allow requests with no origin (e.g., mobile apps, Postman)
    
    return allowedOrigins.includes(origin) ? origin : null;
  },
  credentials: true, // Important for cookie-based auth
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowHeaders: [
    'Origin', 
    'Content-Type', 
    'Accept', 
    'Authorization', 
    'X-Requested-With',
    'X-User-Agent',
    'Cache-Control'
  ],
  exposeHeaders: ['Content-Length', 'X-Request-ID'],
  maxAge: 86400, // 24 hours preflight cache
}));

// Add compression middleware
app.use('*', compress());

// Request logging middleware
app.use('*', async (c, next) => {
  const start = Date.now();
  const path = c.req.path;
  const method = c.req.method;
  
  try {
    await next();
    
    const duration = Date.now() - start;
    metrics.incrementCounter(MetricNames.REQUEST_TOTAL, 1, { 
      method, 
      path, 
      status: String(c.res.status) 
    });
    metrics.recordHistogram(MetricNames.REQUEST_DURATION, duration, { method, path });
    
    console.log(`${method} ${path} - ${c.res.status} - ${duration}ms`);
  } catch (error) {
    const duration = Date.now() - start;
    metrics.incrementCounter(MetricNames.REQUEST_ERROR, 1, { method, path });
    console.error(`${method} ${path} - ERROR - ${duration}ms`, error);
    throw error;
  }
});

// Health check endpoint
app.get('/health', async (c) => {
  const poolStats = redisPool.getStats();
  
  return c.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    dragonfly_status: dragonflyClient.getStatus(),
    connection_pool: poolStats,
    metrics: metrics.getMetricsSummary(),
  });
});

// Metrics endpoint for Prometheus
app.get('/metrics', (c) => {
  c.header('Content-Type', 'text/plain; version=0.0.4');
  return c.text(metrics.getMetricsPrometheus());
});

// Apply auth middleware to all routes except health and metrics
app.use('*', async (c, next) => {
  if (c.req.path === '/health' || c.req.path === '/metrics') {
    await next();
    return;
  }
  
  await authMiddleware(c, next);
});

// Auth test endpoint (useful for frontend integration testing)
app.get('/auth/test', async (c) => {
  try {
    // This endpoint uses the auth middleware to test authentication
    const ctx = c as any;
    const user = ctx.get('user') as AuthUser;
    
    return c.json({
      success: true,
      message: 'Authentication successful',
      user: {
        userId: user.userId,
        // Don't expose sensitive data, just confirm auth works
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    return c.json({
      success: false,
      message: 'Authentication failed',
      timestamp: new Date().toISOString()
    }, 401 as any);
  }
});

// Main proxy handler for all Tinybird requests
app.all('*', async (c) => {
  const requestTimer = metrics.startTimer(MetricNames.REQUEST_DURATION);
  
  try {
    // Type assertion to work around Hono's context typing
    const ctx = c as any;
    const user = ctx.get('user') as AuthUser;
    const userId = user.userId;

    console.log(`Processing request for user ${userId}: ${c.req.method} ${c.req.path}`);

    // Check cache for existing token
    let tinybirdToken: string | null = null;
    
    try {
      const cacheTimer = metrics.startTimer(MetricNames.CACHE_HIT);
      tinybirdToken = await redisPool.execute(async (redis) => {
        return await redis.get(`tinybird_token:${userId}`);
      });
      cacheTimer();
      
      if (tinybirdToken) {
        metrics.incrementCounter(MetricNames.CACHE_HIT);
      } else {
        metrics.incrementCounter(MetricNames.CACHE_MISS);
      }
    } catch (error) {
      metrics.incrementCounter(MetricNames.CACHE_ERROR);
      console.warn('Cache lookup failed, proceeding without cache:', error);
    }

    // Generate new token if not cached
    if (!tinybirdToken) {
      const tokenTimer = metrics.startTimer(MetricNames.TOKEN_GENERATION_DURATION);
      
      try {
        console.log(`Generating new Tinybird token for user ${userId}`);
        tinybirdToken = await generateTinybirdToken(userId);
        metrics.incrementCounter(MetricNames.TOKEN_GENERATED);
        
        // Cache the token for 1 hour (3600 seconds)
        try {
          await redisPool.execute(async (redis) => {
            await redis.setex(`tinybird_token:${userId}`, 3600, tinybirdToken!);
          });
        } catch (error) {
          console.warn('Failed to cache token, proceeding anyway:', error);
        }
      } catch (error) {
        metrics.incrementCounter(MetricNames.TOKEN_GENERATION_ERROR);
        tokenTimer();
        
        if (error instanceof TinybirdError) {
          return c.json({ error: error.message }, (error.statusCode || 500) as any);
        }
        throw error;
      } finally {
        tokenTimer();
      }
    }

    // Prepare Tinybird request
    const tinybirdApiUrl = process.env.TINYBIRD_API_URL;
    if (!tinybirdApiUrl) {
      return c.json({ error: 'TINYBIRD_API_URL not configured' }, 500 as any);
    }

    // Build the target URL
    const targetUrl = `${tinybirdApiUrl}${c.req.path}`;
    const searchParams = new URLSearchParams();
    
    // Copy query parameters
    const url = new URL(c.req.url);
    url.searchParams.forEach((value, key) => {
      searchParams.append(key, value);
    });

    const finalUrl = searchParams.toString() 
      ? `${targetUrl}?${searchParams.toString()}`
      : targetUrl;

    // Prepare headers (exclude original Authorization header and cookies)
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${tinybirdToken}`,
      'Content-Type': 'application/json',
    };

    // Copy other headers (excluding authorization, cookies, and host)
    const requestHeaders = c.req.header();
    Object.entries(requestHeaders).forEach(([key, value]) => {
      const lowerKey = key.toLowerCase();
      if (lowerKey !== 'authorization' && 
          lowerKey !== 'host' && 
          lowerKey !== 'cookie' &&
          typeof value === 'string') {
        headers[key] = value;
      }
    });

    // Get request body if present
    let requestBody: any = undefined;
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
      try {
        const contentType = c.req.header('content-type');
        if (contentType?.includes('application/json')) {
          requestBody = await c.req.json();
        } else {
          requestBody = await c.req.text();
        }
      } catch (error) {
        console.warn('Failed to parse request body:', error);
      }
    }

    console.log(`Forwarding ${c.req.method} request to: ${finalUrl}`);

    // Forward request to Tinybird
    const tinybirdTimer = metrics.startTimer(MetricNames.TINYBIRD_REQUEST_DURATION);
    
    try {
      const response = await axios({
        method: c.req.method.toLowerCase() as any,
        url: finalUrl,
        headers,
        data: requestBody,
        timeout: 30000, // 30 second timeout
        validateStatus: () => true, // Don't throw on HTTP error status codes
      });

      tinybirdTimer();
      metrics.incrementCounter(MetricNames.TINYBIRD_REQUEST_TOTAL, 1, {
        status: String(response.status),
        method: c.req.method,
      });

      // Forward response headers (excluding set-cookie for security)
      const responseHeaders: Record<string, string> = {};
      Object.entries(response.headers).forEach(([key, value]) => {
        if (typeof value === 'string' && key.toLowerCase() !== 'set-cookie') {
          responseHeaders[key] = value;
        }
      });

      // Return the response
      return c.json(response.data, response.status as any, responseHeaders);
      
    } catch (error) {
      tinybirdTimer();
      metrics.incrementCounter(MetricNames.TINYBIRD_REQUEST_ERROR);
      throw error;
    }

  } catch (error) {
    console.error('Proxy error:', error);
    
    if (axios.isAxiosError(error)) {
      const statusCode = error.response?.status || 500;
      const message = error.response?.data?.error || error.message;
      return c.json({ error: `Tinybird request failed: ${message}` }, statusCode as any);
    }

    return c.json({ error: 'Internal server error' }, 500 as any);
  } finally {
    requestTimer();
  }
});

// Start server
const port = parseInt(process.env.PORT || '3000');

console.log(`Starting authentication proxy server on port ${port}`);
console.log(`Environment: ${process.env.NODE_ENV || 'production'}`);
console.log(`Redis pool: min=${redisPool.getStats().total} connections`);
console.log(`Cookie-based authentication enabled with CORS credentials support`);

serve({
  fetch: app.fetch,
  port,
});

// Update pool metrics periodically
setInterval(() => {
  const stats = redisPool.getStats();
  metrics.setGauge(MetricNames.POOL_CONNECTIONS_ACTIVE, stats.inUse);
  metrics.setGauge(MetricNames.POOL_CONNECTIONS_IDLE, stats.available);
  metrics.setGauge(MetricNames.POOL_CONNECTIONS_TOTAL, stats.total);
}, 10000); // Every 10 seconds

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');
  await dragonflyClient.disconnect();
  await redisPool.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  await dragonflyClient.disconnect();
  await redisPool.shutdown();
  process.exit(0);
}); 