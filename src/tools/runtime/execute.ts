import { scriptLogger } from "./script-logger.js";
import { isEnvOn } from "../../utils/env.js";
import { randomUUID } from "node:crypto";
import { appendHistory, hashCode } from "./agent-store.js";
import { getClientSession, normalizeClient, requireLease } from "./client-registry.js";
import type { MinecraftClientName } from "./types.js";

const scriptLogsEnabled = isEnvOn('MCDEV_SCRIPT_LOGS');

export const mcExecuteTool = {
    name: "mc_execute",
    description: `Execute arbitrary GROOVY inside a real rendered Minecraft client. This is the primary agentic exploration tool: inspect internals, test hypotheses, attach temporary state, drive behavior, and iterate live. The binding is persistent per client: undeclared assignments (x = 5) survive to later calls; def x is script-local.

Native tools remain useful stable shortcuts:
- Player state (x/y/z/yaw/pitch/look/velocity/vehicle/raycast target/world): mc_snapshot
- Nearby entities or one entity's details: mc_nearby_entities / mc_entity_details
- Nearby block entities (signs, chests, etc.): mc_nearby_blocks / mc_block_details
- Open screen / inventory contents: mc_screen_inspect
- Recent chat: mc_chat_history
- Item textures: mc_get_item_texture (by slot or by id)
Reach for mc_execute when you need to explore the Java API or do something
the native tools don't cover.

Pre-bound globals: mc (Minecraft instance), player, level — plus the "java" helper.

Mojang names everywhere, on every Minecraft version: obj.foo reads a field
(JavaBean getter fallback), obj.foo(args) calls a method. Overloads resolve by
argument types; decimal literals coerce to double/float params.

Minecraft classes can't be named directly on obfuscated builds — load them via
java.type: def Vec3 = java.type('net.minecraft.world.phys.Vec3'); construct with
Vec3(1, 2, 3) or Vec3.create(1, 2, 3). (Single-quote class names: double-quoted
GStrings interpolate the $ in inner-class names.)

The "java" helper provides:
- java.type(className) - class handle for statics + construction, by Mojang name
- java.list(x) - Java collection/array -> Groovy List (use for iteration)
- java.typeName(obj) - the Mojang class name
- java.isNull(obj) - null check
- java.ref(refId) - retrieve a stored object reference ($ref_N from results)
- sync { ... } - run the closure ON THE GAME THREAD in one hop. Use it to batch
  bulk loops (hundreds of entities/slots run in milliseconds instead of one
  thread-hop per call): sync { java.list(level.entitiesForRendering()).collect { java.typeName(it) } }

Reflection helpers for exploring API:
- java.describe(obj) - full dump: class, fields, methods, supers
- java.methods(obj, [filter]) - list methods (optional name filter)
- java.fields(obj, [filter]) - list fields (optional name filter)
- java.supers(obj) - class hierarchy and interfaces
- java.find(pattern, [scope]) - search mappings for classes/methods/fields

Plain JDK classes work natively (System.currentTimeMillis(), new File(path).text = "...").
Sandbox: Runtime / ProcessBuilder / java.net.* are blocked; file I/O is allowed.
Caveat: bridge-wrapped Minecraft objects don't auto-unwrap when passed to NATIVE
Java calls like new File(wrappedFile, name) — pass strings/primitives or unwrap
with wrapped.getTarget(). Bridge-dispatched calls (anything on mc/player/level or
a java.type class) unwrap arguments automatically.

Use "return <value>" to get a value back; println/print output is captured.
Returned Minecraft objects serialize as {className, ref, toString, fields} —
resume them later with java.ref(ref).

timeoutMs: optional per-call deadline in ms (default 10000, max 300000 = 5 min).
Bump it for bulk reflection or heavy file I/O — but prefer sync{} batching or a
native tool over raising the timeout.

MIGRATING FROM THE OLD LUA SURFACE (pre-2026-06): obj:method(args) -> obj.method(args);
java.import(name) -> java.type(name); java.new(Cls, args) -> Cls(args) or
Cls.create(args); java.iter/java.array -> java.list; java.typeof -> java.typeName;
java.cast - removed (dispatch walks the runtime hierarchy, no cast needed);
io.open(...) -> new File(...); os.time() -> System.currentTimeMillis();
print(x) -> println x; pcall -> try/catch; local x -> def x;
{a = 1} tables -> [a: 1] maps and [1, 2, 3] lists.`,
    inputSchema: {
        type: "object" as const,
        properties: {
            code: {
                type: "string",
                description: "Groovy code to execute",
            },
            timeoutMs: {
                type: "integer",
                description: "Optional per-call execution deadline in milliseconds. Range 1000-300000, default 10000 (10s). Use a longer value for bulk reflection or heavy file I/O.",
                minimum: 1000,
                maximum: 300000,
            },
            client: {
                type: "string",
                enum: ["primary", "secondary"],
                description: "Real Minecraft client to execute inside. Defaults to primary.",
            },
            leaseId: {
                type: "string",
                description: "Optional explicit client lease. A Codex lease is acquired automatically when absent.",
            },
        },
        required: ["code"],
    },

    handler: async (args: { code: string; timeoutMs?: number; client?: MinecraftClientName; leaseId?: string }) => {
        return executeOnClient(args);
    }
};

