import { readHistory, listSnippets, readSnippet, saveSnippet } from "./agent-store.js";
import {
    acquireLease,
    clientSessions,
    getClientSession,
    leaseSnapshot,
    normalizeClient,
    releaseLease,
    requireLease,
} from "./client-registry.js";
import { executeOnClient } from "./execute.js";
import type { MinecraftClientName } from "./types.js";

const text = (value: unknown, isError = false) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
});

const clientProperty = {
    type: "string",
    enum: ["primary", "secondary"],
    description: "Target real Minecraft client. Defaults to primary.",
};

async function control(clientValue: MinecraftClientName | undefined, leaseId: string | undefined, type: string, payload: Record<string, unknown>) {
    const client = normalizeClient(clientValue);
    const lease = requireLease(client, leaseId);
    const response = await getClientSession(client).send(type, payload);
    if (!response.success) return text({ client, leaseId: lease.id, success: false, error: response.error }, true);
    return text({ client, leaseId: lease.id, success: true, result: response.result });
}

export const mcClientAcquireTool = {
    name: "mc_client_acquire",
    description: "Acquire or renew the exclusive Codex lease for a real Minecraft client.",
    inputSchema: { type: "object" as const, properties: { client: clientProperty, owner: { type: "string" }, ttlSeconds: { type: "integer", minimum: 30, maximum: 3600 } } },
    handler: async (args: { client?: MinecraftClientName; owner?: string; ttlSeconds?: number }) => text(acquireLease(args.client, args.owner, args.ttlSeconds)),
};

export const mcClientReleaseTool = {
    name: "mc_client_release",
    description: "Release a client lease, disconnect the MCP socket, and trigger bridge input/listener cleanup.",
    inputSchema: { type: "object" as const, properties: { client: clientProperty, leaseId: { type: "string" } } },
    handler: async (args: { client?: MinecraftClientName; leaseId?: string }) => text({ released: releaseLease(args.client, args.leaseId) }),
};

export const mcClientsTool = {
    name: "mc_clients",
    description: "List primary/secondary client ports, connection state, and active leases.",
    inputSchema: { type: "object" as const, properties: {} },
    handler: async () => text(leaseSnapshot()),
};

export const mcExecuteBothTool = {
    name: "mc_execute_both",
    description: "Run arbitrary Groovy inside both real clients with an optional true cross-client barrier and return both structured execution records.",
    inputSchema: {
        type: "object" as const,
        properties: {
            code: { type: "string", description: "Code used for both clients unless primaryCode/secondaryCode override it." },
            primaryCode: { type: "string" },
            secondaryCode: { type: "string" },
            timeoutMs: { type: "integer", minimum: 1000, maximum: 300000 },
            barrier: { type: "boolean", description: "Wait until both client JVMs reach the same rendezvous before running either body. Defaults to true." },
        },
    },
    handler: async (args: { code?: string; primaryCode?: string; secondaryCode?: string; timeoutMs?: number; barrier?: boolean }) => {
        const primaryCode = args.primaryCode ?? args.code;
        const secondaryCode = args.secondaryCode ?? args.code;
        if (!primaryCode || !secondaryCode) throw new Error("Provide code or both client-specific code values");
        const barrier = args.barrier ?? true;
        const barrierDir = path.join(process.env.MCDEV_MCP_BARRIER_DIR ?? "/tmp/mcdev-mcp-barriers", randomUUID());
        if (barrier) await mkdir(barrierDir, { recursive: true });
        const wrap = (client: MinecraftClientName, peer: MinecraftClientName, code: string) => barrier
            ? `
def __mcdevBarrierDir = java.nio.file.Path.of(${JSON.stringify(barrierDir)})
java.nio.file.Files.writeString(__mcdevBarrierDir.resolve(${JSON.stringify(client)}), "ready")
def __mcdevBarrierDeadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(30)
while (!java.nio.file.Files.exists(__mcdevBarrierDir.resolve(${JSON.stringify(peer)}))) {
  if (System.nanoTime() >= __mcdevBarrierDeadline) throw new java.util.concurrent.TimeoutException("peer did not reach mc_execute_both barrier")
  Thread.sleep(5)
}
${code}`
            : code;
        try {
            const [primary, secondary] = await Promise.all([
                executeOnClient({ client: "primary", code: wrap("primary", "secondary", primaryCode), timeoutMs: args.timeoutMs }),
                executeOnClient({ client: "secondary", code: wrap("secondary", "primary", secondaryCode), timeoutMs: args.timeoutMs }),
            ]);
            return text({ barrier, primary: JSON.parse(primary.content[0].text), secondary: JSON.parse(secondary.content[0].text) });
        } finally {
            if (barrier) await rm(barrierDir, { recursive: true, force: true });
        }
    },
};

