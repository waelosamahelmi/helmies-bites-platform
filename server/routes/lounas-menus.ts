import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db, logger } from '../db.js';
import { authMiddleware, requireTenantAdmin } from '../middleware/auth.js';

const router = Router();

// Validation schemas
const createLounasMenuSchema = z.object({
  name: z.string().min(1).max(255),
  name_en: z.string().max(255).optional(),
  description: z.string().optional(),
  description_en: z.string().optional(),
  date: z.string().date(),
  price: z.number().positive(),
  currency: z.string().default('EUR'),
  soup_of_the_day: z.string().optional(),
  salad: z.string().optional(),
  main_course: z.string().optional(),
  dessert: z.string().optional(),
  drinks: z.array(z.string()).default([]),
  is_active: z.boolean().default(true),
  metadata: z.record(z.any()).optional(),
});

const updateLounasMenuSchema = createLounasMenuSchema.partial().extend({
  is_active: z.boolean().optional(),
});

/**
 * GET /api/lounas-menus
 * List all lunch menus (tenant admin)
 */
router.get('/', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { date, is_active, limit = 50, offset = 0 } = req.query;
    const tenantId = req.user?.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Tenant ID is required',
      });
    }

    let conditions: any = { tenant_id: tenantId };

    if (date) conditions.date = date;
    if (is_active) conditions.is_active = is_active === 'true';

    const lounasMenus = await db.lounasMenus.findAll(conditions, limit as number, offset as number, 'date ASC');

    logger.info({
      count: lounasMenus.length,
      tenantId,
      userId: req.user?.id,
    }, 'Listed lunch menus');

    res.json({
      lounasMenus,
      count: lounasMenus.length,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error listing lunch menus');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to list lunch menus',
    });
  }
});

/**
 * GET /api/lounas-menus/:id
 * Get lunch menu details
 */
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const lounasMenu = await db.lounasMenus.findOne({ id });

    if (!lounasMenu) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Lunch menu not found',
      });
    }

    // Check authorization
    const isAdmin = req.user?.role === 'helmies_admin' || req.user?.role === 'admin';
    const isOwnTenant = lounasMenu.tenant_id === tenantId;

    if (!isAdmin && !isOwnTenant) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to view this lunch menu',
      });
    }

    // Get orders for this lunch menu
    const orders = await db.lounasMenus.getOrders(id);

    logger.info({
      lounasMenuId: id,
      userId: req.user?.id,
    }, 'Retrieved lunch menu details');

    res.json({
      lounasMenu,
      orders,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      lounasMenuId: req.params.id,
    }, 'Error retrieving lunch menu');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve lunch menu',
    });
  }
});

/**
 * POST /api/lounas-menus
 * Create new lunch menu
 */
router.post('/', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const validationResult = createLounasMenuSchema.safeParse(req.body);

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

    // Check if lunch menu already exists for this date
    const existingMenu = await db.lounasMenus.findOne({ date: data.date, tenant_id: tenantId });
    if (existingMenu) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'A lunch menu already exists for this date',
      });
    }

    const lounasMenu = await db.lounasMenus.create(data);

    logger.info({
      lounasMenuId: lounasMenu.id,
      date: lounasMenu.date,
      tenantId,
      userId: req.user?.id,
    }, 'Created new lunch menu');

    res.status(201).json({
      lounasMenu,
      message: 'Lunch menu created successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error creating lunch menu');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create lunch menu',
    });
  }
});

/**
 * PUT /api/lounas-menus/:id
 * Update lunch menu
 */
