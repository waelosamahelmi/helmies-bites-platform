import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db, logger } from '../db.js';
import { authMiddleware, requireAdmin } from '../middleware/auth.js';

const router = Router();

// Validation schemas
const createTenantSchema = z.object({
  slug: z.string().min(2).max(100).regex(/^[a-z0-9-]+$/, 'Slug must contain only lowercase letters, numbers, and hyphens'),
  name: z.string().min(2).max(255),
  name_en: z.string().max(255).optional(),
  description: z.string().optional(),
  description_en: z.string().optional(),
  subscription_tier: z.enum(['starter', 'pro', 'enterprise']).optional().default('starter'),
  stripe_customer_id: z.string().optional(),
  helmies_fee_percentage: z.number().min(0).max(100).optional().default(5),
  monthly_fee: z.number().min(0).optional().default(0),
  features: z.object({
    cashOnDelivery: z.boolean().optional().default(false),
    aiAssistant: z.boolean().optional().default(false),
    delivery: z.boolean().optional().default(true),
    pickup: z.boolean().optional().default(true),
    lunch: z.boolean().optional().default(false),
    multiBranch: z.boolean().optional().default(false),
  }).optional(),
  metadata: z.record(z.any()).optional(),
});

const updateTenantSchema = createTenantSchema.partial().extend({
  status: z.enum(['pending', 'active', 'suspended', 'cancelled']).optional(),
});

/**
 * GET /api/tenants
 * List all tenants (admin only)
 */
router.get('/', authMiddleware, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { status, subscription_tier, search } = req.query;

    let conditions: any = {};

    if (status) {
      conditions.status = status;
    }

    if (subscription_tier) {
      conditions.subscription_tier = subscription_tier;
    }

    let tenants;

    if (search) {
      // Search by name or slug
      tenants = await db.tenants.findAll();
      tenants = tenants.filter((t: any) =>
        t.name.toLowerCase().includes((search as string).toLowerCase()) ||
        t.slug.toLowerCase().includes((search as string).toLowerCase())
      );
    } else {
      tenants = await db.tenants.findAll(conditions);
    }

    logger.info({
      count: tenants.length,
      userId: req.user?.id,
    }, 'Listed tenants');

    res.json({
      tenants,
      count: tenants.length,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 'Error listing tenants');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to list tenants',
    });
  }
});

/**
 * GET /api/tenants/:id
 * Get tenant details
 */
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const tenant = await db.tenants.findOne({ id });

    if (!tenant) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Tenant not found',
      });
    }

    // Check authorization - admin or own tenant
    const isAdmin = req.user?.role === 'helmies_admin' || req.user?.role === 'admin';
    const isOwnTenant = req.user?.tenant_id === id;

    if (!isAdmin && !isOwnTenant) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to view this tenant',
      });
    }

    // Get tenant statistics
    const stats = await db.statistics.getTenantStats(id);

    // Get tenant domains
    const domains = await db.tenantDomains.findByTenantId(id);

    // Get onboarding tasks
    const tasks = await db.onboardingTasks.findByTenantId(id);

    logger.info({
      tenantId: id,
      userId: req.user?.id,
    }, 'Retrieved tenant details');

    res.json({
      tenant,
      statistics: stats,
      domains,
      onboardingTasks: tasks,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.params.id,
    }, 'Error retrieving tenant');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve tenant',
    });
  }
});

/**
 * GET /api/tenants/slug/:slug
 * Get tenant by slug (public endpoint for subdomain lookup)
 */
router.get('/slug/:slug', async (req: Request, res: Response) => {
  try {
    const { slug } = req.params;

    const tenant = await db.tenants.findOne({ slug });

    if (!tenant) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Tenant not found',
      });
    }

    // Only return active tenants for public lookup
    if (tenant.status !== 'active') {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Tenant not available',
      });
    }

    // Return limited data for public lookup
    res.json({
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      name_en: tenant.name_en,
      status: tenant.status,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      slug: req.params.slug,
    }, 'Error retrieving tenant by slug');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve tenant',
    });
  }
});

