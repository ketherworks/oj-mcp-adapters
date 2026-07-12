#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAtCoderMcpServer } from "./server.js";

const server = createAtCoderMcpServer({ transport: "local_stdio" });
await server.connect(new StdioServerTransport());
