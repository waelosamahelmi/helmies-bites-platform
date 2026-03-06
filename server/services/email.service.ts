import nodemailer from 'nodemailer';
import { logger } from '../db.js';
import { db } from '../db.js';

/**
 * Email Service
 * Handles transactional email sending
 */
export class EmailService {
  private transporter: nodemailer.Transporter;

  constructor() {
    // Create transporter based on configuration
    if (process.env.SENDGRID_API_KEY) {
      // Use SendGrid
      this.transporter = nodemailer.createTransport({
        host: 'smtp.sendgrid.net',
        port: 587,
        secure: false,
        auth: {
          user: 'apikey',
          pass: process.env.SENDGRID_API_KEY,
        },
      });
    } else if (process.env.SMTP_HOST) {
      // Use custom SMTP (Hostinger)
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587'),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASSWORD,
        },
      });
    } else {
      logger.warn('No email configuration found - emails will be logged only');
      this.transporter = nodemailer.createTransport({
        streamTransport: true,
        newline: 'unix',
      } as any);
    }
  }

  /**
   * Send transactional email
   */
  async send(config: {
    to: string | string[];
    subject: string;
    template?: string;
    data?: Record<string, any>;
    html?: string;
    text?: string;
    from?: string;
    fromName?: string;
  }): Promise<boolean> {
    try {
      const {
        to,
        subject,
        template,
        data = {},
        html,
        text,
        from = process.env.EMAIL_FROM || 'noreply@helmiesbites.com',
        fromName = process.env.EMAIL_FROM_NAME || 'Helmies Bites',
      } = config;

      let finalHtml = html;
      let finalText = text;

      // If template is specified, load and render it
      if (template && !html) {
        const emailTemplate = await this.loadTemplate(template);
        if (emailTemplate) {
          finalHtml = this.renderTemplate(emailTemplate.body_html_en, data);
          finalText = this.renderTemplate(emailTemplate.body_html_en.replace(/<[^>]*>/g, ''), data);
        }
      }

      const mailOptions = {
        from: `"${fromName}" <${from}>`,
        to: Array.isArray(to) ? to.join(', ') : to,
        subject,
        html: finalHtml,
        text: finalText,
      };

      logger.info({
        to,
        subject,
        template,
      }, 'Sending email');

      const info = await this.transporter.sendMail(mailOptions);

      logger.info({
        to,
        subject,
        messageId: info.messageId,
      }, 'Email sent successfully');

      return true;
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
        config: {
          to: config.to,
          subject: config.subject,
        },
      }, 'Error sending email');

      return false;
    }
  }

  /**
   * Send welcome email to new restaurant
   */
  async sendWelcomeEmail(tenant: {
    id: string;
    slug: string;
    name: string;
    metadata: {
      email: string;
      password: string;
    };
  }): Promise<boolean> {
    return this.send({
      to: tenant.metadata.email,
      template: 'welcome',
      data: {
        restaurantName: tenant.name,
        email: tenant.metadata.email,
        password: tenant.metadata.password,
        adminUrl: `https://${tenant.slug}.helmiesbites.com/admin`,
        siteUrl: `https://${tenant.slug}.helmiesbites.com`,
      },
      subject: `Welcome to Helmies Bites! 🍽️`,
    });
  }

  /**
   * Send password reset email
   */
  async sendPasswordResetEmail(email: string, resetToken: string): Promise<boolean> {
    const resetLink = `${process.env.PLATFORM_URL}/reset-password?token=${resetToken}`;

    return this.send({
      to: email,
      template: 'password_reset',
      data: {
        resetLink,
      },
      subject: 'Reset your Helmies Bites password',
    });
  }

  /**
   * Send monthly invoice
   */
  async sendMonthlyInvoice(tenant: {
    id: string;
    name: string;
    metadata: { email: string };
  }, invoice: {
    month: string;
    year: number;
    orderCount: number;
    serviceFee: number;
    monthlyFee: number;
    totalAmount: number;
  }): Promise<boolean> {
    return this.send({
      to: tenant.metadata.email,
      template: 'monthly_invoice',
      data: {
        restaurantName: tenant.name,
        month: invoice.month,
        year: invoice.year,
        orderCount: invoice.orderCount,
        serviceFee: invoice.serviceFee,
        monthlyFee: invoice.monthlyFee,
        totalAmount: invoice.totalAmount,
      },
      subject: `Your Helmies Bites invoice for ${invoice.month} ${invoice.year}`,
    });
  }

  /**
   * Send support ticket notification to support team
   */
  async sendSupportTicketNotification(ticket: {
    id: string;
    subject: string;
    message: string;
    tenant?: { name: string };
    priority: string;
  }): Promise<boolean> {
    const supportEmail = process.env.SUPPORT_EMAIL || 'support@helmiesbites.com';

    return this.send({
      to: supportEmail,
      subject: `New Support Ticket: ${ticket.subject}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #FF8C00;">New Support Ticket Created</h2>
          <div style="background: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Ticket ID:</strong> ${ticket.id}</p>
            <p><strong>Subject:</strong> ${ticket.subject}</p>
            <p><strong>Priority:</strong> ${ticket.priority}</p>
            ${ticket.tenant ? `<p><strong>Restaurant:</strong> ${ticket.tenant.name}</p>` : ''}
            <p><strong>Message:</strong></p>
            <p style="background: white; padding: 15px; border-left: 3px solid #FF8C00;">${ticket.message}</p>
          </div>
          <p><a href="https://admin.helmiesbites.com/support/tickets/${ticket.id}" style="display: inline-block; padding: 10px 20px; background: #FF8C00; color: white; text-decoration: none; border-radius: 5px;">View Ticket</a></p>
        </div>
      `,
    });
  }

  /**
   * Send support ticket update notification to user
   */
  async sendSupportTicketUpdate(ticket: {
    id: string;
    subject: string;
    tenant?: { metadata: { email?: string } };
    status: string;
  }, message: string): Promise<boolean> {
    if (!ticket.tenant?.metadata?.email) {
      logger.warn('No email for tenant, skipping notification');
      return false;
    }

    return this.send({
      to: ticket.tenant.metadata.email,
      subject: `Support Ticket Update: ${ticket.subject}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #FF8C00;">Your Support Ticket Has Been Updated</h2>
          <div style="background: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Ticket ID:</strong> ${ticket.id}</p>
            <p><strong>Subject:</strong> ${ticket.subject}</p>
            <p><strong>New Status:</strong> ${ticket.status.replace('_', ' ')}</p>
            <p><strong>Update:</strong></p>
            <p style="background: white; padding: 15px; border-left: 3px solid #FF8C00;">${message}</p>
          </div>
          <p><a href="https://admin.helmiesbites.com/support" style="display: inline-block; padding: 10px 20px; background: #FF8C00; color: white; text-decoration: none; border-radius: 5px;">View Ticket</a></p>
        </div>
      `,
    });
  }

  /**
   * Send order notification to restaurant
   */
  async sendOrderNotification(order: {
    orderNumber: string;
    tenant: { metadata: { email?: string }; name: string };
    items: Array<{ name: string; quantity: number }>;
    totalAmount: number;
    deliveryType: string;
  }): Promise<boolean> {
    if (!order.tenant.metadata?.email) {
      return false;
    }

    const itemsList = order.items.map(item =>
      `<li>${item.quantity}x ${item.name}</li>`
    ).join('');

    return this.send({
      to: order.tenant.metadata.email,
      subject: `New Order: ${order.orderNumber}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #FF8C00;">🍽️ New Order Received!</h2>
          <div style="background: #f9f9f9; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <p><strong>Order Number:</strong> ${order.orderNumber}</p>
            <p><strong>Type:</strong> ${order.deliveryType}</p>
            <p><strong>Items:</strong></p>
            <ul style="background: white; padding: 15px; border-radius: 5px;">${itemsList}</ul>
            <p><strong>Total:</strong> €${order.totalAmount.toFixed(2)}</p>
          </div>
          <p><a href="https://admin.helmiesbites.com/orders" style="display: inline-block; padding: 10px 20px; background: #FF8C00; color: white; text-decoration: none; border-radius: 5px;">View Order</a></p>
        </div>
      `,
    });
  }

  /**
   * Load email template from database
   */
  private async loadTemplate(type: string) {
    try {
      const templates = await db.emailTemplates.findByType(type);
      return templates || null;
    } catch (error) {
      logger.error({ error, type }, 'Error loading email template');
      return null;
    }
  }

  /**
   * Render template with data
   */
  private renderTemplate(template: string, data: Record<string, any>): string {
    let rendered = template;

    // Replace placeholders with actual data
    Object.keys(data).forEach(key => {
      const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
      rendered = rendered.replace(regex, String(data[key]));
    });

    return rendered;
  }

  /**
   * Verify email configuration
   */
  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      logger.info('Email configuration verified');
      return true;
    } catch (error) {
      logger.error({
        error: error instanceof Error ? error.message : 'Unknown error',
      }, 'Email configuration verification failed');
      return false;
    }
  }
}

export default EmailService;
