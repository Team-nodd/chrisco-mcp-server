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
  createProduct,
  getOrders,
  createOrder,
  changeDeliveryAddress,
  verifyDeliveryAddress,
  getOrderOutstandingAmount,
  getNextPaymentInfo,
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
        name: 'get_customer',
        description: 'Retrieves a specific customer’s information using an exact match of first name, last name, email, and phone number. Once a customer is successfully identified, immediately fetch their associated orders using the "get_orders_for_a_customer" tool. This step is mandatory and ensures Jesse always has full order context when assisting the user.',
        inputSchema: {
          type: 'object',
          properties: {
            first_name: { type: 'string' },
            last_name: { type: 'string' },
            email: { type: 'string' },
            phone: { type: 'string' },
          },
          required: ['first_name', 'last_name', 'email', 'phone']
        }
      },
      {
        name: 'update_customer',
        description: 'Update specific details of an existing customer. This tool should only be used after identity verification, and only for fields that the customer has explicitly asked to change (e.g. contact details, address, or preferences).',
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
        description: 'Fetches up to 20 of the most recent orders associated with a customer, if available. This tool returns key order details including order ID, product list, outstanding amount, next payment info, payment method, and status. It should be used in every conversation after verifying the customer’s identity to ensure you have full context when assisting.',
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
      // {
      //   name: 'create_order',
      //   description: `Create a new order. Required fields: customer_id (existing customer), product_id (selected product), item_description, quantity, total_amount, amount_paid, payment_method_id (selected payment method).\n\nAuto-generated: payment_id is created automatically.\n\nThe delivery_address is constructed from the customer's address details (street, suburb, state, postcode).`,
      //   inputSchema: {
      //     type: 'object',
      //     properties: {
      //       customer_id: { type: 'string', description: 'Reference to an existing customer' },
      //       product_id: { type: 'string', description: 'Reference to the selected product' },
      //       item_description: { type: 'string' },
      //       quantity: { type: 'number' },
      //       total_amount: { type: 'number' },
      //       amount_paid: { type: 'number' },
      //       payment_method_id: { type: 'string', description: 'Reference to the selected payment method' }
      //     },
      //     required: ['customer_id', 'product_id', 'item_description', 'quantity', 'total_amount', 'amount_paid', 'payment_method_id']
      //   }
      // },
      // {
      //   name: 'create_payment_method',
      //   description: 'Create a new payment method. Required fields: method_type (e.g., Credit Card, Debit Card, etc.), masked_card_number (last four digits only, e.g., "**** **** **** 1234").',
      //   inputSchema: {
      //     type: 'object',
      //     properties: {
      //       method_type: { type: 'string', description: 'e.g., Credit Card, Debit Card, etc.' },
      //       masked_card_number: { type: 'string', description: 'Last four digits only, e.g., "**** **** **** 1234"' }
      //     },
      //     required: ['method_type', 'masked_card_number']
      //   }
      // },
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
      // {
      //   name: 'get_order_outstanding_amount',
      //   description: 'Get the outstanding amount or amount paid for an order.',
      //   inputSchema: {
      //     type: 'object',
      //     properties: {
      //       order_id: { type: 'string' }
      //     },
      //     required: ['order_id']
      //   }
      // },
      // {
      //   name: 'get_next_payment_info',
      //   description: 'Get the next payment date and payment frequency for an order.',
      //   inputSchema: {
      //     type: 'object',
      //     properties: {
      //       order_id: { type: 'string' }
      //     },
      //     required: ['order_id']
      //   }
      // },
      // {
      //   name: 'skip_next_payment',
      //   description: 'Skip the next payment and see the new payment schedule.',
      //   inputSchema: {
      //     type: 'object',
      //     properties: {
      //       order_id: { type: 'string' }
      //     },
      //     required: ['order_id']
      //   }
      // },
      // {
      //   name: 'get_payment_method',
      //   description: 'Check how an order is being paid and get account details.',
      //   inputSchema: {
      //     type: 'object',
      //     properties: {
      //       order_id: { type: 'string' }
      //     },
      //     required: ['order_id']
      //   }
      // },
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
          return { content: [{ type: 'text', text: JSON.stringify(await getCustomerById(args), null, 2) }] };
        // case 'get_products':
        //   return { content: [{ type: 'text', text: JSON.stringify(await getProducts(args), null, 2) }] };
        // case 'create_product':
        //   return { content: [{ type: 'text', text: JSON.stringify(await createProduct(args), null, 2) }] };
        case 'get_orders_for_a_customer':
          return { content: [{ type: 'text', text: JSON.stringify(await getOrders(args), null, 2) }] };
        case 'create_order':
          // return { content: [{ type: 'text', text: JSON.stringify(await createOrder(args), null, 2) }] };
        case 'change_delivery_address':
          return { content: [{ type: 'text', text: JSON.stringify(await changeDeliveryAddress(args.order_id, args.new_address), null, 2) }] };
        case 'verify_delivery_address':
          return { content: [{ type: 'text', text: JSON.stringify(await verifyDeliveryAddress(args.order_id), null, 2) }] };
        case 'get_order_outstanding_amount':
          return { content: [{ type: 'text', text: JSON.stringify(await getOrderOutstandingAmount(args.order_id), null, 2) }] };
        case 'get_next_payment_info':
          return { content: [{ type: 'text', text: JSON.stringify(await getNextPaymentInfo(args.order_id), null, 2) }] };
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



