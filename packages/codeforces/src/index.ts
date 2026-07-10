#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCodeforcesMcpServer } from "./server.js";

const server = createCodeforcesMcpServer();
await server.connect(new StdioServerTransport());
