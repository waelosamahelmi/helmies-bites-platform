import { Router, Request, Response } from 'express';
import { sql, logger } from '../db.js';

const router = Router();

/**
 * GET /api/analytics/platform
 * Get platform-wide analytics
 */
router.get('/platform', async (req: Request, res: Response) => {
  try {
    // Get active tenants count
    const activeTenants = await sql`
      SELECT COUNT(*) as count
      FROM public.tenants
      WHERE status = 'active'
    `;

    // Get monthly recurring revenue from monthly fees
    const mrr = await sql`
      SELECT COALESCE(SUM(monthly_fee), 0) as revenue
      FROM public.tenants
      WHERE status = 'active'
    `;

    // Get total orders count (last 30 days)
    const totalOrders = await sql`
      SELECT COUNT(*) as count
      FROM public.orders
      WHERE created_at >= NOW() - INTERVAL '30 days'
    `;

    // Get pending onboarding (tenants with status 'pending')
    const pendingOnboarding = await sql`
      SELECT COUNT(*) as count
      FROM public.tenants
      WHERE status = 'pending'
    `;

    // Get recent tenants
    const recentTenants = await sql`
      SELECT id, slug, name, status, subscription_tier, created_at
      FROM public.tenants
      ORDER BY created_at DESC
      LIMIT 5
    `;

    // Calculate service fee revenue (5% of all orders)
    const serviceFeeRevenue = await sql`
      SELECT COALESCE(SUM(total_amount * 0.05), 0) as revenue
      FROM public.orders
      WHERE created_at >= NOW() - INTERVAL '30 days'
      AND payment_method != 'cash'
    `;

    res.json({
      activeTenants: Number(activeTenants[0]?.count || 0),
      monthlyRecurringRevenue: Number(mrr[0]?.revenue || 0),
      serviceFeeRevenue: Number(serviceFeeRevenue[0]?.revenue || 0),
      totalOrders: Number(totalOrders[0]?.count || 0),
      pendingOnboarding: Number(pendingOnboarding[0]?.count || 0),
      recentTenants: recentTenants.map((t: any) => ({
        id: t.id,
        slug: t.slug,
        name: t.name,
        status: t.status,
        subscriptionTier: t.subscription_tier,
        createdAt: t.created_at
      }))
    });
  } catch (error) {
    logger.error('Error fetching platform analytics:', error);
    res.status(500).json({ error: 'Failed to fetch platform analytics' });
  }
});

/**
 * GET /api/analytics/tenant/:id
 * Get tenant-specific analytics
 */
router.get('/tenant/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    // Get tenant orders statistics
    const orderStats = await sql`
      SELECT
        COUNT(*) as total_orders,
        COALESCE(SUM(total_amount), 0) as total_revenue,
        COUNT(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN 1 END) as orders_last_30_days,
        COALESCE(SUM(CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN total_amount ELSE 0 END), 0) as revenue_last_30_days
      FROM public.orders
      WHERE tenant_id = ${id}
    `;

    // Get menu items count
    const menuStats = await sql`
      SELECT COUNT(*) as menu_items_count
      FROM public.menu_items
      WHERE tenant_id = ${id}
    `;

    // Get customers count
    const customerStats = await sql`
      SELECT COUNT(DISTINCT customer_id) as unique_customers
      FROM public.orders
      WHERE tenant_id = ${id}
    `;

    // Get popular items
    const popularItems = await sql`
      SELECT
        mi.name,
        mi.name_en,
        COUNT(oi.id) as order_count,
        SUM(oi.quantity) as total_quantity
      FROM public.menu_items mi
      LEFT JOIN public.order_items oi ON mi.id = oi.menu_item_id
      WHERE mi.tenant_id = ${id}
      GROUP BY mi.id, mi.name, mi.name_en
      ORDER BY order_count DESC
      LIMIT 10
    `;

    // Get orders over time (last 30 days, by day)
    const ordersOverTime = await sql`
      SELECT
        DATE(created_at) as date,
        COUNT(*) as orders,
        COALESCE(SUM(total_amount), 0) as revenue
      FROM public.orders
      WHERE tenant_id = ${id}
        AND created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `;

    res.json({
      totalOrders: Number(orderStats[0]?.total_orders || 0),
      totalRevenue: Number(orderStats[0]?.total_revenue || 0),
      ordersLast30Days: Number(orderStats[0]?.orders_last_30_days || 0),
      revenueLast30Days: Number(orderStats[0]?.revenue_last_30_days || 0),
      menuItemsCount: Number(menuStats[0]?.menu_items_count || 0),
      uniqueCustomers: Number(customerStats[0]?.unique_customers || 0),
      popularItems: popularItems.map((item: any) => ({
        name: item.name,
        nameEn: item.name_en,
        orderCount: Number(item.order_count),
        totalQuantity: Number(item.total_quantity)
      })),
      ordersOverTime: ordersOverTime.map((row: any) => ({
        date: row.date,
        orders: Number(row.orders),
        revenue: Number(row.revenue)
      }))
    });
  } catch (error) {
    logger.error(`Error fetching tenant analytics for ${req.params.id}:`, error);
    res.status(500).json({ error: 'Failed to fetch tenant analytics' });
  }
});

