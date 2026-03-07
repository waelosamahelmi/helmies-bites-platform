import { Router, Request, Response } from 'express';
import { sql } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { z } from 'zod';

const router = Router();

// ==========================================
// PUBLIC: Get loyalty rewards for a tenant
// ==========================================
router.get('/rewards', async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'Missing X-Tenant-ID header' });
    }

    const rewards = await sql`
      SELECT * FROM loyalty_rewards
      WHERE tenant_id = ${tenantId}
        AND is_active = true
      ORDER BY points_required ASC
    `;

    res.json(rewards);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// Get loyalty transactions for a customer
// ==========================================
router.get('/transactions/:customerId', async (req: Request, res: Response) => {
  try {
    const { customerId } = req.params;
    const tenantId = req.headers['x-tenant-id'] as string;

    const transactions = await sql`
      SELECT lt.* FROM loyalty_transactions lt
      JOIN customers c ON lt.customer_id = c.id
      WHERE lt.customer_id = ${customerId}
        AND c.tenant_id = ${tenantId}
      ORDER BY lt.created_at DESC
      LIMIT 50
    `;

    res.json(transactions);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// Get customer loyalty points
// ==========================================
router.get('/points/:customerId', async (req: Request, res: Response) => {
  try {
    const { customerId } = req.params;

    const [customer] = await sql`
      SELECT id, loyalty_points FROM customers
      WHERE id = ${customerId}
    `;

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    res.json({ points: customer.loyalty_points || 0 });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// Redeem a reward
// ==========================================
const redeemSchema = z.object({
  customerId: z.string().uuid(),
  rewardId: z.string().uuid(),
});

router.post('/redeem', async (req: Request, res: Response) => {
  try {
    const { customerId, rewardId } = redeemSchema.parse(req.body);

    // Get reward details
    const [reward] = await sql`
      SELECT * FROM loyalty_rewards
      WHERE id = ${rewardId} AND is_active = true
    `;

    if (!reward) {
      return res.status(404).json({ error: 'Reward not found' });
    }

    // Get customer points
    const [customer] = await sql`
      SELECT id, loyalty_points FROM customers
      WHERE id = ${customerId}
    `;

    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    if (customer.loyalty_points < reward.points_required) {
      return res.status(400).json({ error: 'Not enough points' });
    }

    // Deduct points
    await sql`
      UPDATE customers
      SET loyalty_points = loyalty_points - ${reward.points_required}
      WHERE id = ${customerId}
    `;

    // Record transaction
    await sql`
      INSERT INTO loyalty_transactions (customer_id, points, type, description)
      VALUES (${customerId}, ${-reward.points_required}, 'redeemed', ${'Redeemed: ' + reward.name})
    `;

    res.json({ success: true, pointsDeducted: reward.points_required });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ADMIN: Create/manage loyalty rewards
// ==========================================
const rewardSchema = z.object({
  name: z.string().min(1),
  name_en: z.string().optional(),
  description: z.string().optional(),
  points_required: z.number().min(1),
  discount_type: z.enum(['percentage', 'fixed']),
  discount_value: z.number().min(0),
  is_active: z.boolean().optional().default(true),
});

router.post('/rewards', authMiddleware, async (req: Request, res: Response) => {
  try {
    const tenantId = req.headers['x-tenant-id'] as string;
    const data = rewardSchema.parse(req.body);

    const [reward] = await sql`
      INSERT INTO loyalty_rewards (tenant_id, name, name_en, description, points_required, discount_type, discount_value, is_active)
      VALUES (${tenantId}, ${data.name}, ${data.name_en || null}, ${data.description || null}, ${data.points_required}, ${data.discount_type}, ${data.discount_value}, ${data.is_active})
      RETURNING *
    `;

    res.status(201).json(reward);
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    res.status(500).json({ error: error.message });
  }
});

router.put('/rewards/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.headers['x-tenant-id'] as string;
    const data = rewardSchema.partial().parse(req.body);

    const [reward] = await sql`
      UPDATE loyalty_rewards
      SET
        name = COALESCE(${data.name || null}, name),
        name_en = COALESCE(${data.name_en || null}, name_en),
        description = COALESCE(${data.description || null}, description),
        points_required = COALESCE(${data.points_required || null}, points_required),
        discount_type = COALESCE(${data.discount_type || null}, discount_type),
        discount_value = COALESCE(${data.discount_value || null}, discount_value),
        is_active = COALESCE(${data.is_active ?? null}, is_active)
      WHERE id = ${id} AND tenant_id = ${tenantId}
      RETURNING *
    `;

    if (!reward) {
      return res.status(404).json({ error: 'Reward not found' });
    }

    res.json(reward);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// ADMIN: Award points to a customer (e.g. after order)
// ==========================================
router.post('/award', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { customerId, points, description } = z.object({
      customerId: z.string().uuid(),
      points: z.number().min(1),
      description: z.string().optional(),
    }).parse(req.body);

    await sql`
      UPDATE customers
      SET loyalty_points = loyalty_points + ${points}
      WHERE id = ${customerId}
    `;

    await sql`
      INSERT INTO loyalty_transactions (customer_id, points, type, description)
      VALUES (${customerId}, ${points}, 'earned', ${description || 'Points earned'})
    `;

    res.json({ success: true, pointsAwarded: points });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation error', details: error.errors });
    }
    res.status(500).json({ error: error.message });
  }
});

export default router;
