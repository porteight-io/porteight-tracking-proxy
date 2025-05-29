import { connect } from '@planetscale/database';

export class PlanetScaleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanetScaleError';
  }
}

// Create PlanetScale connection
const config = {
  host: process.env.PLANETSCALE_HOST,
  username: process.env.PLANETSCALE_USERNAME,
  password: process.env.PLANETSCALE_PASSWORD,
};

const conn = connect(config);

export interface TruckAccess {
  truck_registration_no: string;
  user_id: string;
  access_level: string;
  granted_at: Date;
  expires_at?: Date;
}

/**
 * Query truck access for a specific user from PlanetScale
 * This fetches all truck registration numbers that a user has access to
 */
export async function getTruckAccessForUser(userId: string): Promise<string[]> {
  try {
    // Query to fetch truck registration numbers for a user
    // Assumes a table structure like:
    // CREATE TABLE truck_access (
    //   id INT AUTO_INCREMENT PRIMARY KEY,
    //   user_id VARCHAR(255) NOT NULL,
    //   truck_registration_no VARCHAR(50) NOT NULL,
    //   access_level ENUM('read', 'write', 'admin') DEFAULT 'read',
    //   granted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    //   expires_at TIMESTAMP NULL,
    //   INDEX idx_user_id (user_id),
    //   INDEX idx_truck_reg (truck_registration_no),
    //   UNIQUE KEY unique_user_truck (user_id, truck_registration_no)
    // );
    
    const query = `
      SELECT DISTINCT truck_registration_no 
      FROM truck_access 
      WHERE user_id = ? 
        AND (expires_at IS NULL OR expires_at > NOW())
        AND access_level IN ('read', 'write', 'admin')
      ORDER BY truck_registration_no
    `;

    const results = await conn.execute(query, [userId]);
    
    if (!results.rows || results.rows.length === 0) {
      console.log(`No truck access found for user ${userId}`);
      return [];
    }

    const registrationNumbers = results.rows.map((row: any) => row.truck_registration_no);
    console.log(`Found ${registrationNumbers.length} trucks for user ${userId}`);
    
    return registrationNumbers;
  } catch (error) {
    console.error('PlanetScale query error:', error);
    throw new PlanetScaleError(`Failed to fetch truck access: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Get detailed truck access information for a user
 */
export async function getTruckAccessDetailsForUser(userId: string): Promise<TruckAccess[]> {
  try {
    const query = `
      SELECT 
        truck_registration_no,
        user_id,
        access_level,
        granted_at,
        expires_at
      FROM truck_access 
      WHERE user_id = ? 
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY granted_at DESC
    `;

    const results = await conn.execute(query, [userId]);
    
    if (!results.rows || results.rows.length === 0) {
      return [];
    }

    return results.rows as TruckAccess[];
  } catch (error) {
    console.error('PlanetScale query error:', error);
    throw new PlanetScaleError(`Failed to fetch truck access details: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Check if a user has access to a specific truck
 */
export async function userHasTruckAccess(userId: string, truckRegistrationNo: string): Promise<boolean> {
  try {
    const query = `
      SELECT COUNT(*) as count
      FROM truck_access 
      WHERE user_id = ? 
        AND truck_registration_no = ?
        AND (expires_at IS NULL OR expires_at > NOW())
        AND access_level IN ('read', 'write', 'admin')
    `;

    const results = await conn.execute(query, [userId, truckRegistrationNo]);
    
    if (!results.rows || results.rows.length === 0) {
      return false;
    }

    const count = (results.rows[0] as any).count;
    return count > 0;
  } catch (error) {
    console.error('PlanetScale query error:', error);
    throw new PlanetScaleError(`Failed to check truck access: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Batch check if a user has access to multiple trucks
 * More efficient than checking one by one
 */
export async function userHasMultipleTruckAccess(userId: string, truckRegistrationNos: string[]): Promise<Map<string, boolean>> {
  try {
    if (truckRegistrationNos.length === 0) {
      return new Map();
    }

    const placeholders = truckRegistrationNos.map(() => '?').join(',');
    const query = `
      SELECT truck_registration_no
      FROM truck_access 
      WHERE user_id = ? 
        AND truck_registration_no IN (${placeholders})
        AND (expires_at IS NULL OR expires_at > NOW())
        AND access_level IN ('read', 'write', 'admin')
    `;

    const params = [userId, ...truckRegistrationNos];
    const results = await conn.execute(query, params);
    
    const accessMap = new Map<string, boolean>();
    
    // Initialize all as false
    truckRegistrationNos.forEach(regNo => {
      accessMap.set(regNo, false);
    });
    
    // Set true for trucks found in results
    if (results.rows && results.rows.length > 0) {
      results.rows.forEach((row: any) => {
        accessMap.set(row.truck_registration_no, true);
      });
    }

    return accessMap;
  } catch (error) {
    console.error('PlanetScale batch query error:', error);
    throw new PlanetScaleError(`Failed to batch check truck access: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
} 