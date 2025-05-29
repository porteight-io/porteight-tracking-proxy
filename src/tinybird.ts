import axios from 'axios';
import jwt from 'jsonwebtoken';
import { getTruckRegistrationNos } from './truckFetcher.js';

export class TinybirdError extends Error {
  constructor(message: string, public statusCode?: number) {
    super(message);
    this.name = 'TinybirdError';
  }
}

interface TinybirdJWTPayload {
  workspace_id: string;
  name: string;
  exp: number;
  scopes: Array<{
    type: string;
    resource: string;
    fixed_params?: Record<string, any>;
  }>;
  limits?: {
    rps?: number;
  };
}

interface TinybirdTokenResponse {
  token: string;
  expires_at?: string;
}

/**
 * Generate a Tinybird JWT token with row-level security for a specific user
 * Using Tinybird's JWT format for better security and control
 */
export async function generateTinybirdToken(userId: string): Promise<string> {
  try {
    const tinybirdWorkspaceId = process.env.TINYBIRD_WORKSPACE_ID;
    const tinybirdSigningKey = process.env.TINYBIRD_SIGNING_KEY;
    
    if (!tinybirdWorkspaceId) {
      throw new TinybirdError('TINYBIRD_WORKSPACE_ID environment variable is not configured', 500);
    }

    if (!tinybirdSigningKey) {
      throw new TinybirdError('TINYBIRD_SIGNING_KEY environment variable is not configured', 500);
    }

    // Fetch truck registration numbers for this user
    const truckRegistrationNos = await getTruckRegistrationNos(userId);
    
    if (truckRegistrationNos.length === 0) {
      throw new TinybirdError(`No truck registration numbers found for user ${userId}`, 404);
    }

    // Create JWT payload with row-level security
    const jwtPayload: TinybirdJWTPayload = {
      workspace_id: tinybirdWorkspaceId,
      name: `user_${userId}_jwt`,
      exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour expiration
      scopes: [
        {
          type: 'PIPES:READ',
          resource: 'truck_history_endpoint',
          fixed_params: {
            registrationNo: truckRegistrationNos
          }
        },
        {
          type: 'PIPES:READ',
          resource: 'truck_location_endpoint',
          fixed_params: {
            registrationNo: truckRegistrationNos
          }
        }
      ],
      limits: {
        rps: 1 // Rate limit per second for this user
      }
    };

    console.log(`Creating Tinybird JWT for user ${userId} with ${truckRegistrationNos.length} trucks`);

    // Sign the JWT with Tinybird's signing key
    const token = jwt.sign(jwtPayload, tinybirdSigningKey, {
      algorithm: 'HS256'
    });

    console.log(`Successfully created Tinybird JWT for user ${userId}`);
    return token;

  } catch (error) {
    if (error instanceof TinybirdError) {
      throw error;
    }

    if (error instanceof jwt.JsonWebTokenError) {
      throw new TinybirdError(`JWT generation error: ${error.message}`, 500);
    }

    throw new TinybirdError(`Failed to generate Tinybird token: ${error instanceof Error ? error.message : 'Unknown error'}`, 500);
  }
}

/**
 * Alternative method using Tinybird's token API if JWT signing is not preferred
 * This creates a static token with row-level security
 */
export async function generateTinybirdStaticToken(userId: string): Promise<string> {
  try {
    const tinybirdApiUrl = process.env.TINYBIRD_API_URL;
    const tinybirdAdminToken = process.env.TINYBIRD_ADMIN_TOKEN;

    if (!tinybirdApiUrl) {
      throw new TinybirdError('TINYBIRD_API_URL environment variable is not configured', 500);
    }

    if (!tinybirdAdminToken) {
      throw new TinybirdError('TINYBIRD_ADMIN_TOKEN environment variable is not configured', 500);
    }

    // Fetch truck registration numbers for this user
    const truckRegistrationNos = await getTruckRegistrationNos(userId);
    
    if (truckRegistrationNos.length === 0) {
      throw new TinybirdError(`No truck registration numbers found for user ${userId}`, 404);
    }

    // Create RLS condition for the registration numbers
    const registrationNosCondition = truckRegistrationNos
      .map(regNo => `'${regNo}'`)
      .join(', ');
    
    const rlsCondition = `registrationNo IN (${registrationNosCondition})`;

    // Prepare token creation payload
    const tokenPayload = {
      name: `user_${userId}_token_${Date.now()}`,
      scope: 'PIPES:READ',
      pipes: ['truck_history_endpoint', 'truck_location_endpoint'],
      sql_filter: rlsCondition,
      ttl: 3600 // 1 hour TTL
    };

    console.log(`Creating Tinybird static token for user ${userId} with RLS: ${rlsCondition}`);

    // Make API call to create token
    const response = await axios.post<TinybirdTokenResponse>(
      `${tinybirdApiUrl}/v0/tokens`,
      tokenPayload,
      {
        headers: {
          'Authorization': `Bearer ${tinybirdAdminToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000 // 10 second timeout
      }
    );

    if (!response.data.token) {
      throw new TinybirdError('Invalid response from Tinybird API - no token received', 500);
    }

    console.log(`Successfully created Tinybird static token for user ${userId}`);
    return response.data.token;

  } catch (error) {
    if (error instanceof TinybirdError) {
      throw error;
    }

    if (axios.isAxiosError(error)) {
      const statusCode = error.response?.status || 500;
      const message = error.response?.data?.error || error.message;
      throw new TinybirdError(`Tinybird API error: ${message}`, statusCode);
    }

    throw new TinybirdError(`Failed to generate Tinybird token: ${error instanceof Error ? error.message : 'Unknown error'}`, 500);
  }
} 