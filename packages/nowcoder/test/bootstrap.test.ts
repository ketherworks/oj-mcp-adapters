import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, test } from "vitest";
import { createNowCoderMcpServerFromEnvironment } from "../src/bootstrap.js";

describe("NowCoder stdio bootstrap", () => {
  test("injects the dedicated session environment value into the MCP provider", async () => {
    const server = createNowCoderMcpServerFromEnvironment({
      environment: { NOWCODER_SESSION_COOKIE: "NOWCODER_SESSION=bootstrap-secret" },
      clientOptions: {
        requester: async (_url, context) => {
          expect(context.sessionCookie).toBe("NOWCODER_SESSION=bootstrap-secret");
          return {
            status: 200,
            body: '<script>window.isLogin = true; window.globalInfo = { ownerId: "123456789" };</script>',
            headers: { "content-type": "text/html" }
          };
        }
      },
      nowIso: () => "2026-07-14T11:05:00.000Z"
    });
    const client = new Client({ name: "bootstrap-test", version: "0.1.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({ name: "nowcoder_auth_status", arguments: {} });

    expect(result).toMatchObject({
      structuredContent: { configured: true, state: "authenticated" }
    });
    await client.close();
    await server.close();
  });
});
