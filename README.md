# Porteight Tracking Authentication Service

A highly scalable authentication proxy service built with Hono.js and TypeScript that validates user JWTs from cookies, generates Tinybird access tokens with row-level security (RLS), caches tokens using DragonflyDB, and forwards requests to Tinybird.

## Features

- **Cookie-based JWT Authentication**: Validates user JWTs from HTTP cookies (with Bearer token fallback)
- **Token Caching**: Uses DragonflyDB (Redis-compatible) for high-performance token caching
- **Row-Level Security**: Generates Tinybird JWT tokens with RLS based on user's truck registration numbers
- **PlanetScale Integration**: Queries truck access permissions from PlanetScale MySQL database
- **Connection Pooling**: Redis connection pool for improved scalability and performance
- **Metrics & Monitoring**: Prometheus-compatible metrics endpoint for monitoring
- **Request Forwarding**: Seamlessly forwards requests to Tinybird with appropriate authorization
- **Error Handling**: Comprehensive error handling for all major operations
- **Health Checks**: Built-in health check endpoint with detailed status
- **Performance Optimizations**: Request compression, CORS support with credentials, and efficient caching

## Architecture

```
Frontend (Cookies) → Auth Middleware → Cache Check → Token Generation (if needed) → Tinybird Request → Response
                                           ↓                    ↓
                                     DragonflyDB          PlanetScale DB
                                   (Token Cache)        (Truck Access)
```

## Setup

### Prerequisites

- Node.js 18+ 
- DragonflyDB or Redis instance
- PlanetScale database account
- Tinybird account with workspace ID and signing key

### Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file with the following variables:
   ```env
   # Server Configuration
   PORT=3000
   NODE_ENV=production
   
   # JWT Authentication
   JWT_SECRET=your-jwt-secret-key-here
   
   # CORS Configuration (comma-separated allowed origins)
   ALLOWED_ORIGINS=https://your-frontend-domain.com,https://app.yourdomain.com
   
   # Tinybird Configuration
   TINYBIRD_WORKSPACE_ID=your-workspace-id
   TINYBIRD_SIGNING_KEY=your-signing-key
   TINYBIRD_API_URL=https://api.tinybird.co
   TINYBIRD_ADMIN_TOKEN=your-admin-token # Optional, for static token generation
   
   # DragonflyDB/Redis Configuration
   DRAGONFLY_URL=redis://localhost:6379
   REDIS_MIN_CONNECTIONS=5
   REDIS_MAX_CONNECTIONS=50
   
   # PlanetScale Configuration
   PLANETSCALE_HOST=your-host.psdb.cloud
   PLANETSCALE_USERNAME=your-username
   PLANETSCALE_PASSWORD=your-password
   ```

### Database Schema

Create the following table in your PlanetScale database:

```sql
CREATE TABLE truck_access (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(255) NOT NULL,
  truck_registration_no VARCHAR(50) NOT NULL,
  access_level ENUM('read', 'write', 'admin') DEFAULT 'read',
  granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NULL,
  INDEX idx_user_id (user_id),
  INDEX idx_truck_reg (truck_registration_no),
  UNIQUE KEY unique_user_truck (user_id, truck_registration_no)
);
```

### Development

```bash
npm run dev
```

### Production

```bash
npm run build
npm start
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | `3000` |
| `NODE_ENV` | Environment (development/production) | `production` |
| `JWT_SECRET` | Secret key for JWT verification | Required |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed CORS origins | All origins in development |
| `TINYBIRD_WORKSPACE_ID` | Tinybird workspace ID for JWT generation | Required |
| `TINYBIRD_SIGNING_KEY` | Tinybird signing key for JWT generation | Required |
| `TINYBIRD_API_URL` | Tinybird API base URL | `https://api.tinybird.co` |
| `TINYBIRD_ADMIN_TOKEN` | Tinybird admin token (for static tokens) | Optional |
| `DRAGONFLY_URL` | DragonflyDB/Redis connection URL | `redis://localhost:6379` |
| `REDIS_MIN_CONNECTIONS` | Minimum Redis connections in pool | `5` |
| `REDIS_MAX_CONNECTIONS` | Maximum Redis connections in pool | `50` |
| `PLANETSCALE_HOST` | PlanetScale database host | Required |
| `PLANETSCALE_USERNAME` | PlanetScale username | Required |
| `PLANETSCALE_PASSWORD` | PlanetScale password | Required |

## API Endpoints

### Health Check
```
GET /health
```
Returns server health status, DragonflyDB connection status, connection pool stats, and metrics summary.

### Metrics
```
GET /metrics
```
Returns Prometheus-compatible metrics for monitoring.

### Proxy Endpoints
```
ALL /*
```
All other requests are proxied to Tinybird with proper authentication and RLS.

## Authentication Flow

1. **Cookie/Token Extraction**: Extract JWT from cookies (`auth_token`, `jwt`, or `access_token`) or Authorization header as fallback
2. **JWT Validation**: Verify JWT using configured secret
3. **User Extraction**: Extract `userId` from JWT payload
4. **Cache Check**: Check DragonflyDB for existing Tinybird token
5. **Truck Access Query**: If no cached token, query PlanetScale for user's truck access
6. **Token Generation**: Generate Tinybird JWT with RLS based on truck access
7. **Token Caching**: Cache the generated token for 1 hour
8. **Request Forwarding**: Forward request to Tinybird with Tinybird token
9. **Response**: Return Tinybird response to client

