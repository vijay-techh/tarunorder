// server.js
import express from "express";
import cors from "cors";
import { Pool } from "pg";
import dotenv from "dotenv";
import PDFDocument from "pdfkit";
import dayjs from "dayjs";
import { v4 as uuidv4 } from "uuid";

dotenv.config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

/* helper: safeNumber */
function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* ============================================================
   1) NEW CUSTOMER + FIRST ORDER
   (same logic as before - inserts rent_status = 'ACTIVE' for new customers)
============================================================ */
app.post("/api/new-customer", async (req, res) => {
  const client = await pool.connect();
  try {
    const {
      name, phone, alt_phone, address, rent_start, rent_end, items = [], order_date
    } = req.body;

    if (!name || !phone || !address) {
      return res.json({ success: false, error: "Missing required fields (name, phone, address)" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.json({ success: false, error: "No product items found" });
    }

    await client.query("BEGIN");

    // check existing customer by phone
   // Always create a new customer entry (no overwrite)
const newCustomer = await client.query(
  `INSERT INTO customers (name, phone, alt_phone, address, rent_status)
   VALUES ($1,$2,$3,$4,$5) RETURNING id`,
  [name, phone, alt_phone || null, address, "ACTIVE"]
);

const customerId = newCustomer.rows[0].id;


    const finalOrderDate = order_date || dayjs().format("YYYY-MM-DD");

    const ord = await client.query(
      `INSERT INTO orders (invoice_no, customer_id, order_date, rent_start, rent_end, total)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [uuidv4(), customerId, finalOrderDate, rent_start || null, rent_end || null, 0]
    );
    const orderId = ord.rows[0].id;

    let total = 0;
    for (const it of items) {
      const price = safeNumber(it.price);
      const qty = safeNumber(it.quantity);
      const line = price * qty;
      total += line;

      await client.query(
        `INSERT INTO order_items (order_id, product, price, quantity, line_total)
         VALUES ($1,$2,$3,$4,$5)`,
        [orderId, it.product, price, qty, line]
      );
    }

    await client.query(`UPDATE orders SET total=$1 WHERE id=$2`, [total, orderId]);

    await client.query("COMMIT");
    return res.json({ success: true, customerId, orderId });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch(_) {}
    console.error("🔥 NEW CUSTOMER ERROR:", err);
    return res.json({ success: false, error: err.message || "Server error" });
  } finally {
    client.release();
  }
});

/* ============================================================
   2) GENERATE BILL (Manual)
============================================================ */
app.post("/api/generate-bill", async (req, res) => {
  const client = await pool.connect();
  try {
    const { name, phone, alt_phone, address, rent_start, rent_end, items = [] } = req.body;

    if (!name || !phone || !address) {
      return res.json({ success: false, error: "Missing required fields (name, phone, address)" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.json({ success: false, error: "No product items found" });
    }

    await client.query("BEGIN");

    // find or create customer
    const c = await client.query(`SELECT id FROM customers WHERE phone=$1`, [phone]);
    let customerId;
    if (c.rows.length) {
      customerId = c.rows[0].id;
      await client.query(
        `UPDATE customers SET name=$1, alt_phone=$2, address=$3 WHERE id=$4`,
        [name, alt_phone || null, address, customerId]
      );
    } else {
      const nc = await client.query(
        `INSERT INTO customers (name, phone, alt_phone, address, rent_status)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [name, phone, alt_phone || null, address, "ACTIVE"]
      );
      customerId = nc.rows[0].id;
    }

    const orderDate = dayjs().format("YYYY-MM-DD");
    const orderRes = await client.query(
      `INSERT INTO orders (invoice_no, customer_id, order_date, rent_start, rent_end, total)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, invoice_no`,
      [uuidv4(), customerId, orderDate, rent_start || null, rent_end || null, 0]
    );
    const orderId = orderRes.rows[0].id;

    let total = 0;
    for (const it of items) {
      const price = safeNumber(it.price);
      const qty = safeNumber(it.quantity);
      const line = price * qty;
      total += line;

      await client.query(
        `INSERT INTO order_items (order_id, product, price, quantity, line_total)
         VALUES ($1,$2,$3,$4,$5)`,
        [orderId, it.product, price, qty, line]
      );
    }

    await client.query(`UPDATE orders SET total=$1 WHERE id=$2`, [total, orderId]);
    await client.query("COMMIT");
    return res.json({ success: true, orderId, invoiceNo: orderRes.rows[0].invoice_no });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch(_) {}
    console.error("🔥 GENERATE BILL ERROR:", err);
    return res.json({ success: false, error: err.message || "Server error" });
  } finally {
    client.release();
  }
});

/* ============================================================
   3) SEARCH CUSTOMERS
   ============================================================ */
app.get("/api/customers", async (req, res) => {
  try {
    const { q } = req.query;
    let sql = `SELECT id, name, phone, alt_phone, address, rent_status FROM customers`;
    const params = [];
    if (q) {
      sql += ` WHERE name ILIKE $1 OR phone ILIKE $1 OR alt_phone ILIKE $1`;
      params.push(`%${q}%`);
    }
    sql += ` ORDER BY id DESC`;
    const r = await pool.query(sql, params);
    res.json({ success: true, rows: r.rows });
  } catch (err) {
    console.error("SEARCH CUSTOMERS ERROR:", err);
    res.json({ success: false });
  }
});

/* ============================================================
   4) CUSTOMER DETAILS
   ============================================================ */
app.get("/api/customer-details", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.json({ success: false, error: "Missing id" });

    const cust = await pool.query(`SELECT * FROM customers WHERE id=$1`, [id]);
    if (!cust.rows.length) return res.json({ success: false, error: "Customer not found" });

    const orders = await pool.query(`SELECT * FROM orders WHERE customer_id=$1 ORDER BY id DESC`, [id]);

    const orderDetails = [];
    for (const o of orders.rows) {
      const items = await pool.query(`SELECT * FROM order_items WHERE order_id=$1 ORDER BY id ASC`, [o.id]);
      orderDetails.push({ order: o, items: items.rows });
    }

    res.json({ success: true, customer: cust.rows[0], orderDetails });
  } catch (err) {
    console.error("CUSTOMER DETAILS ERROR:", err);
    res.json({ success: false });
  }
});

