#!/usr/bin/env node
// Phase 0 Channels test — a minimal one-and-a-half-way Claude Code channel.
// Claude Code spawns this over stdio (via .mcp.json). It declares the
// claude/channel capability, exposes a `cc_ack` reply tool, and listens on a
// local HTTP port. POSTing to that port injects the body into the running
// Claude session as a <channel> event; when Claude calls cc_ack we append the
// token to an ack log. Writing to the ack log proves the notification landed
// AND the reply path works — i.e. that bug #71792 is not blocking us.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import http from 'node:http'
import { appendFileSync } from 'node:fs'

const SCRATCH =
  '/private/tmp/claude-501/-Users-avanrossum-Developer-claude-command-center/4d3cc1a9-2dc3-46d4-a3f3-3e6f0c5e9c7d/scratchpad'
const LOG = process.env.CCC_CHANNEL_LOG || `${SCRATCH}/ccc-channel.log`
const ACK = process.env.CCC_ACK_LOG || `${SCRATCH}/ccc-ack.log`
const PORT = Number(process.env.CCC_CHANNEL_PORT || 8799)

const log = (m) => {
  try {
    appendFileSync(LOG, `[${new Date().toISOString()}] ${m}\n`)
  } catch {
    /* ignore */
  }
}

log(`starting cc-channel, pid=${process.pid}, port=${PORT}`)

const mcp = new Server(
  { name: 'ccc', version: '0.0.1' },
  {
    capabilities: {
      experimental: { 'claude/channel': {} },
      tools: {},
    },
    instructions:
      'Messages arrive as <channel source="ccc" ...>. This is a connectivity test. ' +
      'When a channel message asks you to acknowledge with a token, immediately call the ' +
      'cc_ack tool with that exact token, then reply in one short line.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'cc_ack',
      description:
        'Acknowledge receipt of a channel message by echoing its token. Call this when a channel message asks you to ack.',
      inputSchema: {
        type: 'object',
        properties: {
          token: { type: 'string', description: 'The token from the channel message' },
        },
        required: ['token'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === 'cc_ack') {
    const token = String(req.params.arguments?.token ?? '')
    appendFileSync(ACK, `ACK ${token} ${new Date().toISOString()}\n`)
    log(`cc_ack called token=${token}`)
    return { content: [{ type: 'text', text: `ack recorded for ${token}` }] }
  }
  throw new Error(`unknown tool: ${req.params.name}`)
})

await mcp.connect(new StdioServerTransport())
log('mcp connected over stdio')

http
  .createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.end('ok')
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      log(`inbound POST (${body.length} bytes): ${body.slice(0, 120)}`)
      try {
        await mcp.notification({
          method: 'notifications/claude/channel',
          params: { content: body, meta: { test: 'phase0' } },
        })
        log('notification written to transport')
        res.end('ok')
      } catch (e) {
        log(`notification error: ${e}`)
        res.statusCode = 500
        res.end('err')
      }
    })
  })
  .listen(PORT, '127.0.0.1', () => log(`http listening on 127.0.0.1:${PORT}`))