export const mcSnippetSaveTool = {
    name: "mc_snippet_save",
    description: "Save a useful exploratory Groovy program for later reruns across reconnects.",
    inputSchema: { type: "object" as const, properties: { name: { type: "string" }, code: { type: "string" } }, required: ["name", "code"] },
    handler: async (args: { name: string; code: string }) => text({ name: args.name, path: saveSnippet(args.name, args.code) }),
};

export const mcSnippetListTool = {
    name: "mc_snippet_list",
    description: "List saved Groovy snippets with size and SHA-256 code hash.",
    inputSchema: { type: "object" as const, properties: {} },
    handler: async () => text(listSnippets()),
};

export const mcSnippetRunTool = {
    name: "mc_snippet_run",
    description: "Run a saved Groovy snippet inside primary or secondary with persistent bindings.",
    inputSchema: { type: "object" as const, properties: { name: { type: "string" }, client: clientProperty, timeoutMs: { type: "integer", minimum: 1000, maximum: 300000 }, leaseId: { type: "string" } }, required: ["name"] },
    handler: async (args: { name: string; client?: MinecraftClientName; timeoutMs?: number; leaseId?: string }) => executeOnClient({ ...args, code: readSnippet(args.name), snippet: args.name }),
};

export const mcExecutionHistoryTool = {
    name: "mc_execution_history",
    description: "Read redacted mc_execute history including code hashes, results, errors, and durations.",
    inputSchema: { type: "object" as const, properties: { client: clientProperty, limit: { type: "integer", minimum: 1, maximum: 500 } } },
    handler: async (args: { client?: MinecraftClientName; limit?: number }) => text(readHistory(args.limit, args.client)),
};

export const mcExecutionCancelTool = {
    name: "mc_execution_cancel",
    description: "Cancel pending execution by terminating the selected bridge connection; the bridge releases held input and temporary state.",
    inputSchema: { type: "object" as const, properties: { client: clientProperty, reason: { type: "string" } } },
    handler: async (args: { client?: MinecraftClientName; reason?: string }) => {
        const client = normalizeClient(args.client);
        clientSessions[client].cancelPending(args.reason);
        return text({ client, cancelled: true });
    },
};

export const mcInputTool = {
    name: "mc_input",
    description: "Press, hold, tap, or release real Minecraft key/mouse mappings in a rendered client.",
    inputSchema: { type: "object" as const, properties: { client: clientProperty, leaseId: { type: "string" }, operation: { type: "string", enum: ["set", "tap", "releaseAll"] }, key: { type: "string" }, keys: { type: "array", items: { type: "string" } }, down: { type: "boolean" }, durationTicks: { type: "integer", minimum: 1, maximum: 1200 } } },
    handler: async (args: { client?: MinecraftClientName; leaseId?: string; [key: string]: unknown }) => {
        const { client, leaseId, ...payload } = args;
        return control(client, leaseId, "input", payload);
    },
};

export const mcLookTool = {
    name: "mc_look",
    description: "Set or delta-adjust the real player's yaw and pitch.",
    inputSchema: { type: "object" as const, properties: { client: clientProperty, leaseId: { type: "string" }, operation: { type: "string", enum: ["set", "delta"] }, yaw: { type: "number" }, pitch: { type: "number" } }, required: ["yaw", "pitch"] },
    handler: async (args: { client?: MinecraftClientName; leaseId?: string; operation?: string; yaw: number; pitch: number }) => {
        const { client, leaseId, ...payload } = args;
        return control(client, leaseId, "look", payload);
    },
};