/**
 * POST /api/tenants
 * Create new tenant (admin only)
 */
router.post('/', authMiddleware, requireAdmin, async (req: Request, res: Response) => {
  try {
    const validationResult = createTenantSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        error: 'Validation Error',
        details: validationResult.error.errors,
      });
    }

    const data = validationResult.data;

    // Check if slug already exists
    const existing = await db.tenants.findOne({ slug: data.slug });
    if (existing) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'A tenant with this slug already exists',
      });
    }

    const tenant = await db.tenants.create(data);

    logger.info({
      tenantId: tenant.id,
      slug: tenant.slug,
      userId: req.user?.id,
    }, 'Created new tenant');

    res.status(201).json({
      tenant,
      message: 'Tenant created successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 'Error creating tenant');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create tenant',
    });
  }
});

/**
 * PUT /api/tenants/:id
 * Update tenant (admin or own tenant admin)
 */
router.put('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Check authorization
    const isAdmin = req.user?.role === 'helmies_admin' || req.user?.role === 'admin';
    const isOwnTenant = req.user?.tenant_id === id;

    if (!isAdmin && !isOwnTenant) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to update this tenant',
      });
    }

    const validationResult = updateTenantSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        error: 'Validation Error',
        details: validationResult.error.errors,
      });
    }

    const data = validationResult.data;

    // If features changed, recalculate monthly fee
    if (data.features && isAdmin) {
      const currentTenant = await db.tenants.findOne({ id });
      if (currentTenant) {
        const newFee = calculateMonthlyFee(data.features);
        data.monthly_fee = newFee;
      }
    }

    const tenant = await db.tenants.update(id, data);

    if (!tenant) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Tenant not found',
      });
    }

    logger.info({
      tenantId: id,
      userId: req.user?.id,
      changes: Object.keys(data),
    }, 'Updated tenant');

    res.json({
      tenant,
      message: 'Tenant updated successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.params.id,
    }, 'Error updating tenant');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update tenant',
    });
  }
});

/**
 * DELETE /api/tenants/:id
 * Suspend/delete tenant (admin only)
 */
router.delete('/:id', authMiddleware, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const tenant = await db.tenants.findOne({ id });

    if (!tenant) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Tenant not found',
      });
    }

    // Soft delete by setting status to cancelled
    const updated = await db.tenants.update(id, { status: 'cancelled' });

    logger.info({
      tenantId: id,
      userId: req.user?.id,
    }, 'Cancelled tenant');

    res.json({
      tenant: updated,
      message: 'Tenant cancelled successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.params.id,
    }, 'Error cancelling tenant');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to cancel tenant',
    });
  }
});

/**
 * POST /api/tenants/:id/suspend
 * Suspend tenant (admin only)
 */
router.post('/:id/suspend', authMiddleware, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const tenant = await db.tenants.update(id, {
      status: 'suspended',
      metadata: {
        ...(tenant?.metadata || {}),
        suspension_reason: reason,
        suspended_at: new Date().toISOString(),
      },
    });

    logger.info({
      tenantId: id,
      userId: req.user?.id,
      reason,
    }, 'Suspended tenant');

    res.json({
      tenant,
      message: 'Tenant suspended successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.params.id,
    }, 'Error suspending tenant');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to suspend tenant',
    });
  }
});

/**
 * POST /api/tenants/:id/activate
 * Activate tenant (admin only)
 */
router.post('/:id/activate', authMiddleware, requireAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const tenant = await db.tenants.update(id, { status: 'active' });

    logger.info({
      tenantId: id,
      userId: req.user?.id,
    }, 'Activated tenant');

    res.json({
      tenant,
      message: 'Tenant activated successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.params.id,
    }, 'Error activating tenant');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to activate tenant',
    });
  }
});

// Helper function to calculate monthly fee
function calculateMonthlyFee(features: any): number {
  let fee = 0;

  if (features?.cashOnDelivery) fee += 30;
  if (features?.aiAssistant) fee += 10;

  return fee;
}

export default router;