/* ============================================================
   5) CUSTOMER ORDERS (summary)
   ============================================================ */
app.get("/api/customer-orders", async (req, res) => {
  try {
    const { id } = req.query;
    if (!id) return res.json({ success: false, error: "Missing id" });

    const rows = await pool.query(
      `SELECT id, order_date, rent_start, rent_end, total FROM orders WHERE customer_id=$1 ORDER BY id DESC`,
      [id]
    );
    res.json({ success: true, rows: rows.rows });
  } catch (err) {
    console.error("CUSTOMER ORDERS ERROR:", err);
    res.json({ success: false });
  }
});

/* ============================================================
   6) ORDER FULL DETAILS
   ============================================================ */
app.get("/api/order-full-details", async (req, res) => {
  try {
    const { orderId } = req.query;
    if (!orderId) return res.json({ success: false, error: "Missing orderId" });

    const order = await pool.query(
      `SELECT o.*, c.name AS cname, c.phone AS cphone, c.alt_phone AS caltphone, c.address AS caddress
       FROM orders o JOIN customers c ON c.id=o.customer_id
       WHERE o.id=$1 LIMIT 1`,
      [orderId]
    );
    if (!order.rows.length) return res.json({ success: false, error: "Order not found" });

    const items = await pool.query(`SELECT * FROM order_items WHERE order_id=$1 ORDER BY id ASC`, [orderId]);
    res.json({ success: true, order: order.rows[0], items: items.rows });
  } catch (err) {
    console.error("ORDER FULL DETAILS ERROR:", err);
    res.json({ success: false });
  }
});

/* ============================================================
   7) UPDATE CUSTOMER RENT STATUS
   ============================================================ */
app.post("/api/update-status", async (req, res) => {
  try {
    const { customerId, status } = req.body;
    if (!customerId || !status) return res.json({ success: false, error: "Missing fields" });
    await pool.query(`UPDATE customers SET rent_status=$1 WHERE id=$2`, [status, customerId]);
    res.json({ success: true });
  } catch (err) {
    console.error("UPDATE STATUS ERROR:", err);
    res.json({ success: false });
  }
});

