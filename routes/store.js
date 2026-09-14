const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY || '');

const router = express.Router();

function generateOrderCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// GET /store/products  — list of products for the storefront
router.get('/products', authMiddleware, async (req, res) => {
  const db = req.app.locals.db;
  try {
    const conn = await db.getConnection();
    const products = await conn.query('SELECT id, name, description, price, image_url, is_new, featured_order, stock_quantity FROM products');
    conn.release();
    const result = products.map(product => {
      return {
        id: product.id,
        name: product.name,
        description: product.description,
        price: product.price,
        image_url: product.image_url,
        is_new: product.is_new,
        featured_order: product.featured_order,
        stock_quantity: product.stock_quantity
      };
    });
    res.json({ products: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /products/:id  — product detail record
router.get('/products/:product_id', authMiddleware, async (req, res) => {
  const db = req.app.locals.db;
  const { product_id } = req.params;
  try {
    const conn = await db.getConnection();
    const products = await conn.query('SELECT id, name, description, price, image_url, is_new, featured_order, stock_quantity FROM products WHERE id = ?', [product_id]);
    conn.release();
    const result = products.map(product => {
      return {
        id: product.id,
        name: product.name,
        description: product.description,
        price: product.price,
        image_url: product.image_url,
        is_new: product.is_new,
        featured_order: product.featured_order,
        stock_quantity: product.stock_quantity
      };
    })[0];
    res.json({ product: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /devices/mine  — list all devices belonging to logged-in user

// POST /store/payment-intent  — create Stripe payment intent
router.post('/payment-intent', authMiddleware, async (req, res) => {
  const { amount, currency, metadata } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Valid amount is required' });
  
  try {
    const intent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Stripe uses cents
      currency: currency || 'jpy',
      metadata: metadata || {}
    });
    res.json({ clientSecret: intent.client_secret, intentId: intent.id });
  } catch (err) {
    console.error('[PAYMENT_INTENT] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /store/orders  — create order with Stripe payment
router.post('/orders', authMiddleware, async (req, res) => {
  const { customer, shipping_address, items, payment_intent_id } = req.body;
  if (!customer || !customer.email || !customer.name) return res.status(400).json({ error: 'customer information is required' });
  if (!shipping_address || !shipping_address.address || !shipping_address.city || !shipping_address.postal_code || !shipping_address.country) return res.status(400).json({ error: 'shipping information is required' });
  if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items information is required' });
  if (!payment_intent_id) return res.status(400).json({ error: 'payment_intent_id is required' });
  
  const db = req.app.locals.db;
  try {
    // Verify payment intent was successful
    const intent = await stripe.paymentIntents.retrieve(payment_intent_id);
    if (intent.status !== 'succeeded') {
      return res.status(400).json({ error: `Payment not completed. Status: ${intent.status}` });
    }

    const conn = await db.getConnection();
    const order_id = generateOrderCode();
    
    // Insert order record
    for (const item of items) {
      await conn.query(
        'INSERT INTO orders (order_id, customer_id, customer_name, customer_email, shipping_address, shipping_city, shipping_postalcode, shipping_country, payment, product_id, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [order_id, req.user.user_id, customer.name, customer.email, shipping_address.address, shipping_address.city, shipping_address.postal_code, shipping_address.country, payment_intent_id, item.product_id, item.quantity]
      );
    }
    
    conn.release();
    console.log(`[PRODUCT_ORDER] New order: ${order_id} (customer: ${customer.email}, items: ${items.length})`);
    res.json({ status: 'success', order_id: order_id });
  } catch (err) {
    console.error('[PRODUCT_ORDER] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
