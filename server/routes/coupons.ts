import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db, logger } from '../db.js';
import { authMiddleware, requireTenantAdmin } from '../middleware/auth.js';

const router = Router();

// Validation schemas
const createCouponSchema = z.object({
  code: z.string().min(1).max(50).regex(/^[A-Z0-9_-]+$/i, 'Code can only contain letters, numbers, hyphens, and underscores'),
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  type: z.enum(['percentage', 'fixed_amount']),
  value: z.number().positive(),
  max_redemptions: z.number().int().min(1).optional(),
  valid_from: z.string().datetime().optional(),
  valid_until: z.string().datetime().optional(),
  min_order_value: z.number().min(0).optional(),
  applicable_categories: z.array(z.string().uuid()).default([]),
  applicable_menu_items: z.array(z.string().uuid()).default([]),
  is_active: z.boolean().default(true),
  usage_limit_per_customer: z.number().int().min(1).optional(),
  metadata: z.record(z.any()).optional(),
});

const updateCouponSchema = createCouponSchema.partial().extend({
  is_active: z.boolean().optional(),
});

/**
 * GET /api/coupons
 * List all coupons (tenant admin)
 */
router.get('/', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { code, is_active, type, limit = 50, offset = 0 } = req.query;
    const tenantId = req.user?.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Tenant ID is required',
      });
    }

    let conditions: any = { tenant_id: tenantId };

    if (code) conditions.code = { ilike: `%${code}%` };
    if (is_active) conditions.is_active = is_active === 'true';
    if (type) conditions.type = type;

    const coupons = await db.coupons.findAll(conditions, limit as number, offset as number, 'created_at DESC');

    // Get usage statistics for each coupon
    const couponsWithStats = await Promise.all(
      coupons.map(async (coupon) => {
        const stats = await db.coupons.getUsageStats(coupon.id);
        return { ...coupon, ...stats };
      })
    );

    logger.info({
      count: coupons.length,
      tenantId,
      userId: req.user?.id,
    }, 'Listed coupons');

    res.json({
      coupons: couponsWithStats,
      count: coupons.length,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error listing coupons');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to list coupons',
    });
  }
});

/**
 * GET /api/coupons/:id
 * Get coupon details with usage statistics
 */
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const coupon = await db.coupons.findOne({ id });

    if (!coupon) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Coupon not found',
      });
    }

    // Check authorization
    const isAdmin = req.user?.role === 'helmies_admin' || req.user?.role === 'admin';
    const isOwnTenant = coupon.tenant_id === tenantId;

    if (!isAdmin && !isOwnTenant) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to view this coupon',
      });
    }

    // Get usage statistics
    const stats = await db.coupons.getUsageStats(id);

    logger.info({
      couponId: id,
      userId: req.user?.id,
    }, 'Retrieved coupon details');

    res.json({
      coupon,
      stats,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      couponId: req.params.id,
    }, 'Error retrieving coupon');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve coupon',
    });
  }
});

/**
 * POST /api/coupons
 * Create new coupon
 */
router.post('/', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const validationResult = createCouponSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        error: 'Validation Error',
        details: validationResult.error.errors,
      });
    }

    const data = validationResult.data;
    const tenantId = req.user?.tenant_id;

    // Ensure tenant is set
    data.tenant_id = tenantId;

    // Check if coupon code already exists
    const existingCoupon = await db.coupons.findOne({ code: data.code.toUpperCase(), tenant_id: tenantId });
    if (existingCoupon) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'A coupon with this code already exists',
      });
    }

    // Normalize code to uppercase
    data.code = data.code.toUpperCase();

    const coupon = await db.coupons.create(data);

    logger.info({
      couponId: coupon.id,
      code: coupon.code,
      tenantId,
      userId: req.user?.id,
    }, 'Created new coupon');

    res.status(201).json({
      coupon,
      message: 'Coupon created successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error creating coupon');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create coupon',
    });
  }
});

/**
 * PUT /api/coupons/:id
 * Update coupon
 */
