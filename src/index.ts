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
  createCustomer,
  getCustomerById,
  getProducts,
  getProductById,
  createProduct,
  getOrders,
  getOrderById,
  createOrder,
  changeDeliveryAddress,
  verifyDeliveryAddress,
  getOrderOutstandingAmount,
  getNextPaymentInfo,
  getHeadStartPlanStatus,
  skipNextPayment,
  getPaymentMethod
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
        name: 'get_customers',
        description: 'Retrieve all customers.',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'create_customer',
        description: 'Create a new customer.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            // ...add other customer fields as needed
          },
          required: ['name']
        }
      },
      {
        name: 'get_products',
        description: 'Retrieve all products.',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'create_product',
        description: 'Create a new product.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            // ...add other product fields as needed
          },
          required: ['name']
        }
      },
      {
        name: 'get_orders',
        description: 'Retrieve all orders.',
        inputSchema: { type: 'object', properties: {}, required: [] }
      },
      {
        name: 'create_order',
        description: 'Create a new order.',
        inputSchema: {
          type: 'object',
          properties: {
            // ...add order fields as needed
          },
          required: []
        }
      },
      {
        name: 'change_delivery_address',
        description: 'Change the delivery address for an order.',
        inputSchema: {
          type: 'object',
          properties: {
            order_id: { type: 'string' },
            new_address: { type: 'string' }
          },
          required: ['order_id', 'new_address']
        }
      },
      {
        name: 'verify_delivery_address',
        description: 'Verify the postal or delivery address for an order.',
        inputSchema: {
          type: 'object',
          properties: {
            order_id: { type: 'string' }
          },
          required: ['order_id']
        }
      },
      {
        name: 'get_order_outstanding_amount',
        description: 'Get the outstanding amount or amount paid for an order.',
        inputSchema: {
          type: 'object',
          properties: {
            order_id: { type: 'string' }
          },
          required: ['order_id']
        }
      },
      {
        name: 'get_next_payment_info',
        description: 'Get the next payment date and payment frequency for an order.',
        inputSchema: {
          type: 'object',
          properties: {
            order_id: { type: 'string' }
          },
          required: ['order_id']
        }
      },
      {
        name: 'get_headstart_plan_status',
        description: 'Get the paid amount and projected value of the HeadStart plan.',
        inputSchema: {
          type: 'object',
          properties: {
            customer_id: { type: 'string' }
          },
          required: ['customer_id']
        }
      },
      {
        name: 'skip_next_payment',
        description: 'Skip the next payment and see the new payment schedule.',
        inputSchema: {
          type: 'object',
          properties: {
            order_id: { type: 'string' }
          },
          required: ['order_id']
        }
      },
      {
        name: 'get_payment_method',
        description: 'Check how an order is being paid and get account details.',
        inputSchema: {
          type: 'object',
          properties: {
            order_id: { type: 'string' }
          },
          required: ['order_id']
        }
      },
      // ...add more tools for your API as needed
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
        case 'get_customers':
          return { content: [{ type: 'text', text: JSON.stringify(await getCustomers(), null, 2) }] };
        
        case 'create_customer':
          return { content: [{ type: 'text', text: JSON.stringify(await createCustomer(args), null, 2) }] };
        case 'get_products':
          return { content: [{ type: 'text', text: JSON.stringify(await getProducts(), null, 2) }] };
        case 'create_product':
          return { content: [{ type: 'text', text: JSON.stringify(await createProduct(args), null, 2) }] };
        case 'get_orders':
          return { content: [{ type: 'text', text: JSON.stringify(await getOrders(), null, 2) }] };
        case 'create_order':
          return { content: [{ type: 'text', text: JSON.stringify(await createOrder(args), null, 2) }] };
        case 'change_delivery_address':
          return { content: [{ type: 'text', text: JSON.stringify(await changeDeliveryAddress(args.order_id, args.new_address), null, 2) }] };
        case 'verify_delivery_address':
          return { content: [{ type: 'text', text: JSON.stringify(await verifyDeliveryAddress(args.order_id), null, 2) }] };
        case 'get_order_outstanding_amount':
          return { content: [{ type: 'text', text: JSON.stringify(await getOrderOutstandingAmount(args.order_id), null, 2) }] };
        case 'get_next_payment_info':
          return { content: [{ type: 'text', text: JSON.stringify(await getNextPaymentInfo(args.order_id), null, 2) }] };
        case 'get_headstart_plan_status':
          return { content: [{ type: 'text', text: JSON.stringify(await getHeadStartPlanStatus(args.customer_id), null, 2) }] };
        case 'skip_next_payment':
          return { content: [{ type: 'text', text: JSON.stringify(await skipNextPayment(args.order_id), null, 2) }] };
        case 'get_payment_method':
          return { content: [{ type: 'text', text: JSON.stringify(await getPaymentMethod(args.order_id), null, 2) }] };
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

// MCP endpoint with stateless transport (no session management)
app.post('/mcp', async (req, res) => {
  const timestamp = new Date().toISOString();
  const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  console.log(`\n=== [${timestamp}] MCP REQUEST START [${requestId}] ===`);
  console.log(`Method: ${req.method}`);
  console.log(`URL: ${req.url}`);
  console.log(`Headers:`, JSON.stringify(req.headers, null, 2));
  console.log(`Body:`, JSON.stringify(req.body, null, 2));
  req.setTimeout(25000);
  res.setTimeout(25000);
  console.log(`🚀 [${requestId}] Handling stateless MCP request`);
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
  console.log(`=== [${new Date().toISOString()}] MCP REQUEST END [${requestId}] ===\n`);
});
   

// MCP endpoint with stateless transport (no session management)
app.post('/mcp', async (req, res) => {
  const timestamp = new Date().toISOString();
  const requestId = `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  console.log(`\n=== [${timestamp}] MCP REQUEST START [${requestId}] ===`);
  console.log(`Method: ${req.method}`);
  console.log(`URL: ${req.url}`);
  console.log(`Headers:`, JSON.stringify(req.headers, null, 2));
  console.log(`Body:`, JSON.stringify(req.body, null, 2));
  req.setTimeout(25000);
  res.setTimeout(25000);
  console.log(`🚀 [${requestId}] Handling stateless MCP request`);
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
  console.log(`=== [${new Date().toISOString()}] MCP REQUEST END [${requestId}] ===\n`);
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



