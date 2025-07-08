import express from 'express';
import cors from 'cors';
import { getCustomers, createCustomer, getCustomerById } from './supabaseAPI.js';
import { getProducts, getProductById, createProduct } from './supabaseAPI.js';
import { getOrders, getOrderById, createOrder } from './supabaseAPI.js';


const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// --- Customer Management ---
app.get('/customers', async (req, res) => {
  try {
    const customers = await getCustomers();
    res.json(customers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/customers/:id', async (req, res) => {
  try {
    const customer = await getCustomerById(req.params.id);
    res.json(customer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/customers', async (req, res) => {
  try {
    const newCustomer = await createCustomer(req.body);
    res.status(201).json(newCustomer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Product Management ---
app.get('/products', async (req, res) => {
  try {
    const products = await getProducts();
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/products/:id', async (req, res) => {
  try {
    const product = await getProductById(req.params.id);
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Order Management ---
app.get('/orders', async (req, res) => {
  try {
    const orders = await getOrders();
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/orders/:id', async (req, res) => {
  try {
    const order = await getOrderById(req.params.id);
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/orders', async (req, res) => {
  try {
    const newOrder = await createOrder(req.body);
    res.status(201).json(newOrder);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Root ---
app.get('/', (req, res) => {
  res.send('Welcome to the MCP Supabase API server!');
});

// MCP base endpoint handlers for GET and POST
app.get('/mcp', (req, res) => {
  res.send('MCP endpoint. Use /mcp/list-tools or /mcp/call-tool.');
});

app.post('/mcp', (req, res) => {
  res.send('MCP endpoint. Use /mcp/list-tools or /mcp/call-tool.');
});

// List available tools
app.post('/mcp/list-tools', (req, res) => {
  console.log('List tools endpoint called');
  res.json({
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
            // ...other customer fields
          },
          required: ['name']
        }
      },
      // ...add more tools for products, orders, etc.
    ]
  });
});

// Handle tool calls
app.post('/mcp/call-tool', async (req, res) => {
  const { name, arguments: args } = req.body;
  try {
    let result;
    switch (name) {
      case 'get_customers':
        result = await getCustomers();
        break;
      case 'create_customer':
        result = await createCustomer(args);
        break;
      // ...other cases
      default:
        throw new Error('Unknown tool');
    }
    res.json({ content: [{ type: 'json', data: result }] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 MCP Supabase API Server running on port ${PORT}`);
});



