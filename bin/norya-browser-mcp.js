#!/usr/bin/env node
'use strict';

/**
 * norya-browser-mcp.js
 *
 * MCP stdio server for Norya browser.
 * Claude Code spawns this process; it reads/writes MCP messages on stdio
 * and proxies tool calls over JSON-RPC to the per-profile Unix socket.
 *
 * Required env vars:
 *   NORYA_BROWSER_MCP_SOCKET  — path to the Unix socket started by MCPServer
 *   NORYA_PROFILE_ID          — the active profile ID (informational)
 */

const net = require('net');
const readline = require('readline');

const SOCK = process.env.NORYA_BROWSER_MCP_SOCKET;
const PROFILE = process.env.NORYA_PROFILE_ID; // eslint-disable-line no-unused-vars

// Sem socket = fora de um pane do Norya. NÃO morre (2026-07-14): este bridge é
// registrado user-scope no Claude Code, então ele também sobe em sessões fora
// do Norya — aí responde o handshake com ZERO tools e fica idle. Invisível
// fora, funcional dentro. exit(1) aqui viraria erro de MCP em toda sessão.
const INSIDE_NORYA = !!SOCK;

// ---------------------------------------------------------------------------
// Tool definitions (MCP schema)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'browser_open',
    description: 'Open a URL in the profile browser. Optionally in new tab; Tor auto-decided unless overridden.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        new_tab: { type: 'boolean' },
        tor: { type: ['boolean', 'string'] },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_list_tabs',
    description: 'List all open tabs in the profile browser.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_close_tab',
    description: 'Close a tab by ID.',
    inputSchema: {
      type: 'object',
      properties: { tab_id: { type: 'string' } },
      required: ['tab_id'],
    },
  },
  {
    name: 'browser_finish',
    description: 'Call this when you are DONE with the browser: closes every tab you opened (the user\'s own tabs stay). Each open tab is a live renderer process burning CPU/RAM, so finish instead of leaving them behind. Idle agent tabs are also swept automatically after 10 minutes.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'browser_screenshot',
    description: 'Capture screenshot. Returns path to PNG/JPEG in /tmp.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        full_page: { type: 'boolean' },
        format: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_get_dom',
    description: 'Get outerHTML of selector (or full document if no selector).',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        selector: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_get_text',
    description: 'Get textContent of selector.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        selector: { type: 'string' },
      },
    },
  },
  {
    name: 'browser_click',
    description: 'Click element matching selector.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        selector: { type: 'string' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into element. Optionally submit form.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        submit: { type: 'boolean' },
      },
      required: ['selector', 'text'],
    },
  },
  {
    name: 'browser_evaluate',
    description: 'Evaluate JS in page context. Returns serialized result.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        js: { type: 'string' },
      },
      required: ['js'],
    },
  },
  {
    name: 'browser_wait_for',
    description: 'Wait for element matching selector. Default timeout 10s.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        selector: { type: 'string' },
        timeout_ms: { type: 'integer' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'browser_console_logs',
    description: 'Read console logs captured for tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        since_ts: { type: 'integer' },
      },
    },
  },
  {
    name: 'browser_network_log',
    description: 'Read network requests captured for tab.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        since_ts: { type: 'integer' },
      },
    },
  },
  {
    name: 'browser_navigate',
    description: 'Browser navigation: back, forward, or reload.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        action: { type: 'string', enum: ['back', 'forward', 'reload'] },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_set_viewport',
    description: 'Resize viewport / emulate mobile.',
    inputSchema: {
      type: 'object',
      properties: {
        tab_id: { type: 'string' },
        w: { type: 'integer' },
        h: { type: 'integer' },
        dpr: { type: 'number' },
        mobile: { type: 'boolean' },
      },
      required: ['w', 'h'],
    },
  },
];

// ---------------------------------------------------------------------------
// Backend socket communication
// ---------------------------------------------------------------------------

/**
 * Send a JSON-RPC call to the MCPServer Unix socket and resolve with result.
 * A fresh connection is used per call (simple, stateless).
 * @param {string} method
 * @param {object} params
 * @returns {Promise<any>}
 */
function callBackend(method, params) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(SOCK, () => {
      client.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || {} }) + '\n');
      // Half-close so the server's 'end' event fires; server will close fully after response.
      client.end();
    });

    let buf = '';
    client.on('data', (d) => { buf += d; });
    client.on('end', () => {
      try {
        const lines = buf.split('\n').filter(Boolean);
        const last = JSON.parse(lines[lines.length - 1]);
        if (last.error) reject(new Error(last.error.message));
        else resolve(last.result);
      } catch (e) {
        reject(new Error('Failed to parse backend response: ' + e.message));
      }
    });
    client.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// MCP protocol handlers
// ---------------------------------------------------------------------------

const handlers = {
  initialize: (_params) => ({
    protocolVersion: '2024-11-05',
    serverInfo: { name: 'norya-browser', version: '1.0.0' },
    capabilities: { tools: {} },
  }),

  'tools/list': () => ({ tools: INSIDE_NORYA ? TOOLS : [] }),

  'tools/call': async (params) => {
    if (!INSIDE_NORYA) {
      throw new Error('norya-browser: fora de um pane do Norya (NORYA_BROWSER_MCP_SOCKET ausente)');
    }
    const result = await callBackend(params.name, params.arguments);
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  },
};

// ---------------------------------------------------------------------------
// Stdio message loop
// ---------------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', async (line) => {
  if (!line.trim()) return;

  let msg;
  try {
    msg = JSON.parse(line);
  } catch (_) {
    // Malformed JSON — can't reply without an id; silently drop.
    return;
  }

  const handler = handlers[msg.method];
  if (!handler) {
    if (msg.id != null) {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }) + '\n'
      );
    }
    return;
  }

  try {
    const result = await handler(msg.params);
    if (msg.id != null) {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
    }
  } catch (e) {
    if (msg.id != null) {
      process.stdout.write(
        JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: e.message } }) + '\n'
      );
    }
  }
});

// Keep the process alive until stdin closes.
rl.on('close', () => process.exit(0));
