import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db, logger } from '../db.js';
import { authMiddleware, requireTenantAdmin } from '../middleware/auth.js';

const router = Router();

// Validation schemas
const createLounasSettingsSchema = z.object({
  tenant_id: z.string().uuid(),
  is_enabled: z.boolean().default(false),
  order_deadline_hours: z.number().int().min(1).default(24),
  pickup_time_minutes: z.number().int().min(15).default(30),
  price: z.number().positive().default(12.90),
  currency: z.string().default('EUR'),
  max_orders_per_day: z.number().int().min(1).default(100),
  available_days: z.array(z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday'])).default(['monday', 'tuesday', 'wednesday', 'thursday', 'friday']),
  soup_of_the_day_selection: z.array(z.string()).default([]),
  salad_selection: z.array(z.string()).default([]),
  main_course_selection: z.array(z.string()).default([]),
  dessert_selection: z.array(z.string()).default([]),
  drink_selection: z.array(z.string()).default([]),
  dietary_options: z.array(z.string()).default(['vegetarian', 'gluten-free']),
  metadata: z.record(z.any()).optional(),
});

const updateLounasSettingsSchema = createLounasSettingsSchema.partial().extend({
  tenant_id: z.string().uuid(),
});

/**
 * GET /api/lounas-settings
 * Get lunch settings (tenant admin)
 */
router.get('/', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const tenantId = req.user?.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Tenant ID is required',
      });
    }

    const settings = await db.lounasSettings.findOne({ tenant_id: tenantId });

    if (!settings) {
      // Return default settings if none exist
      const defaultSettings = {
        is_enabled: false,
        order_deadline_hours: 24,
        pickup_time_minutes: 30,
        price: 12.90,
        currency: 'EUR',
        max_orders_per_day: 100,
        available_days: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
        soup_of_the_day_selection: [],
        salad_selection: [],
        main_course_selection: [],
        dessert_selection: [],
        drink_selection: [],
        dietary_options: ['vegetarian', 'gluten-free'],
      };
      return res.json({
        settings: defaultSettings,
        message: 'No settings found, returning defaults',
      });
    }

    logger.info({
      tenantId,
      userId: req.user?.id,
    }, 'Retrieved lunch settings');

    res.json({
      settings,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error retrieving lunch settings');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve lunch settings',
    });
  }
});

/**
 * GET /api/lounas-settings/current
 * Get current lunch settings for public API (optional auth)
 */
router.get('/current', async (req: Request, res: Response) => {
  try {
    // Extract tenant from subdomain or header
    const tenantSlug = req.headers['x-tenant-slug'] as string;

    if (!tenantSlug) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Tenant not specified',
      });
    }

    const tenant = await db.tenants.findOne({ slug: tenantSlug });
    if (!tenant) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Tenant not found',
      });
    }

    const settings = await db.lounasSettings.findOne({ tenant_id: tenant.id });

    if (!settings || !settings.is_enabled) {
      return res.json({
        is_enabled: false,
        message: 'Lunch service is not enabled',
      });
    }

    logger.info({
      tenantId: tenant.id,
    }, 'Retrieved current lunch settings for public API');

    res.json({
      settings,
      tenant: {
        id: tenant.id,
        slug: tenant.slug,
        name: tenant.name,
      },
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 'Error retrieving current lunch settings');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve lunch settings',
    });
  }
});

/**
 * POST /api/lounas-settings
 * Create or update lunch settings (tenant admin)
 */
router.post('/', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const validationResult = createLounasSettingsSchema.safeParse(req.body);

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

    // Check if settings already exist
    const existingSettings = await db.lounasSettings.findOne({ tenant_id: tenantId });

    if (existingSettings) {
      // Update existing settings
      const settings = await db.lounasSettings.update(existingSettings.id, data);

      logger.info({
        settingsId: existingSettings.id,
        tenantId,
        userId: req.user?.id,
      }, 'Updated lunch settings');

      res.json({
        settings,
        message: 'Lunch settings updated successfully',
      });
    } else {
      // Create new settings
      const settings = await db.lounasSettings.create(data);

      logger.info({
        settingsId: settings.id,
        tenantId,
        userId: req.user?.id,
      }, 'Created lunch settings');

      res.status(201).json({
        settings,
        message: 'Lunch settings created successfully',
      });
    }
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error creating/updating lunch settings');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create/update lunch settings',
    });
  }
});

