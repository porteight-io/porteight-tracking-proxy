import { getTruckAccessForUser } from './planetscale.js';
import { dragonflyClient } from './dragonfly.js';

/**
 * Fetch truck registration numbers for a user from PlanetScale
 * with caching for improved performance
 */
export async function getTruckRegistrationNos(userId: string): Promise<string[]> {
  const cacheKey = `truck_access:${userId}`;
  const cacheTTL = 300; // 5 minutes cache for truck access
  
  try {
    // Try to get from cache first
    const cachedData = await dragonflyClient.getToken(cacheKey);
    if (cachedData) {
      console.log(`Cache hit for truck access of user ${userId}`);
      return JSON.parse(cachedData);
    }
  } catch (error) {
    console.warn('Failed to check cache for truck access:', error);
  }

  try {
    // Fetch from PlanetScale
    console.log(`Fetching truck registration numbers from PlanetScale for user: ${userId}`);
    const truckRegistrationNos = await getTruckAccessForUser(userId);
    
    // Cache the result
    if (truckRegistrationNos.length > 0) {
      try {
        await dragonflyClient.setToken(cacheKey, JSON.stringify(truckRegistrationNos), cacheTTL);
        console.log(`Cached truck access for user ${userId} with ${truckRegistrationNos.length} trucks`);
      } catch (error) {
        console.warn('Failed to cache truck access:', error);
      }
    }
    
    return truckRegistrationNos;
  } catch (error) {
    console.error('Failed to fetch truck access from PlanetScale:', error);
    
    // Fallback to hardcoded values in development/testing
    if (process.env.NODE_ENV === 'development') {
      console.warn('Using fallback truck registration numbers for development');
      return ['HT56E4521', 'HR05G5555'];
    }
    
    throw error;
  }
}

/**
 * Invalidate cached truck access for a user
 * Call this when truck access is updated
 */
export async function invalidateTruckAccessCache(userId: string): Promise<void> {
  const cacheKey = `truck_access:${userId}`;
  try {
    await dragonflyClient.deleteToken(cacheKey);
    console.log(`Invalidated truck access cache for user ${userId}`);
  } catch (error) {
    console.error('Failed to invalidate truck access cache:', error);
  }
} 