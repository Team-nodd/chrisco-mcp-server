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
  skipNextPayment
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
        description: 'Use this tool to identify a customer by matching their first name, last name, email, and phone number. Once the customer is found, their key details will be returned — including their contact info, address, member number, and total outstanding balance across all orders. After successfully identifying the customer, immediately follow up by calling the "get_orders_for_a_customer" tool to get full order context. This step ensures you can answer any account or payment-related questions with accuracy and clarity.',
        inputSchema: {
          type: 'object',
          properties: {
            first_name: { type: 'string' },
            last_name: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string' }
          },
          required: ['first_name', 'last_name', 'email', 'phone']
        }
      },
      {
        name: 'update_customer',
        description: 'Update specific details of an existing customer. This tool should only be used after the customer’s identity has been verified, and only for fields they’ve explicitly asked to change—such as contact details, address, or preferences. If the customer requests a name change, both first_name and last_name must be provided accurately.',
        inputSchema: {
          type: 'object',
          properties: {
            customer_id: { type: 'string', description: 'Unique ID of the customer to update' },
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
      
      // {
      //   name: 'get_products',
      //   description: 'Retrieve products with advanced filtering (name, description, stock_quantity_less, stock_quantity_greater) and pagination (limit, offset).',
      //   inputSchema: {
      //     type: 'object',
      //     properties: {
      //       name: { type: 'string' },
      //       description: { type: 'string' },
      //       stock_quantity_less: { type: 'number' },
      //       stock_quantity_greater: { type: 'number' },
      //       limit: { type: 'number' },
      //       offset: { type: 'number' }
      //     },
      //     required: []
      //   }
      // },
      // {
      //   name: 'create_product',
      //   description: 'Create a new product.',
      //   inputSchema: {
      //     type: 'object',
      //     properties: {
      //       name: { type: 'string' },
      //       description: { type: 'string' },
      //       price: { type: 'number' }, 
      //       sku: { type: 'string' },
      //       stock_quantity: { type: 'number' },
      //       is_active: { type: 'boolean' }, 
      //     },
      //     required: ['name', 'description', 'price', 'sku', 'stock_quantity']
      //   }
      // },
      {
        name: 'get_orders_for_a_customer',
        description: 'Use this tool to look up a customer’s recent orders — up to 20 if available. It helps you understand what they’ve ordered, how much is still outstanding, what’s been paid, the next payment date, how they’re paying, and the current status of each order. This should be used once you’ve confirmed who you’re speaking with, so you can support them with full confidence and context. If the customer asks what happens when a payment is skipped, let them know the schedule will simply extend by the length of their payment frequency (e.g., one week for weekly payments). If they ask to skip their next payment, use the "skip_next_payment" tool to process that change.',
        inputSchema: {
          type: 'object',
          properties: {
            customer_id: { type: 'string', description: 'Unique identifier for the customer' },
            status: { type: 'string', description: 'Filter by order status (e.g., active, cancelled, completed)' },
            limit: { type: 'number', description: 'Maximum number of orders to return (default: 20)' }
          },
          required: ['customer_id']
        }
      },
      {
        name: 'update_order',
        description: 'Use this tool to update the delivery address for an existing order after the customer asks to change where their order should be sent. This only updates the delivery address — no other parts of the order will be changed. Make sure the order ID is correct and the new address is complete before proceeding. you should not ask the order ID directly from the customer instead pass it from the data you got before',
        inputSchema: {
          type: 'object',
          properties: {
            order_id: { type: 'string' },
            delivery_address: { type: 'string' }
          },
          required: ['order_id', 'delivery_address']
        }
      },
      {
        name: 'skip_next_payment',
        description: 'Use this tool to skip the upcoming payment for an order. It automatically adjusts the schedule by shifting the next payment date forward based on the payment frequency (e.g., by one week for weekly plans). This is helpful when a customer requests to pause their payment without cancelling their order.',
        inputSchema: {
          type: 'object',
          properties: {
            order_id: { type: 'string' }
          },
          required: ['order_id']
        }
      }
      
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