/**
 * PUT /api/lounas-settings/:id
 * Update lunch settings (tenant admin)
 */
router.put('/:id', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const validationResult = updateLounasSettingsSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        error: 'Validation Error',
        details: validationResult.error.errors,
      });
    }

    const data = validationResult.data;

    // Verify settings exist and belong to tenant
    const existingSettings = await db.lounasSettings.findOne({ id, tenant_id: tenantId });
    if (!existingSettings) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Lunch settings not found',
      });
    }

    const settings = await db.lounasSettings.update(id, data);

    logger.info({
      settingsId: id,
      tenantId,
      userId: req.user?.id,
      changes: Object.keys(data),
    }, 'Updated lunch settings');

    res.json({
      settings,
      message: 'Lunch settings updated successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      settingsId: req.params.id,
    }, 'Error updating lunch settings');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update lunch settings',
    });
  }
});

/**
 * POST /api/lounas-settings/toggle-enabled
 * Toggle lunch service enabled/disabled (tenant admin)
 */
router.post('/toggle-enabled', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const tenantId = req.user?.tenant_id;

    const settings = await db.lounasSettings.findOne({ tenant_id: tenantId });
    if (!settings) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Lunch settings not found',
      });
    }

    const updated = await db.lounasSettings.update(settings.id, {
      is_enabled: !settings.is_enabled,
    });

    logger.info({
      settingsId: settings.id,
      tenantId,
      newEnabledStatus: !settings.is_enabled,
      userId: req.user?.id,
    }, 'Toggled lunch service enabled status');

    res.json({
      settings: updated,
      message: `Lunch service ${!settings.is_enabled ? 'enabled' : 'disabled'} successfully`,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error toggling lunch service enabled status');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to toggle lunch service status',
    });
  }
});

/**
 * POST /api/lounas-settings/check-availability
 * Check if lunch service is available (public API)
 */
router.post('/check-availability', async (req: Request, res: Response) => {
  try {
    const { date, estimated_pickup_time } = req.body;

    if (!date) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'date is required',
      });
    }

    // Extract tenant from subdomain or header
    const tenantSlug = req.headers['x-tenant-slug'] as string;

    if (!tenantSlug) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Tenant not specified',
      });
    }

    const tenant = await db.tenants.findOne({ slug: tenantSlug });
    if (!tenant) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Tenant not found',
      });
    }

    const settings = await db.lounasSettings.findOne({ tenant_id: tenant.id });

    if (!settings || !settings.is_enabled) {
      return res.json({
        is_available: false,
        reason: 'Lunch service is not enabled',
      });
    }

    // Check if date is an available day
    const dayOfWeek = new Date(date).toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    if (!settings.available_days.includes(dayOfWeek)) {
      return res.json({
        is_available: false,
        reason: 'Lunch service not available on this day',
      });
    }

    // Check deadline
    const deadlineTime = new Date(date);
    deadlineTime.setHours(deadlineTime.getHours() - settings.order_deadline_hours);
    const now = new Date();

    if (now > deadlineTime) {
      return res.json({
        is_available: false,
        reason: 'Order deadline has passed',
      });
    }

    // Check daily order limit
    const ordersCount = await db.lounasSettings.getDailyOrdersCount(tenant.id, date);
    if (ordersCount >= settings.max_orders_per_day) {
      return res.json({
        is_available: false,
        reason: 'Maximum daily orders reached',
      });
    }

    // If estimated pickup time provided, check capacity
    if (estimated_pickup_time) {
      const pickupTime = new Date(estimated_pickup_time);
      const ordersAtTime = await db.lounasSettings.getOrdersAtTime(tenant.id, date, pickupTime);

      // Simple capacity check - in production you'd have more sophisticated logic
      if (ordersAtTime >= 20) { // Example capacity
        return res.json({
          is_available: false,
          reason: 'Limited capacity at requested time',
        });
      }
    }

    logger.info({
      tenantId: tenant.id,
      date,
      estimatedPickupTime: estimated_pickup_time,
    }, 'Checked lunch availability');

    res.json({
      is_available: true,
      settings,
      deadline_time: deadlineTime.toISOString(),
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 'Error checking lunch availability');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to check lunch availability',
    });
  }
});

export default router;