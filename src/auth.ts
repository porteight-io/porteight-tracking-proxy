import { Context, Next } from 'hono';
import { getCookie } from 'hono/cookie';
import jwt from 'jsonwebtoken';

export interface AuthUser {
  userId: string;
  [key: string]: any;
}

export interface AuthContext {
  user: AuthUser;
}

export class AuthError extends Error {
  constructor(message: string, public statusCode: number = 401) {
    super(message);
    this.name = 'AuthError';
  }
}

export const authMiddleware = async (c: Context, next: Next) => {
  try {
    // Primary: Extract JWT from cookies
    let token = getCookie(c, 'auth_token') || getCookie(c, 'jwt') || getCookie(c, 'access_token');
    
    // Fallback: Check Authorization header for Bearer token
    if (!token) {
      const authHeader = c.req.header('Authorization');
      if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7); // Remove 'Bearer ' prefix
      }
    }
    
    if (!token) {
      throw new AuthError('Authentication required. Please provide a valid JWT token in cookies or Authorization header.', 401);
    }
    
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) {
      throw new AuthError('JWT_SECRET environment variable is not configured', 500);
    }

    // Verify the JWT token
    const decoded = jwt.verify(token, jwtSecret) as any;
    
    if (!decoded.userId) {
      throw new AuthError('Invalid token: userId not found in JWT payload', 401);
    }

    // Attach user to context
    c.set('user', {
      userId: decoded.userId,
      ...decoded
    } as AuthUser);

    await next();
  } catch (error) {
    if (error instanceof AuthError) {
      return c.json({ 
        error: error.message,
        code: 'AUTH_ERROR',
        timestamp: new Date().toISOString()
      }, error.statusCode as any);
    }
    
    if (error instanceof jwt.JsonWebTokenError) {
      return c.json({ 
        error: 'Invalid authentication token format or signature',
        code: 'INVALID_TOKEN',
        timestamp: new Date().toISOString()
      }, 401 as any);
    }
    
    if (error instanceof jwt.TokenExpiredError) {
      return c.json({ 
        error: 'Authentication token has expired. Please log in again.',
        code: 'TOKEN_EXPIRED',
        timestamp: new Date().toISOString()
      }, 401 as any);
    }
    
    console.error('Auth middleware error:', error);
    return c.json({ 
      error: 'Internal authentication error',
      code: 'AUTH_INTERNAL_ERROR',
      timestamp: new Date().toISOString()
    }, 500 as any);
  }
}; 