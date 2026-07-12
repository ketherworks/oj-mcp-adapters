#!/usr/bin/env node
import { createNodeHttpServer } from "./bridge.js";
import { createHostedWorker, parseHostConfig } from "./config.js";

const config = parseHostConfig(process.argv.slice(2), process.env);
const server = createNodeHttpServer({
  worker: createHostedWorker(config.provider),
  env: config.workerEnv,
  ...(config.internalKey ? { internalKey: config.internalKey } : {})
});

server.listen(config.port, config.host, () => {
  process.stdout.write(`${config.provider} OJ MCP listening on ${config.host}:${config.port}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close((error) => {
      if (error) {
        process.stderr.write(`OJ MCP HTTP host shutdown failed: ${error.message}\n`);
        process.exitCode = 1;
      }
    });
  });
}
