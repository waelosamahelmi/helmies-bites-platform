import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { logger, db, sql } from '../db.js';

const router = Router();

// Initialize Stripe
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

if (!stripeSecretKey) {
  logger.warn('STRIPE_SECRET_KEY not set - Stripe features will not work');
}

const stripe = stripeSecretKey ? new Stripe(stripeSecretKey, {
  apiVersion: '2025-01-27.acacia',
  typescript: true
}) : null;

/**
 * POST /api/stripe/create-payment-intent
 * Create a payment intent for an order
 */
router.post('/create-payment-intent', async (req: Request, res: Response) => {
  try {
    const { amount, currency = 'eur', orderId, tenantId, metadata = {} } = req.body;

    if (!amount || !orderId || !tenantId) {
      return res.status(400).json({
        error: 'Missing required fields: amount, orderId, tenantId'
      });
    }

    if (!stripe) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }

    // Get tenant to apply Helmies fee
    const tenants = await db.tenants.findOne({ id: tenantId });
    if (!tenants || tenants.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const tenant = tenants[0];
    const helmiesFeePercentage = tenant.helmies_fee_percentage || 5;
    const helmiesFee = amount * (helmiesFeePercentage / 100);

    // Create payment intent with Helmies fee
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert to cents
      currency,
      metadata: {
        orderId,
        tenantId,
        helmiesFee: helmiesFee.toFixed(2),
        originalAmount: amount.toFixed(2),
        ...metadata
      },
      description: `Order ${orderId} - ${tenant.name}`
    });

    res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amount,
      helmiesFee,
      totalAmount: amount + helmiesFee
    });
  } catch (error) {
    logger.error('Failed to create payment intent:', error);
    res.status(500).json({
      error: 'Failed to create payment intent',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/stripe/confirm-payment
 * Confirm a payment intent and update order status
 */
router.post('/confirm-payment', async (req: Request, res: Response) => {
  try {
    const { paymentIntentId, orderId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: 'paymentIntentId is required' });
    }

    if (!stripe) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (paymentIntent.status === 'succeeded') {
      // Update order status to paid
      await sql`
        UPDATE public.orders
        SET status = 'paid', payment_status = 'completed', paid_at = NOW()
        WHERE id = ${orderId}
      `;

      res.json({
        success: true,
        status: paymentIntent.status,
        orderId
      });
    } else {
      res.json({
        success: false,
        status: paymentIntent.status,
        message: 'Payment not completed'
      });
    }
  } catch (error) {
    logger.error('Failed to confirm payment:', error);
    res.status(500).json({
      error: 'Failed to confirm payment',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/stripe/balance
 * Get Helmies platform balance
 */
router.get('/balance', async (req: Request, res: Response) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: 'Stripe not configured' });
    }

    const balance = await stripe.balance.retrieve();

    // Calculate restaurant balances from database
    const restaurantBalances = await sql`
      SELECT
        t.id,
        t.name,
        t.slug,
        COALESCE(SUM(
          CASE WHEN o.payment_status = 'completed'
            THEN (o.total_amount * (t.helmies_fee_percentage / 100))
          ELSE 0 END
        ), 0) as pending_fees
      FROM public.tenants t
      LEFT JOIN public.orders o ON o.tenant_id = t.id
        AND o.paid_at >= NOW() - INTERVAL '30 days'
      WHERE t.status = 'active'
      GROUP BY t.id, t.name, t.slug, t.helmies_fee_percentage
    `;

    // Calculate restaurant earnings
    const restaurantEarnings = await sql`
      SELECT
        t.id,
        t.name,
        t.slug,
        COALESCE(SUM(
          CASE WHEN o.payment_status = 'completed'
            THEN o.total_amount * (1 - (t.helmies_fee_percentage / 100))
          ELSE 0 END
        ), 0) as earnings
      FROM public.tenants t
      LEFT JOIN public.orders o ON o.tenant_id = t.id
        AND o.payment_status = 'completed'
      WHERE t.status = 'active'
      GROUP BY t.id, t.name, t.slug
    `;

    res.json({
      available: {
        amount: balance.available[0]?.amount || 0,
        currency: balance.available[0]?.currency || 'eur'
      },
      pending: {
        amount: balance.pending[0]?.amount || 0,
        currency: balance.pending[0]?.currency || 'eur'
      },
      restaurantBalances: restaurantBalances.map((r: any) => ({
        tenantId: r.id,
        name: r.name,
        slug: r.slug,
        pendingFees: Number(r.pending_fees)
      })),
      restaurantEarnings: restaurantEarnings.map((r: any) => ({
        tenantId: r.id,
        name: r.name,
        slug: r.slug,
        totalEarnings: Number(r.earnings)
      }))
    });
  } catch (error) {
    logger.error('Failed to retrieve balance:', error);
    res.status(500).json({
      error: 'Failed to retrieve balance',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/stripe/payout
 * Trigger payout to restaurant
 * Note: Since Helmies manages all payments, payouts are handled manually or via bank transfer
 */
router.post('/payout', async (req: Request, res: Response) => {
  try {
    const { tenantId, amount, bankDetails } = req.body;

    if (!tenantId || !amount) {
      return res.status(400).json({ error: 'tenantId and amount are required' });
    }

    // Get tenant
    const tenants = await db.tenants.findOne({ id: tenantId });
    if (!tenants || tenants.length === 0) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const tenant = tenants[0];

    // Calculate tenant's earnings
    const earnings = await sql`
      SELECT COALESCE(SUM(
        CASE WHEN o.payment_status = 'completed'
          THEN o.total_amount * (1 - ${tenant.helmies_fee_percentage || 5} / 100)
        ELSE 0 END
      ), 0) as available_earnings
      FROM public.orders o
      WHERE o.tenant_id = ${tenantId}
        AND o.payment_status = 'completed'
        AND (o.paid_out IS NULL OR o.paid_out = false)
    `;

    const availableEarnings = Number(earnings[0]?.available_earnings || 0);

    if (amount > availableEarnings) {
      return res.status(400).json({
        error: 'Insufficient earnings',
        available: availableEarnings,
        requested: amount
      });
    }

    // Mark orders as paid out
    await sql`
      UPDATE public.orders
      SET paid_out = true, payout_date = NOW()
      WHERE tenant_id = ${tenantId}
        AND payment_status = 'completed'
        AND (paid_out IS NULL OR paid_out = false)
      LIMIT ${Math.ceil(amount / 100)}
    `;

    // Create payout record
    const payout = await sql`
      INSERT INTO public.payouts (tenant_id, amount, status, bank_details)
      VALUES (${tenantId}, ${amount}, 'processing', ${JSON.stringify(bankDetails || {})})
      RETURNING *
    `;

    res.json({
      success: true,
      payout: payout[0],
      message: 'Payout recorded. Bank transfer will be initiated within 1-2 business days.'
    });
  } catch (error) {
    logger.error('Failed to create payout:', error);
    res.status(500).json({
      error: 'Failed to create payout',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * GET /api/stripe/tenant-earnings/:tenantId
 * Get tenant earnings and payout history
 */
router.get('/tenant-earnings/:tenantId', async (req: Request, res: Response) => {
  try {
    const { tenantId } = req.params;

    // Get total earnings
    const earnings = await sql`
      SELECT
        COUNT(*) as total_orders,
        COALESCE(SUM(total_amount), 0) as gross_revenue,
        COALESCE(SUM(total_amount * (t.helmies_fee_percentage / 100)), 0) as helmies_fees,
        COALESCE(SUM(total_amount * (1 - (t.helmies_fee_percentage / 100))), 0) as net_earnings
      FROM public.orders o
      JOIN public.tenants t ON o.tenant_id = t.id
      WHERE o.tenant_id = ${tenantId}
        AND o.payment_status = 'completed'
    `;

    // Get pending (not yet paid out) earnings
    const pending = await sql`
      SELECT
        COALESCE(SUM(total_amount * (1 - (t.helmies_fee_percentage / 100))), 0) as pending_earnings,
        COUNT(*) as pending_orders
      FROM public.orders o
      JOIN public.tenants t ON o.tenant_id = t.id
      WHERE o.tenant_id = ${tenantId}
        AND o.payment_status = 'completed'
        AND (o.paid_out IS NULL OR o.paid_out = false)
    `;

    // Get payout history
    const payoutHistory = await sql`
      SELECT * FROM public.payouts
      WHERE tenant_id = ${tenantId}
      ORDER BY created_at DESC
      LIMIT 10
    `;

    res.json({
      totalEarnings: {
        totalOrders: Number(earnings[0]?.total_orders || 0),
        grossRevenue: Number(earnings[0]?.gross_revenue || 0),
        helmiesFees: Number(earnings[0]?.helmies_fees || 0),
        netEarnings: Number(earnings[0]?.net_earnings || 0)
      },
      pending: {
        pendingEarnings: Number(pending[0]?.pending_earnings || 0),
        pendingOrders: Number(pending[0]?.pending_orders || 0)
      },
      payoutHistory: payoutHistory.map((p: any) => ({
        id: p.id,
        amount: Number(p.amount),
        status: p.status,
        createdAt: p.created_at,
        completedAt: p.completed_at
      }))
    });
  } catch (error) {
    logger.error(`Failed to get earnings for tenant ${req.params.tenantId}:`, error);
    res.status(500).json({
      error: 'Failed to get tenant earnings',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/stripe/webhook
 * Handle Stripe webhooks
 */
router.post('/webhook', async (req: Request, res: Response) => {
  if (!webhookSecret) {
    logger.warn('Stripe webhook secret not configured');
    return res.status(500).json({ error: 'Webhook not configured' });
  }

  const sig = req.headers['stripe-signature'] as string;

  try {
    if (!stripe) {
      throw new Error('Stripe not configured');
    }

    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      webhookSecret
    );

    logger.info(`Stripe webhook received: ${event.type}`);

    switch (event.type) {
      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const { orderId, tenantId } = paymentIntent.metadata;

        // Update order status
        await sql`
          UPDATE public.orders
          SET status = 'paid', payment_status = 'completed', paid_at = NOW()
          WHERE id = ${orderId}
        `;

        logger.info(`Payment succeeded for order ${orderId}, tenant ${tenantId}`);
        break;
      }

      case 'payment_intent.payment_failed': {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const { orderId } = paymentIntent.metadata;

        // Update order status
        await sql`
          UPDATE public.orders
          SET status = 'payment_failed', payment_status = 'failed'
          WHERE id = ${orderId}
        `;

        logger.info(`Payment failed for order ${orderId}`);
        break;
      }

      case 'payout.created':
      case 'payout.paid':
      case 'payout.failed': {
        logger.info(`Payout event: ${event.type}`);
        break;
      }

      default:
        logger.info(`Unhandled webhook event: ${event.type}`);
    }

    res.json({ received: true });
  } catch (error) {
    logger.error('Webhook error:', error);
    return res.status(400).json({
      error: 'Webhook handler failed',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
