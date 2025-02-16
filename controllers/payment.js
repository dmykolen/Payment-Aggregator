const db = require("../db");

function getConfig() {
  const row = db.prepare("SELECT * FROM configs WHERE id = 1").get();
  return {
    A: row?.fee_ps_fixed ?? 0,
    B: row?.fee_ps_percent ?? 0,
    D: row?.temp_hold_percent ?? 0,
  };
}

// fullPayout = amount - (A + B*amount + C*amount)
function calculateFullPayout(payment, merchant, config) {
  const { amount } = payment;
  return amount - (config.A + config.B * amount + merchant.commission_percent * amount);
}

// calculateAvailable - calculate the available balance for a payment, based on its status
function calculateAvailable(payment, config) {
  const { amount, status } = payment;
  if (status === "executed") {
    return amount - (config.A + config.B * amount);
  } else if (status === "processed") {
    return amount - (config.A + config.B * amount) - config.D * amount;
  }
  return 0;
}

/**
 * @swagger
 * components:
 *   schemas:
 *     Merchant:
 *       type: object
 *       properties:
 *         name:
 *           type: string
 *           description: Merchant name
 *         commission:
 *           type: number
 *           description: Merchant commission rate
 *     Payment:
 *       type: object
 *       properties:
 *         merchantId:
 *           type: string
 *         amount:
 *           type: number
 */
class PaymentController {
  /**
   * @swagger
   * /api/config:
   *   post:
   *     summary: Set payment system configuration
   *     tags: [Configuration]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               A:
   *                 type: number
   *                 description: Fixed fee amount
   *               B:
   *                 type: number
   *                 description: Percentage fee
   *               D:
   *                 type: number
   *                 description: Temporary hold percentage
   *     responses:
   *       200:
   *         description: Configuration updated successfully
   *       400:
   *         description: Invalid configuration values
   */
  async setConfigs(req, res) {
    try {
      const { A, B, D } = req.body;

      if (![A, B, D].every((val) => typeof val === "number" && val >= 0)) {
        return res.status(400).json({ error: "Invalid configuration values." });
      }

      await db.prepare("INSERT OR REPLACE INTO configs VALUES (1, ?, ?, ?)").run(A, B / 100, D / 100);
      res.json({
        message: "Configuration updated successfully.",
        config: { A, B, D },
      });
    } catch (error) {
      console.error("Error setting config:", error);
      res.status(500).json({ error: "Internal server error." });
    }
  }

  getConfig(req, res) {
    const config = getConfig();
    return res.json({
      ...config,
      B: config.B * 100,
      D: config.D * 100,
    });
  }

  /**
   * @swagger
   * /api/merchants:
   *   post:
   *     summary: Add a new merchant
   *     tags: [Merchants]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/Merchant'
   *     responses:
   *       200:
   *         description: Merchant created successfully
   *       400:
   *         description: Invalid merchant data
   */
  addMerchant(req, res) {
    console.log(req.body);
    let { name, commission } = req.body;

    // convrt commission to number
    commission = parseFloat(commission);

    if (!name || typeof commission !== "number") {
      return res.status(400).json({ error: "Missing name or commission." });
    }
    const stmt = db.prepare("INSERT INTO merchants (name, commission_percent) VALUES (?, ?)");
    const result = stmt.run(name, commission / 100);
    res.json({ id: result.lastInsertRowid });
  }

