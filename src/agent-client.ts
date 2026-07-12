import { getClientSession, normalizeClient, requireLease } from "./tools/runtime/client-registry.js";
import { executeOnClient } from "./tools/runtime/execute.js";
import { mcExecuteBothTool } from "./tools/runtime/agent-tools.js";
import { listSnippets, readHistory, readSnippet, saveSnippet } from "./tools/runtime/agent-store.js";
import type { BridgeResponse, MinecraftClientName } from "./tools/runtime/types.js";

export type { BridgeResponse, MinecraftClientName };

export async function executeGroovy(options: {
    client?: MinecraftClientName;
    code: string;
    timeoutMs?: number;
    leaseId?: string;
    snippet?: string;
}) {
    return executeOnClient(options);
}

export async function executeBothGroovy(options: {
    code?: string;
    primaryCode?: string;
    secondaryCode?: string;
    timeoutMs?: number;
    barrier?: boolean;
}) {
    return mcExecuteBothTool.handler(options);
}

export async function callClient(
    clientValue: MinecraftClientName | undefined,
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
    leaseId?: string,
): Promise<BridgeResponse> {
    const client = normalizeClient(clientValue);
    requireLease(client, leaseId);
    return getClientSession(client).send(type, payload, timeoutMs);
}

export function disconnectClient(clientValue?: MinecraftClientName): void {
    getClientSession(normalizeClient(clientValue)).disconnect();
}

export function cancelClient(clientValue?: MinecraftClientName, reason?: string): void {
    getClientSession(normalizeClient(clientValue)).cancelPending(reason);
}

export function saveGroovySnippet(name: string, code: string) {
    return { name, path: saveSnippet(name, code) };
}

export function listGroovySnippets() {
    return listSnippets();
}

export function runGroovySnippet(options: {
    name: string;
    client?: MinecraftClientName;
    timeoutMs?: number;
    leaseId?: string;
}) {
    return executeOnClient({
        ...options,
        code: readSnippet(options.name),
        snippet: options.name,
    });
}

export function getExecutionHistory(limit = 50, client?: MinecraftClientName) {
    return readHistory(limit, client);
}