export async function executeOnClient(args: {
    code: string;
    timeoutMs?: number;
    client?: MinecraftClientName;
    leaseId?: string;
    snippet?: string;
}) {
        const client = normalizeClient(args.client);
        const lease = requireLease(client, args.leaseId);
        const session = getClientSession(client);
        const startTime = Date.now();
        const executionId = randomUUID();
        try {
            // `timeoutMs` is intentionally passed to two different layers:
            //   * payload `{ code, timeoutMs }` — bounds the script's own
            //     execution inside the Minecraft JVM (the bridge mod uses
            //     this to interrupt runaway scripts).
            //   * 3rd-arg `timeoutMs` — bounds the WebSocket request from
            //     this side (BridgeSession adds a +5s grace and then a
            //     5-minute ceiling, see session.ts).
            // Both are needed: dropping the payload one would let runaway
            // scripts pin the game thread; dropping the 3rd-arg one would
            // let the wait pile up here even after the bridge gave up.
            //
            // The default is made explicit rather than left to the two sides'
            // own defaults: with no value, the bridge interrupts at its own
            // ~10s default while this side also gave up at a flat 10s — a
            // race the bridge usually lost, so callers saw "the game may be
            // frozen" instead of the script's real timeout result.
            const timeoutMs = args.timeoutMs ?? 10000;
            const resp = await session.send("execute", { code: args.code, timeoutMs }, timeoutMs);
            const duration_ms = Date.now() - startTime;

            appendHistory({
                id: executionId,
                timestamp: new Date().toISOString(),
                client,
                codeHash: hashCode(args.code),
                snippet: args.snippet,
                success: resp.success,
                durationMs: duration_ms,
                output: resp.output,
                result: resp.result,
                error: resp.error,
            });

            // Log the execution (dev mode only)
            if (scriptLogsEnabled) {
                scriptLogger.log({
                    timestamp: new Date().toISOString(),
                    success: resp.success,
                    code: args.code,
                    result: resp.result,
                    output: resp.output,
                    error: resp.error,
                    duration_ms,
                });

                // Periodically rotate logs
                if (Math.random() < 0.01) {
                    scriptLogger.rotateIfNeeded();
                }
            }

            if (!resp.success) {
                return { content: [{ type: "text" as const, text: JSON.stringify({ executionId, client, leaseId: lease.id, success: false, durationMs: duration_ms, error: resp.error }, null, 2) }], isError: true };
            }
            return { content: [{ type: "text" as const, text: JSON.stringify({
                executionId,
                client,
                leaseId: lease.id,
                success: true,
                durationMs: duration_ms,
                output: resp.output || undefined,
                result: resp.result,
            }, null, 2) }] };
        } catch (e: unknown) {
            const duration_ms = Date.now() - startTime;
            const msg = e instanceof Error ? e.message : String(e);

            appendHistory({
                id: executionId,
                timestamp: new Date().toISOString(),
                client,
                codeHash: hashCode(args.code),
                snippet: args.snippet,
                success: false,
                durationMs: duration_ms,
                error: msg,
            });

            // Log connection/timeout errors too (dev mode only)
            if (scriptLogsEnabled) {
                scriptLogger.log({
                    timestamp: new Date().toISOString(),
                    success: false,
                    code: args.code,
                    error: msg,
                    duration_ms,
                });
            }

            return { content: [{ type: "text" as const, text: JSON.stringify({ executionId, client, leaseId: lease.id, success: false, durationMs: duration_ms, error: msg }, null, 2) }], isError: true };
        }
}