/**
 * GET /api/analytics/revenue
 * Get revenue reports
 */
router.get('/revenue', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, tenantId } = req.query;

    // Build date filter
    let dateFilter = '';
    const params: any = [];

    if (startDate) {
      dateFilter += ` AND created_at >= $1`;
      params.push(startDate);
    }
    if (endDate) {
      dateFilter += ` AND created_at <= $${params.length + 1}`;
      params.push(endDate);
    }
    if (tenantId) {
      dateFilter += ` AND tenant_id = $${params.length + 1}`;
      params.push(tenantId);
    }

    // Get revenue breakdown by tenant
    const revenueByTenant = await sql`
      SELECT
        t.slug,
        t.name,
        COUNT(o.id) as order_count,
        COALESCE(SUM(o.total_amount), 0) as total_revenue,
        COALESCE(SUM(o.total_amount * 0.05), 0) as helmies_fee,
        COALESCE(SUM(o.total_amount * 0.95), 0) as restaurant_earnings
      FROM public.tenants t
      LEFT JOIN public.orders o ON t.id = o.tenant_id
        AND o.created_at >= COALESCE(${startDate as string}::timestamp, NOW() - INTERVAL '30 days')
        AND o.created_at <= COALESCE(${endDate as string}::timestamp, NOW())
      WHERE t.status = 'active'
      GROUP BY t.id, t.slug, t.name
      ORDER BY total_revenue DESC
    `;

    // Get service fee vs COD revenue
    const revenueByPaymentMethod = await sql`
      SELECT
        payment_method,
        COUNT(*) as order_count,
        COALESCE(SUM(total_amount), 0) as total_revenue,
        COALESCE(SUM(total_amount * 0.05), 0) as helmies_fee
      FROM public.orders
      WHERE created_at >= COALESCE(${startDate as string}::timestamp, NOW() - INTERVAL '30 days')
        AND created_at <= COALESCE(${endDate as string}::timestamp, NOW())
        ${tenantId ? sql`AND tenant_id = ${tenantId as string}` : sql``}
      GROUP BY payment_method
    `;

    // Get AI credits revenue
    const aiCreditsRevenue = await sql`
      SELECT
        credit_type,
        COUNT(*) as count,
        SUM(cost) as total_cost
      FROM public.ai_credits
      WHERE created_at >= COALESCE(${startDate as string}::timestamp, NOW() - INTERVAL '30 days')
        AND created_at <= COALESCE(${endDate as string}::timestamp, NOW())
        ${tenantId ? sql`AND tenant_id = ${tenantId as string}` : sql``}
      GROUP BY credit_type
    `;

    // Get monthly subscription revenue
    const subscriptionRevenue = await sql`
      SELECT
        SUM(monthly_fee) as monthly_revenue
      FROM public.tenants
      WHERE status = 'active'
    `;

    res.json({
      revenueByTenant: revenueByTenant.map((row: any) => ({
        slug: row.slug,
        name: row.name,
        orderCount: Number(row.order_count),
        totalRevenue: Number(row.total_revenue),
        helmiesFee: Number(row.helmies_fee),
        restaurantEarnings: Number(row.restaurant_earnings)
      })),
      revenueByPaymentMethod: revenueByPaymentMethod.map((row: any) => ({
        paymentMethod: row.payment_method,
        orderCount: Number(row.order_count),
        totalRevenue: Number(row.total_revenue),
        helmiesFee: Number(row.helmies_fee)
      })),
      aiCreditsRevenue: aiCreditsRevenue.map((row: any) => ({
        creditType: row.credit_type,
        count: Number(row.count),
        totalCost: Number(row.total_cost)
      })),
      monthlySubscriptionRevenue: Number(subscriptionRevenue[0]?.monthly_revenue || 0)
    });
  } catch (error) {
    logger.error('Error fetching revenue reports:', error);
    res.status(500).json({ error: 'Failed to fetch revenue reports' });
  }
});

