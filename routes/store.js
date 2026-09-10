const express = require('express');
const { authMiddleware } = require('../middleware/auth');

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
router.post('/orders', authMiddleware, async (req, res) => {
  const { customer, shipping_address, payment, items } = req.body;
  if (!customer || !customer.email || !customer.name) return res.status(400).json({ error: 'customer infromation is required' });
  if (!shipping_address || !shipping_address.address || !shipping_address.city || !shipping_address.postal_code || !shipping_address.country) return res.status(400).json({ error: 'shipping infromation is required' });
  if (!payment || !payment.card_number || !payment.expiry || !payment.cvc) return res.status(400).json({ error: 'payment infromation is required' });
  if (!items || !items.product_id || !items.quantity) return res.status(400).json({ error: 'items infromation is required' });
  const db = req.app.locals.db;
  try {
    const conn = await db.getConnection();
    const order_id = generateOrderCode();
    const payment_hash = '**payment_hash**'; // TBD: process payment and obtain key of the order
    await conn.query(
      'INSERT INTO orders (order_id, customer_id, customer_name, customer_email, shipping_address, shipping_city, shipping_postalcode, shipping_country, payment, product_id, quantity) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [order_id, req.user.user_id, customer.name, customer.email, shipping_address.address, shipping_address.city, shipping_address.postal_code, shipping_address.country, payment_hash, items.product_id, items.quantity]
    );
    conn.release();
    console.log(`[PRODUCT_ORDER] New order: ${items.product_id} (claim: ${order_id})`);
    res.json({ status: 'pending', order_id: order_id });
  } catch (err) {
    console.error('[PRODUCT_ORDER] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
