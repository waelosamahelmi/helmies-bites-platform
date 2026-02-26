import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { db, logger } from '../db.js';
import { authMiddleware, requireTenantAdmin } from '../middleware/auth.js';

const router = Router();

// Validation schemas
const createOrderSchema = z.object({
  customer_id: z.string().uuid(),
  delivery_address: z.object({
    street: z.string(),
    city: z.string(),
    postal_code: z.string(),
    country: z.string().optional(),
  }).optional(),
  pickup_location: z.string().optional(),
  items: z.array(z.object({
    menu_item_id: z.string().uuid(),
    quantity: z.number().int().positive(),
    price: z.number().positive(),
    special_instructions: z.string().optional(),
  })),
  subtotal: z.number().positive(),
  delivery_fee: z.number().min(0).optional(),
  tax_amount: z.number().min(0).optional(),
  total_amount: z.number().positive(),
  payment_method: z.enum(['stripe', 'cash', 'card_on_delivery']),
  payment_status: z.enum(['pending', 'paid', 'failed', 'refunded']).default('pending'),
  status: z.enum(['pending', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled']).default('pending'),
  delivery_instructions: z.string().optional(),
  scheduled_for: z.string().datetime().optional(),
  metadata: z.record(z.any()).optional(),
});

const updateOrderSchema = createOrderSchema.partial().extend({
  status: z.enum(['pending', 'confirmed', 'preparing', 'ready', 'delivered', 'cancelled']).optional(),
  payment_status: z.enum(['pending', 'paid', 'failed', 'refunded']).optional(),
});

/**
 * GET /api/orders
 * List all orders (tenant admin)
 */
router.get('/', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { customer_id, status, payment_status, limit = 50, offset = 0 } = req.query;

    const tenantId = req.user?.tenant_id;
    if (!tenantId) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Tenant ID is required',
      });
    }

    let conditions: any = { tenant_id: tenantId };

    if (customer_id) conditions.customer_id = customer_id;
    if (status) conditions.status = status;
    if (payment_status) conditions.payment_status = payment_status;

    const orders = await db.orders.findAll(conditions, limit as number, offset as number);

    // Get customer details for each order
    const ordersWithCustomers = await Promise.all(
      orders.map(async (order) => {
        if (order.customer_id) {
          const customer = await db.customers.findOne({ id: order.customer_id });
          return { ...order, customer };
        }
        return order;
      })
    );

    logger.info({
      count: orders.length,
      tenantId,
      userId: req.user?.id,
    }, 'Listed orders');

    res.json({
      orders: ordersWithCustomers,
      count: orders.length,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error listing orders');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to list orders',
    });
  }
});

/**
 * GET /api/orders/:id
 * Get order details
 */
router.get('/:id', authMiddleware, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const order = await db.orders.findOne({ id });

    if (!order) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Order not found',
      });
    }

    // Check authorization
    const isAdmin = req.user?.role === 'helmies_admin' || req.user?.role === 'admin';
    const isOwnTenant = order.tenant_id === tenantId;

    if (!isAdmin && !isOwnTenant) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'You do not have permission to view this order',
      });
    }

    // Get customer details
    let customer = null;
    if (order.customer_id) {
      customer = await db.customers.findOne({ id: order.customer_id });
    }

    // Get menu items details
    let menuItems = [];
    if (order.items && Array.isArray(order.items)) {
      menuItems = await Promise.all(
        order.items.map(async (item) => {
          if (item.menu_item_id) {
            const menuItem = await db.menuItems.findOne({ id: item.menu_item_id });
            return { ...item, menuItem };
          }
          return item;
        })
      );
    }

    logger.info({
      orderId: id,
      userId: req.user?.id,
    }, 'Retrieved order details');

    res.json({
      order,
      customer,
      menuItems,
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      orderId: req.params.id,
    }, 'Error retrieving order');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to retrieve order',
    });
  }
});

/**
 * POST /api/orders
 * Create new order
 */
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    const validationResult = createOrderSchema.safeParse(req.body);

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

    // Verify customer exists
    if (data.customer_id) {
      const customer = await db.customers.findOne({ id: data.customer_id, tenant_id: tenantId });
      if (!customer) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'Customer not found',
        });
      }
    }

    // Verify menu items exist and belong to the tenant
    if (data.items && data.items.length > 0) {
      const menuItemIds = data.items.map(item => item.menu_item_id);
      const menuItems = await db.menuItems.findAll({ id: { $in: menuItemIds }, tenant_id: tenantId });

      if (menuItems.length !== menuItemIds.length) {
        return res.status(404).json({
          error: 'Not Found',
          message: 'One or more menu items not found',
        });
      }
    }

    const order = await db.orders.create(data);

    logger.info({
      orderId: order.id,
      tenantId,
      userId: req.user?.id,
    }, 'Created new order');

    res.status(201).json({
      order,
      message: 'Order created successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      tenantId: req.user?.tenant_id,
    }, 'Error creating order');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to create order',
    });
  }
});

/**
 * PUT /api/orders/:id
 * Update order
 */
router.put('/:id', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const validationResult = updateOrderSchema.safeParse(req.body);

    if (!validationResult.success) {
      return res.status(400).json({
        error: 'Validation Error',
        details: validationResult.error.errors,
      });
    }

    const data = validationResult.data;

    // Verify order exists and belongs to tenant
    const existingOrder = await db.orders.findOne({ id, tenant_id: tenantId });
    if (!existingOrder) {
      return res.status(404).json({
        error: 'Not Found',
        message: 'Order not found',
      });
    }

    const order = await db.orders.update(id, data);

    logger.info({
      orderId: id,
      tenantId,
      userId: req.user?.id,
      changes: Object.keys(data),
    }, 'Updated order');

    res.json({
      order,
      message: 'Order updated successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      orderId: req.params.id,
    }, 'Error updating order');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update order',
    });
  }
});

/**
 * POST /api/orders/:id/cancel
 * Cancel order
 */
router.post('/:id/cancel', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user?.tenant_id;

    const order = await db.orders.update(id, {
      status: 'cancelled',
      metadata: {
        ...existingOrder.metadata,
        cancelled_at: new Date().toISOString(),
        cancelled_by: req.user?.id,
      },
    });

    logger.info({
      orderId: id,
      tenantId,
      userId: req.user?.id,
    }, 'Cancelled order');

    res.json({
      order,
      message: 'Order cancelled successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      orderId: req.params.id,
    }, 'Error cancelling order');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to cancel order',
    });
  }
});

/**
 * POST /api/orders/:id/update-payment
 * Update payment status
 */
router.post('/:id/update-payment', authMiddleware, requireTenantAdmin, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { payment_status, payment_intent_id } = req.body;
    const tenantId = req.user?.tenant_id;

    if (!payment_status) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'payment_status is required',
      });
    }

    const order = await db.orders.update(id, {
      payment_status,
      ...(payment_intent_id && { payment_intent_id }),
      ...(payment_status === 'paid' && { paid_at: new Date().toISOString() }),
    });

    logger.info({
      orderId: id,
      tenantId,
      paymentStatus: payment_status,
      userId: req.user?.id,
    }, 'Updated payment status');

    res.json({
      order,
      message: 'Payment status updated successfully',
    });
  } catch (error) {
    logger.error({
      error: error instanceof Error ? error.message : 'Unknown error',
      orderId: req.params.id,
    }, 'Error updating payment status');

    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to update payment status',
    });
  }
});

export default router;