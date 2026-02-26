import { Router, Request, Response } from 'express';
import { db, logger, sql } from '../db.js';
import { body, param, validationResult } from 'express-validator';
import { EmailService } from '../services/email.service.js';

const router = Router();
const emailService = new EmailService();

/**
 * GET /api/support/tickets
 * List support tickets with filtering
 */
router.get('/tickets', async (req: Request, res: Response) => {
  try {
    const { status, priority, tenantId, limit = '50', offset = '0' } = req.query;

    // Build query conditions
    const conditions: string[] = [];
    const params: any[] = [];

    if (status) {
      conditions.push(`st.status = $${params.length + 1}`);
      params.push(status);
    }
    if (priority) {
      conditions.push(`st.priority = $${params.length + 1}`);
      params.push(priority);
    }
    if (tenantId) {
      conditions.push(`st.tenant_id = $${params.length + 1}`);
      params.push(tenantId);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Get tickets with tenant info
    const tickets = await sql`
      SELECT
        st.*,
        t.name as tenant_name,
        t.slug as tenant_slug
      FROM public.support_tickets st
      LEFT JOIN public.tenants t ON st.tenant_id = t.id
      ${sql.unsafe(whereClause)}
      ORDER BY
        st.priority DESC,
        st.created_at DESC
      LIMIT ${Number(limit)}
      OFFSET ${Number(offset)}
    `;

    // Get total count
    const countResult = await sql`
      SELECT COUNT(*) as total
      FROM public.support_tickets st
      ${sql.unsafe(whereClause)}
    `;

    res.json({
      tickets: tickets.map((t: any) => ({
        id: t.id,
        tenantId: t.tenant_id,
        tenant: t.tenant_name ? {
          name: t.tenant_name,
          slug: t.tenant_slug
        } : null,
        subject: t.subject,
        message: t.message,
        status: t.status,
        priority: t.priority,
        createdAt: t.created_at,
        updatedAt: t.updated_at
      })),
      total: Number(countResult[0]?.total || 0),
      limit: Number(limit),
      offset: Number(offset)
    });
  } catch (error) {
    logger.error('Failed to fetch support tickets:', error);
    res.status(500).json({
      error: 'Failed to fetch support tickets',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * POST /api/support/tickets
 * Create support ticket
 */
router.post('/tickets',
  [
    body('tenantId').optional().isUUID(),
    body('subject').trim().isLength({ min: 3, max: 255 }),
    body('message').trim().isLength({ min: 10, max: 5000 }),
    body('priority').optional().isIn(['low', 'normal', 'high', 'urgent']),
    body('email').optional().isEmail()
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { tenantId, subject, message, priority = 'normal', email } = req.body;

      // Create ticket
      const result = await db.supportTickets.create({
        tenant_id: tenantId || null,
        subject,
        message,
        status: 'open',
        priority
      });

      if (!result || result.length === 0) {
        throw new Error('Failed to create support ticket');
      }

      const ticket = result[0];

      // Send notification email to support team
      const tenantInfo = tenantId ? await db.tenants.findOne({ id: tenantId }) : null;
      emailService.sendSupportTicketNotification({
        id: ticket.id,
        subject: ticket.subject,
        message: ticket.message,
        tenant: tenantInfo && tenantInfo.length > 0 ? tenantInfo[0] : undefined,
        priority: ticket.priority
      }).catch(err => logger.warn({ error: err }, 'Failed to send support email notification'));

      // Send confirmation email to user if email provided
      if (email) {
        emailService.send({
          to: email,
          subject: 'Support Ticket Created - Helmies Bites',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #FF8C00;">Support Ticket Created</h2>
              <p>Thank you for contacting Helmies Bites support. We have received your ticket and will respond shortly.</p>
              <div style="background: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
                <p><strong>Ticket ID:</strong> ${ticket.id}</p>
                <p><strong>Subject:</strong> ${ticket.subject}</p>
                <p><strong>Status:</strong> Open</p>
              </div>
              <p style="color: #666; font-size: 14px;">We typically respond within 1-2 business hours.</p>
            </div>
          `,
        }).catch(err => logger.warn({ error: err }, 'Failed to send confirmation email'));
      }

      res.status(201).json({
        success: true,
        ticket: {
          id: ticket.id,
          subject: ticket.subject,
          status: ticket.status,
          priority: ticket.priority,
          createdAt: ticket.created_at
        }
      });
    } catch (error) {
      logger.error('Failed to create support ticket:', error);
      res.status(500).json({
        error: 'Failed to create support ticket',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

/**
 * GET /api/support/tickets/:id
 * Get ticket details with messages
 */
router.get('/tickets/:id',
  [param('id').isUUID()],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { id } = req.params;

      // Get ticket
      const tickets = await sql`
        SELECT
          st.*,
          t.name as tenant_name,
          t.slug as tenant_slug,
          t.email as tenant_email
        FROM public.support_tickets st
        LEFT JOIN public.tenants t ON st.tenant_id = t.id
        WHERE st.id = ${id}
      `;

      if (!tickets || tickets.length === 0) {
        return res.status(404).json({ error: 'Ticket not found' });
      }

      const ticket = tickets[0];

      // Get ticket messages
      const messages = await sql`
        SELECT * FROM public.support_messages
        WHERE ticket_id = ${id}
        ORDER BY created_at ASC
      `;

      res.json({
        ticket: {
          id: ticket.id,
          tenantId: ticket.tenant_id,
          tenant: ticket.tenant_name ? {
            name: ticket.tenant_name,
            slug: ticket.tenant_slug,
            email: ticket.tenant_email
          } : null,
          subject: ticket.subject,
          message: ticket.message,
          status: ticket.status,
          priority: ticket.priority,
          createdAt: ticket.created_at,
          updatedAt: ticket.updated_at
        },
        messages: messages.map((m: any) => ({
          id: m.id,
          message: m.message,
          sender: m.sender,
          senderType: m.sender_type,
          createdAt: m.created_at
        }))
      });
    } catch (error) {
      logger.error(`Failed to fetch ticket ${req.params.id}:`, error);
      res.status(500).json({
        error: 'Failed to fetch ticket',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

/**
 * PUT /api/support/tickets/:id
 * Update ticket status or priority
 */
router.put('/tickets/:id',
  [
    param('id').isUUID(),
    body('status').optional().isIn(['open', 'in_progress', 'waiting', 'resolved', 'closed']),
    body('priority').optional().isIn(['low', 'normal', 'high', 'urgent'])
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { id } = req.params;
      const { status, priority } = req.body;

      if (!status && !priority) {
        return res.status(400).json({ error: 'At least status or priority must be provided' });
      }

      // Update ticket
      const updateData: any = {};
      if (status) updateData.status = status;
      if (priority) updateData.priority = priority;

      const result = await db.supportTickets.update(id, updateData);

      if (!result || result.length === 0) {
        return res.status(404).json({ error: 'Ticket not found' });
      }

      res.json({
        success: true,
        ticket: {
          id: result[0].id,
          status: result[0].status,
          priority: result[0].priority,
          updatedAt: result[0].updated_at
        }
      });
    } catch (error) {
      logger.error(`Failed to update ticket ${req.params.id}:`, error);
      res.status(500).json({
        error: 'Failed to update ticket',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

/**
 * POST /api/support/tickets/:id/messages
 * Add message to ticket
 */
router.post('/tickets/:id/messages',
  [
    param('id').isUUID(),
    body('message').trim().isLength({ min: 1, max: 5000 }),
    body('sender').trim().isLength({ min: 1, max: 255 }),
    body('senderType').isIn(['tenant', 'support', 'system'])
  ],
  async (req: Request, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    try {
      const { id } = req.params;
      const { message, sender, senderType } = req.body;

      // Check if ticket exists
      const tickets = await sql`SELECT * FROM public.support_tickets WHERE id = ${id}`;
      if (!tickets || tickets.length === 0) {
        return res.status(404).json({ error: 'Ticket not found' });
      }

      // Insert message
      const result = await sql`
        INSERT INTO public.support_messages (ticket_id, message, sender, sender_type)
        VALUES (${id}, ${message}, ${sender}, ${senderType})
        RETURNING *
      `;

      // Update ticket's updated_at timestamp
      await sql`UPDATE public.support_tickets SET updated_at = NOW() WHERE id = ${id}`;

      // If tenant sent message, update status to 'waiting'
      if (senderType === 'tenant') {
        await sql`UPDATE public.support_tickets SET status = 'waiting' WHERE id = ${id}`;
      }
      // If support sent message, update status to 'in_progress' or 'waiting'
      else if (senderType === 'support') {
        const currentStatus = tickets[0].status;
        if (currentStatus === 'open') {
          await sql`UPDATE public.support_tickets SET status = 'in_progress' WHERE id = ${id}`;
        }

        // Send notification to tenant about new message
        const tenantInfo = tickets[0].tenant_id ? await db.tenants.findOne({ id: tickets[0].tenant_id }) : null;
        if (tenantInfo && tenantInfo.length > 0) {
          emailService.sendSupportTicketUpdate(
            { id: tickets[0].id, subject: tickets[0].subject, tenant: tenantInfo[0], status: 'in_progress' },
            message
          ).catch(err => logger.warn({ error: err }, 'Failed to send ticket update email'));
        }
      }

      res.status(201).json({
        success: true,
        message: {
          id: result[0].id,
          ticketId: result[0].ticket_id,
          message: result[0].message,
          sender: result[0].sender,
          senderType: result[0].sender_type,
          createdAt: result[0].created_at
        }
      });
    } catch (error) {
      logger.error(`Failed to add message to ticket ${req.params.id}:`, error);
      res.status(500).json({
        error: 'Failed to add message',
        details: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }
);

/**
 * GET /api/support/stats
 * Get support statistics
 */
router.get('/stats', async (req: Request, res: Response) => {
  try {
    // Get ticket counts by status
    const statusStats = await sql`
      SELECT
        status,
        COUNT(*) as count
      FROM public.support_tickets
      GROUP BY status
    `;

    // Get ticket counts by priority
    const priorityStats = await sql`
      SELECT
        priority,
        COUNT(*) as count
      FROM public.support_tickets
      WHERE status != 'closed'
      GROUP BY priority
    `;

    // Get average response time
    const responseTime = await sql`
      SELECT
        AVG(EXTRACT(EPOCH FROM (first_response.created_at - st.created_at)) / 3600) as avg_hours
      FROM public.support_tickets st
      LEFT JOIN public.support_messages first_response ON first_response.ticket_id = st.id
        AND first_response.sender_type = 'support'
      WHERE st.status = 'closed'
        AND first_response.id IS NOT NULL
    `;

    // Get recent tickets
    const recentTickets = await sql`
      SELECT
        st.id,
        st.subject,
        st.status,
        st.priority,
        t.name as tenant_name,
        st.created_at
      FROM public.support_tickets st
      LEFT JOIN public.tenants t ON st.tenant_id = t.id
      ORDER BY st.created_at DESC
      LIMIT 10
    `;

    res.json({
      byStatus: statusStats.reduce((acc: any, row: any) => {
        acc[row.status] = Number(row.count);
        return acc;
      }, {}),
      byPriority: priorityStats.reduce((acc: any, row: any) => {
        acc[row.priority] = Number(row.count);
        return acc;
      }, {}),
      avgResponseTimeHours: responseTime[0]?.avg_hours ? Number(responseTime[0].avg_hours).toFixed(2) : null,
      recentTickets: recentTickets.map((t: any) => ({
        id: t.id,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        tenantName: t.tenant_name,
        createdAt: t.created_at
      }))
    });
  } catch (error) {
    logger.error('Failed to fetch support stats:', error);
    res.status(500).json({
      error: 'Failed to fetch support statistics',
      details: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
