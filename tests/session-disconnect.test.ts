import { afterEach, describe, expect, it } from "@jest/globals";
import { WebSocketServer } from "ws";
import { BridgeSession } from "../src/tools/runtime/session.js";

describe("BridgeSession.disconnect", () => {
    let server: WebSocketServer | undefined;
    let session: BridgeSession | undefined;

    afterEach(async () => {
        session?.disconnect();
        await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
    });

    it("rejects an in-flight request instead of orphaning its promise", async () => {
        server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
        await new Promise<void>((resolve) => server!.once("listening", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("missing test port");

        server.on("connection", (socket) => socket.on("message", (raw) => {
            const request = JSON.parse(raw.toString()) as { id: string; type: string };
            if (request.type === "status") {
                socket.send(JSON.stringify({ id: request.id, success: true, result: {} }));
            }
        }));

        session = new BridgeSession(address.port, "", false);
        await session.connect();
        const pending = session.send("execute", { code: "while (true) {}" }, 60_000);
        session.disconnect();

        await expect(pending).rejects.toThrow("disconnected");
    });
});
