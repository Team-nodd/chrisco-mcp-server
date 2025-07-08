// src/supabaseApi.ts
const BASE_URL = 'https://gkyxqeytiqugonsdexba.supabase.co/functions/v1';

// Utility fetch wrapper
async function fetchFromSupabase(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, options);
  if (!res.ok) throw new Error(`Supabase API error: ${res.status} ${res.statusText}`);
  return res.json();
}

function buildQuery(params) {
  if (!params) return '';
  const esc = encodeURIComponent;
  return (
    '?' +
    Object.entries(params)
      .filter(([_, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${esc(k)}=${esc(String(v))}`)
      .join('&')
  );
}

export async function getCustomers(params) {
  return fetchFromSupabase(`/customers${buildQuery(params)}`);
}

export async function getCustomerById(id) {
  const res = await fetch(`${BASE_URL}/customers/${id}`);
  if (!res.ok) throw new Error('Failed to fetch customer');
  return res.json();
}

export async function createCustomer(data) {
  const res = await fetch(`${BASE_URL}/customers`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error('Failed to create customer');
  return res.json();
}



export async function getProducts(params) {
  return fetchFromSupabase(`/products${buildQuery(params)}`);
}

export async function getProductById(id) {
  const res = await fetch(`${BASE_URL}/products/${id}`);
  if (!res.ok) throw new Error('Failed to fetch product');
  return res.json();
}


export async function createProduct(data) {
  const res = await fetch(`${BASE_URL}/products`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error('Failed to create product');
  return res.json();
}

export async function getOrders(params) {
  return fetchFromSupabase(`/orders${buildQuery(params)}`);
}

export async function getOrderById(id) {
  const res = await fetch(`${BASE_URL}/orders/${id}`);
  if (!res.ok) throw new Error('Failed to fetch order');
  return res.json();
}

export async function createOrder(data) {
  const res = await fetch(`${BASE_URL}/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error('Failed to create order');
  return res.json();
}

export async function changeDeliveryAddress(order_id, new_address) {
  // Assumes PUT /orders/:id with { delivery_address }
  return fetchFromSupabase(`/orders/${order_id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ delivery_address: new_address })
  });
}

export async function verifyDeliveryAddress(order_id) {
  // Assumes GET /orders/:id returns address info
  return fetchFromSupabase(`/orders/${order_id}`);
}

export async function getOrderOutstandingAmount(order_id) {
  // Assumes GET /orders/:id returns outstanding info
  return fetchFromSupabase(`/orders/${order_id}`);
}

export async function getNextPaymentInfo(order_id) {
  // Assumes GET /payment-schedules?order_id=...
  return fetchFromSupabase(`/payment-schedules?order_id=${order_id}`);
}


// export async function skipNextPayment(order_id) {
//   // Assumes PATCH /payment-schedules/:id/skip
//   return fetchFromSupabase(`/payment-schedules/${order_id}/skip`, {
//     method: 'PATCH'
//   });
// }

export async function getPaymentMethod(order_id) {
  // Assumes GET /orders/:id/payments
  return fetchFromSupabase(`/orders/${order_id}/payments`);
}


