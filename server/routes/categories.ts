import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db, logger } from '../db.js';
import { authMiddleware, requireTenantAdmin } from '../middleware/auth.js';

const router = Router();

// Validation schemas
const createCategorySchema = z.object({
  name: z.string().min(1).max(255),
  name_en: z.string().max(255).optional(),
  description: z.string().optional(),
  description_en: z.string().optional(),
  icon: z.string().url().optional(),
  color: z.string().optional(),
  sort_order: z.number().int().min(0).default(0),
  is_active: z.boolean().default(true),
  metadata: z.record(z.any()).optional(),
});

const updateCategorySchema = createCategorySchema.partial().extend({
  is_active: z.boolean().optional(),
});

/**
 * GET /api/categories
 * List all categories (tenant admin)
 */
router.get('/', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { is_active, limit = 50, offset = 0 } = req.query;
    const tenantId = req.user?.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Tenant ID is required',
      });
    }

    let conditions: any = { tenant_id: tenantId };

    if (is_active) conditions.is_active = is_active === 'true';

    const categories = await db.categories.findAll(conditions, limit as number, offset as number, 'sort_order ASC, name ASC');

    logger.info({
      count: categories.length,
      tenantId,
      userId: req.user?.id,
    }, 'Listed categories');

    res.json({
      categories,
      count: categories.length,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error listing categories');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to list categories',
    });
  }
});

/**
 * GET /api/categories/:id
 * Get category details
 */
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const category = await db.categories.findOne({ id });

    if (!category) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Category not found',
      });
    }

    // Check authorization
    const isAdmin = req.user?.role === 'helmies_admin' || req.user?.role === 'admin';
    const isOwnTenant = category.tenant_id === tenantId;

    if (!isAdmin && !isOwnTenant) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to view this category',
      });
    }

    // Get menu items count for this category
    const menuItemsCount = await db.categories.getMenuItemsCount(id);

    logger.info({
      categoryId: id,
      userId: req.user?.id,
    }, 'Retrieved category details');

    res.json({
      category,
      menuItemsCount,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      categoryId: req.params.id,
    }, 'Error retrieving category');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve category',
    });
  }
});

/**
 * POST /api/categories
 * Create new category
 */
router.post('/', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const validationResult = createCategorySchema.safeParse(req.body);

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

    // Set default sort order if not provided
    if (!data.sort_order) {
      const lastCategory = await db.categories.findAll({ tenant_id: tenantId });
      data.sort_order = lastCategory.length > 0 ? Math.max(...lastCategory.map(cat => cat.sort_order || 0)) + 1 : 1;
    }

    const category = await db.categories.create(data);

    logger.info({
      categoryId: category.id,
      tenantId,
      userId: req.user?.id,
    }, 'Created new category');

    res.status(201).json({
      category,
      message: 'Category created successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error creating category');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create category',
    });
  }
});

/**
 * PUT /api/categories/:id
 * Update category
 */
router.put('/:id', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const validationResult = updateCategorySchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        error: 'Validation Error',
        details: validationResult.error.errors,
      });
    }

    const data = validationResult.data;

    // Verify category exists and belongs to tenant
    const existingCategory = await db.categories.findOne({ id, tenant_id: tenantId });
    if (!existingCategory) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Category not found',
      });
    }

    const category = await db.categories.update(id, data);

    logger.info({
      categoryId: id,
      tenantId,
      userId: req.user?.id,
      changes: Object.keys(data),
    }, 'Updated category');

    res.json({
      category,
      message: 'Category updated successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      categoryId: req.params.id,
    }, 'Error updating category');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update category',
    });
  }
});

/**
 * DELETE /api/categories/:id
 * Delete category
 */
router.delete('/:id', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    // Verify category exists and belongs to tenant
    const category = await db.categories.findOne({ id, tenant_id: tenantId });
    if (!category) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Category not found',
      });
    }

    // Check if category has menu items
    const menuItemsCount = await db.categories.getMenuItemsCount(id);
    if (menuItemsCount > 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Cannot delete category that contains menu items. Please move or delete menu items first.',
      });
    }

    await db.categories.delete(id);

    logger.info({
      categoryId: id,
      tenantId,
      userId: req.user?.id,
    }, 'Deleted category');

    res.json({
      message: 'Category deleted successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      categoryId: req.params.id,
    }, 'Error deleting category');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to delete category',
    });
  }
});

/**
 * POST /api/categories/:id/toggle-active
 * Toggle category active status
 */
router.post('/:id/toggle-active', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const category = await db.categories.findOne({ id, tenant_id: tenantId });
    if (!category) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Category not found',
      });
    }

    const updated = await db.categories.update(id, {
      is_active: !category.is_active,
    });

    logger.info({
      categoryId: id,
      tenantId,
      newActiveStatus: !category.is_active,
      userId: req.user?.id,
    }, 'Toggled category active status');

    res.json({
      category: updated,
      message: 'Category active status updated successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      categoryId: req.params.id,
    }, 'Error toggling category active status');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to toggle category active status',
    });
  }
});

/**
 * GET /api/categories/sorted
 * Get all categories sorted by order
 */
router.get('/sorted', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const tenantId = req.user?.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Tenant ID is required',
      });
    }

    const categories = await db.categories.findAll({
      tenant_id: tenantId,
      is_active: true,
    }, 100, 0, 'sort_order ASC, name ASC');

    logger.info({
      count: categories.length,
      tenantId,
    }, 'Retrieved sorted categories');

    res.json({
      categories,
      count: categories.length,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error retrieving sorted categories');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve categories',
    });
  }
});

export default router;