export const mcScreenStateTool = {
    name: "mc_screen_state",
    description: "Inspect the current screen revision, widgets, container slots, item names, and lore.",
    inputSchema: { type: "object" as const, properties: { client: clientProperty, leaseId: { type: "string" } } },
    handler: async (args: { client?: MinecraftClientName; leaseId?: string }) => control(args.client, args.leaseId, "screenState", {}),
};

export const mcScreenActionTool = {
    name: "mc_screen_action",
    description: "Perform a revision-safe real widget, coordinate, key, close, or inventory-slot action.",
    inputSchema: { type: "object" as const, properties: { client: clientProperty, leaseId: { type: "string" }, revision: { type: "integer" }, action: { type: "string", enum: ["clickWidget", "clickAt", "clickSlot", "keyPress", "close"] }, ref: { type: "string" }, x: { type: "number" }, y: { type: "number" }, button: { type: "integer" }, slot: { type: "integer" }, clickType: { type: "string" }, key: { type: "integer" }, scancode: { type: "integer" }, modifiers: { type: "integer" } }, required: ["action"] },
    handler: async (args: { client?: MinecraftClientName; leaseId?: string; [key: string]: unknown }) => {
        const { client, leaseId, ...payload } = args;
        return control(client, leaseId, "screenAction", payload);
    },
};

export const mcHudInspectTool = {
    name: "mc_hud_inspect",
    description: "Inspect player HUD, server/resource-pack state, title/actionbar, tab list, boss bars, and sidebar.",
    inputSchema: { type: "object" as const, properties: { client: clientProperty, leaseId: { type: "string" } } },
    handler: async (args: { client?: MinecraftClientName; leaseId?: string }) => control(args.client, args.leaseId, "hudInspect", {}),
};

export const mcEventsTool = {
    name: "mc_events",
    description: "Read the cursor-based real-client event journal without losing events between agent steps.",
    inputSchema: { type: "object" as const, properties: { client: clientProperty, leaseId: { type: "string" }, after: { type: "integer" }, limit: { type: "integer", minimum: 1, maximum: 500 } } },
    handler: async (args: { client?: MinecraftClientName; leaseId?: string; after?: number; limit?: number }) => {
        const { client, leaseId, ...payload } = args;
        return control(client, leaseId, "events", payload);
    },
};

export const mcTestControlTool = {
    name: "mc_test_control",
    description: "Send a signed, structured request from the real client to the allowlisted FumazTest-only control channel. Use for attestation, server lease, fixtures, named faults, and authoritative evidence.",
    inputSchema: {
        type: "object" as const,
        properties: {
            client: clientProperty,
            leaseId: { type: "string", description: "Local client lease." },
            operation: {
                type: "string",
                enum: ["attest", "lease.acquire", "lease.renew", "lease.release", "lease.status", "fault.arm", "fault.clear", "fault.status", "map.inspect", "fixture.restore", "evidence.runtime", "cleanup"],
            },
            args: { type: "object", additionalProperties: true },
            timeoutMs: { type: "integer", minimum: 1000, maximum: 30000 },
        },
        required: ["operation"],
    },
    handler: async (args: { client?: MinecraftClientName; leaseId?: string; operation: string; args?: Record<string, unknown>; timeoutMs?: number }) => {
        const { client, leaseId, ...payload } = args;
        return control(client, leaseId, "testControl", payload);
    },
};

export const agentRuntimeTools = [
    mcClientsTool,
    mcClientAcquireTool,
    mcClientReleaseTool,
    mcExecuteBothTool,
    mcSnippetSaveTool,
    mcSnippetRunTool,
    mcSnippetListTool,
    mcExecutionCancelTool,
    mcExecutionHistoryTool,
    mcInputTool,
    mcLookTool,
    mcScreenStateTool,
    mcScreenActionTool,
    mcHudInspectTool,
    mcEventsTool,
    mcTestControlTool,
];
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
