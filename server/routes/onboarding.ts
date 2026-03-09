import { Router, Request, Response } from 'express';
import { logger } from '../db.js';
import { EmailService } from '../services/email.service.js';

const router = Router();
const emailService = new EmailService();

/**
 * POST /api/onboarding/submit
 * Receive restaurant onboarding form data and send it to info@helmies.fi
 */
router.post('/submit', async (req: Request, res: Response) => {
  try {
    const {
      email,
      plan,
      restaurantName,
      cuisine,
      phone,
      street,
      postalCode,
      city,
      openingHours,
      parsedMenu,
    } = req.body;

    if (!email || !restaurantName) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Email and restaurant name are required',
      });
    }

    // Format opening hours
    const hoursHtml = (openingHours || [])
      .map((h: any) => `<tr><td style="padding:4px 12px 4px 0;color:#666;">${h.day}</td><td style="padding:4px 0;font-weight:600;">${h.closed ? '<span style="color:#999;">Closed</span>' : `${h.open} – ${h.close}`}</td></tr>`)
      .join('');

    // Format parsed menu
    let menuHtml = '<p style="color:#999;">No menu uploaded</p>';
    if (parsedMenu?.categories?.length) {
      const categoriesHtml = parsedMenu.categories.map((cat: any) => {
        const itemsHtml = (cat.items || [])
          .map((item: any) => `<li style="margin:4px 0;"><strong>${item.name || item.name_en || '—'}</strong> — €${item.price || '?'}${item.description ? `<br/><span style="color:#666;font-size:13px;">${item.description}</span>` : ''}</li>`)
          .join('');
        return `<h4 style="margin:12px 0 6px;color:#FF7A00;">${cat.name || cat.name_en || 'Category'}</h4><ul style="margin:0;padding-left:20px;">${itemsHtml}</ul>`;
      }).join('');
      menuHtml = categoriesHtml;
    }

    const planLabels: Record<string, string> = {
      starter: 'Starter (5% per order, €49 min/mo)',
      pro: 'Pro (€129/month, €500 setup)',
      annual: 'Annual (€99/month billed annually, €0 setup)',
    };

    const htmlBody = `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;">
        <div style="background:linear-gradient(135deg,#FF7A00,#CC6200);padding:24px;border-radius:12px 12px 0 0;">
          <h1 style="color:white;margin:0;font-size:24px;">🍽️ New Restaurant Onboarding</h1>
          <p style="color:rgba(255,255,255,0.8);margin:8px 0 0;">A new restaurant has submitted their setup request</p>
        </div>
        
        <div style="background:#f9f9f9;padding:24px;border:1px solid #eee;">
          <h2 style="color:#333;font-size:18px;margin-top:0;">Contact Information</h2>
          <table style="width:100%;">
            <tr><td style="padding:4px 12px 4px 0;color:#666;width:120px;">Email:</td><td style="font-weight:600;">${email}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#666;">Plan:</td><td style="font-weight:600;color:#FF7A00;">${planLabels[plan] || plan || 'Not selected'}</td></tr>
          </table>

          <h2 style="color:#333;font-size:18px;margin-top:24px;">Restaurant Details</h2>
          <table style="width:100%;">
            <tr><td style="padding:4px 12px 4px 0;color:#666;width:120px;">Name:</td><td style="font-weight:600;">${restaurantName}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#666;">Cuisine:</td><td>${cuisine || 'Not specified'}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#666;">Phone:</td><td>${phone || 'Not provided'}</td></tr>
            <tr><td style="padding:4px 12px 4px 0;color:#666;">Address:</td><td>${[street, postalCode, city].filter(Boolean).join(', ') || 'Not provided'}</td></tr>
          </table>

          <h2 style="color:#333;font-size:18px;margin-top:24px;">Opening Hours</h2>
          <table style="width:100%;">${hoursHtml || '<tr><td style="color:#999;">Not specified</td></tr>'}</table>

          <h2 style="color:#333;font-size:18px;margin-top:24px;">Menu</h2>
          ${menuHtml}
        </div>
        
        <div style="background:#333;color:white;padding:16px 24px;border-radius:0 0 12px 12px;text-align:center;font-size:13px;">
          <p style="margin:0;">Helmies Bites Platform — Automatic onboarding submission</p>
        </div>
      </div>
    `;

    const textBody = [
      `New Restaurant Onboarding`,
      `========================`,
      ``,
      `Email: ${email}`,
      `Plan: ${planLabels[plan] || plan || 'Not selected'}`,
      `Restaurant: ${restaurantName}`,
      `Cuisine: ${cuisine || 'N/A'}`,
      `Phone: ${phone || 'N/A'}`,
      `Address: ${[street, postalCode, city].filter(Boolean).join(', ') || 'N/A'}`,
      ``,
      `Opening Hours:`,
      ...(openingHours || []).map((h: any) => `  ${h.day}: ${h.closed ? 'Closed' : `${h.open} - ${h.close}`}`),
    ].join('\n');

    // Send email to info@helmies.fi
    await emailService.send({
      to: 'info@helmies.fi',
      subject: `New Restaurant Onboarding - ${restaurantName}`,
      html: htmlBody,
      text: textBody,
    });

    logger.info(`Onboarding submission received from ${email} for ${restaurantName}`);

    res.json({
      success: true,
      message: 'Your application has been submitted successfully',
    });
  } catch (error) {
    logger.error('Onboarding submission failed:', error);
    res.status(500).json({
      error: 'Submission failed',
      message: 'Please try again or contact us at info@helmies.fi',
    });
  }
});

export default router;
