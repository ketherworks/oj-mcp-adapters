#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createNowCoderMcpServer } from "./server.js";

const server = createNowCoderMcpServer();
await server.connect(new StdioServerTransport());
