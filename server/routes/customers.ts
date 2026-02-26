import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db, logger } from '../db.js';
import { authMiddleware, requireTenantAdmin } from '../middleware/auth.js';

const router = Router();

// Validation schemas
const createCustomerSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email(),
  phone: z.string().optional(),
  street: z.string().optional(),
  city: z.string().optional(),
  postal_code: z.string().optional(),
  country: z.string().optional(),
  is_active: z.boolean().default(true),
  metadata: z.record(z.any()).optional(),
});

const updateCustomerSchema = createCustomerSchema.partial().extend({
  is_active: z.boolean().optional(),
});

/**
 * GET /api/customers
 * List all customers (tenant admin)
 */
router.get('/', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { search, email, limit = 50, offset = 0 } = req.query;
    const tenantId = req.user?.tenant_id;

    if (!tenantId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Tenant ID is required',
      });
    }

    let conditions: any = { tenant_id: tenantId };

    if (email) conditions.email = email;
    if (search) {
      // Search by name or email
      const customers = await db.customers.findAll({ tenant_id: tenantId });
      const filtered = customers.filter((c: any) =>
        c.name.toLowerCase().includes((search as string).toLowerCase()) ||
        c.email.toLowerCase().includes((search as string).toLowerCase())
      );
      return res.json({
        customers: filtered,
        count: filtered.length,
      });
    }

    const customers = await db.customers.findAll(conditions, limit as number, offset as number, 'created_at DESC');

    logger.info({
      count: customers.length,
      tenantId,
      userId: req.user?.id,
    }, 'Listed customers');

    res.json({
      customers,
      count: customers.length,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error listing customers');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to list customers',
    });
  }
});

/**
 * GET /api/customers/:id
 * Get customer details
 */
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const customer = await db.customers.findOne({ id });

    if (!customer) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Customer not found',
      });
    }

    // Check authorization
    const isAdmin = req.user?.role === 'helmies_admin' || req.user?.role === 'admin';
    const isOwnTenant = customer.tenant_id === tenantId;

    if (!isAdmin && !isOwnTenant) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to view this customer',
      });
    }

    // Get customer order statistics
    const orderStats = await db.customers.getOrderStatistics(id);

    logger.info({
      customerId: id,
      userId: req.user?.id,
    }, 'Retrieved customer details');

    res.json({
      customer,
      orderStats,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      customerId: req.params.id,
    }, 'Error retrieving customer');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve customer',
    });
  }
});

/**
 * POST /api/customers
 * Create new customer
 */
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const validationResult = createCustomerSchema.safeParse(req.body);

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

    // Check if customer with this email already exists
    const existingCustomer = await db.customers.findOne({ email: data.email, tenant_id: tenantId });
    if (existingCustomer) {
      return res.status(409).json({
        error: 'Conflict',
        message: 'A customer with this email already exists',
      });
    }

    const customer = await db.customers.create(data);

    logger.info({
      customerId: customer.id,
      tenantId,
      userId: req.user?.id,
    }, 'Created new customer');

    res.status(201).json({
      customer,
      message: 'Customer created successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error creating customer');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create customer',
    });
  }
});

/**
 * PUT /api/customers/:id
 * Update customer
 */
router.put('/:id', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const validationResult = updateCustomerSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        error: 'Validation Error',
        details: validationResult.error.errors,
      });
    }

    const data = validationResult.data;

    // Verify customer exists and belongs to tenant
    const existingCustomer = await db.customers.findOne({ id, tenant_id: tenantId });
    if (!existingCustomer) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Customer not found',
      });
    }

    // If email is being updated, check for duplicates
    if (data.email && data.email !== existingCustomer.email) {
      const existingWithSameEmail = await db.customers.findOne({ email: data.email, tenant_id: tenantId });
      if (existingWithSameEmail) {
        return res.status(409).json({
          error: 'Conflict',
          message: 'A customer with this email already exists',
        });
      }
    }

    const customer = await db.customers.update(id, data);

    logger.info({
      customerId: id,
      tenantId,
      userId: req.user?.id,
      changes: Object.keys(data),
    }, 'Updated customer');

    res.json({
      customer,
      message: 'Customer updated successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      customerId: req.params.id,
    }, 'Error updating customer');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update customer',
    });
  }
});

/**
 * DELETE /api/customers/:id
 * Delete customer (soft delete)
 */
router.delete('/:id', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    // Verify customer exists and belongs to tenant
    const customer = await db.customers.findOne({ id, tenant_id: tenantId });
    if (!customer) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Customer not found',
      });
    }

    // Soft delete by setting is_active to false
    await db.customers.update(id, { is_active: false });

    logger.info({
      customerId: id,
      tenantId,
      userId: req.user?.id,
    }, 'Soft deleted customer');

    res.json({
      message: 'Customer deleted successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      customerId: req.params.id,
    }, 'Error deleting customer');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to delete customer',
    });
  }
});

/**
 * GET /api/customers/:id/orders
 * Get customer's orders
 */
router.get('/:id/orders', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { limit = 20, offset = 0 } = req.query;
    const tenantId = req.user?.tenant_id;

    const customer = await db.customers.findOne({ id, tenant_id: tenantId });
    if (!customer) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Customer not found',
      });
    }

    const orders = await db.customers.getOrders(id, limit as number, offset as number);

    logger.info({
      customerId: id,
      orderCount: orders.length,
    }, 'Retrieved customer orders');

    res.json({
      orders,
      count: orders.length,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      customerId: req.params.id,
    }, 'Error retrieving customer orders');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve customer orders',
    });
  }
});

/**
 * GET /api/customers/:id/history
 * Get customer order history with statistics
 */
router.get('/:id/history', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const customer = await db.customers.findOne({ id, tenant_id: tenantId });
    if (!customer) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Customer not found',
      });
    }

    // Get detailed order history
    const orderHistory = await db.customers.getDetailedOrderHistory(id);

    logger.info({
      customerId: id,
      userId: req.user?.id,
    }, 'Retrieved customer order history');

    res.json({
      customer,
      orderHistory,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      customerId: req.params.id,
    }, 'Error retrieving customer order history');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve customer order history',
    });
  }
});

/**
 * POST /api/customers/:id/restore
 * Restore soft-deleted customer
 */
router.post('/:id/restore', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const customer = await db.customers.update(id, { is_active: true });

    logger.info({
      customerId: id,
      tenantId,
      userId: req.user?.id,
    }, 'Restored customer');

    res.json({
      customer,
      message: 'Customer restored successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      customerId: req.params.id,
    }, 'Error restoring customer');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to restore customer',
    });
  }
});

export default router;