  /**
   * @swagger
   * /api/payments:
   *   post:
   *     summary: Create a new payment
   *     tags: [Payments]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/Payment'
   *     responses:
   *       201:
   *         description: Payment created successfully
   *       400:
   *         description: Invalid payment data
   */
  createPayment(req, res) {
    const { merchantId, amount } = req.body;
    if (!merchantId || typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "Invalid merchantId or amount." });
    }

    const merchant = db.prepare("SELECT * FROM merchants WHERE id = ?").get(merchantId);
    if (!merchant) {
      return res.status(404).json({ error: "Merchant not found." });
    }
    const stmt = db.prepare("INSERT INTO payments (merchant_id, amount, status) VALUES (?, ?, ?)");
    const result = stmt.run(merchantId, amount, "accepted");
    res.json({ id: result.lastInsertRowid });
  }

  /**
   * @swagger
   * /api/payments/process:
   *   post:
   *     summary: Process payments
   *     tags: [Payments]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               paymentIds:
   *                 type: array
   *                 items:
   *                   type: integer
   *                 description: Array of payment IDs to process
   *     responses:
   *       200:
   *         description: Payments updated to processed
   *       400:
   *         description: Invalid paymentIds
   */
  processPayments(req, res) {
    const { paymentIds } = req.body;
    if (!Array.isArray(paymentIds)) return res.status(400).json({ error: "paymentIds must be an array." });

    const config = getConfig();
    const updateStmt = db.prepare("UPDATE payments SET status = ?, available_balance = ? WHERE id = ? AND status = ?");
    const updatedIds = [];
    const transaction = db.transaction((ids) => {
      for (const id of ids) {
        const payment = db.prepare("SELECT * FROM payments WHERE id = ?").get(id);
        if (payment) {
          // Calculate available balance for processed status
          const availableBalance = payment.amount - (config.A + config.B * payment.amount + config.D * payment.amount);
          const result = updateStmt.run("processed", availableBalance, id, "accepted");
          if (result.changes > 0) {
            updatedIds.push(id);
          }
        }
      }
    });
    transaction(paymentIds);
    res.json({
      message: "Payments updated to processed.",
      updated: updatedIds,
    });
  }

  /**
   * @swagger
   * /api/payments/execute:
   *   post:
   *     summary: Update payments status to 'executed'
   *     tags: [Payments]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               paymentIds:
   *                 type: array
   *                 items:
   *                   type: integer
   *                 description: Array of payment IDs to execute
   *     responses:
   *       200:
   *         description: Payments updated to executed
   *       400:
   *         description: Invalid paymentIds
   */
  executePayments(req, res) {
    const { paymentIds } = req.body;
    if (!Array.isArray(paymentIds)) return res.status(400).json({ error: "paymentIds must be an array." });
    const config = getConfig();
    const updateStmt = db.prepare("UPDATE payments SET status = ?, available_balance = ? WHERE id = ? AND status = ?");
    const updatedIds = [];
    const transaction = db.transaction((ids) => {
      for (const id of ids) {
        const payment = db.prepare("SELECT * FROM payments WHERE id = ?").get(id);
        if (payment) {
          // Calculate available balance for executed status (remove D hold)
          const availableBalance = payment.amount - (config.A + config.B * payment.amount);
          console.log("Available balance for payment", id, "=>", availableBalance, "available=", calculateAvailable(payment, config));
          const result = updateStmt.run("executed", availableBalance, id, "processed");
          if (result.changes > 0) {
            updatedIds.push(id);
          }
        }
      }
    });
    transaction(paymentIds);
    res.json({ message: "Payments updated to executed.", updated: updatedIds });
  }

  /**
   * @swagger
   * /api/payments/payout:
   *   post:
   *     summary: Process payout for a merchant
   *     tags: [Payments]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               merchantId:
   *                 type: integer
   *                 description: ID of the merchant
   *     responses:
   *       200:
   *         description: Payout processed successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 totalPayout:
   *                   type: number
   *                   description: Total payout amount
   *                 payments:
   *                   type: array
   *                   items:
   *                     type: object
   *                     properties:
   *                       id:
   *                         type: integer
   *                         description: Payment ID
   *                       payoutAmount:
   *                         type: number
   *                         description: Payout amount for the payment
   *       400:
   *         description: Invalid merchantId
   *       404:
   *         description: Merchant not found
   */
  processPayout(req, res) {
    const { merchantId } = req.body;
    if (!merchantId) return res.status(400).json({ error: "merchantId is required." });

    const merchant = db.prepare("SELECT * FROM merchants WHERE id = ?").get(merchantId);
    if (!merchant) return res.status(404).json({ error: "Merchant not found." });

    const config = getConfig();
    const eligiblePayments = db
      .prepare("SELECT * FROM payments WHERE merchant_id = ? AND status IN ('processed', 'executed') ORDER BY created_at ASC")
      .all(merchantId);
    console.log("Eligible payments for merchant", eligiblePayments);

    !eligiblePayments.length && res.json({ totalPayout: 0, payments: [] });

    // Calculate the total available balance (the amount that can actually be used for payouts)
    let totalAvailable = 0;
    for (const payment of eligiblePayments) {
      totalAvailable += calculateAvailable(payment, config);
    }
    console.log(`Total available balance for merchant [${merchant.name}]: ${totalAvailable}`);

    // Selecting payments: iterate through payments in the order they were created (FIFO) and, if adding
    // the full payout amount of this payment (fullPayout) does not exceed the total available, include it.
    let runningSum = 0;
    const selectedPayments = [];
    const updateStmt = db.prepare("UPDATE payments SET status = ? WHERE id = ?");

    // Оновлення статусу платежів проводимо у транзакції
    const payoutTransaction = db.transaction((paymentsToUpdate) => {
      for (const p of paymentsToUpdate) {
        updateStmt.run("paid", p.id);
      }
    });

    for (const payment of eligiblePayments) {
      const fullPayout = calculateFullPayout(payment, merchant, config);
      if (runningSum + fullPayout <= totalAvailable) {
        runningSum += fullPayout;
        selectedPayments.push({ id: payment.id, payoutAmount: fullPayout });
      }
    }

    console.log("Selected payments for payout", selectedPayments);

    // Update the status of selected payments to "paid"
    payoutTransaction(selectedPayments);

    res.json({
      totalPayout: runningSum,
      payments: selectedPayments,
    });
  }

  /**
   * @swagger
   * /api/merchants:
   *   get:
   *     summary: List all merchants
   *     tags: [Merchants]
   *     responses:
   *       200:
   *         description: List of merchants
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 properties:
   *                   id:
   *                     type: integer
   *                   name:
   *                     type: string
   *                   commission_percent:
   *                     type: number
   */
  listMerchants(req, res) {
    const merchants = db.prepare("SELECT * FROM merchants ORDER BY id").all();
    const merchantTotals = db
      .prepare(`SELECT merchant_id, SUM(amount) as total_paid FROM payments WHERE status = 'paid' GROUP BY merchant_id`)
      .all();
    merchants.forEach((m) => {
      m.commission_percent *= 100;
      m.totalPaid = merchantTotals.find((t) => t.merchant_id === m.id)?.total_paid || 0;
    });
    res.json(merchants);
  }

  /**
   * @swagger
   * /api/payments:
   *   get:
   *     summary: List payments with optional filters
   *     tags: [Payments]
   *     parameters:
   *       - in: query
   *         name: merchantId
   *         schema:
   *           type: integer
   *         description: Filter by merchant ID
   *       - in: query
   *         name: status
   *         schema:
   *           type: string
   *           enum: [accepted, processed, executed, paid]
   *         description: Filter by payment status
   *     responses:
   *       200:
   *         description: List of payments
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 type: object
   *                 properties:
   *                   id:
   *                     type: integer
   *                   merchant_id:
   *                     type: integer
   *                   amount:
   *                     type: number
   *                   status:
   *                     type: string
   *                   created_at:
   *                     type: string
   */
  listPayments(req, res) {
    const { merchantId, status } = req.query;
    let sql = "SELECT * FROM payments";
    const params = [];

    if (merchantId || status) {
      sql += " WHERE";
      const conditions = [];

      if (merchantId) {
        conditions.push(" merchant_id = ?");
        params.push(merchantId);
      }

      if (status) {
        conditions.push(" status = ?");
        params.push(status);
      }

      sql += conditions.join(" AND");
    }

    sql += " ORDER BY created_at DESC";

    const payments = db.prepare(sql).all(...params);
    console.log(payments);

    res.json(payments);
  }
}

module.exports = PaymentController;