/* ============================================================
   8) UPDATE ORDER (NEW) — Edit last order (or any order) items + metadata
   - body: { orderId, order_date, rent_start, rent_end, items: [{product,price,quantity}, ...] }
   - transaction: delete old items -> insert new items -> update order total & dates
============================================================ */
app.post("/api/update-order", async (req, res) => {
  const client = await pool.connect();
  try {
    const { orderId, order_date, rent_start, rent_end, items } = req.body;
    if (!orderId) return res.json({ success: false, error: "Missing orderId" });
    if (!Array.isArray(items) || items.length === 0) return res.json({ success: false, error: "No items provided" });

    await client.query("BEGIN");

    // Ensure order exists
    const oQ = await client.query(`SELECT id FROM orders WHERE id=$1 LIMIT 1`, [orderId]);
    if (!oQ.rows.length) {
      await client.query("ROLLBACK");
      return res.json({ success: false, error: "Order not found" });
    }

    // Delete existing items for that order
    await client.query(`DELETE FROM order_items WHERE order_id=$1`, [orderId]);

    // Insert provided items
    let total = 0;
    for (const it of items) {
      const price = safeNumber(it.price);
      const qty = safeNumber(it.quantity);
      const line = price * qty;
      total += line;

      await client.query(
        `INSERT INTO order_items (order_id, product, price, quantity, line_total)
         VALUES ($1,$2,$3,$4,$5)`,
        [orderId, it.product, price, qty, line]
      );
    }

    // Update order meta: total, dates if provided
    await client.query(
      `UPDATE orders SET total=$1, order_date = COALESCE($2, order_date), rent_start = COALESCE($3, rent_start), rent_end = COALESCE($4, rent_end) WHERE id=$5`,
      [total, order_date || null, rent_start || null, rent_end || null, orderId]
    );

    await client.query("COMMIT");
    res.json({ success: true, total });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch(_) {}
    console.error("UPDATE ORDER ERROR:", err);
    res.json({ success: false, error: err.message || "Server error" });
  } finally {
    client.release();
  }
});

