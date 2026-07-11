import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureDir, getHomeDir } from "../../utils/paths.js";
import type { MinecraftClientName } from "./types.js";

const snippetsDir = path.join(getHomeDir(), "snippets");
const historyFile = path.join(getHomeDir(), "executions", "history.jsonl");
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]{0,79}$/;

export interface ExecutionHistoryEntry {
    id: string;
    timestamp: string;
    client: MinecraftClientName;
    codeHash: string;
    snippet?: string;
    success: boolean;
    durationMs: number;
    output?: string;
    result?: unknown;
    error?: string;
}

export function saveSnippet(name: string, code: string): string {
    if (!SAFE_NAME.test(name)) throw new Error("Snippet name must match [a-z0-9][a-z0-9._-]{0,79}");
    ensureDir(snippetsDir);
    const file = path.join(snippetsDir, `${name}.groovy`);
    fs.writeFileSync(file, code, { mode: 0o600 });
    return file;
}

export function readSnippet(name: string): string {
    if (!SAFE_NAME.test(name)) throw new Error("Invalid snippet name");
    return fs.readFileSync(path.join(snippetsDir, `${name}.groovy`), "utf8");
}

export function listSnippets() {
    ensureDir(snippetsDir);
    return fs.readdirSync(snippetsDir)
        .filter(name => name.endsWith(".groovy"))
        .map(file => {
            const full = path.join(snippetsDir, file);
            const code = fs.readFileSync(full, "utf8");
            return { name: file.slice(0, -7), bytes: Buffer.byteLength(code), codeHash: hashCode(code) };
        });
}

export function hashCode(code: string): string {
    return createHash("sha256").update(code).digest("hex");
}

export function appendHistory(entry: ExecutionHistoryEntry): void {
    ensureDir(path.dirname(historyFile));
    const safe = { ...entry, output: redact(entry.output), error: redact(entry.error), result: redactValue(entry.result) };
    fs.appendFileSync(historyFile, JSON.stringify(safe) + "\n", { mode: 0o600 });
}

export function readHistory(limit = 50, client?: MinecraftClientName): ExecutionHistoryEntry[] {
    if (!fs.existsSync(historyFile)) return [];
    return fs.readFileSync(historyFile, "utf8").trim().split("\n").filter(Boolean)
        .map(line => JSON.parse(line) as ExecutionHistoryEntry)
        .filter(entry => !client || entry.client === client)
        .slice(-Math.max(1, Math.min(limit, 500)))
        .reverse();
}

function redact(value?: string): string | undefined {
    if (!value) return value;
    return value
        .replace(/(access|refresh|auth|bearer|token|secret|password)(["'\s:=]+)[^\s,"'}]+/gi, "$1$2[REDACTED]")
        .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]");
}

function redactValue(value: unknown): unknown {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
            key,
            /(token|secret|password|authorization)/i.test(key) ? "[REDACTED]" : redactValue(item),
        ]));
    }
    return value;
}
