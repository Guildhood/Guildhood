import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export class BackendError extends Error {}

export interface PlayerRecord {
  userId: string;
  displayName: string;
  username: string | null;
  onboardingComplete: boolean;
  /** Active suspension or ban, if any (eligibility is re-checked while connected). */
  restriction: { type: string; expiresAt: string | null } | null;
  vehicle: { id: string; modelId: string; colorIndex: number } | null;
  friendIds: Set<string>;
  neighborhoodIds: Set<string>;
}

export interface NeighborhoodRecord {
  id: string;
  name: string;
  mapKey: string;
  capacity: number;
  isOpen: boolean;
}

/** Everything the game server reads from or writes to the persistent store. */
export interface Backend {
  getPlayer(userId: string): Promise<PlayerRecord | null>;
  getNeighborhood(id: string): Promise<NeighborhoodRecord | null>;
  openInstance(instanceId: string, neighborhoodId: string, serverId: string, capacity: number): Promise<void>;
  heartbeat(serverId: string, instances: { id: string; player_count: number }[]): Promise<number>;
  closeInstance(instanceId: string): Promise<void>;
  setPresence(userId: string, instanceId: string): Promise<void>;
  clearPresence(userId: string, instanceId: string): Promise<void>;
  reapStaleInstances(staleAfterSeconds: number): Promise<number>;
}

const TIMEOUT_MS = 5_000;

/** Calls the service-role-only RPCs defined in supabase/migrations. */
export class SupabaseBackend implements Backend {
  private readonly db: SupabaseClient;

  constructor(url: string, secretKey: string) {
    this.db = createClient(url, secretKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  }

  private async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    let res;
    try {
      res = await this.db.rpc(fn, args).abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    } catch (err) {
      throw new BackendError(`${fn} failed: ${(err as Error).message}`);
    }
    if (res.error) throw new BackendError(`${fn} failed: ${res.error.message}`);
    return res.data as T;
  }

  async getPlayer(userId: string): Promise<PlayerRecord | null> {
    const p = await this.rpc<{
      user_id: string;
      display_name: string;
      username: string | null;
      onboarding_complete: boolean;
      restriction: { restriction_type: string; expires_at: string | null } | null;
      vehicle: { id: string; model_id: string; color_index: number } | null;
      friend_ids: string[];
      neighborhood_ids: string[];
    } | null>('server_get_player', { p_user_id: userId });
    if (!p) return null;
    return {
      userId: p.user_id,
      displayName: p.display_name,
      username: p.username,
      onboardingComplete: p.onboarding_complete,
      restriction: p.restriction ? { type: p.restriction.restriction_type, expiresAt: p.restriction.expires_at } : null,
      vehicle: p.vehicle ? { id: p.vehicle.id, modelId: p.vehicle.model_id, colorIndex: p.vehicle.color_index } : null,
      friendIds: new Set(p.friend_ids),
      neighborhoodIds: new Set(p.neighborhood_ids),
    };
  }

  async getNeighborhood(id: string): Promise<NeighborhoodRecord | null> {
    const n = await this.rpc<{ id: string; name: string; map_key: string; max_players_per_instance: number; is_open: boolean } | null>(
      'server_get_neighborhood',
      { p_neighborhood_id: id },
    );
    if (!n) return null;
    return { id: n.id, name: n.name, mapKey: n.map_key, capacity: n.max_players_per_instance, isOpen: n.is_open };
  }

  async openInstance(instanceId: string, neighborhoodId: string, serverId: string, capacity: number): Promise<void> {
    await this.rpc('server_open_instance', {
      p_instance_id: instanceId,
      p_neighborhood_id: neighborhoodId,
      p_server_id: serverId,
      p_capacity: capacity,
    });
  }

  heartbeat(serverId: string, instances: { id: string; player_count: number }[]): Promise<number> {
    return this.rpc<number>('server_heartbeat', { p_server_id: serverId, p_instances: instances });
  }

  async closeInstance(instanceId: string): Promise<void> {
    await this.rpc('server_close_instance', { p_instance_id: instanceId });
  }

  async setPresence(userId: string, instanceId: string): Promise<void> {
    await this.rpc('server_set_presence', { p_user_id: userId, p_instance_id: instanceId });
  }

  async clearPresence(userId: string, instanceId: string): Promise<void> {
    await this.rpc('server_clear_presence', { p_user_id: userId, p_instance_id: instanceId });
  }

  reapStaleInstances(staleAfterSeconds: number): Promise<number> {
    return this.rpc<number>('server_reap_stale_instances', { p_stale_after_seconds: staleAfterSeconds });
  }
}
