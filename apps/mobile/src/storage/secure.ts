import * as SecureStore from 'expo-secure-store';
import { z } from 'zod';

const CONNECTION_KEY = 'mobile-claude.connection';

const ConnectionSchema = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  deviceToken: z.string().min(1),
});

export type ConnectionInfo = z.infer<typeof ConnectionSchema>;

/**
 * Persist daemon connection credentials in the platform secure store.
 * Raw device token never goes to AsyncStorage / plain disk.
 */
export async function saveConnection(info: ConnectionInfo): Promise<void> {
  const parsed = ConnectionSchema.parse(info);
  await SecureStore.setItemAsync(CONNECTION_KEY, JSON.stringify(parsed));
}

/**
 * Load saved connection, or `null` if missing / corrupt.
 * Corrupt values are cleared so the user can re-pair.
 */
export async function loadConnection(): Promise<ConnectionInfo | null> {
  const raw = await SecureStore.getItemAsync(CONNECTION_KEY);
  if (!raw) {
    return null;
  }

  try {
    const json: unknown = JSON.parse(raw);
    const result = ConnectionSchema.safeParse(json);
    if (!result.success) {
      await SecureStore.deleteItemAsync(CONNECTION_KEY);
      return null;
    }
    return result.data;
  } catch {
    await SecureStore.deleteItemAsync(CONNECTION_KEY);
    return null;
  }
}

/** Remove saved host / port / device token (disconnect / re-pair). */
export async function clearConnection(): Promise<void> {
  await SecureStore.deleteItemAsync(CONNECTION_KEY);
}