/* ============================================================
   9) PDF invoice endpoint
============================================================ */
app.get("/api/invoice/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    const orderQ = await pool.query(
      `SELECT o.*, c.name AS cname, c.phone AS cphone, c.address AS caddress
       FROM orders o JOIN customers c ON o.customer_id = c.id
       WHERE o.id=$1 LIMIT 1`,
      [orderId]
    );
    if (!orderQ.rows.length) return res.status(404).send("Order not found");
    const order = orderQ.rows[0];

    const itemsQ = await pool.query(
      `SELECT * FROM order_items WHERE order_id=$1 ORDER BY id ASC`,
      [orderId]
    );

    const doc = new PDFDocument({ size: "A4", margin: 40 });
    const filename = `invoice-${order.invoice_no || orderId}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
    doc.pipe(res);

    const teal = "#006666";

    // Header text (phones, title)
    doc.fontSize(12).fillColor(teal).text("9916067960, 8073024022", 40, 30);

    // Title with underline (centered)
    doc.fontSize(26).fillColor(teal).text("SUBRAMANI ENTERPRISES", 0, 60, {
      align: "center",
    });

    // Draw underline under title (across the page)
    doc
      .moveTo(40, 95)
      .lineTo(550, 95)
      .lineWidth(2)
      .strokeColor(teal)
      .stroke();

    // Customer / order info
    let cy = 130;
    doc.font("Helvetica").fontSize(12).fillColor("#000");
    doc.text(
      `DATE: ${dayjs(order.order_date).format("DD/MM/YYYY")}`,
      0,
      cy,
      { align: "center" }
    );
    cy += 25;
    doc.text(`CUSTOMER NAME: ${order.cname}`, 0, cy, { align: "center" });
    cy += 25;
    doc.text(`PHONE: ${order.cphone}`, 0, cy, { align: "center" });
    cy += 25;
    doc.text(`ADDRESS: ${order.caddress}`, 0, cy, { align: "center" });
    cy += 25;

    // NEW: Rent Start - End line (centered)
    const rentStartStr = order.rent_start
      ? dayjs(order.rent_start).format("DD/MM/YYYY")
      : "-";
    const rentEndStr = order.rent_end
      ? dayjs(order.rent_end).format("DD/MM/YYYY")
      : "-";
   // Calculate number of days
let daysCount = 1;
if (order.rent_start && order.rent_end) {
  const start = dayjs(order.rent_start);
  const end = dayjs(order.rent_end);
  const diff = end.diff(start, "day") + 1;
  daysCount = diff > 0 ? diff : 1;
}

// Show Rent + Days
doc.text(
  `RENT: ${rentStartStr} - ${rentEndStr} (${daysCount} Day${daysCount > 1 ? "s" : ""})`,
  0,
  cy,
  { align: "center" }
);

  
    // Table header
    let tableTop = doc.y + 30;
    doc.font("Helvetica-Bold").fontSize(11).fillColor(teal);
    doc.text("DESCRIPTION", 40, tableTop);
    doc.text("PRICE", 260, tableTop);
    doc.text("QTY", 350, tableTop);
    doc.text("AMOUNT", 450, tableTop);
    doc
      .moveTo(40, tableTop + 15)
      .lineTo(550, tableTop + 15)
      .strokeColor(teal)
      .stroke();

    // Table rows
    doc.font("Helvetica").fontSize(10).fillColor("#000");
    let y = tableTop + 25;
    let grand = 0;
   for (const it of itemsQ.rows) {
  const price = safeNumber(it.price);
  const qty = safeNumber(it.quantity);
  const amount = (safeNumber(it.line_total) || (price * qty)) * daysCount;

  // If next row exceeds current page space, start new page & redraw header
  if (y + 50 > doc.page.height - 60) {
    doc.addPage();

    // reset y position
    y = 40;

    // redraw table headers on new page
    doc.font("Helvetica-Bold").fontSize(11).fillColor(teal);
    doc.text("DESCRIPTION", 40, y);
    doc.text("PRICE",       260, y);
    doc.text("QTY",         350, y);
    doc.text("AMOUNT",      450, y);

    doc
      .moveTo(40, y + 15)
      .lineTo(550, y + 15)
      .strokeColor(teal)
      .stroke();

    y += 25;
    doc.font("Helvetica").fontSize(10).fillColor("#000");
  }

  // print row
  doc.text(it.product, 40, y);
  doc.text(price.toFixed(2), 260, y);
  doc.text(String(qty), 350, y);
  doc.text(amount.toFixed(2), 450, y);

  // breakdown
  doc.fontSize(8).fillColor("#555")
     .text(`(${price} × ${qty} × ${daysCount})`, 450, y + 10);

  doc.fontSize(10).fillColor("#000");

  grand += amount;
  y += 22;

  // row bottom line
  doc
    .moveTo(40, y)
    .lineTo(550, y)
    .strokeColor("#ddd")
    .stroke();

  y += 8;

      // Summary breakdown section
// After loop ends, before drawing total box
y += 20;
doc.font("Helvetica-Bold").fontSize(11).fillColor(teal)
   .text("PRICE CALCULATION SUMMARY", 40, y);
y += 18;

doc.font("Helvetica").fontSize(10).fillColor("#000")
doc.text(`Products Total (Per-day): ₹ ${(price * qty).toFixed(2)}`, 40, y);
y += 16;

doc.text(`Number of days: ${daysCount}`, 40, y);
y += 16;

doc.text(`Final Total: ₹ ${amount.toFixed(2)}`, 40, y);

y += 30;

// reset
doc.fontSize(10).fillColor("#000");


      doc
        .moveTo(40, y)
        .lineTo(550, y)
        .strokeColor("#ddd")
        .stroke();
    }

    // Total box
    y += 30;
    doc.strokeColor(teal).rect(350, y, 200, 50).stroke();
    doc
      .font("Helvetica-Bold")
      .fontSize(13)
      .fillColor(teal)
      .text("TOTAL", 360, y + 8);
    doc
      .fontSize(16)
      .fillColor(teal)
      .text(`₹ ${grand.toFixed(2)}`, 360, y + 28);

    // Footer
    doc.moveDown(4);
    doc
      .font("Helvetica")
      .fontSize(10)
      .fillColor(teal)
      .text(
        "5TH CROSS, CANNEL RIGHT SIDE, VENKATESHA NAGAR, SHIMOGA | 577202 | PHONE: 6363499137",
        { align: "center" }
      );
    doc.moveDown(1);
    doc
      .font("Helvetica-Bold")
      .fontSize(11)
      .fillColor(teal)
      .text("THANK YOU FOR YOUR BUSINESS!", { align: "center" });

    doc.end();
  } catch (err) {
    console.error("🔥 PDF ERROR:", err);
    if (!res.headersSent) res.status(500).send("PDF Error");
  }
});
/* ============================================================
   10) Delete customer
============================================================ */
app.delete("/api/delete-customer", async (req, res) => {
  const client = await pool.connect();
  try {
    const { customerId } = req.body;
    if (!customerId) return res.json({ success: false, error: "Missing customerId" });

    await client.query("BEGIN");
    await client.query(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE customer_id=$1)`, [customerId]);
    await client.query(`DELETE FROM orders WHERE customer_id=$1`, [customerId]);
    await client.query(`DELETE FROM customers WHERE id=$1`, [customerId]);
    await client.query("COMMIT");

    res.json({ success: true });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch(_) {}
    console.error("DELETE CUSTOMER ERROR:", err);
    res.json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

export default app;