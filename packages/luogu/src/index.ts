#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLuoguMcpServer } from "./server.js";

const server = createLuoguMcpServer();
await server.connect(new StdioServerTransport());
