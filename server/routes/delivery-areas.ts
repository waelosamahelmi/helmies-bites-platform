import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db, logger } from '../db.js';
import { authMiddleware, requireTenantAdmin } from '../middleware/auth.js';

const router = Router();

// Validation schemas
const createDeliveryAreaSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  area_type: z.enum(['polygon', 'radius', 'postal_code']).default('radius'),
  coordinates: z.array(z.number()).optional(), // For polygon
  center_lat: z.number().optional(), // For radius
  center_lng: z.number().optional(),
  radius_km: z.number().min(0.1).optional(), // For radius
  postal_codes: z.array(z.string()).optional(), // For postal_code
  delivery_fee: z.number().min(0),
  free_delivery_threshold: z.number().min(0).optional(),
  min_order_amount: z.number().min(0),
  estimated_delivery_minutes: z.number().int().min(5),
  is_active: z.boolean().default(true),
  priority: z.number().int().min(1).default(1),
  metadata: z.record(z.any()).optional(),
});

const updateDeliveryAreaSchema = createDeliveryAreaSchema.partial().extend({
  is_active: z.boolean().optional(),
});

/**
 * GET /api/delivery-areas
 * List all delivery areas (tenant admin)
 */
router.get('/', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { is_active, area_type, limit = 50, offset = 0 } = req.query;
    const tenantId = req.user?.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Tenant ID is required',
      });
    }

    let conditions: any = { tenant_id: tenantId };

    if (is_active) conditions.is_active = is_active === 'true';
    if (area_type) conditions.area_type = area_type;

    const deliveryAreas = await db.deliveryAreas.findAll(conditions, limit as number, offset as number, 'priority ASC, name ASC');

    logger.info({
      count: deliveryAreas.length,
      tenantId,
      userId: req.user?.id,
    }, 'Listed delivery areas');

    res.json({
      deliveryAreas,
      count: deliveryAreas.length,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error listing delivery areas');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to list delivery areas',
    });
  }
});

/**
 * GET /api/delivery-areas/:id
 * Get delivery area details
 */
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const deliveryArea = await db.deliveryAreas.findOne({ id });

    if (!deliveryArea) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Delivery area not found',
      });
    }

    // Check authorization
    const isAdmin = req.user?.role === 'helmies_admin' || req.user?.role === 'admin';
    const isOwnTenant = deliveryArea.tenant_id === tenantId;

    if (!isAdmin && !isOwnTenant) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to view this delivery area',
      });
    }

    // Get orders count for this area
    const ordersCount = await db.deliveryAreas.getOrdersCount(id);

    logger.info({
      deliveryAreaId: id,
      userId: req.user?.id,
    }, 'Retrieved delivery area details');

    res.json({
      deliveryArea,
      ordersCount,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      deliveryAreaId: req.params.id,
    }, 'Error retrieving delivery area');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve delivery area',
    });
  }
});

/**
 * POST /api/delivery-areas
 * Create new delivery area
 */
router.post('/', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const validationResult = createDeliveryAreaSchema.safeParse(req.body);

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

    // Validate coordinates based on area type
    if (data.area_type === 'polygon') {
      if (!data.coordinates || data.coordinates.length < 3) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Polygon requires at least 3 coordinates',
        });
      }
    } else if (data.area_type === 'radius') {
      if (!data.center_lat || !data.center_lng || !data.radius_km) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Radius-based area requires center coordinates and radius',
        });
      }
    } else if (data.area_type === 'postal_code') {
      if (!data.postal_codes || data.postal_codes.length === 0) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Postal code-based area requires postal codes',
        });
      }
    }

    // Check if area name already exists
    const existingArea = await db.deliveryAreas.findOne({ name: data.name, tenant_id: tenantId });
    if (existingArea) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'A delivery area with this name already exists',
      });
    }

    const deliveryArea = await db.deliveryAreas.create(data);

    logger.info({
      deliveryAreaId: deliveryArea.id,
      name: deliveryArea.name,
      tenantId,
      userId: req.user?.id,
    }, 'Created new delivery area');

    res.status(201).json({
      deliveryArea,
      message: 'Delivery area created successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error creating delivery area');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create delivery area',
    });
  }
});

/**
 * PUT /api/delivery-areas/:id
 * Update delivery area
 */
router.put('/:id', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const validationResult = updateDeliveryAreaSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        error: 'Validation Error',
        details: validationResult.error.errors,
      });
    }

    const data = validationResult.data;

    // Verify delivery area exists and belongs to tenant
    const existingArea = await db.deliveryAreas.findOne({ id, tenant_id: tenantId });
    if (!existingArea) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Delivery area not found',
      });
    }

    // Validate coordinates based on area type
    if (data.area_type === 'polygon') {
      if (!data.coordinates || data.coordinates.length < 3) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Polygon requires at least 3 coordinates',
        });
      }
    } else if (data.area_type === 'radius') {
      if (!data.center_lat || !data.center_lng || !data.radius_km) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Radius-based area requires center coordinates and radius',
        });
      }
    } else if (data.area_type === 'postal_code') {
      if (!data.postal_codes || data.postal_codes.length === 0) {
        return res.status(400).json({
          error: 'Validation Error',
          message: 'Postal code-based area requires postal codes',
        });
      }
    }

    // If name is being updated, check for duplicates
    if (data.name && data.name !== existingArea.name) {
      const existingWithSameName = await db.deliveryAreas.findOne({
        name: data.name,
        tenant_id: tenantId,
        id: { $ne: id }
      });
      if (existingWithSameName) {
        return res.status(409).json({
          error: 'Conflict',
          message: 'A delivery area with this name already exists',
        });
      }
    }

    const deliveryArea = await db.deliveryAreas.update(id, data);

    logger.info({
      deliveryAreaId: id,
      tenantId,
      userId: req.user?.id,
      changes: Object.keys(data),
    }, 'Updated delivery area');

    res.json({
      deliveryArea,
      message: 'Delivery area updated successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      deliveryAreaId: req.params.id,
    }, 'Error updating delivery area');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update delivery area',
    });
  }
});

