import { randomUUID } from "node:crypto";
import { BridgeSession, bridgeSession } from "./session.js";
import type { MinecraftClientName } from "./types.js";

const port = (name: MinecraftClientName): number => {
    const env = process.env[`DEBUGBRIDGE_${name.toUpperCase()}_PORT`];
    const fallback = name === "primary" ? 9876 : 9877;
    const parsed = Number(env);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
};

const token = (name: MinecraftClientName): string =>
    process.env[`DEBUGBRIDGE_${name.toUpperCase()}_TOKEN`] ?? "";

export const clientSessions: Record<MinecraftClientName, BridgeSession> = {
    primary: bridgeSession,
    secondary: new BridgeSession(port("secondary"), token("secondary"), false),
};

export function normalizeClient(value?: string): MinecraftClientName {
    if (!value || value === "primary") return "primary";
    if (value === "secondary") return "secondary";
    throw new Error(`Unknown Minecraft client '${value}'. Expected primary or secondary.`);
}

export function getClientSession(value?: string): BridgeSession {
    return clientSessions[normalizeClient(value)];
}

interface Lease {
    id: string;
    owner: string;
    expiresAt: number;
}

const leases = new Map<MinecraftClientName, Lease>();

export function acquireLease(clientValue?: string, owner = "codex", ttlSeconds = 900): Lease & { client: MinecraftClientName } {
    const client = normalizeClient(clientValue);
    const now = Date.now();
    const existing = leases.get(client);
    if (existing && existing.expiresAt > now && existing.owner !== owner) {
        throw new Error(`${client} is leased by ${existing.owner} until ${new Date(existing.expiresAt).toISOString()}`);
    }
    const lease: Lease = {
        id: existing?.owner === owner ? existing.id : randomUUID(),
        owner,
        expiresAt: now + Math.max(30, Math.min(ttlSeconds, 3600)) * 1000,
    };
    leases.set(client, lease);
    return { client, ...lease };
}

export function requireLease(clientValue?: string, leaseId?: string): Lease & { client: MinecraftClientName } {
    const client = normalizeClient(clientValue);
    const lease = leases.get(client);
    if (!lease || lease.expiresAt <= Date.now()) {
        leases.delete(client);
        return acquireLease(client, "codex");
    }
    if (leaseId && lease.id !== leaseId) throw new Error(`Lease mismatch for ${client}`);
    lease.expiresAt = Date.now() + 15 * 60 * 1000;
    return { client, ...lease };
}

export function releaseLease(clientValue?: string, leaseId?: string): boolean {
    const client = normalizeClient(clientValue);
    const lease = leases.get(client);
    if (!lease) return false;
    if (leaseId && lease.id !== leaseId) throw new Error(`Lease mismatch for ${client}`);
    clientSessions[client].disconnect();
    leases.delete(client);
    return true;
}

export function leaseSnapshot() {
    const now = Date.now();
    return (["primary", "secondary"] as MinecraftClientName[]).map(client => {
        const lease = leases.get(client);
        return {
            client,
            connected: clientSessions[client].isConnected,
            port: clientSessions[client].getConnectedPort() ?? port(client),
            lease: lease && lease.expiresAt > now ? lease : null,
        };
    });
}
