import { fileURLToPath } from "node:url";

export default {
  resolve: {
    alias: {
      "@kaiserunix/oj-mcp-contracts": fileURLToPath(new URL("../contracts/src/index.ts", import.meta.url)),
      "@kaiserunix/oj-mcp-server-common": fileURLToPath(new URL("../server-common/src/index.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
};