/**
 * DELETE /api/delivery-areas/:id
 * Delete delivery area
 */
router.delete('/:id', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    // Verify delivery area exists and belongs to tenant
    const deliveryArea = await db.deliveryAreas.findOne({ id, tenant_id: tenantId });
    if (!deliveryArea) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Delivery area not found',
      });
    }

    // Check if delivery area has orders
    const hasOrders = await db.deliveryAreas.hasOrders(id);
    if (hasOrders) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Cannot delete delivery area that has been used in orders. Please deactivate it instead.',
      });
    }

    await db.deliveryAreas.delete(id);

    logger.info({
      deliveryAreaId: id,
      tenantId,
      userId: req.user?.id,
    }, 'Deleted delivery area');

    res.json({
      message: 'Delivery area deleted successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      deliveryAreaId: req.params.id,
    }, 'Error deleting delivery area');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to delete delivery area',
    });
  }
});

/**
 * POST /api/delivery-areas/:id/toggle-active
 * Toggle delivery area active status
 */
router.post('/:id/toggle-active', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const deliveryArea = await db.deliveryAreas.findOne({ id, tenant_id: tenantId });
    if (!deliveryArea) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Delivery area not found',
      });
    }

    const updated = await db.deliveryAreas.update(id, {
      is_active: !deliveryArea.is_active,
    });

    logger.info({
      deliveryAreaId: id,
      tenantId,
      newActiveStatus: !deliveryArea.is_active,
      userId: req.user?.id,
    }, 'Toggled delivery area active status');

    res.json({
      deliveryArea: updated,
      message: 'Delivery area active status updated successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      deliveryAreaId: req.params.id,
    }, 'Error toggling delivery area active status');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to toggle delivery area active status',
    });
  }
});

/**
 * POST /api/delivery-areas/check-address
 * Check if an address falls within any delivery area (public API)
 */
router.post('/check-address', async (req: Request, res: Response) => {
  try {
    const { address, latitude, longitude, postal_code } = req.body;

    if (!address && !latitude && !longitude && !postal_code) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'At least one of address, latitude/longitude, or postal_code is required',
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

    const deliveryAreas = await db.deliveryAreas.findAll({
      tenant_id: tenant.id,
      is_active: true,
    }, 100, 0, 'priority ASC');

    let matchingArea = null;
    let deliveryFee = 0;
    let estimatedDelivery = 0;

    // Check each delivery area
    for (const area of deliveryAreas) {
      let matches = false;

      if (area.area_type === 'polygon' && area.coordinates && latitude && longitude) {
        // Simple point-in-polygon check (simplified)
        matches = checkPointInPolygon(latitude, longitude, area.coordinates);
      } else if (area.area_type === 'radius' && area.center_lat && area.center_lng && area.radius_km && latitude && longitude) {
        // Calculate distance
        const distance = calculateDistance(area.center_lat, area.center_lng, latitude, longitude);
        matches = distance <= area.radius_km;
      } else if (area.area_type === 'postal_code' && area.postal_codes && postal_code) {
        // Check postal code
        matches = area.postal_codes.includes(postal_code);
      }

      if (matches) {
        matchingArea = area;
        deliveryFee = area.delivery_fee;
        estimatedDelivery = area.estimated_delivery_minutes;
        break;
      }
    }

    if (!matchingArea) {
      logger.info({
        tenantId: tenant.id,
        address,
        latitude,
        longitude,
        postal_code,
      }, 'Address not in any delivery area');

      return res.json({
        is_delivery_available: false,
        reason: 'Address not in delivery area',
      });
    }

    logger.info({
      tenantId: tenant.id,
      deliveryAreaId: matchingArea.id,
      address,
    }, 'Address validated in delivery area');

    res.json({
      is_delivery_available: true,
      deliveryArea: {
        id: matchingArea.id,
        name: matchingArea.name,
        description: matchingArea.description,
        deliveryFee: matchingArea.delivery_fee,
        freeDeliveryThreshold: matchingArea.free_delivery_threshold,
        estimatedDeliveryMinutes: matchingArea.estimated_delivery_minutes,
      },
      message: 'Address is within delivery area',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
    }, 'Error checking delivery area');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to check delivery area',
    });
  }
});

// Helper functions for geographic calculations
function calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a =
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng/2) * Math.sin(dLng/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function checkPointInPolygon(lat: number, lng: number, coordinates: number[]): boolean {
  // Simplified point-in-polygon check
  // This is a basic implementation - in production you'd use a proper geometric library
  if (coordinates.length < 6) return false; // Need at least 3 points (x,y for each)

  let inside = false;
  for (let i = 0, j = coordinates.length - 2; i < coordinates.length; j = i, i += 2) {
    const xi = coordinates[i], yi = coordinates[i + 1];
    const xj = coordinates[j], yj = coordinates[j + 1];

    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }

  return inside;
}

export default router;