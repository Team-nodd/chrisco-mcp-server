#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  InitializeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import cors from 'cors';
import {
  getCustomers,
  getOrders,
  changeDeliveryAddress,
  updateCustomerByID,
  skipNextPayment,
  InfoSkippingNextPayment
} from './supabaseAPI.js';

const app = express();
const PORT = process.env.PORT || 8080;

// Improve connection handling
app.use((req, res, next) => {
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Keep-Alive', 'timeout=30, max=100');
  next();
});

// Enable CORS and JSON parsing
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id'],
}));
app.use(express.json());

// Create the MCP server
const server = new Server(
  {
    name: 'supabase-mcp-server',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {
        listChanged: false
      }
    },
  }
);

// INITIALIZATION - Handle MCP initialization
server.setRequestHandler(InitializeRequestSchema, async (request) => {
  console.log('Initialize request received:', JSON.stringify(request));
  return {
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: {
        listChanged: false
      }
    },
    serverInfo: {
      name: 'supabase-mcp-server',
      version: '1.0.0'
    }
  };
});

// TOOLS - Supabase integration functions
server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.log('Tools/list request - sending Supabase tool definitions');
  return {
    tools: [
      {
        name: 'get_customer',
        description: 'Find a customer using name, member number, and DOB (YYYY-MM-DD). Convert DOB if needed. Once matched, follow up with get_orders_for_a_customer.',
        inputSchema: {
          type: 'object',
          properties: {
            member_number: { type: 'string' },
            full_name: { type: 'string' },
            date_of_birth: { type: 'string' }
          },
          required: ['first_name', 'last_name', 'member_number', 'date_of_birth']
        }
      },
      {
        name: 'update_customer',
        description: 'Update verified customer details (e.g. address, phone, email). Name changes require both first and last names.',
        inputSchema: {
          type: 'object',
          properties: {
            customer_id: { type: 'string' },
            street_address: { type: 'string' },
            suburb: { type: 'string' },
            state: { type: 'string' },
            postcode: { type: 'string' },
            phone: { type: 'string' },
            email: { type: 'string' },
            correspondence_preference: { type: 'string' },
            postal_address: { type: 'string' }
          },
          required: ['customer_id']
        }
      },
      {
        name: 'get_orders_for_a_customer',
        description: 'Get up to 20 recent orders after verifying the customer. Includes status, payment info, and remaining balance.',
        inputSchema: {
          type: 'object',
          properties: {
            customer_id: { type: 'string' },
            status: { type: 'string' },
            limit: { type: 'number' }
          },
          required: ['customer_id']
        }
      },
      {
        name: 'update_order',
        description: 'Update delivery address for an existing order. Use order_id from prior data (do not ask customer).',
        inputSchema: {
          type: 'object',
          properties: {
            order_id: { type: 'string' },
            delivery_address: { type: 'string' },
            status: { type: 'string' }
          },
          required: ['order_id', 'delivery_address']
        }
      },
      {
        name: 'skip_next_payment',
        description: 'Skip the next scheduled payment. Shifts the date forward based on payment frequency.',
        inputSchema: {
          type: 'object',
          properties: {
            order_id: { type: 'string' }
          },
          required: ['order_id']
        }
      },
      {
        name: 'get_info_for_skipping_next_payment',
        description: 'Returns 2 options for skipping payments: (1) spread amount over future payments, (2) add to next payment.',
        inputSchema: {
          type: 'object',
          properties: {
            payment_schedule_id: { type: 'number' },
            paymentsToSkip: { type: 'number' },
            totalOwed: { type: 'number' }
          },
          required: ['payment_schedule_id', 'paymentsToSkip', 'totalOwed']
        }
      }
    ]
  };
});


server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const executeWithTimeout = async (operation: () => Promise<any>, timeoutMs = 30000) => {
    return Promise.race([
      operation(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Operation timed out after 30 seconds')), timeoutMs)
      )
    ]);
  };

  try {
    console.log(`MCP Tool called: ${name}`, JSON.stringify(args));
    const result = await executeWithTimeout(async () => {
      switch (name) {
        case 'get_customer':
          return { content: [{ type: 'text', text: JSON.stringify(await getCustomers(args), null, 2) }] };
        case 'update_customer':
          return { content: [{ type: 'text', text: JSON.stringify(await updateCustomerByID(args as { customer_id: string; [key: string]: any }), null, 2) }] };
        case 'get_orders_for_a_customer':
          return { content: [{ type: 'text', text: JSON.stringify(await getOrders(args), null, 2) }] };
        case 'update_order':
          return { content: [{ type: 'text', text: JSON.stringify(await changeDeliveryAddress(args.order_id, args.delivery_address), null, 2) }] };
        case 'skip_next_payment':
          return { content: [{ type: 'text', text: JSON.stringify(await skipNextPayment(args.order_id), null, 2) }] };
        case 'get_info_for_skipping_next_payment':
          return { content: [{ type: 'text', text: JSON.stringify(await InfoSkippingNextPayment(args), null, 2) }] };
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    });
    console.log(`Tool result:`, JSON.stringify(result, null, 2));
    return result;  
  } catch (error) {
    console.error(`Error in tool call: ${name}`, error);
    return {
      content: [
        {
          type: 'text',   
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }
      ],
      isError: true
    };
  }
});

// MCP endpoint with stateless transport
app.post('/mcp', async (req, res) => {
  const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  console.log(`🚀 [${requestId}] Handling MCP request`);
  
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    console.log(`✨ [${requestId}] Request completed successfully`);
  } catch (error) {
    console.error(`❌ [${requestId}] Error handling request:`, error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Request handling failed', data: error.message },
        id: null
      });
    }
  }
});

// Add a GET handler for /mcp to avoid 404s on GET requests
app.get('/mcp', (req, res) => {
  res.status(200).json({
    message: 'MCP endpoint is alive. Please use POST requests to interact with this endpoint.'
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Supabase MCP Server running on port ${PORT}`);
  console.log(`📡 MCP endpoint: http://localhost:${PORT}/mcp`);
  console.log(`❤️ Health check: http://localhost:${PORT}/health`);
});



