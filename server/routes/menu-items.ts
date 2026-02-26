import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db, logger } from '../db.js';
import { authMiddleware, requireTenantAdmin } from '../middleware/auth.js';

const router = Router();

// Validation schemas
const createMenuItemSchema = z.object({
  category_id: z.string().uuid(),
  name: z.string().min(1).max(255),
  name_en: z.string().max(255).optional(),
  description: z.string().optional(),
  description_en: z.string().optional(),
  price: z.number().positive(),
  currency: z.string().default('EUR'),
  image_url: z.string().url().optional(),
  image_public_id: z.string().optional(),
  is_available: z.boolean().default(true),
  is_popular: z.boolean().default(false),
  allergens: z.array(z.string()).default([]),
  dietary_restrictions: z.array(z.string()).default([]),
  preparation_time_minutes: z.number().int().positive().optional(),
  ingredients: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  sort_order: z.number().int().min(0).optional(),
  metadata: z.record(z.any()).optional(),
});

const updateMenuItemSchema = createMenuItemSchema.partial().extend({
  is_available: z.boolean().optional(),
});

/**
 * GET /api/menu-items
 * List all menu items (tenant admin)
 */
router.get('/', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { category_id, is_available, is_popular, limit = 50, offset = 0 } = req.query;
    const tenantId = req.user?.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Tenant ID is required',
      });
    }

    let conditions: any = { tenant_id: tenantId };

    if (category_id) conditions.category_id = category_id;
    if (is_available) conditions.is_available = is_available === 'true';
    if (is_popular) conditions.is_popular = is_popular === 'true';

    const menuItems = await db.menuItems.findAll(conditions, limit as number, offset as number);

    // Get category details for each menu item
    const menuItemsWithCategories = await Promise.all(
      menuItems.map(async (item) => {
        if (item.category_id) {
          const category = await db.categories.findOne({ id: item.category_id });
          return { ...item, category };
        }
        return item;
      })
    );

    logger.info({
      count: menuItems.length,
      tenantId,
      userId: req.user?.id,
    }, 'Listed menu items');

    res.json({
      menuItems: menuItemsWithCategories,
      count: menuItems.length,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error listing menu items');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to list menu items',
    });
  }
});

/**
 * GET /api/menu-items/:id
 * Get menu item details
 */
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const menuItem = await db.menuItems.findOne({ id });

    if (!menuItem) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Menu item not found',
      });
    }

    // Check authorization
    const isAdmin = req.user?.role === 'helmies_admin' || req.user?.role === 'admin';
    const isOwnTenant = menuItem.tenant_id === tenantId;

    if (!isAdmin && !isOwnTenant) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to view this menu item',
      });
    }

    // Get category details
    let category = null;
    if (menuItem.category_id) {
      category = await db.categories.findOne({ id: menuItem.category_id });
    }

    logger.info({
      menuItemId: id,
      userId: req.user?.id,
    }, 'Retrieved menu item details');

    res.json({
      menuItem,
      category,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      menuItemId: req.params.id,
    }, 'Error retrieving menu item');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve menu item',
    });
  }
});

/**
 * POST /api/menu-items
 * Create new menu item
 */
router.post('/', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const validationResult = createMenuItemSchema.safeParse(req.body);

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

    // Verify category exists and belongs to tenant
    if (data.category_id) {
      const category = await db.categories.findOne({ id: data.category_id, tenant_id: tenantId });
      if (!category) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Category not found',
        });
      }
    }

    // Set default sort order if not provided
    if (!data.sort_order) {
      const lastItem = await db.menuItems.findAll({ category_id: data.category_id, tenant_id: tenantId });
      data.sort_order = lastItem.length > 0 ? Math.max(...lastItem.map(item => item.sort_order || 0)) + 1 : 1;
    }

    const menuItem = await db.menuItems.create(data);

    logger.info({
      menuItemId: menuItem.id,
      tenantId,
      userId: req.user?.id,
    }, 'Created new menu item');

    res.status(201).json({
      menuItem,
      message: 'Menu item created successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error creating menu item');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create menu item',
    });
  }
});

/**
 * PUT /api/menu-items/:id
 * Update menu item
 */
router.put('/:id', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const validationResult = updateMenuItemSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        error: 'Validation Error',
        details: validationResult.error.errors,
      });
    }

    const data = validationResult.data;

    // Verify menu item exists and belongs to tenant
    const existingMenuItem = await db.menuItems.findOne({ id, tenant_id: tenantId });
    if (!existingMenuItem) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Menu item not found',
      });
    }

    // If category changed, verify new category exists
    if (data.category_id && data.category_id !== existingMenuItem.category_id) {
      const category = await db.categories.findOne({ id: data.category_id, tenant_id: tenantId });
      if (!category) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Category not found',
        });
      }
    }

    const menuItem = await db.menuItems.update(id, data);

    logger.info({
      menuItemId: id,
      tenantId,
      userId: req.user?.id,
      changes: Object.keys(data),
    }, 'Updated menu item');

    res.json({
      menuItem,
      message: 'Menu item updated successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      menuItemId: req.params.id,
    }, 'Error updating menu item');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update menu item',
    });
  }
});

/**
 * DELETE /api/menu-items/:id
 * Delete menu item
 */
router.delete('/:id', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    // Verify menu item exists and belongs to tenant
    const menuItem = await db.menuItems.findOne({ id, tenant_id: tenantId });
    if (!menuItem) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Menu item not found',
      });
    }

    // Check if menu item has been ordered
    const hasOrders = await db.menuItems.checkHasOrders(id);
    if (hasOrders) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Cannot delete menu item that has been ordered. Please mark as unavailable instead.',
      });
    }

    await db.menuItems.delete(id);

    logger.info({
      menuItemId: id,
      tenantId,
      userId: req.user?.id,
    }, 'Deleted menu item');

    res.json({
      message: 'Menu item deleted successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      menuItemId: req.params.id,
    }, 'Error deleting menu item');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to delete menu item',
    });
  }
});

/**
 * POST /api/menu-items/:id/toggle-availability
 * Toggle menu item availability
 */
router.post('/:id/toggle-availability', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const menuItem = await db.menuItems.findOne({ id, tenant_id: tenantId });
    if (!menuItem) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Menu item not found',
      });
    }

    const updated = await db.menuItems.update(id, {
      is_available: !menuItem.is_available,
    });

    logger.info({
      menuItemId: id,
      tenantId,
      newAvailability: !menuItem.is_available,
      userId: req.user?.id,
    }, 'Toggled menu item availability');

    res.json({
      menuItem: updated,
      message: 'Menu item availability updated successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      menuItemId: req.params.id,
    }, 'Error toggling menu item availability');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to toggle menu item availability',
    });
  }
});

/**
 * GET /api/menu-items/categories/:categoryId/items
 * Get menu items by category
 */
router.get('/categories/:categoryId/items', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { categoryId } = req.params;
    const tenantId = req.user?.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Tenant ID is required',
      });
    }

    const menuItems = await db.menuItems.findAll({
      category_id: categoryId,
      tenant_id: tenantId,
      is_available: true,
    }, 100, 0, 'sort_order ASC');

    logger.info({
      categoryId,
      count: menuItems.length,
      tenantId,
    }, 'Retrieved menu items by category');

    res.json({
      menuItems,
      count: menuItems.length,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      categoryId: req.params.categoryId,
    }, 'Error retrieving menu items by category');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve menu items',
    });
  }
});

export default router;