## Frontend Integration

### Cookie Requirements

The service expects JWT tokens in one of these HTTP-only cookies:
- `auth_token` (preferred)
- `jwt`
- `access_token`

### Example Frontend Setup

```javascript
// Set JWT in cookie (server-side)
document.cookie = `auth_token=${jwtToken}; HttpOnly; Secure; SameSite=Strict; Path=/`;

// Make authenticated requests
fetch('https://your-proxy-domain.com/v0/pipes/your-endpoint', {
  method: 'GET',
  credentials: 'include', // Important: include cookies
  headers: {
    'Content-Type': 'application/json'
  }
});
```

### CORS Configuration

Ensure your frontend domain is added to `ALLOWED_ORIGINS` environment variable:
```env
ALLOWED_ORIGINS=https://your-frontend.com,https://app.yourdomain.com
```

## Tinybird Token Generation

The service generates Tinybird JWT tokens with the following structure:

```json
{
  "workspace_id": "your-workspace-id",
  "name": "user_${userId}_jwt",
  "exp": 1234567890, // 1 hour expiration
  "scopes": [
    {
      "type": "PIPES:READ",
      "resource": "truck_history_endpoint",
      "fixed_params": {
        "registrationNo": ["HT56E4521", "HR05G5555"]
      }
    },
    {
      "type": "PIPES:READ",
      "resource": "truck_location_endpoint",
      "fixed_params": {
        "registrationNo": ["HT56E4521", "HR05G5555"]
      }
    }
  ],
  "limits": {
    "rps": 1 // Rate limit per second
  }
}
```

## Row-Level Security (RLS)

The service automatically applies RLS to Tinybird tokens based on the user's truck registration numbers fetched from PlanetScale. This ensures users can only access data for trucks they have permission to view.

## Caching Strategy

- **Tinybird Tokens**: Cached for 1 hour (3600 seconds)
- **Truck Access**: Cached for 5 minutes (300 seconds)
- **Cache Keys**:
  - Token: `tinybird_token:${userId}`
  - Truck Access: `truck_access:${userId}`

## Performance & Scalability

### Connection Pooling
- Maintains a pool of Redis connections (5-50 by default)
- Automatic connection health checks and recovery
- Efficient connection reuse for high concurrency

### Metrics Collected
- Request count, duration, and errors
- Cache hits, misses, and errors
- Token generation count and duration
- Database query performance
- Connection pool statistics
- Tinybird request performance

### Optimizations
- Request compression with gzip
- CORS support with credentials for browser-based clients
- Efficient caching with TTL
- Connection pooling for database operations
- Graceful error handling and fallbacks

## Monitoring

The service exposes a `/metrics` endpoint compatible with Prometheus for monitoring:

- `porteight_proxy_requests_total` - Total requests by method, path, and status
- `porteight_proxy_request_duration_ms` - Request duration histogram
- `porteight_proxy_cache_hits_total` - Cache hit count
- `porteight_proxy_cache_misses_total` - Cache miss count
- `porteight_proxy_token_generation_duration_ms` - Token generation time
- `porteight_proxy_pool_connections_active` - Active connections in pool
- And many more...

## Error Handling

The service handles various error scenarios with structured error responses:

```json
{
  "error": "Authentication token has expired. Please log in again.",
  "code": "TOKEN_EXPIRED",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

Error codes include:
- `AUTH_ERROR` - General authentication errors
- `INVALID_TOKEN` - Invalid JWT format or signature
- `TOKEN_EXPIRED` - Expired JWT token
- `AUTH_INTERNAL_ERROR` - Internal authentication errors

## Security Considerations

- JWT tokens are verified using the configured secret
- HTTP-only cookies prevent XSS attacks
- CORS properly configured with credentials support
- Original cookies and authorization headers are stripped before forwarding
- RLS ensures data isolation between users
- Database queries use parameterized statements
- Rate limiting applied per user via Tinybird JWT

## Development Notes

### File Structure

- `src/auth.ts` - Cookie-based JWT authentication middleware
- `src/dragonfly.ts` - DragonflyDB connection and caching
- `src/planetscale.ts` - PlanetScale database queries
- `src/truckFetcher.ts` - Truck registration number fetching with caching
- `src/tinybird.ts` - Tinybird JWT token generation with RLS
- `src/connectionPool.ts` - Redis connection pool implementation
- `src/metrics.ts` - Metrics collection and reporting
- `src/index.ts` - Main server and request handling

### Testing in Development

In development mode (`NODE_ENV=development`), the truck fetcher will fall back to hardcoded values if PlanetScale is unavailable, and CORS allows all origins.

## Production Deployment

1. Ensure all environment variables are properly configured
2. Use a process manager like PM2 or systemd
3. Set up monitoring with Prometheus/Grafana
4. Configure DragonflyDB/Redis for persistence
5. Set up proper logging and error tracking
6. Use a reverse proxy (nginx/caddy) for SSL termination
7. Implement rate limiting at the proxy level
8. Configure ALLOWED_ORIGINS for your frontend domains

## License

Porteight