router.put('/:id', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const validationResult = updateLounasMenuSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        error: 'Validation Error',
        details: validationResult.error.errors,
      });
    }

    const data = validationResult.data;

    // Verify lunch menu exists and belongs to tenant
    const existingMenu = await db.lounasMenus.findOne({ id, tenant_id: tenantId });
    if (!existingMenu) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Lunch menu not found',
      });
    }

    // If date is being updated, check for conflicts
    if (data.date && data.date !== existingMenu.date) {
      const existingWithSameDate = await db.lounasMenus.findOne({ date: data.date, tenant_id: tenantId });
      if (existingWithSameDate) {
        return res.status(409).json({
          error: 'Conflict',
          message: 'A lunch menu already exists for this date',
        });
      }
    }

    const lounasMenu = await db.lounasMenus.update(id, data);

    logger.info({
      lounasMenuId: id,
      tenantId,
      userId: req.user?.id,
      changes: Object.keys(data),
    }, 'Updated lunch menu');

    res.json({
      lounasMenu,
      message: 'Lunch menu updated successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      lounasMenuId: req.params.id,
    }, 'Error updating lunch menu');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update lunch menu',
    });
  }
});

/**
 * DELETE /api/lounas-menus/:id
 * Delete lunch menu
 */
router.delete('/:id', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    // Verify lunch menu exists and belongs to tenant
    const lounasMenu = await db.lounasMenus.findOne({ id, tenant_id: tenantId });
    if (!lounasMenu) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Lunch menu not found',
      });
    }

    // Check if lunch menu has orders
    const hasOrders = await db.lounasMenus.hasOrders(id);
    if (hasOrders) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Cannot delete lunch menu that has orders. Please deactivate it instead.',
      });
    }

    await db.lounasMenus.delete(id);

    logger.info({
      lounasMenuId: id,
      tenantId,
      userId: req.user?.id,
    }, 'Deleted lunch menu');

    res.json({
      message: 'Lunch menu deleted successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      lounasMenuId: req.params.id,
    }, 'Error deleting lunch menu');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to delete lunch menu',
    });
  }
});

/**
 * POST /api/lounas-menus/:id/toggle-active
 * Toggle lunch menu active status
 */
router.post('/:id/toggle-active', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const lounasMenu = await db.lounasMenus.findOne({ id, tenant_id: tenantId });
    if (!lounasMenu) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Lunch menu not found',
      });
    }

    const updated = await db.lounasMenus.update(id, {
      is_active: !lounasMenu.is_active,
    });

    logger.info({
      lounasMenuId: id,
      tenantId,
      newActiveStatus: !lounasMenu.is_active,
      userId: req.user?.id,
    }, 'Toggled lunch menu active status');

    res.json({
      lounasMenu: updated,
      message: 'Lunch menu active status updated successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      lounasMenuId: req.params.id,
    }, 'Error toggling lunch menu active status');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to toggle lunch menu active status',
    });
  }
});

/**
 * GET /api/lounas-menus/current
 * Get current lunch menu (today)
 */
router.get('/current', authMiddleware, async (req: Request, res: Response) => {
  try {
    const tenantId = req.user?.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Tenant ID is required',
      });
    }

    // Get today's date
    const today = new Date().toISOString().split('T')[0];

    const lounasMenu = await db.lounasMenus.findOne({
      date: today,
      tenant_id: tenantId,
      is_active: true,
    });

    logger.info({
      date: today,
      tenantId,
      hasMenu: !!lounasMenu,
    }, 'Retrieved current lunch menu');

    res.json({
      lounasMenu,
      date: today,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 'Error retrieving current lunch menu');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve current lunch menu',
    });
  }
});

/**
 * GET /api/lounas-menus/future
 * Get upcoming lunch menus
 */
router.get('/future', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { limit = 7 } = req.query;
    const tenantId = req.user?.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Tenant ID is required',
      });
    }

    // Get upcoming dates (next 7 days)
    const startDate = new Date().toISOString().split('T')[0];
    const endDate = new Date();
    endDate.setDate(endDate.getDate() + 7);
    const endDateStr = endDate.toISOString().split('T')[0];

    const lounasMenus = await db.lounasMenus.findAll({
      tenant_id: tenantId,
      is_active: true,
      date: { $gte: startDate, $lte: endDateStr },
    }, limit as number, 0, 'date ASC');

    logger.info({
      count: lounasMenus.length,
      tenantId,
    }, 'Retrieved future lunch menus');

    res.json({
      lounasMenus,
      count: lounasMenus.length,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error retrieving future lunch menus');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve future lunch menus',
    });
  }
});

export default router;