router.put('/:id', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const validationResult = updateCouponSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        error: 'Validation Error',
        details: validationResult.error.errors,
      });
    }

    const data = validationResult.data;

    // Verify coupon exists and belongs to tenant
    const existingCoupon = await db.coupons.findOne({ id, tenant_id: tenantId });
    if (!existingCoupon) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Coupon not found',
      });
    }

    // If code is being updated, check for duplicates
    if (data.code) {
      const existingWithSameCode = await db.coupons.findOne({
        code: data.code.toUpperCase(),
        tenant_id: tenantId,
        id: { $ne: id }
      });
      if (existingWithSameCode) {
        return res.status(409).json({
          error: 'Conflict',
          message: 'A coupon with this code already exists',
        });
      }
      data.code = data.code.toUpperCase();
    }

    const coupon = await db.coupons.update(id, data);

    logger.info({
      couponId: id,
      tenantId,
      userId: req.user?.id,
      changes: Object.keys(data),
    }, 'Updated coupon');

    res.json({
      coupon,
      message: 'Coupon updated successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      couponId: req.params.id,
    }, 'Error updating coupon');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update coupon',
    });
  }
});

/**
 * DELETE /api/coupons/:id
 * Delete coupon
 */
router.delete('/:id', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    // Verify coupon exists and belongs to tenant
    const coupon = await db.coupons.findOne({ id, tenant_id: tenantId });
    if (!coupon) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Coupon not found',
      });
    }

    // Check if coupon has been used
    const usageStats = await db.coupons.getUsageStats(id);
    if (usageStats.total_used > 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Cannot delete coupon that has already been used. Please deactivate it instead.',
      });
    }

    await db.coupons.delete(id);

    logger.info({
      couponId: id,
      tenantId,
      userId: req.user?.id,
    }, 'Deleted coupon');

    res.json({
      message: 'Coupon deleted successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      couponId: req.params.id,
    }, 'Error deleting coupon');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to delete coupon',
    });
  }
});

/**
 * POST /api/coupons/:id/toggle-active
 * Toggle coupon active status
 */
router.post('/:id/toggle-active', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const coupon = await db.coupons.findOne({ id, tenant_id: tenantId });
    if (!coupon) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Coupon not found',
      });
    }

    const updated = await db.coupons.update(id, {
      is_active: !coupon.is_active,
    });

    logger.info({
      couponId: id,
      tenantId,
      newActiveStatus: !coupon.is_active,
      userId: req.user?.id,
    }, 'Toggled coupon active status');

    res.json({
      coupon: updated,
      message: 'Coupon active status updated successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      couponId: req.params.id,
    }, 'Error toggling coupon active status');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to toggle coupon active status',
    });
  }
});

/**
 * POST /api/coupons/:id/validate
 * Validate coupon for use
 */
router.post('/:id/validate', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { order_total, customer_id } = req.body;
    const tenantId = req.user?.tenant_id;

    if (!order_total) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'order_total is required',
      });
    }

    const coupon = await db.coupons.findOne({ id, tenant_id: tenantId });
    if (!coupon) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Coupon not found',
      });
    }

    // Check if coupon is active
    if (!coupon.is_active) {
      return res.status(400).json({
        error: 'Invalid',
        message: 'Coupon is not active',
      });
    }

    // Check coupon validity dates
    const now = new Date().toISOString();
    if (coupon.valid_from && now < coupon.valid_from) {
      return res.status(400).json({
        error: 'Invalid',
        message: 'Coupon is not valid yet',
      });
    }
    if (coupon.valid_until && now > coupon.valid_until) {
      return res.status(400).json({
        error: 'Expired',
        message: 'Coupon has expired',
      });
    }

    // Check minimum order value
    if (coupon.min_order_value && order_total < coupon.min_order_value) {
      return res.status(400).json({
        error: 'Invalid',
        message: `Minimum order value is ${coupon.min_order_value}`,
      });
    }

    // Check usage limits
    const stats = await db.coupons.getUsageStats(id);

    // Check total redemptions
    if (coupon.max_redemptions && stats.total_used >= coupon.max_redemptions) {
      return res.status(400).json({
        error: 'Exhausted',
        message: 'Coupon has reached its maximum redemption limit',
      });
    }

    // Check per customer limit
    if (customer_id && coupon.usage_limit_per_customer) {
      const customerUsage = await db.coupons.getCustomerUsage(id, customer_id);
      if (customerUsage >= coupon.usage_limit_per_customer) {
        return res.status(400).json({
          error: 'Exhausted',
          message: `You have reached the maximum usage limit for this coupon`,
        });
      }
    }

    logger.info({
      couponId: id,
      tenantId,
      customerUsage: customer_id ? stats.customer_usage || 0 : undefined,
    }, 'Coupon validated successfully');

    res.json({
      coupon,
      discount_amount: coupon.type === 'percentage'
        ? order_total * (coupon.value / 100)
        : coupon.value,
      message: 'Coupon is valid',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      couponId: req.params.id,
    }, 'Error validating coupon');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to validate coupon',
    });
  }
});

export default router;