/**
 * GET /api/analytics/orders
 * Get order analytics
 */
router.get('/orders', async (req: Request, res: Response) => {
  try {
    const { startDate, endDate, tenantId, status } = req.query;

    // Get orders with filtering
    const orders = await sql`
      SELECT
        o.id,
        o.order_number,
        o.status,
        o.total_amount,
        o.payment_method,
        o.delivery_type,
        o.created_at,
        t.slug as tenant_slug,
        t.name as tenant_name
      FROM public.orders o
      JOIN public.tenants t ON o.tenant_id = t.id
      WHERE o.created_at >= COALESCE(${startDate as string}::timestamp, NOW() - INTERVAL '30 days')
        AND o.created_at <= COALESCE(${endDate as string}::timestamp, NOW())
        ${tenantId ? sql`AND o.tenant_id = ${tenantId as string}` : sql``}
        ${status ? sql`AND o.status = ${status as string}` : sql``}
      ORDER BY o.created_at DESC
      LIMIT 100
    `;

    // Get order status breakdown
    const statusBreakdown = await sql`
      SELECT
        status,
        COUNT(*) as count,
        COALESCE(SUM(total_amount), 0) as total_value
      FROM public.orders
      WHERE created_at >= COALESCE(${startDate as string}::timestamp, NOW() - INTERVAL '30 days')
        AND created_at <= COALESCE(${endDate as string}::timestamp, NOW())
        ${tenantId ? sql`AND tenant_id = ${tenantId as string}` : sql``}
      GROUP BY status
      ORDER BY count DESC
    `;

    // Get delivery type breakdown
    const deliveryBreakdown = await sql`
      SELECT
        delivery_type,
        COUNT(*) as count,
        COALESCE(SUM(total_amount), 0) as total_value
      FROM public.orders
      WHERE created_at >= COALESCE(${startDate as string}::timestamp, NOW() - INTERVAL '30 days')
        AND created_at <= COALESCE(${endDate as string}::timestamp, NOW())
        ${tenantId ? sql`AND tenant_id = ${tenantId as string}` : sql``}
      GROUP BY delivery_type
    `;

    res.json({
      orders: orders.map((o: any) => ({
        id: o.id,
        orderNumber: o.order_number,
        status: o.status,
        totalAmount: Number(o.total_amount),
        paymentMethod: o.payment_method,
        deliveryType: o.delivery_type,
        createdAt: o.created_at,
        tenant: {
          slug: o.tenant_slug,
          name: o.tenant_name
        }
      })),
      statusBreakdown: statusBreakdown.map((s: any) => ({
        status: s.status,
        count: Number(s.count),
        totalValue: Number(s.total_value)
      })),
      deliveryBreakdown: deliveryBreakdown.map((d: any) => ({
        deliveryType: d.delivery_type,
        count: Number(d.count),
        totalValue: Number(d.total_value)
      }))
    });
  } catch (error) {
    logger.error('Error fetching order analytics:', error);
    res.status(500).json({ error: 'Failed to fetch order analytics' });
  }
});

export default router;
